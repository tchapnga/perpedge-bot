// Sends a Telegram crash alert via raw fetch — usable from uncaughtException handlers
// No grammy dependency so it works even before bot initialization

const TIMEOUT_MS = 3000;

function _escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function sendCrashAlert(err) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const rawMsg = err instanceof Error ? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(err);
  const safeMsg = _escapeHtml(rawMsg.slice(0, 400));
  const text = `⚠️ <b>PerpEdge CRASH</b>\n\n<code>${safeMsg}</code>\n\n🔄 PM2 restart en cours...`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal:  controller.signal,
    });
    clearTimeout(t);
  } catch {
    // Fail silently — crash notification must never block PM2 restart
  }
}
