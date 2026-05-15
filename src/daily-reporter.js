import cron from 'node-cron';
import { readAllTrades } from './trade-journal.js';
import { sendTelegram }  from './notifier.js';

function getYesterdayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
    .toISOString().slice(0, 10);
}

export function startDailyReporter() {
  cron.schedule('0 8 * * *', async () => {
    try {
      const yesterday = getYesterdayUtc();
      const trades = await readAllTrades();
      const yesterdayTrades = trades.filter(t => t.closed_at?.slice(0, 10) === yesterday);

      if (!yesterdayTrades.length) {
        await sendTelegram(`📊 <b>Rapport quotidien PerpEdge</b>\n\nAucun trade hier.`);
        return;
      }

      const totalTrades = yesterdayTrades.length;
      const winners     = yesterdayTrades.filter(t => Number(t.pnl_usdt || 0) > 0);
      const winRate     = Math.round(winners.length / totalTrades * 100);
      const totalPnl    = yesterdayTrades.reduce((s, t) => s + Number(t.pnl_usdt || 0), 0);
      const sorted      = [...yesterdayTrades].sort((a, b) => Number(a.pnl_usdt || 0) - Number(b.pnl_usdt || 0));
      const worst       = sorted[0];
      const best        = sorted[sorted.length - 1];

      const sign = (n) => n >= 0 ? '+' : '';

      await sendTelegram([
        `📊 <b>Rapport quotidien PerpEdge</b> — ${yesterday}`,
        ``,
        `Trades : ${totalTrades} | Win rate : ${winRate}%`,
        `PnL net : <b>${sign(totalPnl)}${totalPnl.toFixed(2)} USDT</b>`,
        `Meilleur : ${best.symbol} ${best.direction} <b>${sign(Number(best.pnl_usdt))}${Number(best.pnl_usdt).toFixed(2)} USDT</b>`,
        `Pire : ${worst.symbol} ${worst.direction} <b>${sign(Number(worst.pnl_usdt))}${Number(worst.pnl_usdt).toFixed(2)} USDT</b>`,
      ].join('\n'));
    } catch (err) {
      console.error('[daily-reporter] error:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('[daily-reporter] Rapport quotidien planifié 08:00 UTC');
}
