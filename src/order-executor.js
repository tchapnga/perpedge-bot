import { createHmac } from 'crypto';
import { getMode } from './bot-state.js';
import { checkExistingPosition } from './position-manager.js';

const DEFAULT_LEVERAGE           = Number(process.env.LEVERAGE) || 20;
const DEFAULT_RECV_WINDOW        = 5000;
const DEFAULT_POSITION_SIZE_USDT = 50;

// P0.1 — Ordres LIMIT GTC avec cancel auto
const LIMIT_CANCEL_MS        = Number(process.env.LIMIT_CANCEL_MS) || 3 * 60_000;

// Guard "no double position" — lock par symbole (consensus ChatGPT+DeepSeek 2026-05-18)
const _symbolLocks = new Set();
const LIMIT_POLL_INTERVAL_MS = 15_000;

// P0.2 — Position sizing dynamique
const RISK_PCT       = Number(process.env.RISK_PCT) || 1;
const BALANCE_TTL_MS = 30_000;
let _balanceCache = { value: null, fetchedAt: 0 };

export function invalidateBalanceCache() {
  _balanceCache = { value: null, fetchedAt: 0 };
}

async function fetchAvailableBalance() {
  const now = Date.now();
  if (_balanceCache.value !== null && now - _balanceCache.fetchedAt < BALANCE_TTL_MS) {
    return _balanceCache.value;
  }
  try {
    let balances;
    try   { balances = await signedRequest('GET', '/fapi/v3/balance'); }
    catch { balances = await signedRequest('GET', '/fapi/v2/balance'); }
    if (!Array.isArray(balances)) throw new Error('Unexpected balance response format');
    const usdt = balances.find(b => b.asset === 'USDT');
    if (!usdt) throw new Error('USDT not found in balance response');
    const available = Number(usdt.availableBalance);
    if (!Number.isFinite(available) || available < 0) throw new Error(`Invalid availableBalance: ${usdt.availableBalance}`);
    _balanceCache = { value: available, fetchedAt: now };
    console.log(`[order-executor] Balance USDT disponible: ${available.toFixed(2)}`);
    return available;
  } catch (err) {
    console.warn(`[order-executor] Balance fetch échoué — fallback POSITION_SIZE_USDT: ${err.message}`);
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
export function floorToTick(price, tick) { return Math.floor(price / tick) * tick; }
export function ceilToTick(price, tick)  { return Math.ceil(price  / tick) * tick; }

const isTestnet = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
const BASE_URL  = isTestnet
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

const API_KEY    = (isTestnet ? process.env.BINANCE_TESTNET_API_KEY : process.env.BINANCE_API_KEY)?.trim();
const API_SECRET = (isTestnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET)?.trim();

function requireBinanceCredentials() {
  if (!API_KEY)    throw new Error('Missing BINANCE_API_KEY');
  if (!API_SECRET) throw new Error('Missing BINANCE_API_SECRET');
}

export function toFixedSafe(value, decimals = 12) {
  return Number(value).toFixed(decimals).replace(/\.?0+$/, '');
}

export function decimalPlaces(value) {
  const str = String(value);
  if (str.includes('e-')) {
    const [, exponent] = str.split('e-');
    return Number(exponent);
  }
  const dotIndex = str.indexOf('.');
  return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
}

function normalizeSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') throw new Error('Invalid signal.symbol');
  return symbol.trim().toUpperCase();
}

function normalizeEntry(entry) {
  const value = Number(entry);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid signal.entry');
  return value;
}

function buildSignedQuery(params = {}) {
  const signedParams = { ...params, timestamp: Date.now(), recvWindow: DEFAULT_RECV_WINDOW };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(signedParams)) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  }
  const payload   = qs.toString();
  const signature = createHmac('sha256', API_SECRET).update(payload).digest('hex');
  qs.append('signature', signature);
  return qs.toString();
}

async function signedRequest(method, path, params = {}) {
  requireBinanceCredentials();
  const url      = `${BASE_URL}${path}?${buildSignedQuery(params)}`;
  const response = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  const text     = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload?.msg || payload?.message || text || `HTTP ${response.status}`);
  return payload;
}

async function publicRequest(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  }
  const url      = qs.toString() ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
  const response = await fetch(url);
  const text     = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload?.msg || payload?.message || text || `HTTP ${response.status}`);
  return payload;
}

