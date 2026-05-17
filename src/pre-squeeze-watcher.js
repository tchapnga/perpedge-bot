// pre-squeeze-watcher.js — Détecteur pré-squeeze prédictif
// Remplace squeeze-watcher.js (réactif/inutile)
// Spec validée 3/3 LLMs 2026-05-17
// Revue code 4/4 LLMs 2026-05-17 — 13 corrections appliquées
// États : IDLE → WATCHING → TRIGGERED → IDLE+cooldown

import { apiGet }                                  from './perp-client.js';
import { getBotState }                             from './bot-state.js';
import { sendTelegram, sendTelegramPhoto }         from './notifier.js';
import { captureChart, cleanChart }                from './chart-capture.js';
import { injectSignal }                            from './injector.js';

// ── Seuils par catégorie (validés 3 LLMs) ────────────────────────────────────

const MAJORS = new Set(['BTCUSDT', 'ETHUSDT']);

const THRESHOLDS = {
  major: {
    clusterMin: 0.4,  clusterMax: 1.0,
    oiDelta15m: 1.5,
    funding:    0.0004,   // 0.04% taux 8h
    volumeMult: 1.5,
    ac1m: 0.5, ac3m: 1.0,
    triggerDist:    0.15,
    liqFallback:    250_000,  // seuil absolu anti-sweep si avg absent (fix B)
  },
  alt: {
    clusterMin: 0.8,  clusterMax: 2.0,
    oiDelta15m: 3.5,
    funding:    0.0008,   // 0.08% taux 8h
    volumeMult: 2.5,
    ac1m: 1.0, ac3m: 2.0,
    triggerDist:    0.22,
    liqFallback:    50_000,   // seuil absolu anti-sweep si avg absent (fix B)
  },
};

const WATCHING_TTL_MS    = 45 * 60_000;
const COOLDOWN_MS        = 15 * 60_000;
const MAX_WATCHING       = 15;
const MAX_TRIGGERED      = 2;
const IDLE_SCAN_MS       = 60_000;
const WATCHING_POLL_MS   = 15_000;
const HEATMAP_RECHECK_MS = 120_000;
const OB_SNAPS_MIN       = 5;
const OI_ROLLING         = 3;

// ── État ──────────────────────────────────────────────────────────────────────

const watching  = new Map();
const cooldowns = new Map();

// ── Guard anti double-start (fix K) ───────────────────────────────────────────
let _started = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

const cat = (sym) => MAJORS.has(sym) ? 'major' : 'alt';
const thr = (sym) => THRESHOLDS[cat(sym)];

// fix H — guard division par zéro
function distPct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return Infinity;
  return Math.abs(a - b) / b * 100;
}

// fix I — guard division par zéro + données invalides
function pctChange(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const n = parseFloat(arr[arr.length - 1][4]);
  const o = parseFloat(arr[0][4]);
  if (!Number.isFinite(n) || !Number.isFinite(o) || o <= 0) return 0;
  return ((n - o) / o) * 100;
}

function volMedian(candles) {
  if (!candles.length) return 0;
  const v = candles.map(c => parseFloat(c[5])).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[m - 1] + v[m]) / 2 : v[m];
}

function fmtP(p) { return !p ? '?' : p < 1 ? p.toPrecision(4) : p.toFixed(2); }

function activeTriggerCount() {
  const now = Date.now();
  let n = 0;
  for (const [, exp] of cooldowns) { if (exp > now) n++; }
  return n;
}

// fix J — guard tableau vide
function calcEMA(closes, period) {
  if (!closes.length) return [];
  const k = 2 / (period + 1);
  let ema  = closes[0];
  return closes.map((c, i) => { if (i === 0) { ema = c; return ema; } ema = c * k + ema * (1 - k); return ema; });
}

