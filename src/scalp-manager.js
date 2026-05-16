// Scalp Manager — polling 15s, T+10 forced close, SL/TP tight
import { createHmac } from 'crypto';
import { sendTelegram, fmt } from './notifier.js';

const POLL_MS     = 15_000;  // 15s
const FORCE_CLOSE_MS = 10 * 60_000; // 10min max hold
const TRAIL_PCT   = 0.008;  // 0.8% trailing (tighter than normal 1.5%)
const SL_ATR_MULT = 1.0;    // 1x ATR SL

const isTestnet  = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
const BASE_URL   = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
const API_KEY    = (isTestnet ? process.env.BINANCE_TESTNET_API_KEY : process.env.BINANCE_API_KEY)?.trim();
const API_SECRET = (isTestnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET)?.trim();

const scalpPositions = new Map();
let intervalHandle = null;

function buildSignedQuery(params = {}) {
  if (!API_SECRET) throw new Error('Missing API secret');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, timestamp: Date.now() })) {
    if (v !== undefined && v !== null) q.append(k, String(v));
  }
  const sig = createHmac('sha256', API_SECRET).update(q.toString()).digest('hex');
  q.append('signature', sig);
  return q.toString();
}

async function signedRequest(method, path, params = {}) {
  if (!API_KEY) throw new Error('Missing API key');
  const url = `${BASE_URL}${path}?${buildSignedQuery(params)}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body?.msg || body?.raw || `HTTP ${res.status}`);
  return body;
}

async function closePosition(symbol, qty, side, reason) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  try {
    const order = await signedRequest('POST', '/fapi/v1/order', {
      symbol, side: closeSide, type: 'MARKET', quantity: qty, reduceOnly: true,
    });
    console.log(`[scalp-manager] CLOSE ${symbol} ${reason} orderId=${order.orderId}`);
    return order;
  } catch (err) {
    console.error(`[scalp-manager] closePosition error ${symbol}:`, err.message);
    return null;
  }
}

async function getMarkPrice(symbol) {
  const res = await fetch(`${BASE_URL}/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  return Number(data?.markPrice);
}

export function registerScalpTrade({ symbol, side, entry, sl, tp, qty }) {
  if (!symbol || !side || entry === undefined) return;
  const pos = {
    symbol, side: String(side).toUpperCase(),
    entry: Number(entry), sl: Number(sl), tp: Number(tp),
    qty, peakPrice: Number(entry),
    openedAt: Date.now(),
    beReached: false,
  };
  scalpPositions.set(symbol, pos);
  console.log(`[scalp-manager] TRACK ${pos.side} ${symbol} entry=${entry} sl=${sl} tp=${tp} T+10`);
}

export function getScalpPositions() {
  return [...scalpPositions.entries()].map(([symbol, pos]) => ({ symbol, ...pos }));
}

