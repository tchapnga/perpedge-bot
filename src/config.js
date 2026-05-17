import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env variable: ${name}`);
  return v;
}

export const config = {
  perpMcpUrl:       process.env.PERP_MCP_URL  || 'https://83-228-242-106.nip.io',
  perpMcpToken:     required('PERP_MCP_TOKEN'),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId:   process.env.TELEGRAM_CHAT_ID   || '',
  cronSchedule:     process.env.CRON_SCHEDULE || '0 * * * *',
  minScore:         Number(process.env.MIN_SCORE) || 5.0,
};
