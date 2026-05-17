import WebSocket from 'ws';
import { createHmac } from 'crypto';
import { logTrade } from './trade-journal.js';
import { apiGet } from './perp-client.js';
import { loadPositions, savePositions } from './position-store.js';
import { recordClosedTrade } from './bot-state.js';
import { sendTelegram, fmt } from './notifier.js';

const POLL_MS   = 60_000;
const TRAIL_PCT = 0.015;           // fallback si ATR indisponible
const LEVERAGE  = 20;
const EARLY_EXIT_THRESHOLD    = 6;
const EARLY_EXIT_TICKS_NEEDED = 2;

// Feature 1 — callbackRate ATR dynamique
const TRAILING_CALLBACK_MIN   = 0.3;
const TRAILING_CALLBACK_MAX   = 3.0;
const TRAILING_ATR_MULTIPLIER = 1.5;

// Feature 2 — WebSocket User Data Stream
const USER_DATA_KEEPALIVE_MS    = 25 * 60 * 1000;
const USER_DATA_BASE_BACKOFF_MS = 1_000;
const USER_DATA_MAX_BACKOFF_MS  = 30_000;
const WS_DEBOUNCE_MS            = 500;

const isTestnet  = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
const BASE_URL   = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
const API_KEY    = isTestnet ? process.env.BINANCE_TESTNET_API_KEY    : process.env.BINANCE_API_KEY;
const API_SECRET = isTestnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET;

const trackedPositions = loadPositions();
let intervalHandle = null;


function buildSignedQuery(params = {}) {
  if (!API_SECRET) throw new Error('Missing Binance API secret');
  const cleanParams = Object.entries({ ...params, timestamp: Date.now() })
    .filter(([, v]) => v !== undefined && v !== null);
  const query = new URLSearchParams();
  for (const [k, v] of cleanParams) query.append(k, String(v));
  const signature = createHmac('sha256', API_SECRET).update(query.toString()).digest('hex');
  query.append('signature', signature);
  return query.toString();
}

async function signedRequest(method, path, params = {}) {
  if (!API_KEY) throw new Error('Missing Binance API key');
  const url      = `${BASE_URL}${path}?${buildSignedQuery(params)}`;
  const response = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  const text     = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload?.msg || payload?.raw || `HTTP ${response.status}`);
  return payload;
}

async function publicRequest(path, params = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) query.append(k, String(v));
  }
  const url      = query.toString() ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;
  const response = await fetch(url);
  const text     = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload?.msg || payload?.raw || `HTTP ${response.status}`);
  return payload;
}

function roundToTick(price, tickSize) {
  const p = Number(price);
  const t = Number(tickSize);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return p;
  const decimals = (String(tickSize).split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.round(p / t) * t).toFixed(decimals));
}

function roundQtyToStep(qty, stepSize) {
  const decimals = (String(stepSize).split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.floor(qty / stepSize) * stepSize).toFixed(decimals));
}

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
function round2(value) { return Math.round(value * 100) / 100; }

async function getDynamicTrailingCallbackRate(symbol, markPrice) {
  try {
    const ta    = await apiGet('ta-analysis', { symbol, interval: '1h' });
    const atr14 = Number(ta?.tf_1h?.atr_14);
    const price = Number(markPrice) || Number(ta?.tf_1h?.close);
    if (!Number.isFinite(atr14) || atr14 <= 0 || !Number.isFinite(price) || price <= 0) {
      return TRAIL_PCT * 100;
    }
    const atrPct       = (atr14 / price) * 100;
    const callbackRate = round2(clamp(atrPct * TRAILING_ATR_MULTIPLIER, TRAILING_CALLBACK_MIN, TRAILING_CALLBACK_MAX));
    console.log(`[position-manager] trailing_callbackRate ${symbol} atr_pct=${atrPct.toFixed(2)}% rate=${callbackRate}%`);
    return callbackRate;
  } catch (err) {
    console.error(`[position-manager] trailing_callbackRate fallback ${symbol}:`, err?.message);
    return TRAIL_PCT * 100;
  }
}

async function getSymbolFilters(symbol) {
  const data        = await publicRequest('/fapi/v1/exchangeInfo', { symbol });
  const symbolInfo  = Array.isArray(data?.symbols) ? data.symbols.find(s => s.symbol === symbol) : null;
  const priceFilter = symbolInfo?.filters?.find(f => f.filterType === 'PRICE_FILTER');
  const lotFilter   = symbolInfo?.filters?.find(f => f.filterType === 'LOT_SIZE');
  if (!priceFilter?.tickSize) throw new Error(`PRICE_FILTER tickSize introuvable pour ${symbol}`);
  if (!lotFilter?.stepSize)   throw new Error(`LOT_SIZE stepSize introuvable pour ${symbol}`);
  return { tickSize: Number(priceFilter.tickSize), stepSize: Number(lotFilter.stepSize) };
}

// Depuis 2025-12-09 : STOP_MARKET/TAKE_PROFIT_MARKET via /fapi/v1/algoOrder, retourne algoId
async function placeStopOrder(symbol, triggerPrice, closeSide, type, quantity) {
  try {
    const params = { algoType: 'CONDITIONAL', symbol, side: closeSide, type, triggerPrice, workingType: 'MARK_PRICE' };
    if (quantity !== undefined && quantity !== null && quantity !== '') {
      params.quantity   = quantity;
      params.reduceOnly = true;
    } else {
      params.closePosition = true;
    }
    const order = await signedRequest('POST', '/fapi/v1/algoOrder', params);
    return order?.algoId ?? null;
  } catch (err) {
    console.error(`[position-manager] placeStopOrder error ${symbol} type=${type} price=${triggerPrice}:`, err?.message);
    return null;
  }
}

// Trailing server-side sans activationPrice. callbackRate ATR-dynamique (Feature 1).
async function placeTrailingOrder(symbol, side, quantity, markPrice = null) {
  try {
    const callbackRate = await getDynamicTrailingCallbackRate(symbol, markPrice);
    const order = await signedRequest('POST', '/fapi/v1/algoOrder', {
      algoType:     'CONDITIONAL',
      symbol,
      side,
      type:         'TRAILING_STOP_MARKET',
      callbackRate,
      workingType:  'MARK_PRICE',
      quantity,
      reduceOnly:   true,
    });
    return order?.algoId ?? null;
  } catch (err) {
    console.error(`[position-manager] placeTrailingOrder error ${symbol}:`, err?.message);
    return null;
  }
}

