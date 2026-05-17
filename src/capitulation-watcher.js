// capitulation-watcher.js — v2 FSM: IDLE→FORMING→CONFIRMING→RECLAIM
// WebSocket Tier-1/Tier-2, dead cat filter, DCA 3 tranches + exit policy
// Spec validée 3/3 LLMs 2026-05-17

import WebSocket from 'ws';
import { getBotState, getMode, isPaused, isEmergencyStopped } from './bot-state.js';
import { buildCombinedMessage, sendTelegram, sendTelegramPhoto } from './notifier.js';
import { captureChart, cleanChart }                           from './chart-capture.js';
import { injectSignal, computeLevels }                        from './injector.js';
import { executeOrder }                                       from './order-executor.js';
import { registerTrade }                                      from './position-manager.js';
import { runAnalysis }                                        from './scorer.js';
import { config }                                             from './config.js';
import { getPreSqueezeWatching }                              from './pre-squeeze-watcher.js';

// ─── Tuning ───────────────────────────────────────────────────────────────────
const TIER1_POLL_MS    = 60_000;         // scan global 1min
const TIER2_OI_POLL_MS = 30_000;         // refresh OI REST par symbole actif
const FORMING_TIMEOUT  = 15 * 60_000;    // max 15min en FORMING avant reset
const RECLAIM_TIMEOUT  = 2 * 60 * 60_000;// max 2h en RECLAIM
const COOLDOWN_CONF_MS = 30 * 60_000;    // cooldown après CONFIRMED (posé avant Telegram)
const COOLDOWN_IGN_MS  = 15 * 60_000;    // cooldown après dead cat IGNORE
const MAX_ACTIVE       = 5;              // sessions Tier-2 simultanées max

const T1_DROP_PCT   = -3.0;   // drop 24h (proxy) pour activer Tier-2
const PRICE_ACCEL   = -1.2;   // % drop / 5m (trigger 1) — consensus débat 3/3 LLMs
const OI_FLASH_PCT  = -2.5;   // % OI drop / 5m (trigger 3) — consensus débat 3/3 LLMs
const CVD_NEG_RATIO = -0.25;  // seuil imbalance CVD/absVol (trigger 4) — consensus débat 3/3 LLMs
const CVD_MIN_VOL   = 500_000;// volume notionnel minimum USDT pour trigger CVD
const LIQ_THRESHOLD = (sym) => ['BTCUSDT', 'ETHUSDT'].includes(sym) ? 1_000_000 : 200_000;
const FORMING_MIN   = 3;      // triggers nécessaires / 4 → CONFIRMING

const OI_RECOVERY   = 1.0;    // % OI slope / 5m (filtre dead cat 1)
const FUNDING_FLOOR = -0.0005;// funding > FLOOR = shorts qui rachètent (filtre 2)
const CONFIRM_MIN   = 3;      // filtres passants / 5 → CONFIRMED

const T1_RISK = 0.30;  // fraction du budget risque normal (30%)
const T2_RISK = 0.50;  // 50%
const T3_RISK = 0.20;  // 20%

// ─── État ─────────────────────────────────────────────────────────────────────
const sessions  = new Map();  // symbol → Session
const cooldowns = new Map();  // symbol → expiry timestamp
const liqBuffer = new Map();  // symbol → [{ ts, usd }] rolling 2min

let globalLiqWs = null;
let _started    = false;

// ─── Tier-1 : scan global — paires en chute ───────────────────────────────────
async function tier1Scan() {
  if (!getBotState().modules.capitulation) return;

  let tickers;
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr',
      { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    tickers = await res.json();
  } catch { return; }

  const squeezeMap = getPreSqueezeWatching();
  const now = Date.now();

  // Nettoyage périodique des maps (évite croissance mémoire illimitée)
  for (const [sym, until] of cooldowns) { if (until <= now) cooldowns.delete(sym); }
  for (const [sym] of liqBuffer) { if (!sessions.has(sym)) liqBuffer.delete(sym); }

  const candidates = tickers
    .filter(t =>
      t.symbol.endsWith('USDT') &&
      parseFloat(t.priceChangePercent) <= T1_DROP_PCT &&
      parseFloat(t.quoteVolume)        >= 5_000_000
    )
    .sort((a, b) => parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent))
    .slice(0, 15);

  for (const t of candidates) {
    const sym = t.symbol;
    if (sessions.has(sym))               continue;
    if (squeezeMap.has(sym))             continue;
    if ((cooldowns.get(sym) ?? 0) > now) continue;
    if (sessions.size >= MAX_ACTIVE)     break;
    openTier2(sym, parseFloat(t.lastPrice));
  }
}