// fix G — vrai ATR(14) sur klines raw Binance [[o,h,l,c,v,...]]
function calcATR14(klines) {
  if (!klines || klines.length < 2) return null;
  const n = Math.min(klines.length - 1, 14);
  let trSum = 0;
  for (let i = klines.length - n; i < klines.length; i++) {
    const h  = parseFloat(klines[i][2]);
    const l  = parseFloat(klines[i][3]);
    const pc = parseFloat(klines[i - 1][4]);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / n;
}

function pushOiDelta(setup, delta) {
  setup.oiDeltas.push(delta);
  if (setup.oiDeltas.length > OI_ROLLING + 2) setup.oiDeltas.shift();
  if (setup.oiDeltas.length < OI_ROLLING) return delta;
  const window = setup.oiDeltas.slice(-OI_ROLLING);
  return window.reduce((s, v) => s + v, 0) / OI_ROLLING;
}

// ── Cleanup cooldowns expirées (fix M) ────────────────────────────────────────

function cleanupCooldowns() {
  const now = Date.now();
  for (const [sym, exp] of cooldowns) {
    if (exp <= now) cooldowns.delete(sym);
  }
}

// ── Score WATCHING (0-100) ────────────────────────────────────────────────────

function calcScore(setup, { oiAvg, fundingOk, obImbalOk, compressionOk, dist }) {
  const th = thr(setup.symbol);
  let s = 0;
  if (oiAvg >= th.oiDelta15m)      s += 30;
  if (fundingOk)                    s += 20;
  if (obImbalOk)                    s += 20;
  if (compressionOk)                s += 20;
  if (dist <= th.triggerDist * 3)   s += 10;
  return s;
}

// ── Binance klines ────────────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`klines ${res.status}`);
  return res.json();
}

// ── Liquidation heatmap ───────────────────────────────────────────────────────

async function fetchHeatmap(symbol) {
  try { return await apiGet('liquidation-heatmap', { symbol }, 10000); }
  catch { return null; }
}

function findCluster(heatmap, price, symbol) {
  if (!heatmap?.clusters?.length) return null;
  const th = thr(symbol);
  let best = null;
  for (const c of heatmap.clusters) {
    if (!Number.isFinite(c.price)) continue;
    const d = distPct(c.price, price);
    if (d === Infinity || d < th.clusterMin || d > th.clusterMax) continue;
    if (!best || (c.notional ?? 0) > (best.notional ?? 0)) best = { ...c, dist: d };
  }
  return best;
}

// ── OI rolling avg ────────────────────────────────────────────────────────────

// ── IDLE scan ─────────────────────────────────────────────────────────────────

async function idleScan() {
  cleanupCooldowns();  // fix M
  if (watching.size >= MAX_WATCHING) return;

  let extremes;
  try {
    extremes = await apiGet('scan/funding-extremes', { min_abs_rate: 0.0003, limit: 30 });
  } catch (err) {
    console.warn('[pre-squeeze] funding-extremes failed:', err.message);
    return;
  }

  const candidates = [
    ...(extremes.most_positive ?? []),
    ...(extremes.most_negative ?? []),
  ].filter(e => Math.abs(e.funding_rate ?? 0) >= 0.0003);

  for (const { symbol, funding_rate } of candidates) {
    if (watching.has(symbol)) continue;
    if (watching.size >= MAX_WATCHING) break;
    if ((cooldowns.get(symbol) ?? 0) > Date.now()) continue;

    try { await evaluateCandidate(symbol, funding_rate); }
    catch (err) { console.warn(`[pre-squeeze] eval ${symbol}:`, err.message); }
  }
}