async function getExchangeInfo(symbol) {
  try   { return await publicRequest('/fapi/v2/exchangeInfo', { symbol }); }
  catch { return await publicRequest('/fapi/v1/exchangeInfo', { symbol }); }
}

function getSymbolFilters(exchangeInfo, symbol) {
  const info = exchangeInfo?.symbols?.find(s => s.symbol === symbol);
  if (!info) throw new Error(`Symbol not found in exchangeInfo: ${symbol}`);
  const lotSize           = info.filters?.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter       = info.filters?.find(f => f.filterType === 'PRICE_FILTER');
  const minNotionalFilter = info.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
  if (!lotSize?.stepSize)     throw new Error(`LOT_SIZE stepSize not found for ${symbol}`);
  if (!priceFilter?.tickSize) throw new Error(`PRICE_FILTER tickSize not found for ${symbol}`);
  return {
    stepSize:    Number(lotSize.stepSize),
    tickSize:    Number(priceFilter.tickSize),
    minQty:      lotSize.minQty ? Number(lotSize.minQty) : 0,
    minNotional: Number(minNotionalFilter?.notional) || 0,
  };
}

export function calculateQuantity({ entry, stepSize, minQty, minNotional, reduceSize, positionSizeUsdt }) {
  if (!Number.isFinite(positionSizeUsdt) || positionSizeUsdt <= 0) throw new Error('Invalid positionSizeUsdt');
  if (!Number.isFinite(stepSize)         || stepSize <= 0)         throw new Error('Invalid stepSize');
  const notional = positionSizeUsdt * (reduceSize ? 0.5 : 1);
  if (minNotional > 0 && notional < minNotional) {
    throw new Error(`BELOW_MIN_NOTIONAL: ${notional.toFixed(2)} USDT < min ${minNotional} USDT`);
  }
  const rawQty     = notional / entry;
  const flooredQty = Math.floor(rawQty / stepSize) * stepSize;
  const precision  = decimalPlaces(stepSize);
  const qty        = Number(toFixedSafe(flooredQty, precision));
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Calculated quantity is zero or invalid');
  if (minQty && qty < minQty) throw new Error(`qty ${qty} below minQty ${minQty} for this symbol`);
  return toFixedSafe(qty, precision);
}

function mapOrderSide(signalSide) {
  if (signalSide === 'LONG')  return 'BUY';
  if (signalSide === 'SHORT') return 'SELL';
  throw new Error(`Invalid signal.side: ${signalSide} (expected LONG or SHORT)`);
}

