import 'dotenv/config';
import { captureChart, cleanChart } from './src/chart-capture.js';
import { sendTelegramPhoto } from './src/notifier.js';

const symbol = process.argv[2] ?? 'BTCUSDT';
const tf     = process.argv[3] ?? '1h';

// Fetch current price to derive realistic levels around it
async function getLivePrice(sym) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
    const j = await r.json();
    return parseFloat(j.price);
  } catch { return null; }
}

const livePrice = await getLivePrice(symbol);
let levels = null;
if (livePrice) {
  const isSmall = livePrice < 1;
  const pct = isSmall ? 0.015 : 0.015;
  levels = {
    entry:  livePrice,
    sl:     +(livePrice * (1 - pct * 1.2)).toPrecision(isSmall ? 6 : 8),
    tp:     +(livePrice * (1 + pct * 2.0)).toPrecision(isSmall ? 6 : 8),
    signal: 'LONG',
  };
  console.log(`[test-chart] Prix live: ${livePrice} → ENTRY=${levels.entry} SL=${levels.sl} TP=${levels.tp}`);
} else {
  console.warn('[test-chart] Prix live non disponible — chart sans niveaux');
}

console.log(`[test-chart] Capture ${symbol} ${tf} en cours...`);

const path = await captureChart(symbol, tf, levels);
if (!path) {
  console.error('[test-chart] ÉCHEC — captureChart a retourné null (voir warn ci-dessus)');
  process.exit(1);
}

console.log(`[test-chart] ✓ Screenshot enregistré : ${path}`);

const dir = levels?.signal ?? 'LONG';
const caption = `📊 <b>${symbol}</b> · ${tf.toUpperCase()} · ${dir} · TEST niveaux ENTRY/SL/TP`;
try {
  await sendTelegramPhoto(path, caption);
  console.log('[test-chart] ✓ Photo envoyée sur Telegram.');
} catch (err) {
  console.error('[test-chart] sendTelegramPhoto error:', err.message);
}

await cleanChart(path);
console.log('[test-chart] ✓ Fichier temporaire supprimé. DONE.');
