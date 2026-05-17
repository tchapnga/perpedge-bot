// Spot DCA Manager — accumulation en 3 tranches à prix dégressifs
// checkFills() spec validée 3/3 LLMs 2026-05-17
// Guard BINANCE_TESTNET validé 3/3 LLMs 2026-05-17 (B+D dans startDCA)
import { getSpotOrderStatus, placeSpotBuy, cancelSpotOrder } from './spot-executor.js';
import { sendTelegram } from './notifier.js';
import { isSpotTradingBlocked, isTestnet, isSpotLiveAllowed } from './utils/guards.js';

const DEFAULT_TOTAL_USDT = Number(process.env.SPOT_DCA_USDT) || 150;
const TRANCHE_COUNT      = 3;
const TRANCHE_PCTS       = [0, -0.01, -0.02];   // entry, -1%, -2%
const CHECK_INTERVAL_MS  = 60_000;              // 60s
const MAX_DCA_AGE_MS     = 7 * 24 * 3600_000;  // expire après 7 jours
const TERMINAL_STATUSES  = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'];
const STALE_THRESHOLD    = 2;                   // cycles sans réponse → alerte

const activeDCA  = new Map();  // symbol → state
const dcaHistory = new Map();  // `${symbol}_${openedAt}` → archive
let   intervalHandle = null;

function isTerminal(status) { return TERMINAL_STATUSES.includes(status); }

function buildDCAMessage(symbol, tranches, totalQuoteSpent, avgPrice) {
  const filled  = tranches.filter(t => t.status === 'FILLED');
  const pending = tranches.filter(t => !isTerminal(t.status));
  const ts = new Date().toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return [
    `💰 <b>DCA SPOT</b>  ·  ${symbol}`,
    `Tranches : ${filled.length}/${TRANCHE_COUNT} remplies  ·  Dépensé ${totalQuoteSpent.toFixed(1)} USDT`,
    avgPrice > 0 ? `Prix moyen : <code>$${avgPrice.toFixed(4)}</code>` : '',
    pending.length ? `En attente : ${pending.map(t => `@$${t.price.toFixed(4)}`).join(', ')}` : '✅ Toutes remplies',
    `<i>${ts} UTC</i>`,
  ].filter(Boolean).join('\n');
}

async function _closeSession(symbol, endReason) {
  const state = activeDCA.get(symbol);
  if (!state) return;

  if (endReason === 'ALL_FILLED') {
    const body = state.totalExecutedQty > 0
      ? `Prix moyen : <code>$${state.avgPrice.toFixed(4)}</code>\nTotal : ${state.totalQuoteSpent.toFixed(1)} USDT`
      : 'Aucune exécution';
    await sendTelegram(`✅ <b>DCA COMPLET</b>  ·  ${symbol}\nToutes tranches remplies\n${body}`).catch(() => {});
  } else if (endReason === 'PARTIAL_TERMINAL') {
    const n   = state.tranches.filter(t => t.status === 'FILLED').length;
    const body = state.totalExecutedQty > 0 ? `Prix moyen : <code>$${state.avgPrice.toFixed(4)}</code>` : 'Aucune exécution';
    await sendTelegram(`⚠️ <b>DCA PARTIEL</b>  ·  ${symbol}\n${n}/${TRANCHE_COUNT} tranches remplies\n${body}`).catch(() => {});
  }

  // Deep copy pour éviter mutation après delete
  dcaHistory.set(`${symbol}_${state.openedAt}`, JSON.parse(JSON.stringify({ ...state, endReason, endTime: Date.now() })));
  activeDCA.delete(symbol);
  console.log(`[spot-dca] Session fermée ${symbol} — ${endReason}`);
}