async function cancelAlgoOrder(algoId) {
  if (!algoId) return null;
  try {
    return await signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId });
  } catch (err) {
    console.error(`[position-manager] cancelAlgoOrder error algoId=${algoId}:`, err?.message);
    return null;
  }
}

// Annule tous les algo orders d'un symbole — endpoint officiel /fapi/v1/algoOpenOrders
// (pas algoOrder/openOrders ni allOpenOrders — confirmé DeepSeek+ChatGPT, revue 3 LLMs)
async function cancelAllAlgoOrders(symbol) {
  try {
    return await signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol });
  } catch (err) {
    console.error(`[position-manager] cancelAllAlgoOrders error ${symbol}:`, err?.message);
    return null;
  }
}

// Détecte si le TP1 a été exécuté en vérifiant les algo orders ouverts.
// GET /fapi/v1/openAlgoOrders — si algoId TP1 absent → exécuté ou annulé.
// Combiné avec |posAmt| < |qty|*0.9 pour distinguer exécution vs annulation accidentelle.
async function isTp1Executed(symbol, tp1AlgoId, posAmt, qty) {
  try {
    const res    = await signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol });
    const orders = res?.orders ?? [];
    const tp1Still = orders.some(o => String(o.algoId) === String(tp1AlgoId));
    if (!tp1Still && Math.abs(posAmt) < Math.abs(qty) * 0.9) return true;
  } catch {
    // fallback sur posAmt seul si l'API échoue
    if (Math.abs(posAmt) < Math.abs(qty) * 0.6) return true;
  }
  return false;
}

// Post-mortem : vérifie via allAlgoOrders si le TP1 a été exécuté.
// Utilisé quand posAmt=0 et beReached=false pour détecter la race condition 60s.
async function checkTp1InHistory(symbol, tp1AlgoId) {
  if (!tp1AlgoId) return false;
  try {
    const res    = await signedRequest('GET', '/fapi/v1/allAlgoOrders', { symbol, limit: 50 });
    const orders = res?.orders ?? [];
    const tp1    = orders.find(o => String(o.algoId) === String(tp1AlgoId));
    return tp1?.status === 'EXECUTED';
  } catch {
    return false;
  }
}

// Option B — TP1 50% + trailing server-side après TP1. Revue complète 3 LLMs.
export async function registerTrade(signal) {
  try {
    const { symbol, side, entry, sl, tp1, tp2, qty } = signal || {};
    if (!symbol || !side || entry === undefined) throw new Error('Signal invalide: symbol, side, entry requis');
    const dir       = String(side).toUpperCase();
    if (dir !== 'LONG' && dir !== 'SHORT') throw new Error(`side invalide: ${side}`);
    const closeSide = dir === 'LONG' ? 'SELL' : 'BUY';
    const { tickSize, stepSize } = await getSymbolFilters(symbol);
    const roundedSl  = roundToTick(sl,  tickSize);
    const roundedTp1 = roundToTick(tp1, tickSize);
    const roundedTp2 = roundToTick(tp2, tickSize);
    // qty_half arrondi au stepSize. qty_remaining = ce qui reste réellement après TP1 (peut != qty_half).
    const qty_half      = roundQtyToStep(qty / 2, stepSize);
    const qty_remaining = roundQtyToStep(qty - qty_half, stepSize);

    const slOrderId  = await placeStopOrder(symbol, roundedSl,  closeSide, 'STOP_MARKET',        qty);
    const tp1OrderId = await placeStopOrder(symbol, roundedTp1, closeSide, 'TAKE_PROFIT_MARKET', qty_half);

    if (!slOrderId)  console.error(`[position-manager] ⚠️ SL non placé pour ${symbol}`);
    if (!tp1OrderId) console.error(`[position-manager] ⚠️ TP1 non placé pour ${symbol}`);

    const tracked = {
      entry: Number(entry), sl: roundedSl, tp1: roundedTp1, tp2: roundedTp2,
      direction: dir, slOrderId, tp1OrderId, trailingOrderId: null,
      beReached: false, peakPrice: Number(entry), tickSize, stepSize,
      qty, qty_half, qty_remaining,
      earlyExitTicks: 0,
      openedAt:     new Date().toISOString(),
      scans:        signal.scans        ?? [],
      scan_count:   signal.scan_count   ?? null,
      ta_score:     signal.ta_score     ?? null,
      der_score:    signal.der_score    ?? null,
      total:        signal.total        ?? null,
      llm_decision: signal.llm_validation?.decision ?? null,
    };
    trackedPositions.set(symbol, tracked);
    savePositions(trackedPositions);
    console.log(`[position-manager] TRACK ${dir} ${symbol} entry=${entry} sl=${roundedSl} tp1=${roundedTp1} qty=${qty} half=${qty_half} remaining=${qty_remaining}`);
    return tracked;
  } catch (err) {
    console.error('[position-manager] registerTrade error:', err?.message);
    return null;
  }
}

