import { createHmac } from 'crypto';
import { logTrade } from './trade-journal.js';
import { apiGet } from './perp-client.js';

const POLL_MS   = 60_000;
const TRAIL_PCT = 0.015;
const LEVERAGE  = 20;
const EARLY_EXIT_THRESHOLD    = 5;
const EARLY_EXIT_TICKS_NEEDED = 2;

const isTestnet  = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
const BASE_URL   = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
const API_KEY    = isTestnet ? process.env.BINANCE_TESTNET_API_KEY    : process.env.BINANCE_API_KEY;
const API_SECRET = isTestnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET;

const trackedPositions = new Map();
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

// Trailing server-side sans activationPrice (évite bug Binance déc-2025, consensus DeepSeek+ChatGPT).
// Placé après détection TP1 — s'active au prix courant.
async function placeTrailingOrder(symbol, side, quantity) {
  try {
    const order = await signedRequest('POST', '/fapi/v1/algoOrder', {
      algoType:     'CONDITIONAL',
      symbol,
      side,
      type:         'TRAILING_STOP_MARKET',
      callbackRate: TRAIL_PCT * 100,
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
    console.log(`[position-manager] TRACK ${dir} ${symbol} entry=${entry} sl=${roundedSl} tp1=${roundedTp1} qty=${qty} half=${qty_half} remaining=${qty_remaining}`);
    return tracked;
  } catch (err) {
    console.error('[position-manager] registerTrade error:', err?.message);
    return null;
  }
}

// Sortie anticipée — consensus 3 LLMs. Score 0-9 : MSB+2, taker+2, OI_15m+2, OB+1, liq+1.
// Seuil ≥5 + 1 core signal. 2 ticks consécutifs (PANIC = 1 tick).
async function checkEarlyExit(symbol, pos) {
  const isLong = pos.direction === 'LONG';

  let results;
  try {
    results = await Promise.allSettled([
      apiGet('perp-snapshot',           { symbol },                        8000),
      apiGet('oi-change',               { symbol, period: '15m', lookback: 2 }, 8000),
      apiGet('orderbook-imbalance',     { symbol },                        6000),
      apiGet('liquidations-summary',    { symbol },                        8000),
      apiGet('market-structure-breaks', { symbol },                        8000),
      apiGet('realized-volatility',     { symbol },                        8000),
    ]);
  } catch { return { exit: false }; }

  const v    = (r) => r.status === 'fulfilled' ? r.value : null;
  const snap = v(results[0]);
  const oi   = v(results[1]);
  const ob   = v(results[2]);
  const liq  = v(results[3]);
  const msb  = v(results[4]);
  const rv   = v(results[5]);

  const taker    = snap?.taker_buy_ratio ?? null;
  const oiChg    = oi?.oi_change_pct ?? null;
  const imb      = ob?.imbalance_ratio ?? null;
  const liqL     = liq?.liq_long_usd ?? 0;
  const liqS     = liq?.liq_short_usd ?? 0;
  const msbDir   = msb?.last_msb_direction ?? null;
  const msbAge   = msb?.last_msb_time ?? 999;
  const rvRegime = rv?.rv_regime ?? 'NORMAL';

  let score = 0;
  const signals = [];
  let hasCoreSignal = false;

  if (isLong) {
    if (msbDir === 'bearish' && msbAge < 5)     { score += 2; signals.push('MSB_BEARISH'); hasCoreSignal = true; }
    if (taker !== null && taker <= 0.42)         { score += 2; signals.push(`TAKER_SELL(${taker.toFixed(2)})`); hasCoreSignal = true; }
    if (oiChg !== null && oiChg < -2.5)         { score += 2; signals.push(`OI_UNWIND(${oiChg.toFixed(1)}%)`); hasCoreSignal = true; }
    if (imb !== null && imb < -0.25)            { score += 1; signals.push(`OB_SELL(${imb.toFixed(2)})`); }
    if (liqL > 0 && liqL > 2 * liqS)           { score += 1; signals.push(`LIQ_CASCADE(${(liqL / 1000).toFixed(0)}K)`); }
    const isPanic = msbDir === 'bearish' && msbAge < 5
      && taker !== null && taker <= 0.40
      && rvRegime === 'EXTREME'
      && ((oiChg !== null && oiChg < -3) || (liqL > 0 && liqL > 3 * liqS));
    if (isPanic) {
      pos.earlyExitTicks = 0;
      console.log(`[position-manager] PANIC_EXIT ${symbol}`);
      return { exit: true, reason: 'EARLY_EXIT_PANIC', signals };
    }
  } else {
    if (msbDir === 'bullish' && msbAge < 5)     { score += 2; signals.push('MSB_BULLISH'); hasCoreSignal = true; }
    if (taker !== null && taker >= 0.58)         { score += 2; signals.push(`TAKER_BUY(${taker.toFixed(2)})`); hasCoreSignal = true; }
    if (oiChg !== null && oiChg > 2.5)          { score += 2; signals.push(`OI_BUILD(${oiChg.toFixed(1)}%)`); hasCoreSignal = true; }
    if (imb !== null && imb > 0.25)             { score += 1; signals.push(`OB_BUY(${imb.toFixed(2)})`); }
    if (liqS > 0 && liqS > 2 * liqL)           { score += 1; signals.push(`LIQ_CASCADE(${(liqS / 1000).toFixed(0)}K)`); }
    const isPanic = msbDir === 'bullish' && msbAge < 5
      && taker !== null && taker >= 0.60
      && rvRegime === 'EXTREME'
      && ((oiChg !== null && oiChg > 3) || (liqS > 0 && liqS > 3 * liqL));
    if (isPanic) {
      pos.earlyExitTicks = 0;
      console.log(`[position-manager] PANIC_EXIT ${symbol}`);
      return { exit: true, reason: 'EARLY_EXIT_PANIC', signals };
    }
  }

  if (score >= EARLY_EXIT_THRESHOLD && hasCoreSignal) {
    pos.earlyExitTicks = (pos.earlyExitTicks || 0) + 1;
    console.log(`[position-manager] early_exit_check ${symbol} score=${score}/9 tick=${pos.earlyExitTicks}/${EARLY_EXIT_TICKS_NEEDED} signals=${signals.join('|')}`);
    if (pos.earlyExitTicks >= EARLY_EXIT_TICKS_NEEDED) {
      pos.earlyExitTicks = 0;
      return { exit: true, reason: 'EARLY_EXIT', signals };
    }
  } else if ((pos.earlyExitTicks || 0) > 0) {
    pos.earlyExitTicks = 0;
    console.log(`[position-manager] early_exit_reset ${symbol} score=${score}/9`);
  }

  return { exit: false };
}

async function pollPositions() {
  if (trackedPositions.size === 0) return;
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
        let rawPnl;
        if (pos.beReached) {
          // PnL cumulatif : TP1 sur qty_half + exit final sur qty_remaining
          const tp1Pnl  = isLong ? (pos.tp1   - pos.entry) * pos.qty_half      : (pos.entry - pos.tp1)    * pos.qty_half;
          const exitPnl = isLong ? (exitPrice - pos.entry) * pos.qty_remaining  : (pos.entry - exitPrice)  * pos.qty_remaining;
          rawPnl = tp1Pnl + exitPnl;
        } else {
          rawPnl = isLong ? (exitPrice - pos.entry) * pos.qty : (pos.entry - exitPrice) * pos.qty;
        }
        const atBreakeven = Math.abs(exitPrice - pos.entry) <= pos.tickSize * 3;
        const exitReason  = !pos.beReached ? 'SL' : atBreakeven ? 'BREAKEVEN' : 'TRAIL';
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
          be_reached:  pos.beReached,
          peak_price:  pos.peakPrice,
          scans:       pos.scans ?? [],
          scan_count:  pos.scan_count ?? null,
          ta_score:    pos.ta_score ?? null,
          der_score:   pos.der_score ?? null,
          total:       pos.total ?? null,
          llm_decision: pos.llm_decision ?? null,
        }).catch(() => {});
        trackedPositions.delete(symbol);
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

        // Trailing sur qty_remaining (pas qty_half — le reste réel peut différer)
        pos.trailingOrderId = await placeTrailingOrder(symbol, closeSide, pos.qty_remaining);
        pos.beReached = true;
        try {
          const idx = await publicRequest('/fapi/v1/premiumIndex', { symbol });
          pos.peakPrice = Number(idx?.markPrice) || pos.tp1;
        } catch { pos.peakPrice = pos.tp1; }

        console.log(`[position-manager] TP1_HIT ${symbol} — BE=${bePrice} trailing=${pos.trailingOrderId} remaining=${pos.qty_remaining}`);
      }

      // ── Early exit sur les qty_remaining restantes ──────────────────────────
      if (pos.beReached) {
        const earlyCheck = await checkEarlyExit(symbol, pos);
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
            trackedPositions.delete(symbol);
            console.log(`[position-manager] EARLY_EXIT ${symbol} @ ${markPrice} (${earlyCheck.reason}) pnl=${rawPnl?.toFixed(2)} USDT`);
          } catch (err) {
            console.error(`[position-manager] early exit MARKET failed ${symbol}:`, err.message);
          }
          continue;
        }
      }
    } catch (err) {
      console.error(`[position-manager] poll error ${symbol}:`, err?.message);
    }
  }
}

export function getTrackedPositions() {
  return [...trackedPositions.entries()].map(([symbol, pos]) => ({ symbol, ...pos }));
}

export async function reconcilePositions() {
  try {
    const positionRisk = await signedRequest('GET', '/fapi/v2/positionRisk');
    if (!Array.isArray(positionRisk)) throw new Error('positionRisk: réponse non-array');
    const binancePositions = positionRisk
      .filter(p => Number(p.positionAmt) !== 0)
      .map(p => ({
        symbol:     p.symbol,
        qty:        Math.abs(Number(p.positionAmt)),
        direction:  Number(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        entryPrice: Number(p.entryPrice),
        markPrice:  Number(p.markPrice),
      }));
    const botPositions = Array.from(trackedPositions.values())
      .map(p => ({ symbol: p.symbol, qty: Number(p.qty ?? 0), direction: String(p.direction ?? '').toUpperCase() }))
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

export function startPositionManager() {
  if (intervalHandle) return intervalHandle;
  console.log('[position-manager] Démarré (polling 60s)');
  intervalHandle = setInterval(() => {
    pollPositions().catch(err => console.error('[position-manager] interval error:', err?.message));
  }, POLL_MS);
  return intervalHandle;
}
