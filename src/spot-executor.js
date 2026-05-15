import { createHmac } from 'crypto';

const SPOT_BASE_URL  = 'https://api.binance.com';
const SPOT_API_KEY   = process.env.BINANCE_SPOT_API_KEY?.trim()   || process.env.BINANCE_API_KEY?.trim();
const SPOT_API_SECRET = process.env.BINANCE_SPOT_API_SECRET?.trim() || process.env.BINANCE_API_SECRET?.trim();

function buildSignedQuery(params = {}) {
  if (!SPOT_API_SECRET) throw new Error('Missing BINANCE_SPOT_API_SECRET');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, timestamp: Date.now() })) {
    if (v !== undefined && v !== null) q.append(k, String(v));
  }
  const sig = createHmac('sha256', SPOT_API_SECRET).update(q.toString()).digest('hex');
  q.append('signature', sig);
  return q.toString();
}

async function signedRequest(method, path, params = {}) {
  if (!SPOT_API_KEY) throw new Error('Missing BINANCE_SPOT_API_KEY');
  const url = `${SPOT_BASE_URL}${path}?${buildSignedQuery(params)}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': SPOT_API_KEY }, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body?.msg || body?.raw || `HTTP ${res.status}`);
  return body;
}

async function getSpotSymbolFilters(symbol) {
  const url = `${SPOT_BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const data = await res.json();
  const info   = data?.symbols?.find((s) => s.symbol === symbol);
  if (!info) throw new Error(`Symbol ${symbol} not found on SPOT`);
  const lotSize   = info.filters?.find(f => f.filterType === 'LOT_SIZE');
  const notional  = info.filters?.find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
  if (!lotSize) throw new Error(`LOT_SIZE filter not found for ${symbol}`);
  return {
    stepSize:    Number(lotSize.stepSize),
    minQty:      Number(lotSize.minQty),
    minNotional: Number(notional?.minNotional || notional?.minVal || 10),
  };
}

function floorToStep(qty, step) {
  if (!step || step <= 0) return qty;
  const decimals = (String(step).split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.floor(qty / step) * step).toFixed(decimals));
}

export async function placeSpotBuy({ symbol, quoteAmount, limitPrice = null }) {
  if (!symbol || !quoteAmount) throw new Error('placeSpotBuy: symbol and quoteAmount required');

  const { stepSize, minQty, minNotional } = await getSpotSymbolFilters(symbol);

  if (limitPrice) {
    // LIMIT order: calculate qty from quoteAmount and price
    const rawQty = quoteAmount / limitPrice;
    const qty    = floorToStep(rawQty, stepSize);
    if (qty < minQty) throw new Error(`qty ${qty} < minQty ${minQty} for ${symbol}`);
    if (qty * limitPrice < minNotional) throw new Error(`notional ${(qty * limitPrice).toFixed(2)} < min ${minNotional}`);
    const order = await signedRequest('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
      quantity: String(qty), price: String(limitPrice),
    });
    console.log(`[spot-executor] LIMIT BUY ${symbol} ${qty}@${limitPrice} orderId=${order.orderId}`);
    return { success: true, orderId: order.orderId, qty, price: limitPrice, type: 'LIMIT' };
  } else {
    // MARKET order using quoteOrderQty
    const order = await signedRequest('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: String(quoteAmount),
    });
    const fillQty   = Number(order.executedQty);
    const fillPrice = fillQty > 0 ? Number(order.cummulativeQuoteQty) / fillQty : 0;
    console.log(`[spot-executor] MARKET BUY ${symbol} ${fillQty}@${fillPrice.toFixed(4)} orderId=${order.orderId}`);
    return { success: true, orderId: order.orderId, qty: fillQty, price: fillPrice, type: 'MARKET' };
  }
}

export async function cancelSpotOrder(symbol, orderId) {
  try {
    return await signedRequest('DELETE', '/api/v3/order', { symbol, orderId });
  } catch (err) {
    console.error(`[spot-executor] cancelOrder ${symbol} #${orderId}:`, err.message);
    return null;
  }
}