// Sortie anticipée v2 — 11 signaux (flow + dérivés). Seuil ≥6 + 1 core. 2 ticks (PANIC = 1).
// Fail-open : timeout endpoint = score 0. earlyExitTicks muté dans pos, savePositions par l'appelant.
// Review cross-LLM (ChatGPT auteur, DeepSeek+Gemini reviewers, Claude arbitre) — corrections appliquées.
async function checkEarlyExit(symbol, pos) {
  if (!pos) return { exit: false, score: 0, signals: [] };
  const isLong = pos.direction === 'LONG';

  const MSB_MAX_AGE              = 5;
  const FUNDING_EXTREME_RATE     = 0.0008;   // 0.08% per 8h
  const BASIS_DISCOUNT_PCT       = -0.15;
  const BASIS_PREMIUM_PCT        = 0.15;
  const FUNDING_SPREAD_PCT       = 0.04;
  const FUNDING_SPREAD_EXTREME_PCT = 0.08;
  const BTC_CORR_MIN             = 0.70;
  const BTC_CORR_STRONG          = 0.85;

  let results;
  try {
    results = await Promise.allSettled([
      apiGet('perp-snapshot',           { symbol },                          8000),
      apiGet('oi-change',               { symbol, period: '15m', lookback: 2 }, 8000),
      apiGet('orderbook-imbalance',     { symbol },                          6000),
      apiGet('liquidations-summary',    { symbol },                          8000),
      apiGet('market-structure-breaks', { symbol },                          8000),
      apiGet('realized-volatility',     { symbol },                          8000),
      apiGet('funding-regime',          { symbol },                          8000),
      apiGet('spot-perp-basis',         { symbol },                          8000),
      apiGet('multi-exchange-funding',  { symbol },                          8000),
      apiGet('asset-correlations',      { symbol },                          8000),
      apiGet('market-structure-breaks', { symbol: 'BTCUSDT' },               8000),
    ]);
  } catch {
    return { exit: false, score: 0, signals: [] };
  }

  const v            = (r) => (r && r.status === 'fulfilled' ? r.value : null);
  const snap         = v(results[0]);
  const oi           = v(results[1]);
  const ob           = v(results[2]);
  const liq          = v(results[3]);
  const msb          = v(results[4]);
  const rv           = v(results[5]);
  const funding      = v(results[6]);
  const basis        = v(results[7]);
  const mexFunding   = v(results[8]);
  const corr         = v(results[9]);
  const btcMsb       = v(results[10]);

  const taker         = snap?.taker_buy_ratio ?? null;
  const oiChg         = oi?.oi_change_pct ?? null;
  const imb           = ob?.imbalance_ratio ?? null;
  const liqL          = Number(liq?.liq_long_usd ?? 0);
  const liqS          = Number(liq?.liq_short_usd ?? 0);
  const msbDir        = msb?.last_msb_direction ?? null;
  const msbAge        = msb?.last_msb_time ?? 999;
  const rvRegime      = rv?.rv_regime ?? 'NORMAL';
  const fundingRegime = funding?.regime ?? null;
  const avgRate8h     = funding?.avg_rate_8h ?? null;
  const basisPct      = basis?.basis_pct ?? null;
  const basisSignal   = basis?.signal ?? null;
  const spreadPct     = mexFunding?.spread_pct ?? null;
  const btcCorr1h     = corr?.btc_corr_1h ?? null;
  const btcMsbDir     = btcMsb?.last_msb_direction ?? null;
  const btcMsbAge     = btcMsb?.last_msb_time ?? 999;

  let score = 0;
  const signals = [];
  let hasCoreSignal = false;

  const addSignal = (condition, points, name, core = false) => {
    if (!condition) return;
    score += points;
    signals.push(name);
    if (core) hasCoreSignal = true;
  };

  const absVal              = (x) => Math.abs(Number(x));
  const hasExtremeFundingRate   = avgRate8h !== null && absVal(avgRate8h) >= FUNDING_EXTREME_RATE;
  const hasFundingSpread        = spreadPct !== null && absVal(spreadPct) >= FUNDING_SPREAD_PCT;
  const hasExtremeFundingSpread = spreadPct !== null && absVal(spreadPct) >= FUNDING_SPREAD_EXTREME_PCT;
  const btcBearishReversal  = btcMsbDir === 'bearish' && btcMsbAge < MSB_MAX_AGE;
  const btcBullishReversal  = btcMsbDir === 'bullish' && btcMsbAge < MSB_MAX_AGE;
  const btcRelevantCorr     = btcCorr1h !== null && btcCorr1h >= BTC_CORR_MIN;
  const btcStrongCorr       = btcCorr1h !== null && btcCorr1h >= BTC_CORR_STRONG;

  if (isLong) {
    addSignal(msbDir === 'bearish' && msbAge < MSB_MAX_AGE,                                           2, 'MSB_BEARISH', true);
    addSignal(taker !== null && taker <= 0.42,                                                        2, 'TAKER_SELL', true);
    addSignal(oiChg !== null && oiChg < -2.5,                                                         2, 'OI_UNWIND', true);
    addSignal(imb !== null && imb < -0.25,                                                            1, 'OB_SELL');
    addSignal(liqL > 0 && liqL > 2 * liqS,                                                           1, 'LONG_LIQ_CASCADE');
    addSignal(fundingRegime === 'EXTREME_LONG',                                                        1, 'FUNDING_EXTREME_LONG');
    addSignal(avgRate8h !== null && avgRate8h >= FUNDING_EXTREME_RATE,                                1, 'FUNDING_RATE_TOO_POSITIVE');
    addSignal(basisSignal === 'discount' || (basisPct !== null && basisPct <= BASIS_DISCOUNT_PCT),    1, 'BASIS_DISCOUNT');
    addSignal(hasFundingSpread,                                                  hasExtremeFundingSpread ? 2 : 1, 'FUNDING_SPREAD_DIVERGENCE');
    addSignal(btcRelevantCorr && btcBearishReversal,                             btcStrongCorr ? 2 : 1,          'BTC_CORR_BEARISH_REVERSAL');

    const isPanic = msbDir === 'bearish' && msbAge < MSB_MAX_AGE
      && taker !== null && taker <= 0.40
      && rvRegime === 'EXTREME'
      && (
        (oiChg !== null && oiChg < -3)
        || (liqL > 0 && liqL > 3 * liqS)
        || (fundingRegime === 'EXTREME_LONG' && hasExtremeFundingRate)
        || (basisSignal === 'discount' && basisPct !== null && basisPct <= BASIS_DISCOUNT_PCT)
        || (btcStrongCorr && btcBearishReversal)
      );
    if (isPanic) {
      pos.earlyExitTicks = 0;
      console.log(`[position-manager] PANIC_EXIT ${symbol} score=${score} signals=${signals.join('|')}`);
      return { exit: true, reason: 'EARLY_EXIT_PANIC', score, signals };
    }
  } else {
    addSignal(msbDir === 'bullish' && msbAge < MSB_MAX_AGE,                                           2, 'MSB_BULLISH', true);
    addSignal(taker !== null && taker >= 0.58,                                                        2, 'TAKER_BUY', true);
    addSignal(oiChg !== null && oiChg > 2.5,                                                          2, 'OI_BUILD', true);
    addSignal(imb !== null && imb > 0.25,                                                             1, 'OB_BUY');
    addSignal(liqS > 0 && liqS > 2 * liqL,                                                           1, 'SHORT_LIQ_CASCADE');
    addSignal(fundingRegime === 'EXTREME_SHORT',                                                       1, 'FUNDING_EXTREME_SHORT');
    addSignal(avgRate8h !== null && avgRate8h <= -FUNDING_EXTREME_RATE,                               1, 'FUNDING_RATE_TOO_NEGATIVE');
    addSignal(basisSignal === 'premium' || (basisPct !== null && basisPct >= BASIS_PREMIUM_PCT),      1, 'BASIS_PREMIUM');
    addSignal(hasFundingSpread,                                                  hasExtremeFundingSpread ? 2 : 1, 'FUNDING_SPREAD_DIVERGENCE');
    addSignal(btcRelevantCorr && btcBullishReversal,                             btcStrongCorr ? 2 : 1,          'BTC_CORR_BULLISH_REVERSAL');

    const isPanic = msbDir === 'bullish' && msbAge < MSB_MAX_AGE
      && taker !== null && taker >= 0.60
      && rvRegime === 'EXTREME'
      && (
        (oiChg !== null && oiChg > 3)
        || (liqS > 0 && liqS > 3 * liqL)
        || (fundingRegime === 'EXTREME_SHORT' && hasExtremeFundingRate)
        || (basisSignal === 'premium' && basisPct !== null && basisPct >= BASIS_PREMIUM_PCT)
        || (btcStrongCorr && btcBullishReversal)
      );
    if (isPanic) {
      pos.earlyExitTicks = 0;
      console.log(`[position-manager] PANIC_EXIT ${symbol} score=${score} signals=${signals.join('|')}`);
      return { exit: true, reason: 'EARLY_EXIT_PANIC', score, signals };
    }
  }

  if (score >= EARLY_EXIT_THRESHOLD && hasCoreSignal) {
    pos.earlyExitTicks = (pos.earlyExitTicks || 0) + 1;
    console.log(`[position-manager] early_exit_check ${symbol} score=${score} tick=${pos.earlyExitTicks}/${EARLY_EXIT_TICKS_NEEDED} signals=${signals.join('|')}`);
    if (pos.earlyExitTicks >= EARLY_EXIT_TICKS_NEEDED) {
      pos.earlyExitTicks = 0;
      return { exit: true, reason: 'EARLY_EXIT', score, signals };
    }
  } else if ((pos.earlyExitTicks || 0) > 0) {
    pos.earlyExitTicks = 0;
    console.log(`[position-manager] early_exit_reset ${symbol} score=${score}`);
  }

  return { exit: false, score, signals };
}