export async function startDCA(symbol, markPrice) {
  // Guard défensif (Option B+D — consensus 3/3 LLMs 2026-05-17)
  // Binance Spot API n'a pas de testnet — bloquer si BINANCE_TESTNET=true ou ENABLE_SPOT_LIVE_TRADING!=true
  if (isSpotTradingBlocked()) {
    const reason = isTestnet()
      ? `BINANCE_TESTNET=true (Spot API toujours production)`
      : `ENABLE_SPOT_LIVE_TRADING non activé`;
    console.warn(`[spot-dca] DRY-RUN BLOCKED — ${symbol} @${markPrice} — ${reason}`);
    await sendTelegram(
      `🧪 <b>[DRY-RUN] DCA Spot simulé</b>  ·  <code>${symbol}</code>\n` +
      `@<code>${markPrice}</code> — ${reason}\nAucun ordre réel envoyé.`
    ).catch(() => {});
    return;
  }

  if (activeDCA.has(symbol)) {
    console.log(`[spot-dca] ${symbol} DCA déjà actif — skip`);
    return;
  }

  const trancheUsdt    = DEFAULT_TOTAL_USDT / TRANCHE_COUNT;
  const tranches       = [];
  let totalExecutedQty = 0;
  let totalQuoteSpent  = 0;

  for (let i = 0; i < TRANCHE_COUNT; i++) {
    const price = markPrice * (1 + TRANCHE_PCTS[i]);
    try {
      const result = await placeSpotBuy({ symbol, quoteAmount: trancheUsdt, limitPrice: i === 0 ? null : price });
      if (i === 0) {
        const execQty  = result.qty;
        const quoteQty = result.quoteSpent ?? trancheUsdt;
        totalExecutedQty += execQty;
        totalQuoteSpent  += quoteQty;
        tranches.push({ index: 0, price: result.price, orderId: result.orderId, status: 'FILLED', executedQty: execQty, cummulativeQuoteQty: quoteQty, lastCheckedAt: Date.now(), staleCount: 0 });
      } else {
        tranches.push({ index: i, price, orderId: result.orderId, status: 'NEW', executedQty: 0, cummulativeQuoteQty: 0, lastCheckedAt: null, staleCount: 0 });
      }
      console.log(`[spot-dca] Tranche ${i + 1}/${TRANCHE_COUNT} ${symbol} @${price.toFixed(4)} orderId=${result.orderId}`);
    } catch (err) {
      console.error(`[spot-dca] Tranche ${i + 1} error ${symbol}:`, err.message);
      tranches.push({ index: i, price, orderId: null, status: 'REJECTED', executedQty: 0, cummulativeQuoteQty: 0, lastCheckedAt: Date.now(), staleCount: 0, error: err.message });
    }
  }

  const avgPrice = totalExecutedQty > 0 ? totalQuoteSpent / totalExecutedQty : 0;
  const state = {
    symbol, markPrice, tranches,
    totalExecutedQty, totalQuoteSpent, avgPrice,
    openedAt: Date.now(),
    cancelRequestedByBot: false, cancelSource: null,
  };
  activeDCA.set(symbol, state);

  await sendTelegram(buildDCAMessage(symbol, tranches, totalQuoteSpent, avgPrice)).catch(err => console.error(`[spot-dca] Telegram ${symbol}:`, err.message));
}

export async function cancelDCA(symbol, reason = 'MANUAL_CANCEL') {
  const state = activeDCA.get(symbol);
  if (!state) return;

  // Flag AVANT DELETE Binance — distingue BOT_CANCEL vs EXTERNAL_CANCEL
  state.cancelRequestedByBot = true;
  state.cancelSource = reason;

  for (const t of state.tranches) {
    if (isTerminal(t.status) || !t.orderId) continue;
    await cancelSpotOrder(symbol, t.orderId).catch(err => console.warn(`[spot-dca] cancel ${symbol} #${t.orderId}:`, err.message));
    t.status = 'CANCELED';
  }

  await sendTelegram(`🛑 <b>DCA ANNULÉ</b>  ·  ${symbol}\nRaison : ${reason}`).catch(() => {});
  await _closeSession(symbol, reason);
}