// ─── Tier-2 : WebSocket + polling par symbole chaud ──────────────────────────
function openTier2(symbol, initialPrice) {
  const sess = {
    symbol,
    state:       'FORMING',
    formingAt:   Date.now(),
    price:       initialPrice,
    cvdWindow:   [],  // [{ ts, delta }] rolling 5min
    priceWindow: [],  // [{ ts, price }] rolling 5min
    oiHistory:   [],  // [{ ts, oi }]   rolling 5min
    triggers:    new Set(),
    wickLow:     null,
    entryPrice:  null,
    slPrice:     null,
    tp1Price:    null,
    tp2Price:    null,
    t1Entered:   false,
    t2Entered:   false,
    t3Entered:   false,
    ws:          null,
    oiTimer:     null,
    tickTimer:   null,
    closing:     false,
    confirmedAt: 0,
  };
  sessions.set(symbol, sess);
  console.log(`[cap-watcher] FORMING ${symbol} — Tier-2 ouvert`);

  // aggTrade WebSocket : CVD + prix live
  const connectWs = () => {
    if (!sessions.has(symbol)) return;
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@aggTrade`);
    sess.ws = ws;
    ws.on('message', (raw) => {
      try {
        const d     = JSON.parse(raw);
        const now   = Date.now();
        const price = parseFloat(d.p);
        const qty   = parseFloat(d.q);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
        sess.price = price;
        const delta = d.m ? -(price * qty) : (price * qty); // m=true : taker = vendeur
        const cut   = now - 5 * 60_000;
        sess.cvdWindow.push({ ts: now, delta });
        sess.cvdWindow   = sess.cvdWindow.filter(e => e.ts > cut);
        sess.priceWindow.push({ ts: now, price });
        sess.priceWindow = sess.priceWindow.filter(e => e.ts > cut);
      } catch { /* ignore malformed */ }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (sessions.get(symbol)?.ws === ws && !sess.closing) setTimeout(connectWs, 3_000);
    });
  };
  connectWs();

  // OI polling REST toutes les 30s
  sess.oiTimer = setInterval(async () => {
    try {
      const r  = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
        { signal: AbortSignal.timeout(5_000) });
      const d  = await r.json();
      const oi = parseFloat(d.openInterest);
      if (!Number.isFinite(oi)) return;
      const now = Date.now();
      sess.oiHistory.push({ ts: now, oi });
      sess.oiHistory = sess.oiHistory.filter(e => e.ts > now - 5 * 60_000);
    } catch { /* fail-open */ }
  }, TIER2_OI_POLL_MS);

  // Tick FSM toutes les 30s
  const tick = async () => {
    if (!sessions.has(symbol)) return;
    try { await fsmTick(sess); }
    catch (err) { console.error(`[cap-watcher] tick ${symbol}:`, err.message); }
    if (sessions.has(symbol)) sess.tickTimer = setTimeout(tick, 30_000);
  };
  sess.tickTimer = setTimeout(tick, 30_000);
}

// ─── FSM tick ─────────────────────────────────────────────────────────────────
async function fsmTick(sess) {
  const { symbol } = sess;
  const now = Date.now();

  if (sess.state === 'FORMING') {
    if (now - sess.formingAt > FORMING_TIMEOUT) {
      console.log(`[cap-watcher] FORMING timeout ${symbol}`);
      return closeSession(symbol, 'timeout');
    }
    evalFormingTriggers(sess);
    if (sess.triggers.size >= FORMING_MIN) {
      sess.state = 'CONFIRMING';
      console.log(`[cap-watcher] ${symbol} → CONFIRMING (${sess.triggers.size}/4 triggers)`);
    }
  }

  if (sess.state === 'CONFIRMING') {
    const score = await evalConfirmFilters(sess);
    if (score >= CONFIRM_MIN) {
      await onConfirmed(sess); // sets sess.state = 'RECLAIM' on success
      return; // empêche CONFIRMING→RECLAIM dans le même tick (consensus 3/3 LLMs)
    } else if (score <= 0) {
      console.log(`[cap-watcher] ${symbol} → IGNORE dead cat (score=${score})`);
      closeSession(symbol, 'ignore');
    }
    // score 1-2 : ambiguïté → re-check tick suivant
  }

  if (sess.state === 'RECLAIM') {
    if (now - sess.formingAt > RECLAIM_TIMEOUT) {
      console.log(`[cap-watcher] RECLAIM timeout ${symbol}`);
      return closeSession(symbol, 'timeout');
    }
    await monitorReclaim(sess);
  }
}

// ─── Triggers FORMING (3/4 nécessaires) ──────────────────────────────────────
function evalFormingTriggers(sess) {
  const now  = Date.now();
  const cut5 = now - 5 * 60_000;

  // 1. Accélération prix ≥ PRICE_ACCEL %/5m
  const pOld = sess.priceWindow.find(p => p.ts > cut5);
  if (pOld && pOld.price > 0 && sess.price > 0) {
    const pct = (sess.price - pOld.price) / pOld.price * 100;
    if (pct <= PRICE_ACCEL) sess.triggers.add('price_accel');
  }

  // 2. Cascade de liquidations LONG ≥ seuil bucket (BTC/ETH 1M, alts 200k) en 1min
  const liq1m = (liqBuffer.get(sess.symbol) ?? [])
    .filter(e => e.ts > now - 60_000)
    .reduce((s, e) => s + e.usd, 0);
  if (liq1m >= LIQ_THRESHOLD(sess.symbol)) sess.triggers.add('liq_cascade');

  // 3. OI flash crash ≤ OI_FLASH_PCT en 5m
  if (sess.oiHistory.length >= 2) {
    const oiFirst = sess.oiHistory[0].oi;
    const oiLast  = sess.oiHistory[sess.oiHistory.length - 1].oi;
    if (oiFirst > 0 && (oiLast - oiFirst) / oiFirst * 100 <= OI_FLASH_PCT) {
      sess.triggers.add('oi_flash');
    }
  }

  // 4. CVD fortement déséquilibré côté vendeur (ratio relatif, cross-symboles)
  if (sess.cvdWindow.length >= 10) {
    const cvdSum = sess.cvdWindow.reduce((s, e) => s + e.delta, 0);
    const absVol = sess.cvdWindow.reduce((s, e) => s + Math.abs(e.delta), 0);
    if (absVol >= CVD_MIN_VOL && cvdSum / absVol <= CVD_NEG_RATIO) sess.triggers.add('cvd_neg');
  }

  if (sess.triggers.size > 0) {
    console.log(`[cap-watcher] ${sess.symbol} triggers [${[...sess.triggers].join(',')}] ${sess.triggers.size}/4`);
  }
}

// ─── Filtres dead cat vs vrai bottom (3/5 nécessaires) ────────────────────────
async function evalConfirmFilters(sess) {
  const { symbol, oiHistory, cvdWindow, price, priceWindow } = sess;
  let score = 0;

  // 1. OI slope positif (+1%/5m) — min 6 lectures (3min à 30s/poll) pour slope fiable
  if (oiHistory.length >= 6) {
    const slope = oiHistory[0].oi > 0
      ? (oiHistory[oiHistory.length - 1].oi - oiHistory[0].oi) / oiHistory[0].oi * 100
      : 0;
    score += slope >= OI_RECOVERY ? 1 : -1;
  }

  // 2. Funding remontant vers 0 (shorts qui rachètent)
  try {
    const r  = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
      { signal: AbortSignal.timeout(5_000) });
    const d  = await r.json();
    const fr = parseFloat(d.lastFundingRate);
    if (Number.isFinite(fr)) score += fr > FUNDING_FLOOR ? 1 : -1;
  } catch { /* neutre */ }

  // 3. CVD redevenu positif (acheteurs absorbent les vendeurs)
  const cvdSum = cvdWindow.reduce((s, e) => s + e.delta, 0);
  score += cvdSum > 0 ? 1 : -1;

  // 4. Prix au-dessus de la SMA15m (proxy EMA15 reclaim)
  const recent15 = priceWindow.filter(p => p.ts > Date.now() - 15 * 60_000);
  if (recent15.length >= 5) {
    const sma = recent15.reduce((s, p) => s + p.price, 0) / recent15.length;
    score += price > sma ? 1 : -1;
  }

  // 5. Wick bas détecté ET prix encore proche du wick (structure capitulation réelle)
  const prices = priceWindow.map(p => p.price).filter(Number.isFinite);
  if (prices.length >= 10) {
    sess.wickLow = Math.min(...prices);
    if (price <= sess.wickLow * 1.003) score += 1;
  }

  console.log(`[cap-watcher] ${symbol} confirmScore=${score}/5`);
  return score;
}

// ─── CONFIRMED : analyse, Telegram, chart, entrée T1 ─────────────────────────
async function onConfirmed(sess) {
  const { symbol } = sess;

  let result;
  try {
    result = await runAnalysis(symbol, ['capitulation']);
    result.scan_count   = 1;
    result.scans        = ['capitulation'];
    result.cap_triggers = [...sess.triggers];
  } catch (err) {
    console.error(`[cap-watcher] runAnalysis ${symbol}:`, err.message);
    return closeSession(symbol, 'analysis_error');
  }

  if (result.signal === 'NO_TRADE' || result.total < config.minScore) {
    console.log(`[cap-watcher] ${symbol} score insuf (${result.total}) → IGNORE`);
    return closeSession(symbol, 'ignore');
  }

  const lvls   = computeLevels(result);
  const risk   = Math.abs(lvls.entry - lvls.sl);
  const reward = Math.abs(lvls.tp1   - lvls.entry);
  if (risk < 1e-8 || reward < 1e-8) return closeSession(symbol, 'levels_invalid');

  const rr = reward / risk;
  if (rr < 1.5) {
    console.log(`[cap-watcher] ${symbol} R:R ${rr.toFixed(2)} < 1.5 → IGNORE`);
    return closeSession(symbol, 'ignore');
  }

  result._levels = lvls;
  result._rr     = +rr.toFixed(2);
  sess.entryPrice = lvls.entry;
  sess.slPrice    = sess.wickLow ? Math.min(sess.wickLow * 0.997, lvls.sl) : lvls.sl;
  sess.tp1Price   = lvls.tp1;
  sess.tp2Price   = lvls.tp2;

  // Cooldown posé AVANT Telegram (évite re-entrée si send throw)
  cooldowns.set(symbol, Date.now() + COOLDOWN_CONF_MS);

  const trigLabel = [...sess.triggers].join('+');
  const modeNote  = `\n<i>💀 Capitulation intracandle · DCA LONG T1 30%</i>`;

  sendTelegram(
    `💀 <b>CAPITULATION</b> · ${symbol}\n` +
    `<code>${trigLabel}</code>  ·  R:R <b>${result._rr}</b>${modeNote}\n\n` +
    buildCombinedMessage([result])
  ).catch(err => console.warn(`[cap-watcher] Telegram ${symbol}:`, err.message));

  // Chart async fail-open
  captureChart(symbol, '1h',
    { entry: sess.entryPrice, sl: sess.slPrice, tp: sess.tp1Price, signal: 'LONG' },
    {
      trend1h: result.ta?.tf_1h?.trend, trend4h: result.ta?.tf_4h?.trend,
      trend1d: result.ta?.tf_1d?.trend, rsi: result.ta?.tf_1h?.rsi,
      score: result.total, oiTrigger: `💀 ${trigLabel}`,
      support: result.ta?.sr?.nearest_support, resistance: result.ta?.sr?.nearest_resistance,
    }
  ).then(path => {
    if (!path) return;
    return sendTelegramPhoto(path, `📊 <b>${symbol}</b> · 1H · LONG · 💀 Capitulation DCA · R:R ${result._rr}`)
      .then(() => cleanChart(path));
  }).catch(err => console.warn(`[cap-watcher] chart ${symbol}:`, err.message));

  await injectSignal(result).catch(err => console.error(`[cap-watcher] inject ${symbol}:`, err.message));

  // Garde pause/stop avant T1 (consensus 2/3 LLMs revue finale)
  if (isPaused() || isEmergencyStopped() || !getBotState().modules.capitulation) {
    console.log(`[cap-watcher] T1 bloqué ${symbol} — bot paused/stopped`);
    return closeSession(symbol, 'paused_or_stopped');
  }

  // Entrée T1 (30% du budget risque)
  if (getMode() === 'LIVE') {
    try {
      const order = await executeOrder({
        symbol, side: 'LONG', entry: sess.entryPrice,
        extra: { reduce_size: false, risk_fraction: T1_RISK },
      });
      if (!order.success) {
        console.error(`[cap-watcher] T1 échec ${symbol}: ${order.error}`);
        return closeSession(symbol, 't1_failed');
      }
      sess.t1Entered   = true;
      sess.t1FillPrice = order.price ?? sess.entryPrice;
      await registerTrade({
        symbol, side: 'LONG',
        entry: sess.t1FillPrice,
        sl:    sess.slPrice,
        tp1:   sess.tp1Price,
        tp2:   sess.tp2Price,
        qty:   order.qty,
      });
      console.log(`[cap-watcher] T1 entré ${symbol} qty=${order.qty} @ ${sess.t1FillPrice}`);
    } catch (err) {
      console.error(`[cap-watcher] T1 error ${symbol}:`, err.message);
      return closeSession(symbol, 't1_error');
    }
  } else {
    console.log(`[cap-watcher] ${getMode()} — T1 simulé ${symbol} @ ${sess.entryPrice}`);
    sess.t1Entered = true;
  }

  sess.confirmedAt = Date.now();
  sess.state = 'RECLAIM';
}

// ─── RECLAIM : suivi T2/T3 + garde SL ────────────────────────────────────────
async function monitorReclaim(sess) {
  const { symbol, price, slPrice, tp1Price, tp2Price } = sess;

  // Garde SL : position-manager gère les ordres, on surveille juste la logique
  if (price < slPrice) {
    console.log(`[cap-watcher] SL atteint ${symbol} @ ${price.toPrecision(5)} (sl=${slPrice.toPrecision(5)})`);
    sendTelegram(`💀 <b>${symbol}</b> — SL @ ${price.toPrecision(5)} · Sortie en cours`)
      .catch(() => {});
    return closeSession(symbol, 'sl_hit');
  }

  const now     = Date.now();
  const cvdSum  = sess.cvdWindow.reduce((s, e) => s + e.delta, 0);
  const oiSlope = computeOiSlope(sess.oiHistory);
  const recent15 = sess.priceWindow.filter(p => p.ts > now - 15 * 60_000);
  const sma15    = recent15.length >= 5
    ? recent15.reduce((s, p) => s + p.price, 0) / recent15.length
    : null;

  // T2 : reclaim EMA15 + OI↑ + CVD+ (50% du budget)
  const canAddRisk = !isPaused() && !isEmergencyStopped() && getBotState().modules.capitulation;
  if (!sess.t2Entered && sess.t1Entered && canAddRisk) {
    const minDelay = 60_000; // T2 au minimum 60s après T1 (empêche T1+T2 même tick)
    if (cvdSum > 0 && oiSlope > 0 && sma15 !== null && price > sma15 &&
        Date.now() - sess.confirmedAt >= minDelay) {
      console.log(`[cap-watcher] T2 signal ${symbol} — reclaim + CVD+ + OI↑`);
      sendTelegram(`💀 <b>${symbol}</b> — DCA T2 50% · Reclaim + CVD+ + OI↑`).catch(() => {});
      sess.t2Entered = true; // flag AVANT await pour éviter double ordre (race condition fix)
      if (getMode() === 'LIVE') {
        try {
          const order = await executeOrder({
            symbol, side: 'LONG', entry: price,
            extra: { reduce_size: false, risk_fraction: T2_RISK },
          });
          if (order.success) {
            sess.t2FillPrice = order.price ?? price;
            await registerTrade({
              symbol, side: 'LONG',
              entry: sess.t2FillPrice,
              sl: slPrice, tp1: tp1Price, tp2: tp2Price, qty: order.qty,
            });
            console.log(`[cap-watcher] T2 entré ${symbol} qty=${order.qty} @ ${sess.t2FillPrice}`);
          } else {
            sess.t2Entered = false; // revert si ordre échoué
            console.error(`[cap-watcher] T2 échec ${symbol}: ${order.error}`);
          }
        } catch (err) {
          sess.t2Entered = false; // revert si exception
          console.error(`[cap-watcher] T2 error ${symbol}:`, err.message);
        }
      } else {
        console.log(`[cap-watcher] ${getMode()} — T2 simulé ${symbol}`);
      }
    }
  }

  // T3 : premier Higher Low 5m (20% du budget)
  if (!sess.t3Entered && sess.t2Entered && sess.wickLow != null && canAddRisk) {
    const prices5m = sess.priceWindow
      .filter(p => p.ts > now - 5 * 60_000)
      .map(p => p.price);
    if (prices5m.length >= 3) {
      const localMin  = Math.min(...prices5m);
      const higherLow = localMin > sess.wickLow && localMin > slPrice * 1.005;
      const bouncing  = price > localMin * 1.002;
      if (higherLow && bouncing) {
        console.log(`[cap-watcher] T3 signal ${symbol} — Higher Low @ ${localMin.toPrecision(5)}`);
        sendTelegram(`💀 <b>${symbol}</b> — DCA T3 20% · Higher Low @ ${localMin.toPrecision(5)}`).catch(() => {});
        sess.t3Entered = true; // flag AVANT await pour éviter double ordre (race condition fix)
        let t3Success = getMode() !== 'LIVE'; // true en SHADOW/DRY_RUN
        if (getMode() === 'LIVE') {
          try {
            const order = await executeOrder({
              symbol, side: 'LONG', entry: price,
              extra: { reduce_size: false, risk_fraction: T3_RISK },
            });
            if (order.success) {
              sess.t3FillPrice = order.price ?? price;
              await registerTrade({
                symbol, side: 'LONG',
                entry: sess.t3FillPrice,
                sl: slPrice, tp1: tp1Price, tp2: tp2Price, qty: order.qty,
              });
              console.log(`[cap-watcher] T3 entré ${symbol} qty=${order.qty} @ ${sess.t3FillPrice}`);
              t3Success = true;
            } else {
              sess.t3Entered = false; // revert si ordre échoué
              console.error(`[cap-watcher] T3 échec ${symbol}: ${order.error}`);
            }
          } catch (err) {
            sess.t3Entered = false; // revert si exception
            console.error(`[cap-watcher] T3 error ${symbol}:`, err.message);
          }
        } else {
          console.log(`[cap-watcher] ${getMode()} — T3 simulé ${symbol}`);
        }
        // closeSession seulement si T3 réellement entré (évite dangling T1/T2 sans SL watch)
        if (t3Success) return closeSession(symbol, 'dca_complete');
      }
    }
  }

  // Fermeture si toutes les tranches sont entrées
  if (sess.t2Entered && sess.t3Entered) closeSession(symbol, 'dca_complete');
}

// ─── OI slope helper ──────────────────────────────────────────────────────────
function computeOiSlope(oiHistory) {
  if (oiHistory.length < 2) return 0;
  const first = oiHistory[0].oi;
  const last  = oiHistory[oiHistory.length - 1].oi;
  return first > 0 ? (last - first) / first * 100 : 0;
}

// ─── Fermeture de session ─────────────────────────────────────────────────────
function closeSession(symbol, reason = '') {
  const sess = sessions.get(symbol);
  if (!sess) return;
  sess.closing = true; // empêche le close handler de relancer connectWs
  if (sess.ws)        try { sess.ws.close(); }       catch { /* ignore */ }
  if (sess.oiTimer)   clearInterval(sess.oiTimer);
  if (sess.tickTimer) clearTimeout(sess.tickTimer);
  sessions.delete(symbol);
  // cooldown : COOLDOWN_CONF_MS si déjà posé par onConfirmed, sinon COOLDOWN_IGN_MS
  if ((cooldowns.get(symbol) ?? 0) <= Date.now()) {
    cooldowns.set(symbol, Date.now() + COOLDOWN_IGN_MS);
  }
  if (reason) console.log(`[cap-watcher] session fermée ${symbol} (${reason})`);
}

// ─── WebSocket global liquidations ───────────────────────────────────────────
function startGlobalLiqWs() {
  const connect = () => {
    globalLiqWs = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
    globalLiqWs.on('message', (raw) => {
      try {
        const e    = JSON.parse(raw);
        const sym  = e?.o?.s;
        const side = e?.o?.S;   // 'SELL' = long liquidé
        const qty  = parseFloat(e?.o?.q ?? 0);
        const px   = parseFloat(e?.o?.p ?? 0);
        if (!sym || side !== 'SELL' || !Number.isFinite(qty) || !Number.isFinite(px)) return;
        const now = Date.now();
        let buf = liqBuffer.get(sym) ?? [];
        buf.push({ ts: now, usd: qty * px });
        liqBuffer.set(sym, buf.filter(e => e.ts > now - 2 * 60_000));
      } catch { /* ignore malformed */ }
    });
    globalLiqWs.on('error', () => {});
    globalLiqWs.on('close', () => setTimeout(connect, 5_000));
  };
  connect();
}

// ─── Export ───────────────────────────────────────────────────────────────────
export function startCapitulationWatcher() {
  if (_started) { console.warn('[cap-watcher] déjà démarré — ignoré'); return; }
  _started = true;

  startGlobalLiqWs();
  tier1Scan();
  setInterval(tier1Scan, TIER1_POLL_MS);

  console.log('[cap-watcher] Démarré — Tier-1 60s · Tier-2 WS aggTrade · FSM FORMING→CONFIRMING→RECLAIM · DCA 3 tranches');
}