let pollPositionsRunning = false;

async function pollPositions() {
  if (pollPositionsRunning) return;
  if (trackedPositions.size === 0) return;
  pollPositionsRunning = true;
  try {
  let positionRisk;
  try {
    positionRisk = await signedRequest('GET', '/fapi/v2/positionRisk');
  } catch (err) {
    console.error('[position-manager] positionRisk error:', err?.message);
    return;
  }
  if (!Array.isArray(positionRisk)) {
    console.error('[position-manager] positionRisk: réponse invalide');
    return;
  }

  for (const [symbol, pos] of trackedPositions.entries()) {
    try {
      const binancePos = positionRisk.find(r => r.symbol === symbol);
      if (!binancePos) { console.error(`[position-manager] positionRisk introuvable: ${symbol}`); continue; }
      const posAmt = Number(binancePos.positionAmt);

      // ── Position entièrement fermée ──────────────────────────────────────────
      if (!Number.isFinite(posAmt) || posAmt === 0) {
        await cancelAllAlgoOrders(symbol);   // obligatoire — les algo orders ne s'annulent pas seuls

        const exitPrice = Number(binancePos.breakEvenPrice) || pos.sl || pos.entry;
        const isLong    = pos.direction === 'LONG';

        // Race condition 60s : TP1 + trailing dans la même fenêtre → posAmt=0 vu avant beReached=true.
        // Post-mortem via allAlgoOrders pour reconstruire le bon exit_reason.
        let beReachedFinal = pos.beReached;
        if (!pos.beReached && pos.tp1OrderId) {
          beReachedFinal = await checkTp1InHistory(symbol, pos.tp1OrderId);
          if (beReachedFinal) {
            console.log(`[position-manager] RACE_CONDITION ${symbol} — TP1+trailing dans même fenêtre, exit reclassifié`);
          }
        }

        let rawPnl;
        if (beReachedFinal) {
          // PnL cumulatif : TP1 sur qty_half + exit final sur qty_remaining
          const tp1Pnl  = isLong ? (pos.tp1   - pos.entry) * pos.qty_half      : (pos.entry - pos.tp1)    * pos.qty_half;
          const exitPnl = isLong ? (exitPrice - pos.entry) * pos.qty_remaining  : (pos.entry - exitPrice)  * pos.qty_remaining;
          rawPnl = tp1Pnl + exitPnl;
        } else {
          rawPnl = isLong ? (exitPrice - pos.entry) * pos.qty : (pos.entry - exitPrice) * pos.qty;
        }
        const atBreakeven = Math.abs(exitPrice - pos.entry) <= pos.tickSize * 3;
        const exitReason  = !beReachedFinal ? 'SL' : atBreakeven ? 'BREAKEVEN' : 'TRAIL';
        const notional    = pos.entry * pos.qty;
        logTrade({
          symbol,
          direction:   pos.direction,
          entry_price: pos.entry,
          exit_price:  exitPrice,
          qty:         pos.qty,
          pnl_usdt:    rawPnl,
          pnl_pct:     notional > 0 ? (rawPnl / notional) * 100 : null,
          roe_pct:     notional > 0 ? (rawPnl / (notional / LEVERAGE)) * 100 : null,
          opened_at:   pos.openedAt ?? null,
          closed_at:   new Date().toISOString(),
          exit_reason: exitReason,
          be_reached:  beReachedFinal,
          peak_price:  pos.peakPrice,
          scans:       pos.scans ?? [],
          scan_count:  pos.scan_count ?? null,
          ta_score:    pos.ta_score ?? null,
          der_score:   pos.der_score ?? null,
          total:       pos.total ?? null,
          llm_decision: pos.llm_decision ?? null,
        }).catch(() => {});
        // P0.4 — Circuit breaker
        if (Number.isFinite(rawPnl)) {
          const cbResult = recordClosedTrade(rawPnl);
          if (cbResult.tripped) {
            sendTelegram(`🚨 <b>Circuit Breaker déclenché</b>\n\n${cbResult.reason}\n\nBot en pause automatique.\nUtilisez /resetcb puis /resume pour reprendre.`).catch(() => {});
          }
        } else {
          console.error(`[position-manager] rawPnl invalide pour CB ${symbol}: ${rawPnl}`);
        }
        // P0t.8 — close lifecycle notification (fail-open)
        if (Number.isFinite(rawPnl)) {
          const _reasonLabel = { SL: 'Stop Loss', BREAKEVEN: 'Breakeven', TRAIL: 'Trailing Stop' }[exitReason] ?? exitReason;
          const _pnlLabel    = rawPnl >= 0 ? `+${rawPnl.toFixed(2)}` : rawPnl.toFixed(2);
          const _gainPct     = notional > 0 ? rawPnl / notional * 100 : null;
          const _gainStr     = _gainPct != null ? ` <i>(${_gainPct >= 0 ? '+' : ''}${_gainPct.toFixed(2)}%)</i>` : '';
          sendTelegram([
            `${exitReason === 'SL' ? '🔴' : '🏁'} <b>Position ${exitReason === 'SL' ? 'stoppée' : 'fermée'}</b> — <code>${symbol}</code>`,
            `📈 <b>${pos.direction}</b> | Entrée <code>${fmt(pos.entry)}</code> → Sortie <code>${fmt(exitPrice)}</code>`,
            `🎯 Sortie par : <b>${_reasonLabel}</b>`,
            `💵 PnL réalisé : <b>${_pnlLabel} USDT</b>${_gainStr}`,
          ].join('\n')).catch(err => console.error(`[Telegram] close notify ${symbol}:`, err.message));
        }
        trackedPositions.delete(symbol);
        savePositions(trackedPositions);
        console.log(`[position-manager] CLOSED ${symbol} → ${exitReason} pnl=${rawPnl?.toFixed(2)} USDT`);
        continue;
      }

      // ── Détection TP1 exécuté ───────────────────────────────────────────────
      // Vérifie via openAlgoOrders si l'algoId TP1 a disparu + posAmt réduit.
      if (!pos.beReached && await isTp1Executed(symbol, pos.tp1OrderId, posAmt, pos.qty)) {
        const isLong    = pos.direction === 'LONG';
        const closeSide = isLong ? 'SELL' : 'BUY';

        // Annuler SL initial (qty totale) et recréer au breakeven sur qty_remaining.
        // Buffer ±2 ticks pour éviter -2021 "Order would immediately trigger" (consensus 3 LLMs).
        await cancelAlgoOrder(pos.slOrderId);
        const bePrice = isLong
          ? roundToTick(pos.entry - pos.tickSize * 2, pos.tickSize)
          : roundToTick(pos.entry + pos.tickSize * 2, pos.tickSize);
        const newSlId = await placeStopOrder(symbol, bePrice, closeSide, 'STOP_MARKET', pos.qty_remaining);
        pos.sl        = bePrice;
        pos.slOrderId = newSlId;

        // Trailing sur qty_remaining — markPrice récupéré en avance pour callbackRate ATR + peakPrice
        let markPriceForTrailing = null;
        try {
          const idx = await publicRequest('/fapi/v1/premiumIndex', { symbol });
          markPriceForTrailing = Number(idx?.markPrice) || null;
          pos.peakPrice = markPriceForTrailing || pos.tp1;
        } catch { pos.peakPrice = pos.tp1; }
        pos.trailingOrderId = await placeTrailingOrder(symbol, closeSide, pos.qty_remaining, markPriceForTrailing);
        pos.beReached = true;

        savePositions(trackedPositions);
        console.log(`[position-manager] TP1_HIT ${symbol} — BE=${bePrice} trailing=${pos.trailingOrderId} remaining=${pos.qty_remaining}`);
        // P0t.8 — TP1 lifecycle notification (fail-open, after SL moved)
        sendTelegram([
          `🎯 <b>TP1 atteint</b> — <code>${symbol}</code>`,
          `📈 <b>${pos.direction}</b> | Entrée <code>${fmt(pos.entry)}</code>`,
          `💰 TP1 touché : <code>${fmt(pos.tp1)}</code>`,
          `🛡️ Stop sécurisé au breakeven : <code>${fmt(bePrice)}</code>`,
          `🔁 Trailing actif sur le reste de la position`,
        ].join('\n')).catch(err => console.error(`[Telegram] TP1 notify ${symbol}:`, err.message));
      }

      // ── Early exit sur les qty_remaining restantes ──────────────────────────
      if (pos.beReached) {
        const earlyCheck = await checkEarlyExit(symbol, pos);
        if (!earlyCheck.exit) {
          savePositions(trackedPositions); // persiste earlyExitTicks (spec contrainte #4)
        }
        if (earlyCheck.exit) {
          let markPrice = pos.peakPrice;
          try {
            const idx = await publicRequest('/fapi/v1/premiumIndex', { symbol });
            markPrice = Number(idx?.markPrice) || pos.peakPrice;
          } catch { /* keep peakPrice */ }

          const isLong    = pos.direction === 'LONG';
          const closeSide = isLong ? 'SELL' : 'BUY';
          try {
            await signedRequest('POST', '/fapi/v1/order', {
              symbol, side: closeSide, type: 'MARKET',
              quantity: pos.qty_remaining, reduceOnly: true,
            });
            await Promise.allSettled([
              cancelAlgoOrder(pos.slOrderId),
              cancelAlgoOrder(pos.trailingOrderId),
            ]);
            const tp1Pnl  = isLong ? (pos.tp1   - pos.entry) * pos.qty_half     : (pos.entry - pos.tp1)    * pos.qty_half;
            const exitPnl = isLong ? (markPrice  - pos.entry) * pos.qty_remaining : (pos.entry - markPrice)  * pos.qty_remaining;
            const rawPnl  = tp1Pnl + exitPnl;
            const notional = pos.entry * pos.qty;
            logTrade({
              symbol,
              direction:          pos.direction,
              entry_price:        pos.entry,
              exit_price:         markPrice,
              qty:                pos.qty,
              pnl_usdt:           rawPnl,
              pnl_pct:            notional > 0 ? (rawPnl / notional) * 100 : null,
              roe_pct:            notional > 0 ? (rawPnl / (notional / LEVERAGE)) * 100 : null,
              opened_at:          pos.openedAt ?? null,
              closed_at:          new Date().toISOString(),
              exit_reason:        earlyCheck.reason,
              be_reached:         pos.beReached,
              peak_price:         pos.peakPrice,
              early_exit_signals: earlyCheck.signals,
              scans:              pos.scans ?? [],
              scan_count:         pos.scan_count ?? null,
              ta_score:           pos.ta_score ?? null,
              der_score:          pos.der_score ?? null,
              total:              pos.total ?? null,
              llm_decision:       pos.llm_decision ?? null,
            }).catch(() => {});
            // P0t.8 — early exit lifecycle notification (fail-open)
            if (Number.isFinite(rawPnl)) {
              const _isPanic  = earlyCheck.reason === 'EARLY_EXIT_PANIC';
              const _title    = _isPanic ? '🚨 Sortie panique' : '⚠️ Early Exit';
              const _pnlLabel = rawPnl >= 0 ? `+${rawPnl.toFixed(2)}` : rawPnl.toFixed(2);
              const _gainPct  = notional > 0 ? rawPnl / notional * 100 : null;
              const _gainStr  = _gainPct != null ? ` <i>(${_gainPct >= 0 ? '+' : ''}${_gainPct.toFixed(2)}%)</i>` : '';
              const _signals  = earlyCheck.signals?.join(', ') || 'N/A';
              sendTelegram([
                `${_title} — <code>${symbol}</code>`,
                `📈 <b>${pos.direction}</b> | Entrée <code>${fmt(pos.entry)}</code> → Sortie <code>${fmt(markPrice)}</code>`,
                `💵 PnL réalisé : <b>${_pnlLabel} USDT</b>${_gainStr}`,
                `📡 Signaux : <i>${_signals}</i>`,
              ].join('\n')).catch(err => console.error(`[Telegram] early exit notify ${symbol}:`, err.message));
            }
            trackedPositions.delete(symbol);
            savePositions(trackedPositions);
            console.log(`[position-manager] EARLY_EXIT ${symbol} @ ${markPrice} (${earlyCheck.reason}) pnl=${rawPnl?.toFixed(2)} USDT`);
          } catch (err) {
            console.error(`[position-manager] early exit MARKET failed ${symbol}:`, err.message);
            savePositions(trackedPositions); // persiste earlyExitTicks même si l'ordre échoue
          }
          continue;
        }
      }
    } catch (err) {
      console.error(`[position-manager] poll error ${symbol}:`, err?.message);
    }
  }
  } finally {
    pollPositionsRunning = false;
  }
}

