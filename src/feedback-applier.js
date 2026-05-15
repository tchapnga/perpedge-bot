// Telegram polling — écoute les commandes /apply_N du chat configuré
import { config } from './config.js';
import { readAllTrades } from './trade-journal.js';
import { sendTelegram } from './notifier.js';

const POLL_INTERVAL_MS = 5_000;  // 5s
let lastUpdateId = 0;
let intervalHandle = null;

const RECOMMENDATIONS = [
  'Augmenter minScore à 7 pour réduire les faux signaux',
  'Désactiver les signaux MODÉRÉ en volatilité extrême',
  'Réduire la taille de position à 75% si win rate < 45%',
  'Augmenter le cooldown à 90min pour les tokens < 100M volume',
  'Exiger gate_block = false ET veto_reason = null avant toute entrée',
];

async function fetchUpdates() {
  if (!config.telegramBotToken) return [];
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.result) ? data.result : [];
}

async function handleApplyCommand(n) {
  const index = n - 1;
  if (index < 0 || index >= RECOMMENDATIONS.length) {
    await sendTelegram(`❌ <b>/apply_${n}</b> — Recommandation inexistante (1-${RECOMMENDATIONS.length})`);
    return;
  }
  const rec = RECOMMENDATIONS[index];
  await sendTelegram([
    `✅ <b>Recommandation #${n} notée</b>`,
    ``,
    `<i>${rec}</i>`,
    ``,
    `Cette recommandation est enregistrée. Applique-la manuellement dans la config ou le scorer.`,
  ].join('\n'));
  console.log(`[feedback-applier] /apply_${n} → ${rec}`);
}

async function handleStatsCommand() {
  const trades = await readAllTrades();
  if (!trades.length) { await sendTelegram('📋 Journal vide — aucun trade enregistré.'); return; }
  const wins = trades.filter(t => (t.pnl_usdt ?? 0) > 0).length;
  const total = trades.length;
  const pnl   = trades.reduce((s, t) => s + (t.pnl_usdt ?? 0), 0);
  await sendTelegram([
    `📋 <b>Stats rapides</b>`,
    `Trades : ${total}  ·  Win rate : ${((wins / total) * 100).toFixed(1)}%`,
    `PnL total : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`,
  ].join('\n'));
}

async function pollOnce() {
  let updates;
  try { updates = await fetchUpdates(); }
  catch { return; }

  for (const update of updates) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id);
    const text = update?.message?.text ?? update?.channel_post?.text ?? '';
    const chatId = String(update?.message?.chat?.id ?? update?.channel_post?.chat?.id ?? '');

    if (!text.startsWith('/')) continue;
    if (chatId !== String(config.telegramChatId)) continue;

    const applyMatch = text.match(/^\/apply_(\d+)/);
    if (applyMatch) { await handleApplyCommand(Number(applyMatch[1])).catch(() => {}); continue; }
    if (text.startsWith('/stats')) { await handleStatsCommand().catch(() => {}); }
  }
}

export function startFeedbackApplier() {
  if (!config.telegramBotToken) {
    console.log('[feedback-applier] Telegram non configuré — skip');
    return;
  }
  if (intervalHandle) return;
  console.log('[feedback-applier] Démarré — polling Telegram 5s');
  intervalHandle = setInterval(() => {
    pollOnce().catch(err => console.error('[feedback-applier] error:', err.message));
  }, POLL_INTERVAL_MS);
}