async function evaluateCandidate(symbol, fundingRate) {
  const th = thr(symbol);

  const [k1m, k3m] = await Promise.all([
    fetchKlines(symbol, '1m', 22),
    fetchKlines(symbol, '3m', 5),
  ]);

  // fix I guards
  if (!Array.isArray(k1m) || k1m.length < 3) return;
  if (!Array.isArray(k3m) || k3m.length < 2) return;

  const price = parseFloat(k1m[k1m.length - 1][4]);
  if (!Number.isFinite(price) || price <= 0) return;

  const var1m = Math.abs(pctChange(k1m.slice(-3)));
  const var3m = Math.abs(pctChange(k3m));

  if (var1m >= th.ac1m || var3m >= th.ac3m) return;

  const heatmap = await fetchHeatmap(symbol);
  const cluster = findCluster(heatmap, price, symbol);
  if (!cluster) return;

  const direction = cluster.price > price ? 'long' : 'short';

  // fix F — funding directionnel : LONG exige funding négatif (shorts paient), SHORT positif
  const fundingOk = direction === 'long'
    ? fundingRate <= -th.funding
    : fundingRate >= th.funding;
  if (!fundingOk) return;

  let oiData;
  try { oiData = await apiGet('oi-change', { symbol, period: '15m', lookback: 4 }); }
  catch { return; }

  const oiDelta    = oiData?.oi_change_pct ?? 0;
  // fix E — OI LONG avec signe du prix (évite faux positif accumulation shorts)
  const priceChg15 = pctChange(k1m.slice(-15));
  const compressionOk = direction === 'long'
    ? (oiDelta >= th.oiDelta15m && priceChg15 >= -th.ac1m)
    : (oiDelta >= th.oiDelta15m && priceChg15 <= th.ac1m);
  if (!compressionOk) return;

  let obData;
  try { obData = await apiGet('orderbook-imbalance', { symbol, depth: 20 }); }
  catch { obData = null; }
  const imbalance = obData?.imbalance ?? 0;
  const obSignal  = Math.abs(imbalance) >= 0.20;

  if (!obSignal) return;

  console.log(`[pre-squeeze] 👁 WATCHING ${symbol} — ${direction.toUpperCase()} cluster @$${fmtP(cluster.price)} (${cluster.dist.toFixed(2)}%) funding=${(fundingRate * 100).toFixed(4)}% OI+${oiDelta.toFixed(2)}%`);

  watching.set(symbol, {
    symbol, direction,
    pTarget:       cluster.price,
    category:      cat(symbol),
    enteredAt:     Date.now(),
    lastHeatmap:   Date.now(),
    heatmapMisses: 0,
    score:         0,
    obSnaps:       imbalance !== 0 ? [imbalance] : [],
    oiDeltas:      [oiDelta],
    fundingRate,
    oiAvg:         oiDelta,
    obAvg:         imbalance,
    lastTelegram:  0,
  });
}

// ── WATCHING poll ─────────────────────────────────────────────────────────────