export function getTrackedPositions() {
  return [...trackedPositions.entries()].map(([symbol, pos]) => ({ symbol, ...pos }));
}

// Fermeture forcée : cancel ordres conditionnels + classiques → MARKET → log → cleanup
export async function forceClosePosition(symbol) {
  try {
    await cancelAllAlgoOrders(symbol);
    try { await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }); } catch { /* ignore */ }

    const posRisk = await signedRequest('GET', '/fapi/v2/positionRisk', { symbol });
    const binPos  = Array.isArray(posRisk) ? posRisk.find(p => p.symbol === symbol) : null;
    const posAmt  = Number(binPos?.positionAmt ?? 0);

    if (!Number.isFinite(posAmt) || posAmt === 0) {
      console.log(`[position-manager] forceClose ${symbol}: déjà fermée (posAmt=0)`);
      trackedPositions.delete(symbol);
      savePositions(trackedPositions);
      return { success: true, posAmt: 0 };
    }

    const closeSide = posAmt > 0 ? 'SELL' : 'BUY';
    const rawQty    = Math.abs(posAmt);
    const pos       = trackedPositions.get(symbol);
    const qty       = pos?.stepSize ? roundQtyToStep(rawQty, pos.stepSize) : rawQty;
    const order     = await signedRequest('POST', '/fapi/v1/order', {
      symbol, side: closeSide, type: 'MARKET', quantity: qty, reduceOnly: true,
    });

    if (pos) {
      const exitPrice = Number(binPos?.markPrice) || pos.entry;
      const isLong    = posAmt > 0;
      const rawPnl    = isLong ? (exitPrice - pos.entry) * qty : (pos.entry - exitPrice) * qty;
      const notional  = pos.entry * qty;
      logTrade({
        symbol,
        direction:   isLong ? 'LONG' : 'SHORT',
        entry_price: pos.entry,
        exit_price:  exitPrice,
        qty,
        pnl_usdt:    rawPnl,
        pnl_pct:     notional > 0 ? (rawPnl / notional) * 100 : null,
        roe_pct:     notional > 0 ? (rawPnl / (notional / LEVERAGE)) * 100 : null,
        opened_at:   pos.openedAt ?? null,
        closed_at:   new Date().toISOString(),
        exit_reason: 'FORCED_CLOSE',
        be_reached:  pos.beReached ?? false,
        peak_price:  pos.peakPrice ?? pos.entry,
      }).catch(() => {});
    }

    trackedPositions.delete(symbol);
    savePositions(trackedPositions);
    console.log(`[position-manager] FORCE_CLOSE ${symbol} qty=${qty} orderId=${order?.orderId}`);
    return { success: true, orderId: order?.orderId, qty };
  } catch (err) {
    console.error(`[position-manager] forceClose error ${symbol}:`, err.message);
    return { success: false, error: err.message };
  }
}