export async function executeOrder(signal) {
  const mode = getMode(); // snapshot avant tout await
  try {
    if (!signal || typeof signal !== 'object') throw new Error('Invalid signal');
    const symbol     = normalizeSymbol(signal.symbol);
    const entry      = normalizeEntry(signal.entry);
    const orderSide  = mapOrderSide(signal.side);

    if (mode === 'SHADOW') {
      console.log(`[order-executor] SHADOW — ordre non envoyé ${orderSide} ${symbol}@${entry}`);
      return { success: false, error: 'SHADOW mode: ordre bloqué', mode };
    }

    // Guard 1 — lock par symbole (évite race condition multi-signaux simultanés)
    if (_symbolLocks.has(symbol)) {
      console.warn(`[order-executor] SKIP ${symbol}: ordre concurrent en cours`);
      return { success: false, error: 'SYMBOL_LOCKED' };
    }
    _symbolLocks.add(symbol);

    try {
    // Guard 2 — position déjà active (bot ou externe) — fail-closed sur erreur API
    const posCheck = await checkExistingPosition(symbol);
    if (posCheck.active) {
      console.warn(`[order-executor] SKIP ${symbol}: position déjà active (${posCheck.source})`);
      return { success: false, error: 'POSITION_ALREADY_ACTIVE', reason: posCheck.source };
    }

    const reduceSize = Boolean(signal.extra?.reduce_size);
    const leverage   = DEFAULT_LEVERAGE;

    await signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    const exchangeInfo = await getExchangeInfo(symbol);
    const { stepSize, tickSize, minQty, minNotional } = getSymbolFilters(exchangeInfo, symbol);

    // P0.2 — Résolution de la taille de position (dynamique ou fallback)
    const availableBalance = await fetchAvailableBalance();
    const rawFraction  = Number(signal.extra?.risk_fraction);
    const riskFraction = Number.isFinite(rawFraction) && rawFraction > 0 ? rawFraction : 1.0;
    const baseSize = (availableBalance !== null && availableBalance > 0)
      ? availableBalance * (RISK_PCT / 100)
      : Number(process.env.POSITION_SIZE_USDT || DEFAULT_POSITION_SIZE_USDT);
    const positionSizeUsdt = baseSize * riskFraction;
    const qty = calculateQuantity({ entry, stepSize, minQty, minNotional, reduceSize, positionSizeUsdt });

    // Double-check : détecte un changement de mode pendant les awaits de préparation
    if (getMode() !== 'LIVE') {
      throw new Error(`ModeGuard: mode changé pendant l'exécution (${getMode()})`);
    }

    // P0.1 — Prix LIMIT depuis bookTicker (bidPrice pour BUY, askPrice pour SELL)
    // Fallback sur entry si bookTicker indisponible
    let limitPrice;
    try {
      const book = await publicRequest('/fapi/v1/ticker/bookTicker', { symbol });
      const base  = orderSide === 'BUY' ? Number(book.bidPrice) : Number(book.askPrice);
      limitPrice  = orderSide === 'BUY'
        ? Number(floorToTick(base, tickSize).toFixed(decimalPlaces(tickSize)))
        : Number(ceilToTick(base, tickSize).toFixed(decimalPlaces(tickSize)));
    } catch {
      limitPrice = Number((Math.round(entry / tickSize) * tickSize).toFixed(decimalPlaces(tickSize)));
    }

    // Placer l'ordre LIMIT GTC
    const order    = await signedRequest('POST', '/fapi/v1/order', {
      symbol, side: orderSide, type: 'LIMIT',
      timeInForce: 'GTC', quantity: qty, price: limitPrice,
    });
    const orderId  = order.orderId;
    const deadline = Date.now() + LIMIT_CANCEL_MS;
    const qtyNum   = Number(qty);
    let filledQty  = 0;

    const modeLabel = isTestnet ? '[TESTNET] ' : '';
    console.log(`[order-executor] ${modeLabel}LIMIT ${orderSide} ${symbol} ${qty}@${limitPrice} leverage=${leverage}x`);

    // Polling jusqu'à fill ou timeout
    while (Date.now() < deadline) {
      await sleep(LIMIT_POLL_INTERVAL_MS);
      let status;
      try { status = await signedRequest('GET', '/fapi/v1/order', { symbol, orderId }); }
      catch { continue; } // erreur réseau temporaire — réessayer

      filledQty = Number(status.executedQty ?? 0);
      const avgPx = Number(status.avgPrice) || (filledQty > 0 ? Number(status.cumQuote) / filledQty : limitPrice);

      if (status.status === 'FILLED') {
        console.log(`[order-executor] FILLED ${symbol} ${filledQty}@${avgPx}`);
        invalidateBalanceCache();
        return { success: true, orderId, partial: filledQty < qtyNum, qty: String(filledQty), price: avgPx, leverage };
      }
      if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(status.status)) {
        if (filledQty > 0) {
          console.log(`[order-executor] ${status.status} partial ${symbol} ${filledQty}@${avgPx}`);
          invalidateBalanceCache();
          return { success: true, orderId, partial: true, qty: String(filledQty), price: avgPx, leverage };
        }
        return { success: false, error: `Order ${status.status}`, orderId };
      }
    }

    // Timeout → DELETE + GET final (DeepSeek: DELETE response seule n'est pas fiable)
    console.log(`[order-executor] LIMIT_TIMEOUT ${symbol} — annulation`);
    try { await signedRequest('DELETE', '/fapi/v1/order', { symbol, orderId }); }
    catch (err) { console.warn(`[order-executor] DELETE échoué ${symbol}: ${err?.message}`); }

    const finalStatus = await signedRequest('GET', '/fapi/v1/order', { symbol, orderId });
    const executedQty = Number(finalStatus.executedQty ?? 0);
    if (executedQty > 0) {
      const finalAvgPx = Number(finalStatus.avgPrice) || (Number(finalStatus.cumQuote) / executedQty);
      console.log(`[order-executor] TIMEOUT partial fill ${symbol} ${executedQty}@${finalAvgPx}`);
      invalidateBalanceCache();
      return { success: true, orderId, partial: true, qty: String(executedQty), price: finalAvgPx, leverage };
    }
    return { success: false, error: 'LIMIT_TIMEOUT', orderId };
    } finally {
      _symbolLocks.delete(symbol);
    }
  } catch (err) {
    console.error(`[order-executor] Error: ${err?.message ?? err}`);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