async function watchingPoll() {
  if (watching.size === 0) return;
  const now = Date.now();

  await Promise.allSettled([...watching.keys()].map(async (symbol) => {
    const setup = watching.get(symbol);
    if (!setup) return;

    const th = thr(symbol);

    // TTL
    if (now - setup.enteredAt >= WATCHING_TTL_MS) {
      watching.delete(symbol);
      console.log(`[pre-squeeze] ${symbol} TTL → abandon`);
      return;
    }

    // fix L — fetch 20 bougies pour priceDp cohérent avec seuil 15m
    let k1m;
    try { k1m = await fetchKlines(symbol, '1m', 20); }
    catch { return; }

    if (!Array.isArray(k1m) || k1m.length < 2) return;

    const price  = parseFloat(k1m[k1m.length - 1][4]);
    if (!Number.isFinite(price) || price <= 0) return;

    const dist   = distPct(setup.pTarget, price);
    const var1m  = Math.abs(pctChange(k1m.slice(-3)));

    // Cascade active
    if (var1m >= th.ac1m * 1.5) {
      watching.delete(symbol);
      console.log(`[pre-squeeze] ${symbol} cascade active (${var1m.toFixed(2)}% 1m) → abandon`);
      return;
    }

    // Prix trop loin
    if (dist > 3.5) {
      watching.delete(symbol);
      console.log(`[pre-squeeze] ${symbol} s'éloigne (${dist.toFixed(2)}%) → abandon`);
      return;
    }

    // Cluster traversé (Gemini Objection C)
    const traversed = setup.direction === 'long' ? price > setup.pTarget : price < setup.pTarget;
    if (traversed) {
      const volNow = parseFloat(k1m[k1m.length - 1][5]);
      const volMed = volMedian(k1m);
      if (volMed > 0 && volNow >= volMed * th.volumeMult) {
        console.log(`[pre-squeeze] ${symbol} cluster traversé avec volume (squeeze raté) → abandon`);
      } else {
        console.log(`[pre-squeeze] ${symbol} cluster absorbé passivement → abandon`);
      }
      watching.delete(symbol);
      return;
    }

    // OI update
    let oiDelta = setup.oiAvg;
    try {
      const r = await apiGet('oi-change', { symbol, period: '15m', lookback: 4 });
      oiDelta = r?.oi_change_pct ?? oiDelta;
    } catch { /* keep last */ }
    const oiAvg = pushOiDelta(setup, oiDelta);

    // Orderbook snapshot
    try {
      const ob = await apiGet('orderbook-imbalance', { symbol, depth: 20 });
      if (ob?.imbalance != null) {
        setup.obSnaps.push(ob.imbalance);
        if (setup.obSnaps.length > 10) setup.obSnaps.shift();
      }
    } catch { /* keep last */ }
    const obAvg     = setup.obSnaps.length >= OB_SNAPS_MIN
      ? setup.obSnaps.reduce((s, v) => s + v, 0) / setup.obSnaps.length
      : 0;
    // fix — score OB directionnel cohérent avec trigger
    const obImbalOk = setup.direction === 'long' ? obAvg >= 0.30 : obAvg <= -0.30;

    // fix C — Heatmap recheck : n'accepter que cluster du même côté que la direction
    if (now - setup.lastHeatmap >= HEATMAP_RECHECK_MS) {
      setup.lastHeatmap = now;
      try {
        const hm      = await fetchHeatmap(symbol);
        const cluster = findCluster(hm, price, symbol);
        const sameSide = cluster && (
          (setup.direction === 'long'  && cluster.price > price) ||
          (setup.direction === 'short' && cluster.price < price)
        );
        if (!sameSide) {
          setup.heatmapMisses++;
          if (setup.heatmapMisses >= 2) {
            watching.delete(symbol);
            console.log(`[pre-squeeze] ${symbol} cluster disparu/inversé (2 scans) → abandon`);
            return;
          }
        } else {
          setup.heatmapMisses = 0;
          setup.pTarget = cluster.price;
        }
      } catch { /* fail-open */ }
    }

    // fix E — OI avec signe du prix
    const priceChg15 = pctChange(k1m.slice(-15));
    const compressionOk = setup.direction === 'long'
      ? (oiAvg >= th.oiDelta15m && priceChg15 >= -th.ac1m)
      : (oiAvg >= th.oiDelta15m && priceChg15 <= th.ac1m);

    // fix F — funding directionnel
    const fundingOk = setup.direction === 'long'
      ? setup.fundingRate <= -th.funding
      : setup.fundingRate >= th.funding;

    setup.oiAvg = oiAvg;
    setup.obAvg = obAvg;
    setup.score = calcScore(setup, { oiAvg, fundingOk, obImbalOk, compressionOk, dist });

    // Telegram WATCH si score ≥ 70 (max 1 notif/10min)
    if (setup.score >= 70 && now - setup.lastTelegram > 10 * 60_000) {
      setup.lastTelegram = now;
      const dir = setup.direction.toUpperCase();
      sendTelegram([
        `👁 <b>PRÉ-SQUEEZE WATCH</b> · ${symbol}`,
        `${setup.direction === 'long' ? '🟢' : '🔴'} ${dir} · Cluster @$${fmtP(setup.pTarget)} · Dist <b>${dist.toFixed(2)}%</b>`,
        `OI Δ15m <b>${oiAvg > 0 ? '+' : ''}${oiAvg.toFixed(2)}%</b> · Score <b>${setup.score}/100</b>`,
        `<i>Sous surveillance — trade auto si conditions remplies</i>`,
      ].join('\n')).catch(() => {});
    }

    // TRIGGER check
    if (setup.score >= 85 && dist <= th.triggerDist) {
      if (activeTriggerCount() < MAX_TRIGGERED) {
        await checkTrigger(symbol, setup, price, k1m, oiAvg, obAvg);
      }
    }
  }));
}

// ── TRIGGER check ─────────────────────────────────────────────────────────────

