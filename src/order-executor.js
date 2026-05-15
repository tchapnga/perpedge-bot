import { createHmac } from 'crypto';
import { getMode } from './bot-state.js';

const DEFAULT_LEVERAGE          = 20;
const DEFAULT_RECV_WINDOW       = 5000;
const DEFAULT_POSITION_SIZE_USDT = 50;

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

function toFixedSafe(value, decimals = 12) {
  return Number(value).toFixed(decimals).replace(/\.?0+$/, '');
}

function decimalPlaces(value) {
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

function calculateQuantity({ entry, stepSize, minQty, minNotional, reduceSize }) {
  const positionSize = Number(process.env.POSITION_SIZE_USDT || DEFAULT_POSITION_SIZE_USDT);
  if (!Number.isFinite(positionSize) || positionSize <= 0) throw new Error('Invalid POSITION_SIZE_USDT');
  if (!Number.isFinite(stepSize)     || stepSize <= 0)     throw new Error('Invalid stepSize');
  const notional    = positionSize * (reduceSize ? 0.5 : 1);
  const rawQty      = notional / entry;
  const flooredQty  = Math.floor(rawQty / stepSize) * stepSize;
  const adjustedQty = flooredQty * entry < minNotional ? flooredQty + stepSize : flooredQty;
  const precision   = decimalPlaces(stepSize);
  const qty         = Number(toFixedSafe(adjustedQty, precision));
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

    if (mode !== 'LIVE') {
      console.log(`[order-executor] ${mode} — ordre simulé ${orderSide} ${symbol}@${entry}`);
      return {
        success:   true,
        orderId:   `sim_${mode.toLowerCase()}_${Date.now()}`,
        side:      orderSide,
        symbol,
        price:     entry,
        qty:       '0',
        leverage:  DEFAULT_LEVERAGE,
        simulated: true,
        mode,
      };
    }

    const reduceSize = Boolean(signal.extra?.reduce_size);
    const leverage   = DEFAULT_LEVERAGE;

    await signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    const exchangeInfo = await getExchangeInfo(symbol);
    const { stepSize, minQty, minNotional } = getSymbolFilters(exchangeInfo, symbol);
    const qty = calculateQuantity({ entry, stepSize, minQty, minNotional, reduceSize });

    // Double-check : détecte un changement de mode pendant les awaits de préparation
    if (getMode() !== 'LIVE') {
      throw new Error('ModeGuard: mode changed during order execution');
    }

    const order = await signedRequest('POST', '/fapi/v1/order', {
      symbol, side: orderSide, type: 'MARKET', quantity: qty,
    });

    const modeLabel = isTestnet ? '[TESTNET] ' : '';
    console.log(`[order-executor] ${modeLabel}${orderSide} ${symbol} ${qty}@${entry} leverage=${leverage}x`);
    return { success: true, orderId: order.orderId, side: orderSide, symbol, price: entry, qty, leverage };
  } catch (err) {
    console.error(`[order-executor] Error: ${err?.message ?? err}`);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
