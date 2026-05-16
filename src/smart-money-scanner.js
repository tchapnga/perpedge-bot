// Smart Money Scanner — détecte accumulation 4H pour spot DCA
// Signal: prix baissé > 20% sur 7j + funding négatif + OI stabilisé + volume en baisse (épuisement vendeurs)
import { apiGet } from './perp-client.js';
import { getBotState } from './bot-state.js';
import { startDCA } from './spot-dca-manager.js';
import { sendTelegram } from './notifier.js';

const SCAN_INTERVAL_MS   = 4 * 3600_000;  // toutes les 4h
const COOLDOWN_MS        = 24 * 3600_000; // 24h par symbole
const MIN_VOLUME_USD     = 100_000_000;   // 100M 24h
const PRICE_DROP_4H_PCT  = -3;            // drop récent 4H > 3%
const FUNDING_MAX        = -0.0002;       // funding négatif (shorts surpayants)
const OI_STABLE_MAX      = 3;            // OI change 4h < 3% abs (stabilisation)
const MIN_SCORE          = 3;             // score min pour déclencher

const cooldowns = new Map();

async function scanSmartMoney() {
  let candidates;
  try {
    // Start from tokens with negative funding (sellers exhausting)
    const extremes = await apiGet('scan/funding-extremes', { min_abs_rate: 0.0001, limit: 30 });
    candidates = (extremes.most_negative ?? []).filter(e => e.funding_rate <= FUNDING_MAX);
  } catch (err) {
    console.error('[smart-money] scan error:', err.message);
    return;
  }

  if (!candidates.length) {
    console.log('[smart-money] Aucun candidat funding négatif.');
    return;
  }

  const now = Date.now();

  await Promise.allSettled(candidates.map(async ({ symbol, funding_rate, mark_price }) => {
    const last = cooldowns.get(symbol);
    if (last && now - last < COOLDOWN_MS) return;

    let ta, oi4h;
    try {
      [ta, oi4h] = await Promise.all([
        apiGet('ta-analysis', { symbol }, 15000),
        apiGet('oi-change', { symbol, period: '4h', lookback: 2 }, 10000),
      ]);
    } catch { return; }

    const price4hPct = ta?.tf_4h?.close && ta?.tf_1h?.close
      ? ((ta.tf_1h.close - ta.tf_4h.close) / ta.tf_4h.close) * 100 // approx 4h move
      : null;
    const oiChangePct = oi4h?.oi_change_pct ?? 0;
    const rsi4h       = ta?.tf_4h?.rsi ?? 50;
    const trend4h     = ta?.tf_4h?.trend ?? 'neutral';
    const vol24h      = ta?.tf_1h?.volume ?? 0;

    if (vol24h < MIN_VOLUME_USD) return;

    // Score accumulation signals
    let score = 0;
    const detail = [];

    if (funding_rate <= FUNDING_MAX)               { score++; detail.push(`FUNDING ${(funding_rate * 100).toFixed(4)}%`); }
    if (rsi4h < 35)                                { score++; detail.push(`RSI4H ${rsi4h.toFixed(0)}`); }
    if (Math.abs(oiChangePct) <= OI_STABLE_MAX)    { score++; detail.push(`OI_STABLE ${oiChangePct.toFixed(1)}%`); }
    if (price4hPct !== null && price4hPct < PRICE_DROP_4H_PCT) { score++; detail.push(`DROP ${price4hPct.toFixed(1)}%`); }
    if (trend4h === 'bearish')                     { detail.push('4H_BEARISH_CTX'); } // context, no score
    else if (trend4h === 'neutral')                { score++; detail.push('4H_NEUTRAL_BASE'); } // potential reversal

    if (score < MIN_SCORE) return;

    console.log(`[smart-money] 💎 ${symbol} score=${score}/5 — ${detail.join(' | ')}`);
    cooldowns.set(symbol, now);

    try {
      await sendTelegram([
        `💎 <b>SMART MONEY</b>  ·  ${symbol}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Score <b>${score}/5</b>  ·  <i>${detail.join(' · ')}</i>`,
        `Prix <code>$${Number(mark_price).toFixed(4)}</code>`,
        ``,
        `<i>⚠️ Informationnel · DCA Spot déclenché — pas de trade perp automatique</i>`,
      ].join('\n'));
    } catch (err) {
      console.error(`[smart-money] Telegram ${symbol}:`, err.message);
    }

    await startDCA(symbol, Number(mark_price)).catch(err =>
      console.error(`[smart-money] startDCA ${symbol}:`, err.message)
    );
  }));
}

export function startSmartMoneyScanner() {
  console.log(`[smart-money] Démarré — scan toutes les 4h`);
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!getBotState().modules.smartMoney) return;
      await scanSmartMoney();
    } catch (err) {
      console.error('[smart-money] tick error:', err.message);
    } finally {
      isRunning = false;
      schedule();
    }
  };
  const schedule = () => setTimeout(() => tick().catch(console.error), SCAN_INTERVAL_MS);
  tick().catch(console.error);
}