async function sendOrphanAlert(orphans) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || orphans.length === 0) return;
  const lines = orphans.map(p => {
    let line = `• ${p.symbol} | ${p.direction} | Qty: ${p.qty}`;
    if (p.entryPrice) line += ` | Entry: ${p.entryPrice}`;
    if (p.pnl != null) line += ` | PnL: ${Number(p.pnl).toFixed(2)} USDT`;
    return line;
  });
  const text = `⚠️ ${orphans.length} position(s) orpheline(s) détectée(s) au démarrage\n\n${lines.join('\n')}\n\nCes positions n'ont pas été ouvertes par le bot — gère-les manuellement sur Binance.`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn('[position-manager] sendOrphanAlert failed:', err?.message || err);
  }
}

// Réconciliation au démarrage — charge le store JSON + compare Binance
// Cas A: Map + Binance → OK (position suivie normalement)
// Cas B: Binance seul (orphelin) → warn log + alerte Telegram, le bot ne touche pas à la position
// Cas C: Map seul sans position Binance → marquer CLOSED + logTrade + supprimer
export async function bootReconcile() {
  console.log('[position-manager] bootReconcile — démarrage réconciliation...');
  let positionRisk;
  try {
    positionRisk = await signedRequest('GET', '/fapi/v2/positionRisk');
  } catch (err) {
    console.error('[position-manager] bootReconcile: impossible de lire positionRisk:', err.message);
    return;
  }
  if (!Array.isArray(positionRisk)) return;

  const binanceActive = new Map(
    positionRisk
      .filter(p => Number(p.positionAmt) !== 0)
      .map(p => [p.symbol, p])
  );

  // Cas C — dans Map local mais plus chez Binance → position fermée sans qu'on le sache
  for (const [symbol, pos] of trackedPositions.entries()) {
    if (!binanceActive.has(symbol)) {
      console.warn(`[position-manager] bootReconcile CAS-C ${symbol}: dans store mais absent Binance → CLOSED`);
      logTrade({
        symbol,
        direction:   pos.direction,
        entry_price: pos.entry,
        exit_price:  pos.entry,
        qty:         pos.qty,
        pnl_usdt:    0,
        pnl_pct:     0,
        roe_pct:     0,
        opened_at:   pos.openedAt ?? null,
        closed_at:   new Date().toISOString(),
        exit_reason: 'CLOSED_EXTERNALLY',
        be_reached:  pos.beReached ?? false,
        peak_price:  pos.peakPrice ?? pos.entry,
      }).catch(() => {});
      trackedPositions.delete(symbol);
    }
  }

  // Cas B — chez Binance mais pas dans Map → alerte unique groupée, le bot ne touche pas aux positions
  const orphans = [];
  for (const [symbol, binPos] of binanceActive.entries()) {
    if (!trackedPositions.has(symbol)) {
      const posAmt = Number(binPos.positionAmt);
      if (!Number.isFinite(posAmt) || posAmt === 0) {
        console.warn(`[position-manager] bootReconcile CAS-B ${symbol}: positionAmt invalide (${binPos.positionAmt}) — ignoré`);
        continue;
      }
      const direction = posAmt > 0 ? 'LONG' : 'SHORT';
      const rawQty    = Math.abs(posAmt);
      console.warn(`[position-manager] bootReconcile CAS-B ${symbol}: position orpheline ${direction} qty=${rawQty} — non gérée par le bot`);
      orphans.push({ symbol, direction, qty: rawQty, entryPrice: binPos.entryPrice, pnl: binPos.unRealizedProfit });
    }
  }
  if (orphans.length > 0) {
    sendOrphanAlert(orphans).catch(err =>
      console.warn('[position-manager] sendOrphanAlert trigger failed:', err?.message || err));
  }

  savePositions(trackedPositions);
  console.log(`[position-manager] bootReconcile terminé — ${trackedPositions.size} position(s) active(s)`);
}

