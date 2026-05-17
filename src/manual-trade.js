import { createHmac } from 'crypto';
import { registerTrade } from './position-manager.js';
import { getMode } from './bot-state.js';

const _isTestnet = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
const BASE_URL   = _isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
const API_KEY    = (_isTestnet ? process.env.BINANCE_TESTNET_API_KEY : process.env.BINANCE_API_KEY)?.trim();
const API_SECRET = (_isTestnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET)?.trim();

function _sign(params = {}) {
  const p = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  }
  const sig = createHmac('sha256', API_SECRET ?? '').update(qs.toString()).digest('hex');
  qs.append('signature', sig);
  return qs.toString();
}

async function _signed(method, path, params = {}) {
  if (!API_KEY) throw new Error('Missing BINANCE_API_KEY');
  if (!API_SECRET) throw new Error('Missing BINANCE_API_SECRET');
  const url = `${BASE_URL}${path}?${_sign(params)}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.msg || data?.message || text || `HTTP ${res.status}`);
  return data;
}

async function _public(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== null) qs.append(k, String(v)); }
  const url = qs.toString() ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.msg || data?.message || text || `HTTP ${res.status}`);
  return data;
}

function _floorStep(qty, stepSize) {
  const decs = (String(stepSize).split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.floor(qty / stepSize) * stepSize).toFixed(decs));
}

function _roundTick(price, tickSize) {
  const decs = (String(tickSize).split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.round(price / tickSize) * tickSize).toFixed(decs));
}

/**
 * Execute a manual trade: MARKET entry → register with position-manager (SL/TP).
 * @param {{ symbol, side, size_usdt, leverage, sl_price, tp_price, note? }} p
 */
export async function executeManualTrade({ symbol, side, size_usdt, leverage, sl_price, tp_price }) {
  const sym  = String(symbol).trim().toUpperCase();
  const dir  = String(side).toUpperCase();
  const sizeUsdt = Number(size_usdt);
  const lev      = Number(leverage);
  const sl       = Number(sl_price);
  const tp1      = Number(tp_price);

  if (!['LONG', 'SHORT'].includes(dir)) throw new Error('INVALID_SIDE');
  if (!Number.isFinite(sizeUsdt) || sizeUsdt <= 0) throw new Error('INVALID_SIZE');
  if (!Number.isFinite(lev) || lev < 1 || lev > 125) throw new Error('INVALID_LEVERAGE');
  if (!Number.isFinite(sl) || sl <= 0) throw new Error('INVALID_SL');
  if (!Number.isFinite(tp1) || tp1 <= 0) throw new Error('INVALID_TP');

  const mode = getMode();

  if (mode === 'SHADOW') {
    return {
      ok: true, simulated: true,
      message: `SHADOW — trade simulé ${dir} ${sym} marge=${sizeUsdt} lev=${lev}x SL=${sl} TP=${tp1}`,
    };
  }

  // ── Exchange info ────────────────────────────────────────────────────────
  const info = await _public('/fapi/v1/exchangeInfo', { symbol: sym });
  const symbolInfo = Array.isArray(info?.symbols) ? info.symbols.find(s => s.symbol === sym) : null;
  if (!symbolInfo) throw new Error('INVALID_SYMBOL');

  const pf  = symbolInfo.filters?.find(f => f.filterType === 'PRICE_FILTER');
  const lf  = symbolInfo.filters?.find(f => f.filterType === 'LOT_SIZE');
  const mnf = symbolInfo.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
  if (!pf?.tickSize || !lf?.stepSize) throw new Error('Filters indisponibles pour ' + sym);

  const tickSize   = Number(pf.tickSize);
  const stepSize   = Number(lf.stepSize);
  const minNotional = Number(mnf?.notional ?? 0);

  // ── Mark price ──────────────────────────────────────────────────────────
  const ticker = await _public('/fapi/v1/ticker/price', { symbol: sym });
  const markPrice = Number(ticker.price);
  if (!Number.isFinite(markPrice) || markPrice <= 0) throw new Error('Mark price indisponible pour ' + sym);

  // ── SL/TP direction validation ─────────────────────────────────────────
  if (dir === 'LONG') {
    if (sl >= markPrice)  throw new Error('SL_TP_INVALID: SL doit être sous le prix actuel pour LONG');
    if (tp1 <= markPrice) throw new Error('SL_TP_INVALID: TP doit être au-dessus du prix actuel pour LONG');
  } else {
    if (sl <= markPrice)  throw new Error('SL_TP_INVALID: SL doit être au-dessus du prix actuel pour SHORT');
    if (tp1 >= markPrice) throw new Error('SL_TP_INVALID: TP doit être en-dessous du prix actuel pour SHORT');
  }

  // ── Leverage ────────────────────────────────────────────────────────────
  await _signed('POST', '/fapi/v1/leverage', { symbol: sym, leverage: lev });

  // ── Quantity ────────────────────────────────────────────────────────────
  const notional = sizeUsdt * lev;
  if (minNotional > 0 && notional < minNotional) {
    throw new Error(`BELOW_MIN_NOTIONAL: notionnel ${notional.toFixed(2)} USDT < min ${minNotional} USDT`);
  }
  const rawQty = notional / markPrice;
  const qty    = _floorStep(rawQty, stepSize);
  if (qty <= 0) throw new Error('Quantité nulle — taille trop petite pour ce symbole');

  // ── Market order ─────────────────────────────────────────────────────────
  const orderSide = dir === 'LONG' ? 'BUY' : 'SELL';
  const order = await _signed('POST', '/fapi/v1/order', { symbol: sym, side: orderSide, type: 'MARKET', quantity: qty });
  const fillPrice = Number(order.avgPrice) || markPrice;
  const filledQty = Number(order.executedQty) || qty;

  // ── tp2 = 1.5× distance tp1 (trailing target) ──────────────────────────
  const tp2 = dir === 'LONG'
    ? fillPrice + (tp1 - fillPrice) * 1.5
    : fillPrice - (fillPrice - tp1) * 1.5;

  // ── Register with position manager (SL/TP algo orders + monitoring) ─────
  const tracked = await registerTrade({
    symbol: sym, side: dir,
    entry: fillPrice,
    sl:  _roundTick(sl,  tickSize),
    tp1: _roundTick(tp1, tickSize),
    tp2: _roundTick(tp2, tickSize),
    qty: filledQty,
    source: 'MANUAL',
  });

  const tag = _isTestnet ? '[TESTNET] ' : '';
  console.log(`[manual-trade] ${tag}${dir} ${sym} ${filledQty}@${fillPrice} SL=${sl} TP=${tp1} lev=${lev}x`);

  return {
    ok: true,
    trade_id: `manual_${Date.now()}`,
    symbol: sym, side: dir,
    fill_price: fillPrice,
    qty: String(filledQty),
    sl_price: _roundTick(sl, tickSize),
    tp_price: _roundTick(tp1, tickSize),
    leverage: lev,
    tracked: !!tracked,
    message: `Trade ${dir} ouvert : ${filledQty} ${sym}@${fillPrice.toFixed(4)}, SL=${sl}, TP=${tp1}, lev=${lev}x`,
  };
}
