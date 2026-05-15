import { appendFile, readFile } from 'fs/promises';
import { join } from 'path';

const JOURNAL_PATH = join(process.cwd(), 'trade_journal.jsonl');

export async function logTrade(entry) {
  if (!entry?.symbol) return;
  const line = JSON.stringify({ ...entry, logged_at: new Date().toISOString() });
  try {
    await appendFile(JOURNAL_PATH, line + '\n', 'utf8');
    console.log(`[trade-journal] Logged ${entry.symbol} ${entry.direction} pnl=${entry.pnl_usdt?.toFixed(2) ?? '?'}`);
  } catch (err) {
    console.error('[trade-journal] write error:', err.message);
  }
}

export async function readAllTrades() {
  try {
    const raw = await readFile(JOURNAL_PATH, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[trade-journal] read error:', err.message);
    return [];
  }
}