async function pollScalp() {
  if (!scalpPositions.size) return;

  await Promise.allSettled([...scalpPositions.entries()].map(async ([symbol, pos]) => {
    const now = Date.now();

    // T+10 forced close
    if (now - pos.openedAt >= FORCE_CLOSE_MS) {
      let exitPrice = pos.entry;
      try { exitPrice = await getMarkPrice(symbol); } catch { /* use entry as fallback */ }
      await closePosition(symbol, pos.qty, pos.side, 'T+10_FORCE');
      scalpPositions.delete(symbol);
      const isLongT10 = pos.side === 'LONG';
      const rawPnlT10 = (exitPrice - pos.entry) * pos.qty * (isLongT10 ? 1 : -1);
      if (Number.isFinite(rawPnlT10)) {
        const pnlLabelT10 = rawPnlT10 >= 0 ? `+${rawPnlT10.toFixed(2)}` : rawPnlT10.toFixed(2);
        sendTelegram([
          `⏱ <b>Scalp T+10 fermé</b> — <code>${symbol}</code>`,
          `📈 <b>${pos.side}</b> | Entrée <code>${fmt(pos.entry)}</code> → Sortie <code>${fmt(exitPrice)}</code>`,
          `💵 PnL estimé : <b>${pnlLabelT10} USDT</b>`,
        ].join('\n')).catch(err => console.error(`[scalp-manager] Telegram T+10 ${symbol}:`, err.message));
      }
      return;
    }

    let markPrice;
    try { markPrice = await getMarkPrice(symbol); }
    catch { return; }
    if (!Number.isFinite(markPrice)) return;

    const isLong = pos.side === 'LONG';

    // TP hit
    if ((isLong && markPrice >= pos.tp) || (!isLong && markPrice <= pos.tp)) {
      await closePosition(symbol, pos.qty, pos.side, 'TP');
      scalpPositions.delete(symbol);
      const rawPnlTP = (markPrice - pos.entry) * pos.qty * (isLong ? 1 : -1);
      if (Number.isFinite(rawPnlTP)) {
        const pnlLabelTP = rawPnlTP >= 0 ? `+${rawPnlTP.toFixed(2)}` : rawPnlTP.toFixed(2);
        sendTelegram([
          `⚡ <b>Scalp TP atteint</b> — <code>${symbol}</code>`,
          `📈 <b>${pos.side}</b> | Entrée <code>${fmt(pos.entry)}</code> → TP <code>${fmt(markPrice)}</code>`,
          `💰 PnL estimé : <b>${pnlLabelTP} USDT</b>`,
        ].join('\n')).catch(err => console.error(`[scalp-manager] Telegram TP ${symbol}:`, err.message));
      }
      return;
    }

    // SL hit
    if ((isLong && markPrice <= pos.sl) || (!isLong && markPrice >= pos.sl)) {
      await closePosition(symbol, pos.qty, pos.side, 'SL');
      scalpPositions.delete(symbol);
      const rawPnlSL = (markPrice - pos.entry) * pos.qty * (isLong ? 1 : -1);
      if (Number.isFinite(rawPnlSL)) {
        const pnlLabelSL = rawPnlSL >= 0 ? `+${rawPnlSL.toFixed(2)}` : rawPnlSL.toFixed(2);
        sendTelegram([
          `🔴 <b>Scalp SL touché</b> — <code>${symbol}</code>`,
          `📈 <b>${pos.side}</b> | Entrée <code>${fmt(pos.entry)}</code> → SL <code>${fmt(markPrice)}</code>`,
          `💵 PnL estimé : <b>${pnlLabelSL} USDT</b>`,
        ].join('\n')).catch(err => console.error(`[scalp-manager] Telegram SL ${symbol}:`, err.message));
      }
      return;
    }

    // Trailing stop (tight 0.8%)
    if (isLong) {
      pos.peakPrice = Math.max(pos.peakPrice, markPrice);
      const trail = pos.peakPrice * (1 - TRAIL_PCT);
      if (trail > pos.sl && markPrice > pos.entry) {
        pos.sl = trail;
        console.log(`[scalp-manager] TRAIL ${symbol} sl→${trail.toFixed(4)}`);
      }
    } else {
      pos.peakPrice = Math.min(pos.peakPrice, markPrice);
      const trail = pos.peakPrice * (1 + TRAIL_PCT);
      if (trail < pos.sl && markPrice < pos.entry) {
        pos.sl = trail;
        console.log(`[scalp-manager] TRAIL ${symbol} sl→${trail.toFixed(4)}`);
      }
    }
  }));
}

export function startScalpManager() {
  if (intervalHandle) return intervalHandle;
  console.log(`[scalp-manager] Démarré — polling ${POLL_MS / 1000}s, T+10 forcé`);
  intervalHandle = setInterval(() => {
    pollScalp().catch(err => console.error('[scalp-manager] interval error:', err.message));
  }, POLL_MS);
  return intervalHandle;
}