export async function reconcilePositions() {
  try {
    const positionRisk = await signedRequest('GET', '/fapi/v2/positionRisk');
    if (!Array.isArray(positionRisk)) throw new Error('positionRisk: réponse non-array');
    const binancePositions = positionRisk
      .filter(p => Number(p.positionAmt) !== 0)
      .map(p => ({
        symbol:          p.symbol,
        qty:             Math.abs(Number(p.positionAmt)),
        direction:       Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        entryPrice:      Number(p.entryPrice),
        markPrice:       Number(p.markPrice),
        unrealizedProfit: Number(p.unRealizedProfit),
      }));
    const botPositions = Array.from(trackedPositions.entries())
      .map(([sym, p]) => ({ symbol: sym, qty: Number(p.qty ?? 0), direction: String(p.direction ?? '').toUpperCase() }))
      .filter(p => p.qty !== 0);
    const binanceBySymbol = new Map(binancePositions.map(p => [p.symbol, p]));
    const botBySymbol     = new Map(botPositions.map(p => [p.symbol, p]));
    const botOnly     = botPositions.filter(p => !binanceBySymbol.has(p.symbol))
      .map(p => ({ symbol: p.symbol, botQty: p.qty, botDirection: p.direction }));
    const binanceOnly = binancePositions.filter(p => !botBySymbol.has(p.symbol))
      .map(p => ({ symbol: p.symbol, binanceQty: p.qty, binanceDirection: p.direction }));
    const mismatch = [];
    for (const [symbol, botPos] of botBySymbol.entries()) {
      const binPos = binanceBySymbol.get(symbol);
      if (!binPos) continue;
      const qtyMismatch = Math.abs(botPos.qty - binPos.qty) > 0.001;
      const dirMismatch = botPos.direction !== binPos.direction;
      if (qtyMismatch || dirMismatch) {
        mismatch.push({ symbol, botQty: botPos.qty, binanceQty: binPos.qty, botDirection: botPos.direction, binanceDirection: binPos.direction });
      }
    }
    return { ok: botOnly.length === 0 && binanceOnly.length === 0 && mismatch.length === 0, botOnly, binanceOnly, mismatch, binancePositions, botPositions };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Vérifie que le bot est stable (aucune position locale ni Binance, aucun ordre ouvert)
export async function checkStability() {
  if (trackedPositions.size > 0) {
    const symbols = [...trackedPositions.keys()].join(', ');
    return { ok: false, reason: `${trackedPositions.size} position(s) dans le store local (${symbols})` };
  }
  try {
    const positionRisk = await signedRequest('GET', '/fapi/v2/positionRisk');
    if (!Array.isArray(positionRisk)) throw new Error('positionRisk: réponse non-array');
    const active = positionRisk.filter(p => Number(p.positionAmt) !== 0);
    if (active.length > 0) {
      const symbols = active.map(p => p.symbol).join(', ');
      return { ok: false, reason: `${active.length} position(s) active(s) sur Binance (${symbols})` };
    }
  } catch (err) {
    return { ok: false, reason: `Impossible de vérifier positionRisk: ${err.message}` };
  }
  try {
    const openOrders = await signedRequest('GET', '/fapi/v1/openOrders');
    if (!Array.isArray(openOrders)) throw new Error('openOrders: réponse non-array');
    if (openOrders.length > 0) {
      return { ok: false, reason: `${openOrders.length} ordre(s) ouvert(s) sur Binance` };
    }
  } catch (err) {
    return { ok: false, reason: `Impossible de vérifier openOrders: ${err.message}` };
  }
  return { ok: true };
}

// ─── Feature 2 — WebSocket User Data Stream ──────────────────────────────────
let userDataWs = null;
let userDataListenKey = null;
let userDataKeepAliveTimer = null;
let userDataReconnectTimer = null;
let userDataReconnectAttempts = 0;
let userDataStreamStopping = false;
const wsPollDebounceBySymbol = new Map();
const wsPollInFlightBySymbol = new Set();

function getUserDataWsUrl(listenKey) {
  const base = isTestnet ? 'wss://stream.binancefuture.com/ws' : 'wss://fstream.binance.com/ws';
  return `${base}/${listenKey}`;
}

async function createListenKey() {
  const r = await signedRequest('POST', '/fapi/v1/listenKey', {});
  return r?.listenKey ?? null;
}

async function keepAliveListenKey() {
  if (!userDataListenKey) return;
  try { await signedRequest('PUT', '/fapi/v1/listenKey', { listenKey: userDataListenKey }); }
  catch (err) { console.error('[position-manager] listenKey keepalive error:', err?.message); }
}

async function closeListenKey() {
  if (!userDataListenKey) return;
  try { await signedRequest('DELETE', '/fapi/v1/listenKey', { listenKey: userDataListenKey }); }
  catch (err) { console.error('[position-manager] listenKey close error:', err?.message); }
}

function clearUserDataTimers() {
  if (userDataKeepAliveTimer) { clearInterval(userDataKeepAliveTimer); userDataKeepAliveTimer = null; }
  if (userDataReconnectTimer) { clearTimeout(userDataReconnectTimer); userDataReconnectTimer = null; }
  for (const timer of wsPollDebounceBySymbol.values()) clearTimeout(timer);
  wsPollDebounceBySymbol.clear();
  wsPollInFlightBySymbol.clear();
}

function scheduleUserDataReconnect() {
  if (userDataStreamStopping) return;
  const delay = Math.min(USER_DATA_BASE_BACKOFF_MS * 2 ** Math.min(userDataReconnectAttempts, 5), USER_DATA_MAX_BACKOFF_MS);
  userDataReconnectAttempts += 1;
  if (userDataReconnectAttempts % 5 === 1) {
    console.warn(`[position-manager] userDataStream reconnect attempt ${userDataReconnectAttempts} in ${delay}ms`);
  }
  userDataReconnectTimer = setTimeout(() => {
    userDataReconnectTimer = null;
    connectUserDataWebSocket().catch((err) => {
      console.error('[position-manager] userDataStream reconnect error:', err?.message);
      scheduleUserDataReconnect();
    });
  }, delay);
}

function scheduleWsTriggeredPoll(symbol) {
  if (!trackedPositions?.has?.(symbol)) return;
  if (wsPollInFlightBySymbol.has(symbol)) return;
  if (wsPollDebounceBySymbol.has(symbol)) return;
  const timer = setTimeout(async () => {
    wsPollDebounceBySymbol.delete(symbol);
    if (!trackedPositions?.has?.(symbol)) return;
    if (wsPollInFlightBySymbol.has(symbol)) return;
    wsPollInFlightBySymbol.add(symbol);
    try { await pollPositions(); }
    catch (err) { console.error(`[position-manager] ws-triggered poll error ${symbol}:`, err?.message); }
    finally { wsPollInFlightBySymbol.delete(symbol); }
  }, WS_DEBOUNCE_MS);
  wsPollDebounceBySymbol.set(symbol, timer);
}

function handleUserDataMessage(rawMessage) {
  let event;
  try { event = JSON.parse(rawMessage.toString()); } catch { return; }
  if (event?.e === 'ACCOUNT_UPDATE') {
    for (const p of (event?.a?.P ?? [])) {
      if (p?.s && trackedPositions?.has?.(p.s)) scheduleWsTriggeredPoll(p.s);
    }
    return;
  }
  if (event?.e !== 'ORDER_TRADE_UPDATE') return;
  const symbol = event?.o?.s;
  const status = event?.o?.X;
  if (!symbol || !trackedPositions?.has?.(symbol)) return;
  if (status === 'FILLED' || status === 'CANCELED' || status === 'EXPIRED') scheduleWsTriggeredPoll(symbol);
}

async function connectUserDataWebSocket() {
  if (userDataStreamStopping) return;
  if (!userDataListenKey) {
    userDataListenKey = await createListenKey();
    if (!userDataListenKey) throw new Error('listenKey creation returned empty response');
  }
  if (!userDataKeepAliveTimer) {
    userDataKeepAliveTimer = setInterval(keepAliveListenKey, USER_DATA_KEEPALIVE_MS);
  }
  const wsUrl = getUserDataWsUrl(userDataListenKey);
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (err) { throw new Error(`WebSocket construction failed: ${err?.message}`); }
  userDataWs = ws;
  userDataWs.on('open', () => {
    userDataReconnectAttempts = 0;
    console.log('[position-manager] userDataStream connected');
  });
  userDataWs.on('message', handleUserDataMessage);
  userDataWs.on('error', (err) => { console.error('[position-manager] userDataStream error:', err?.message); });
  userDataWs.on('close', () => {
    if (userDataStreamStopping) return;
    userDataWs = null;
    userDataListenKey = null;
    if (userDataKeepAliveTimer) { clearInterval(userDataKeepAliveTimer); userDataKeepAliveTimer = null; }
    scheduleUserDataReconnect();
  });
}

export async function startUserDataStream() {
  if (userDataWs || userDataReconnectTimer) return;
  userDataStreamStopping = false;
  userDataReconnectAttempts = 0;
  try { await connectUserDataWebSocket(); }
  catch (err) {
    console.error('[position-manager] userDataStream start error:', err?.message);
    scheduleUserDataReconnect();
  }
}

export async function stopUserDataStream() {
  userDataStreamStopping = true;
  clearUserDataTimers();
  if (userDataWs) {
    try { userDataWs.removeAllListeners(); userDataWs.close(); }
    catch { try { userDataWs.terminate(); } catch {} }
    finally { userDataWs = null; }
  }
  await closeListenKey();
  userDataListenKey = null;
  userDataReconnectAttempts = 0;
}

export function startPositionManager() {
  if (intervalHandle) return intervalHandle;
  console.log('[position-manager] Démarré (polling 60s)');
  intervalHandle = setInterval(() => {
    pollPositions().catch(err => console.error('[position-manager] interval error:', err?.message));
  }, POLL_MS);
  return intervalHandle;
}
