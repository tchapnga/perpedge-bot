import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NETWORK } from './utils/network.js';
import { apiGet } from './perp-client.js';
import { logTrade } from './trade-journal.js';
import { sendTelegram, fmt } from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '..', 'data');
const STORE_PATH = join(DATA_DIR, `shadow_positions.${NETWORK}.json`);

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }

const POSITION_SIZE_USDT = Number(process.env.POSITION_SIZE_USDT) || 50;
const POLL_MS            = 60_000;
const LEVERAGE           = Number(process.env.LEVERAGE) || 20;

// ── Persistence (séquentielle — recommandation Gemini) ───────────────────────
const shadowPositions = new Map();

function loadShadow() {
  try {
    const text    = readFileSync(STORE_PATH, 'utf8');
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) return;
    for (const [k, v] of entries) {
      if (k && v && typeof v === 'object') shadowPositions.set(k, v);
    }
    console.log(`[shadow-pm] ${shadowPositions.size} position(s) shadow chargée(s)`);
  } catch { /* fichier inexistant au premier démarrage */ }
}

let _savePending = false;
function saveShadow() {
  if (_savePending) return;
  _savePending = true;
  setImmediate(() => {
    _savePending = false;
    try {
      writeFileSync(STORE_PATH, JSON.stringify([...shadowPositions.entries()], null, 2), 'utf8');
    } catch (err) {
      console.error('[shadow-pm] save error:', err.message);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function estimateQty(entry, sizeUsdt) {
  const raw = sizeUsdt / entry;
  if (raw >= 1000) return Math.floor(raw);
  if (raw >= 100)  return Math.floor(raw * 10)   / 10;
  if (raw >= 10)   return Math.floor(raw * 100)  / 100;
  if (raw >= 1)    return Math.floor(raw * 1000) / 1000;
  return Math.floor(raw * 10000) / 10000;
}

function estimateTickSize(price) {
  if (price >= 10000) return 1;
  if (price >= 1000)  return 0.1;
  if (price >= 100)   return 0.01;
  if (price >= 10)    return 0.001;
  if (price >= 1)     return 0.0001;
  if (price >= 0.1)   return 0.00001;
  return 0.000001;
}

function round(v, tick) {
  if (!tick || !Number.isFinite(tick)) return v;
  const dec = (String(tick).split('.')[1] || '').length;
  return Number((Math.round(v / tick) * tick).toFixed(dec));
}

// ── registerShadowTrade ───────────────────────────────────────────────────────
export function registerShadowTrade(signal) {
  try {
    const { symbol, side, entry, sl, tp1, tp2 } = signal || {};
    if (!symbol || !side || !Number.isFinite(Number(entry))) {
      console.warn('[shadow-pm] registerShadowTrade: signal invalide');
      return null;
    }
    if (shadowPositions.has(symbol)) {
      console.warn(`[shadow-pm] SKIP ${symbol}: position shadow déjà active`);
      return null;
    }
    const dir  = String(side).toUpperCase();
    if (dir !== 'LONG' && dir !== 'SHORT') { console.warn(`[shadow-pm] side invalide: ${side}`); return null; }

    const entryNum = Number(entry);
    const tickSize = estimateTickSize(entryNum);
    const qty      = estimateQty(entryNum, POSITION_SIZE_USDT);
    const qty_half      = estimateQty(entryNum, POSITION_SIZE_USDT / 2);
    const qty_remaining = qty - qty_half;

    const pos = {
      entry:       entryNum,
      sl:          Number(sl),
      tp1:         Number(tp1),
      tp2:         Number(tp2),
      direction:   dir,
      qty,
      qty_half,
      qty_remaining,
      beReached:   false,
      peakPrice:   entryNum,
      tickSize,
      openedAt:    new Date().toISOString(),
      ta_score:    signal.ta_score    ?? null,
      der_score:   signal.der_score   ?? null,
      total:       signal.total       ?? null,
      llm_decision: signal.llm_validation?.decision ?? null,
    };

    shadowPositions.set(symbol, pos);
    saveShadow();

    const slDist = Math.abs(entryNum - pos.sl);
    const rrTP2  = slDist > 0 ? (Math.abs(pos.tp2 - entryNum) / slDist).toFixed(2) : '?';
    console.log(`[shadow-pm] TRACK ${dir} ${symbol} entry=${fmt(entryNum)} sl=${fmt(pos.sl)} tp1=${fmt(pos.tp1)} tp2=${fmt(pos.tp2)} qty=${qty} rr=${rrTP2}`);

    sendTelegram([
      `🟡 <b>[SHADOW] Entrée simulée</b> — <code>${symbol}</code>`,
      `📈 <b>${dir}</b> | <code>${fmt(entryNum)}</code> | Score <b>${signal.total ?? '?'}/10</b>`,
      `🎯 TP1 <code>${fmt(pos.tp1)}</code> · TP2 <code>${fmt(pos.tp2)}</code> · 🛑 SL <code>${fmt(pos.sl)}</code>`,
      `📊 R:R TP2 <b>${rrTP2}x</b> · Taille <b>${POSITION_SIZE_USDT} USDT</b>`,
    ].join('\n')).catch(() => {});

    return pos;
  } catch (err) {
    console.error('[shadow-pm] registerShadowTrade error:', err.message);
    return null;
  }
}

// ── pollShadowPositions ───────────────────────────────────────────────────────
let _pollRunning = false;

async function pollShadowPositions() {
  if (_pollRunning || shadowPositions.size === 0) return;
  _pollRunning = true;
  try {
    for (const [symbol, pos] of shadowPositions.entries()) {
      try {
        const snap      = await apiGet('perp-snapshot', { symbol }, 8000);
        const markPrice = Number(snap?.mark_price ?? snap?.price);
        if (!Number.isFinite(markPrice) || markPrice <= 0) continue;

        if (markPrice > pos.peakPrice && pos.direction === 'LONG')  pos.peakPrice = markPrice;
        if (markPrice < pos.peakPrice && pos.direction === 'SHORT') pos.peakPrice = markPrice;

        const isLong  = pos.direction === 'LONG';
        const notional = pos.entry * pos.qty;

        if (!pos.beReached) {
          const tp1Hit = isLong ? markPrice >= pos.tp1 : markPrice <= pos.tp1;
          const slHit  = isLong ? markPrice <= pos.sl  : markPrice >= pos.sl;

          if (tp1Hit) {
            const tp1Pnl = isLong
              ? (pos.tp1 - pos.entry) * pos.qty_half
              : (pos.entry - pos.tp1) * pos.qty_half;

            pos.beReached = true;
            // Breakeven SL : légèrement sous l'entrée (LONG) ou au-dessus (SHORT) — buffer 2 ticks
            const tick = pos.tickSize;
            pos.sl = isLong
              ? round(pos.entry - tick * 2, tick)
              : round(pos.entry + tick * 2, tick);

            saveShadow();
            logTrade({
              symbol, direction: pos.direction,
              entry_price: pos.entry, exit_price: pos.tp1,
              qty: pos.qty_half,
              pnl_usdt: tp1Pnl,
              pnl_pct: notional > 0 ? (tp1Pnl / (notional / 2)) * 100 : null,
              roe_pct: notional > 0 ? (tp1Pnl / (notional / 2 / LEVERAGE)) * 100 : null,
              opened_at: pos.openedAt, closed_at: new Date().toISOString(),
              exit_reason: 'TP1_PARTIAL', be_reached: false, shadow: true,
            }).catch(() => {});
            console.log(`[shadow-pm] TP1_HIT ${symbol} price=${fmt(markPrice)} tp1=${fmt(pos.tp1)} pnl=${tp1Pnl.toFixed(2)} — SL→BE ${fmt(pos.sl)}`);
            sendTelegram([
              `🎯 <b>[SHADOW] TP1 atteint</b> — <code>${symbol}</code>`,
              `📈 <b>${pos.direction}</b> | Entrée <code>${fmt(pos.entry)}</code>`,
              `💵 PnL partiel : <b>${tp1Pnl >= 0 ? '+' : ''}${tp1Pnl.toFixed(2)} USDT</b> <i>(brut)</i>`,
              `🛡️ SL déplacé au breakeven : <code>${fmt(pos.sl)}</code>`,
            ].join('\n')).catch(() => {});
            continue;
          }

          if (slHit) {
            const pnl = isLong
              ? (markPrice - pos.entry) * pos.qty
              : (pos.entry - markPrice) * pos.qty;
            logTrade({
              symbol, direction: pos.direction,
              entry_price: pos.entry, exit_price: markPrice,
              qty: pos.qty,
              pnl_usdt: pnl,
              pnl_pct: notional > 0 ? (pnl / notional) * 100 : null,
              roe_pct: notional > 0 ? (pnl / (notional / LEVERAGE)) * 100 : null,
              opened_at: pos.openedAt, closed_at: new Date().toISOString(),
              exit_reason: 'SL', be_reached: false, shadow: true,
            }).catch(() => {});
            shadowPositions.delete(symbol);
            saveShadow();
            console.log(`[shadow-pm] SL_HIT ${symbol} price=${fmt(markPrice)} sl=${fmt(pos.sl)} pnl=${pnl.toFixed(2)}`);
            sendTelegram([
              `🔴 <b>[SHADOW] Stop Loss</b> — <code>${symbol}</code>`,
              `📈 <b>${pos.direction}</b> | Entrée <code>${fmt(pos.entry)}</code> → Sortie <code>${fmt(markPrice)}</code>`,
              `💵 PnL simulé : <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT</b>`,
            ].join('\n')).catch(() => {});
            continue;
          }
        } else {
          // Après TP1 — surveille TP2 et SL breakeven
          const tp2Hit = isLong ? markPrice >= pos.tp2 : markPrice <= pos.tp2;
          const slHit  = isLong ? markPrice <= pos.sl  : markPrice >= pos.sl;

          if (tp2Hit || slHit) {
            const exitPrice = tp2Hit ? pos.tp2 : markPrice;
            const tp1Pnl    = isLong
              ? (pos.tp1 - pos.entry) * pos.qty_half
              : (pos.entry - pos.tp1) * pos.qty_half;
            const exitPnl   = isLong
              ? (exitPrice - pos.entry) * pos.qty_remaining
              : (pos.entry - exitPrice) * pos.qty_remaining;
            const totalPnl  = tp1Pnl + exitPnl;
            const atBE      = Math.abs(exitPrice - pos.entry) <= pos.tickSize * 3;
            const reason    = tp2Hit ? 'TRAIL' : atBE ? 'BREAKEVEN' : 'SL';

            logTrade({
              symbol, direction: pos.direction,
              entry_price: pos.entry, exit_price: exitPrice,
              qty: pos.qty,
              pnl_usdt: totalPnl,
              pnl_pct: notional > 0 ? (totalPnl / notional) * 100 : null,
              roe_pct: notional > 0 ? (totalPnl / (notional / LEVERAGE)) * 100 : null,
              opened_at: pos.openedAt, closed_at: new Date().toISOString(),
              exit_reason: reason, be_reached: true, shadow: true,
            }).catch(() => {});
            shadowPositions.delete(symbol);
            saveShadow();

            const titles = { TRAIL: '✅ [SHADOW] TP2 / Trailing', BREAKEVEN: '🛡️ [SHADOW] Breakeven', SL: '🔴 [SHADOW] Stop Loss BE' };
            const title  = titles[reason] ?? '🏁 [SHADOW] Clôture';
            console.log(`[shadow-pm] ${reason} ${symbol} price=${fmt(exitPrice)} pnl=${totalPnl.toFixed(2)}`);
            sendTelegram([
              `${title} — <code>${symbol}</code>`,
              `📈 <b>${pos.direction}</b> | Entrée <code>${fmt(pos.entry)}</code> → Sortie <code>${fmt(exitPrice)}</code>`,
              `💵 PnL simulé : <b>${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT</b>`,
            ].join('\n')).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[shadow-pm] poll error ${symbol}:`, err.message);
      }
    }
  } finally {
    _pollRunning = false;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
export function getShadowPositions() {
  return [...shadowPositions.entries()].map(([symbol, pos]) => ({ symbol, ...pos }));
}

let _intervalHandle = null;

export function initShadowTracker() {
  if (_intervalHandle) return;
  loadShadow();
  _intervalHandle = setInterval(() => {
    pollShadowPositions().catch(err => console.error('[shadow-pm] interval error:', err.message));
  }, POLL_MS);
  console.log('[shadow-pm] Shadow tracker démarré (polling 60s)');
}