async function checkFills() {
  const now = Date.now();
  for (const [symbol, state] of activeDCA.entries()) {
    if (now - state.openedAt > MAX_DCA_AGE_MS) {
      await cancelDCA(symbol, 'EXPIRED_7DAYS');
      continue;
    }

    let sessionChanged = false;

    for (const t of state.tranches) {
      if (isTerminal(t.status) || !t.orderId) continue;

      let result;
      try {
        result = await getSpotOrderStatus(symbol, t.orderId);
        t.lastCheckedAt = Date.now();
        t.staleCount    = 0;
      } catch (err) {
        console.error(`[spot-dca] status error ${symbol} #${t.orderId}:`, err.message);
        t.staleCount = (t.staleCount ?? 0) + 1;
        if (t.staleCount >= STALE_THRESHOLD) {
          await sendTelegram(`⚠️ <b>DCA STUCK</b>  ·  ${symbol}\nTranche ${t.index + 1} — pas de réponse API (${t.staleCount} cycles) — vérification manuelle requise`).catch(() => {});
        }
        continue; // ne pas clôturer sur erreur temporaire
      }

      const prevStatus = t.status;
      const newStatus  = result.status;
      const newExecQty = Number(result.executedQty);
      const newCumQty  = Number(result.cummulativeQuoteQty);

      // PARTIALLY_FILLED — mise à jour cumuls sans notification
      if (newStatus === 'PARTIALLY_FILLED') {
        t.status              = newStatus;
        t.executedQty         = newExecQty;
        t.cummulativeQuoteQty = newCumQty;
        sessionChanged = true;
        continue;
      }

      // Idempotence — aucune action si statut inchangé
      if (newStatus === prevStatus) continue;

      t.status              = newStatus;
      t.executedQty         = newExecQty;
      t.cummulativeQuoteQty = newCumQty;
      sessionChanged = true;

      if (newStatus === 'FILLED') {
        state.totalExecutedQty += newExecQty;
        state.totalQuoteSpent  += newCumQty;
        state.avgPrice = state.totalExecutedQty > 0 ? state.totalQuoteSpent / state.totalExecutedQty : 0;
        await sendTelegram(buildDCAMessage(symbol, state.tranches, state.totalQuoteSpent, state.avgPrice)).catch(err => console.error(`[spot-dca] Telegram:`, err.message));
      } else if (isTerminal(newStatus) && !state.cancelRequestedByBot) {
        await sendTelegram(`⚠️ <b>DCA EXTERNE</b>  ·  ${symbol}\nTranche ${t.index + 1} annulée (${newStatus}) — vérification manuelle`).catch(() => {});
      }
    }

    if (sessionChanged) {
      const allDone = state.tranches.every(t => isTerminal(t.status) || !t.orderId);
      if (allDone) {
        let endReason;
        if (state.cancelRequestedByBot) {
          endReason = state.cancelSource ?? 'MANUAL_CANCEL';
        } else if (state.tranches.every(t => t.status === 'FILLED' || !t.orderId)) {
          endReason = 'ALL_FILLED';
        } else {
          endReason = 'PARTIAL_TERMINAL';
        }
        await _closeSession(symbol, endReason);
      }
    }
  }
}

export function getActiveDCA() {
  return [...activeDCA.entries()].map(([symbol, state]) => ({ symbol, ...state }));
}

export function getDCAHistory() {
  return [...dcaHistory.values()];
}

export function startSpotDCAManager() {
  if (intervalHandle) return intervalHandle;
  console.log(`[spot-dca] Démarré — check fills ${CHECK_INTERVAL_MS / 1000}s`);
  intervalHandle = setInterval(() => {
    checkFills().catch(err => console.error('[spot-dca] check error:', err.message));
  }, CHECK_INTERVAL_MS);
  return intervalHandle;
}
