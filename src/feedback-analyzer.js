import cron from 'node-cron';
import { readAllTrades } from './trade-journal.js';
import { sendTelegram } from './notifier.js';

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(part, total) {
  if (!total) return '0%';
  return ((part / total) * 100).toFixed(1) + '%';
}

function fmt2(n) {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

async function buildWeeklyReport() {
  const all = await readAllTrades();
  if (!all.length) return null;

  // Filter last 7 days
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  const week   = all.filter(t => t.closed_at && new Date(t.closed_at).getTime() >= cutoff);
  const trades = week.length ? week : all; // fallback to all if no recent

  const wins   = trades.filter(t => (t.pnl_usdt ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl_usdt ?? 0) <= 0);
  const totalPnl   = trades.reduce((s, t) => s + (t.pnl_usdt ?? 0), 0);
  const avgWin     = avg(wins.map(t => t.pnl_usdt ?? 0));
  const avgLoss    = avg(losses.map(t => t.pnl_usdt ?? 0));
  const expectancy = trades.length ? totalPnl / trades.length : 0;

  // Best / worst
  const sorted = [...trades].sort((a, b) => (b.pnl_usdt ?? 0) - (a.pnl_usdt ?? 0));
  const best  = sorted[0];
  const worst = sorted[sorted.length - 1];

  // Exit reasons
  const exitCounts = {};
  for (const t of trades) { exitCounts[t.exit_reason ?? 'UNKNOWN'] = (exitCounts[t.exit_reason ?? 'UNKNOWN'] ?? 0) + 1; }

  // Scans breakdown
  const scanCounts = {};
  for (const t of trades) {
    for (const s of (t.scans ?? [])) scanCounts[s] = (scanCounts[s] ?? 0) + 1;
  }
  const topScans = Object.entries(scanCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}(${v})`).join(' ');

  // Score analysis
  const scored = trades.filter(t => t.total != null);
  const winScores  = wins.filter(t => t.total != null).map(t => t.total);
  const lossScores = losses.filter(t => t.total != null).map(t => t.total);

  const ts = new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });

  const label = week.length ? `7 derniers jours (${trades.length} trades)` : `Tous les trades (${trades.length})`;

  const lines = [
    `📊 <b>RAPPORT HEBDOMADAIRE</b>  ·  ${label}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `<b>Performance globale</b>`,
    `├ PnL total     <code>${fmt2(totalPnl)} USDT</code>`,
    `├ Espérance     <code>${fmt2(expectancy)} USDT/trade</code>`,
    `├ Win rate      <code>${pct(wins.length, trades.length)}  (${wins.length}W / ${losses.length}L)</code>`,
    `├ Avg win       <code>${fmt2(avgWin)} USDT</code>`,
    `└ Avg loss      <code>${fmt2(avgLoss)} USDT</code>`,
    ``,
    `<b>Meilleur/Pire</b>`,
    `├ Best  ${best  ? `${best.symbol} ${fmt2(best.pnl_usdt)} USDT` : 'N/A'}`,
    `└ Worst ${worst ? `${worst.symbol} ${fmt2(worst.pnl_usdt)} USDT` : 'N/A'}`,
    ``,
    `<b>Exits</b>`,
    ...Object.entries(exitCounts).map(([k, v]) => `├ ${k.padEnd(10)} ${v} trades (${pct(v, trades.length)})`),
    ``,
    topScans ? `<b>Top scans</b>  <i>${topScans}</i>` : '',
    winScores.length && lossScores.length
      ? `<b>Score moyen</b>  Wins: ${avg(winScores).toFixed(1)}  Losses: ${avg(lossScores).toFixed(1)}`
      : '',
    ``,
    `<i>🔁 ${ts} UTC</i>`,
  ].filter(l => l !== '');

  return lines.join('\n');
}

export async function runFeedbackAnalysis() {
  try {
    const report = await buildWeeklyReport();
    if (!report) {
      console.log('[feedback-analyzer] Aucun trade à analyser.');
      return;
    }
    await sendTelegram(report);
    console.log('[feedback-analyzer] Rapport hebdomadaire envoyé.');
  } catch (err) {
    console.error('[feedback-analyzer] Error:', err.message);
  }
}

// Cron : dimanche 08:00 UTC
export function startFeedbackAnalyzer() {
  cron.schedule('0 8 * * 0', () => {
    runFeedbackAnalysis().catch(err => console.error('[feedback-analyzer] cron error:', err.message));
  }, { timezone: 'UTC' });
  console.log('[feedback-analyzer] Cron planifié : dimanche 08:00 UTC');
}