async function checkTrigger(symbol, setup, price, k1m, oiAvg, obAvg) {
  const th = thr(symbol);

  // EMA9/21 sur 1m (25 bougies)
  let k1m_ext;
  try { k1m_ext = await fetchKlines(symbol, '1m', 25); }
  catch { return; }

  const closes  = k1m_ext.map(c => parseFloat(c[4]));
  const ema9    = calcEMA(closes, 9);
  const ema21   = calcEMA(closes, 21);
  if (!ema9.length || !ema21.length) return;

  const lastE9  = ema9[ema9.length - 1];
  const lastE21 = ema21[ema21.length - 1];
  const momentumOk = setup.direction === 'long' ? lastE9 > lastE21 : lastE9 < lastE21;
  if (!momentumOk) return;

  // Volume spike
  const volNow = parseFloat(k1m_ext[k1m_ext.length - 1][5]);
  const volMed  = volMedian(k1m_ext.slice(0, 20));
  if (!Number.isFinite(volMed) || volMed <= 0) return;
  if (volNow < volMed * th.volumeMult) return;

  // OI 1m — pas de décharge
  let oi1m = 0;
  try {
    const r = await apiGet('oi-change', { symbol, period: '1m', lookback: 2 });
    oi1m = r?.oi_change_pct ?? 0;
  } catch { /* fail-open */ }
  if (oi1m < -0.2) {
    watching.delete(symbol);
    console.log(`[pre-squeeze] ${symbol} OI 1m décharge (${oi1m.toFixed(2)}%) → abandon`);
    return;
  }

  // Orderbook dans sens du mouvement
  const obDirOk = setup.direction === 'long' ? obAvg > 0.20 : obAvg < -0.20;
  if (!obDirOk) return;

  // fix A — Anti liquidity sweep : oppSide = côté OPPOSÉ au trade
  // Pour LONG : les shorts liquidés = short_usd ; pour SHORT : les longs liquidés = long_usd
  try {
    const liq     = await apiGet('liquidations-summary', { symbol, hours: 1 });
    const oppSide = setup.direction === 'long' ? 'short_usd' : 'long_usd';  // fix A
    const oppSpike = liq?.recent_spike_usd?.[oppSide] ?? 0;
    // fix B — seuil absolu pour éviter fallback oppSpike/2 qui neutralise le filtre
    const oppAvgFallback = th.liqFallback;
    const oppAvg   = liq?.avg_per_hour_usd?.[oppSide] ?? oppAvgFallback;
    if (oppAvg > 0 && oppSpike > oppAvg * 2 && oppSpike >= oppAvgFallback * 0.5) {
      console.log(`[pre-squeeze] ${symbol} liquidity sweep probable (liq ${oppSide} x${(oppSpike / oppAvg).toFixed(1)}) → skip`);
      return;
    }
  } catch { /* fail-open */ }

  // ── Toutes conditions remplies → TRIGGER ─────────────────────────────────

  // fix G — vrai ATR(14) sur klines 1h pour synthResult
  let atr1h = price * 0.012;  // fallback : 1.2% (mieux que 0.5%)
  try {
    const k1h = await fetchKlines(symbol, '1h', 16);
    const computed = calcATR14(k1h);
    if (computed && Number.isFinite(computed) && computed > 0) atr1h = computed;
  } catch { /* use fallback */ }

  const slPct = 0.015;
  const sl    = setup.direction === 'long' ? price * (1 - slPct) : price * (1 + slPct);
  const tpDist = Math.abs(setup.pTarget - price);
  const tp    = setup.direction === 'long'
    ? setup.pTarget + tpDist * 0.5
    : setup.pTarget - tpDist * 0.5;
  const rr    = +((Math.abs(tp - price) / Math.abs(sl - price)).toFixed(2));

  if (rr < 1.5) {
    console.log(`[pre-squeeze] ${symbol} R:R trop faible (${rr}) → skip`);
    return;
  }

  console.log(`[pre-squeeze] 🔥 TRIGGER ${symbol} — ${setup.direction.toUpperCase()} @$${fmtP(price)} R:R=${rr} vol=${(volNow / volMed).toFixed(2)}x OI1m=${oi1m.toFixed(2)}%`);

  // fix D — cooldowns AVANT tout (évite race condition si Telegram/inject plantent)
  watching.delete(symbol);
  cooldowns.set(symbol, Date.now() + COOLDOWN_MS);

  // fix D — Telegram non-bloquant (ne doit pas bloquer l'injection)
  const dir = setup.direction.toUpperCase();
  const msg = [
    `🔥 <b>PRÉ-SQUEEZE TRIGGER</b> · ${symbol}`,
    `${setup.direction === 'long' ? '🟢' : '🔴'} ${dir} · Cluster @$${fmtP(setup.pTarget)} · R:R <b>${rr}</b>`,
    `OI Δ15m <b>${oiAvg > 0 ? '+' : ''}${oiAvg.toFixed(2)}%</b> · Vol <b>${(volNow / volMed).toFixed(2)}x</b>`,
    `Entry <b>$${fmtP(price)}</b>  TP <b>$${fmtP(tp)}</b>  SL <b>$${fmtP(sl)}</b>`,
  ].join('\n');

  sendTelegram(msg).catch(err => console.warn('[pre-squeeze] Telegram:', err.message));

  // Chart async fail-open
  const levels   = { entry: price, sl, tp, signal: dir };
  const chartCtx = {
    oiTrigger: `OI ${oiAvg > 0 ? '+' : ''}${oiAvg.toFixed(2)}% Δ15m`,
    score:     7,
  };
  captureChart(symbol, '1h', levels, chartCtx)
    .then(path => {
      if (!path) return;
      const cap = `📊 <b>${symbol}</b> · 1H · ${dir} · 🔥 Pré-Squeeze · R:R ${rr}`;
      return sendTelegramPhoto(path, cap).then(() => cleanChart(path));
    })
    .catch(err => console.warn(`[pre-squeeze] chart ${symbol}:`, err.message));

  // fix D — injectSignal avec await (on veut savoir si ça échoue)
  const synthResult = {
    signal:    'TRADE',
    direction: setup.direction,
    symbol,
    total:     7, ta_score: 4, der_score: 3, force: 'FORT',
    source: 'pre_squeeze', scan_count: 1, scans: ['pre_squeeze'],
    ta: {
      sr: {
        nearest_support:    setup.direction === 'long' ? sl    : setup.pTarget,
        nearest_resistance: setup.direction === 'long' ? setup.pTarget : sl,
      },
      tf_1h: { close: price, atr_14: atr1h, vwap_24h: price },
    },
  };

  try {
    await injectSignal(synthResult);
    console.log(`[pre-squeeze] injectSignal ${symbol} ✓`);
  } catch (err) {
    console.error(`[pre-squeeze] injectSignal ${symbol} ✗:`, err.message);
  }
}

