// Scalp Manager — polling 15s, T+10 forced close, SL/TP tight
// Revue 3/3 LLMs 2026-05-17 — isPolling guard + closing flag + AbortSignal + PnL wording
import { createHmac } from 'crypto';
import { sendTelegram, fmt } from './notifier.js';

const POLL_MS        = 15_000;
const FORCE_CLOSE_MS = 10 * 60_000;
const TRAIL_PCT      = 0.008;   // 0.8% trailing

const isTestnet  = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
const BASE_URL   = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
const API_KEY    = (isTestnet ? process.env.BINANCE_TESTNET_API_KEY : process.env.BINANCE_API_KEY)?.trim();
const API_SECRET = (isTestnet ? process.env.BINANCE_TESTNET_API_SECRET : process.env.BINANCE_API_SECRET)?.trim();

const scalpPositions = new Map();
let   intervalHandle = null;
let   isPolling      = false;  // guard anti double-poll

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
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY },
    signal: AbortSignal.timeout(5000),
  });
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

function pnlLabel(rawPnl) {
  return rawPnl >= 0 ? `+${rawPnl.toFixed(2)}` : rawPnl.toFixed(2);
}

export function registerScalpTrade({ symbol, side, entry, sl, tp, qty }) {
  if (!symbol || !side || entry === undefined) return;
  const pos = {
    symbol, side: String(side).toUpperCase(),
    entry: Number(entry), sl: Number(sl), tp: Number(tp),
    qty, peakPrice: Number(entry),
    openedAt: Date.now(),
    closing: false,
  };
  scalpPositions.set(symbol, pos);
  console.log(`[scalp-manager] TRACK ${pos.side} ${symbol} entry=${entry} sl=${sl} tp=${tp} T+10`);
}

export function getScalpPositions() {
  return [...scalpPositions.entries()].map(([symbol, pos]) => ({ symbol, ...pos }));
}

async function pollScalp() {
  if (isPolling) {
    console.warn('[scalp-manager] poll skipped — previous cycle still running');
    return;
  }
  if (!scalpPositions.size) return;
  isPolling = true;

  try {
    await Promise.allSettled([...scalpPositions.entries()].map(async ([symbol, pos]) => {
      if (pos.closing) return;  // position déjà en cours de fermeture

      const now = Date.now();

      // T+10 forced close
      if (now - pos.openedAt >= FORCE_CLOSE_MS) {
        let exitPrice = pos.entry;
        try { exitPrice = await getMarkPrice(symbol); } catch { /* fallback entry */ }
        pos.closing = true;
        const order = await closePosition(symbol, pos.qty, pos.side, 'T+10_FORCE');
        if (order) {
          scalpPositions.delete(symbol);
          const rawPnl = (exitPrice - pos.entry) * pos.qty * (pos.side === 'LONG' ? 1 : -1);
          if (Number.isFinite(rawPnl)) {
            sendTelegram([
              `⏱ <b>Scalp T+10 fermé</b> — <code>${symbol}</code>`,
              `📈 <b>${pos.side}</b> | Entrée <code>${fmt(pos.entry)}</code> → Sortie <code>${fmt(exitPrice)}</code>`,
              `💵 PnL estimé (brut) : <b>${pnlLabel(rawPnl)} USDT</b>`,
            ].join('\n')).catch(err => console.error(`[scalp-manager] Telegram T+10 ${symbol}:`, err.message));
          }
        } else {
          pos.closing = false;  // rollback — retry au prochain cycle
          console.warn(`[scalp-manager] T+10 close failed ${symbol} — retry next poll`);
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
        pos.closing = true;
        const order = await closePosition(symbol, pos.qty, pos.side, 'TP');
        if (order) {
          scalpPositions.delete(symbol);
          const rawPnl = (markPrice - pos.entry) * pos.qty * (isLong ? 1 : -1);
          if (Number.isFinite(rawPnl)) {
            sendTelegram([
              `⚡ <b>Scalp TP atteint</b> — <code>${symbol}</code>`,
              `📈 <b>${pos.side}</b> | Entrée <code>${fmt(pos.entry)}</code> → TP <code>${fmt(markPrice)}</code>`,
              `💰 PnL estimé (brut) : <b>${pnlLabel(rawPnl)} USDT</b>`,
            ].join('\n')).catch(err => console.error(`[scalp-manager] Telegram TP ${symbol}:`, err.message));
          }
        } else {
          pos.closing = false;
          console.warn(`[scalp-manager] TP close failed ${symbol} — retry next poll`);
        }
        return;
      }

      // SL hit
      if ((isLong && markPrice <= pos.sl) || (!isLong && markPrice >= pos.sl)) {
        pos.closing = true;
        const order = await closePosition(symbol, pos.qty, pos.side, 'SL');
        if (order) {
          scalpPositions.delete(symbol);
          const rawPnl = (markPrice - pos.entry) * pos.qty * (isLong ? 1 : -1);
          if (Number.isFinite(rawPnl)) {
            sendTelegram([
              `🔴 <b>Scalp SL touché</b> — <code>${symbol}</code>`,
              `📈 <b>${pos.side}</b> | Entrée <code>${fmt(pos.entry)}</code> → SL <code>${fmt(markPrice)}</code>`,
              `💵 PnL estimé (brut) : <b>${pnlLabel(rawPnl)} USDT</b>`,
            ].join('\n')).catch(err => console.error(`[scalp-manager] Telegram SL ${symbol}:`, err.message));
          }
        } else {
          pos.closing = false;
          console.warn(`[scalp-manager] SL close failed ${symbol} — retry next poll`);
        }
        return;
      }

      // Trailing stop (0.8%)
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
  } finally {
    isPolling = false;
  }
}

export function startScalpManager() {
  if (intervalHandle) return intervalHandle;
  console.log(`[scalp-manager] Démarré — polling ${POLL_MS / 1000}s, T+10 forcé`);
  intervalHandle = setInterval(() => {
    pollScalp().catch(err => console.error('[scalp-manager] interval error:', err.message));
  }, POLL_MS);
  return intervalHandle;
}
