// Test : capture chart BTCUSDT + envoi Telegram — simule un signal WATCH
// Usage : node scripts/test-chart-watch.mjs
import { captureChart, cleanChart } from '../src/chart-capture.js';
import { sendTelegramPhoto }        from '../src/notifier.js';

// Prix BTC live → niveaux réalistes
const res  = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
const data = await res.json();
const mark = Number(data.markPrice);

const entry = mark;
const sl    = +(mark * 0.985).toFixed(2);   // -1.5%
const tp    = +(mark * 1.022).toFixed(2);   // +2.2%
const rr    = +((tp - entry) / (entry - sl)).toFixed(2);

console.log(`[test] BTCUSDT mark=${mark.toFixed(2)}  entry=${entry.toFixed(2)}  sl=${sl}  tp=${tp}  R:R=${rr}`);

// Contexte simulé pour tester la bande texte + lignes S/R
const chartCtx = {
  trend1h:    'BULLISH',
  trend4h:    'NEUTRAL',
  trend1d:    'BULLISH',
  rsi:        54,
  score:      7.5,
  oiTrigger:  '+3.2% Δ5m',
  support:    +(mark * 0.992).toFixed(2),
  resistance: +(mark * 1.008).toFixed(2),
};

console.log('[test] Capture chart...');
const path = await captureChart('BTCUSDT', '1h', { entry, sl, tp, signal: 'LONG' }, chartCtx);

if (!path) { console.error('[test] Chart capture échoué'); process.exit(1); }

const caption = [
  `⚠️ <b>OI EXPLOSION — WATCH</b> · BTCUSDT`,
  `<code>Long Buildup</code>  ·  R:R <b>${rr}</b>`,
  `<i>⚠️ WATCH — R:R insuffisant, pas de trade automatique</i>`,
  ``,
  `Entry <b>$${entry.toFixed(2)}</b>  ·  TP <b>$${tp}</b>  ·  SL <b>$${sl}</b>`,
  `<i>📊 Test visuel — est-ce suffisant pour décider manuellement ?</i>`,
].join('\n');

console.log('[test] Envoi Telegram...');
await sendTelegramPhoto(path, caption);
await cleanChart(path);
console.log('[test] ✅ Envoyé — vérifie Telegram.');