// ── Export principal ───────────────────────────────────────────────────────────

export function startPreSqueezeWatcher() {
  // fix K — guard anti double-start
  if (_started) {
    console.warn('[pre-squeeze] déjà démarré — appel ignoré');
    return;
  }
  _started = true;

  console.log(`[pre-squeeze] Démarré — IDLE ${IDLE_SCAN_MS / 1000}s · WATCHING ${WATCHING_POLL_MS / 1000}s · max ${MAX_WATCHING}/${MAX_TRIGGERED}`);

  let idleRunning     = false;
  let watchingRunning = false;

  const idleTick = async () => {
    if (idleRunning || !getBotState()?.modules?.squeeze) return;
    idleRunning = true;
    try { await idleScan(); }
    catch (err) { console.error('[pre-squeeze] idleScan error:', err.message); }
    finally { idleRunning = false; }
  };

  const watchTick = async () => {
    if (watchingRunning || !getBotState()?.modules?.squeeze) return;
    watchingRunning = true;
    try { await watchingPoll(); }
    catch (err) { console.error('[pre-squeeze] watchingPoll error:', err.message); }
    finally { watchingRunning = false; }
  };

  idleTick();
  setInterval(idleTick, IDLE_SCAN_MS);
  setTimeout(() => {
    watchTick();
    setInterval(watchTick, WATCHING_POLL_MS);
  }, 5_000);
}
