// Crowded Unwind Watcher — ADR-4: détecte longs surendettés + capitulation OI + prix en baisse → SHORT bypass Phase 1
import { runAnalysis } from './scorer.js';
import { getBotState } from './bot-state.js';
import { buildCrowdedUnwindMessage, sendTelegram } from './notifier.js';
import { injectSignal } from './injector.js';
import { apiGet } from './perp-client.js';
import { config } from './config.js';

const FUNDING_THRESHOLD   = 0.0004;      // >0.04% funding positif (longs surendettés)
const OI_CHANGE_THRESHOLD = -5.0;        // OI_1h < -5% (capitulation en cours)
const POLL_INTERVAL_MS    = 5 * 60_000;  // poll toutes les 5min
const COOLDOWN_MS         = 15 * 60_000; // 15min entre deux analyses du même token

const cooldowns = new Map();

async function fetchPrice1hChangePct(symbol) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=2`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.length < 2) return null;
  const prevClose = parseFloat(data[0][4]);
  const currClose = parseFloat(data[1][4]);
  return ((currClose - prevClose) / prevClose) * 100;
}

async function pollOnce() {
  let extremes;
  try {
    extremes = await apiGet('scan/funding-extremes', { min_abs_rate: FUNDING_THRESHOLD, limit: 20 });
  } catch (err) {
    console.warn('[crowded-unwind] funding scan failed:', err.message);
    return;
  }

  const candidates = (extremes.most_positive ?? []).filter(e => (e.funding_rate ?? 0) >= FUNDING_THRESHOLD);
  if (!candidates.length) return;

  const now = Date.now();

  await Promise.allSettled(candidates.map(async ({ symbol, funding_rate }) => {
    const lastAlert = cooldowns.get(symbol) ?? 0;
    if (now - lastAlert < COOLDOWN_MS) return;

    let oiData, pricePct;
    try {
      [oiData, pricePct] = await Promise.all([
        apiGet('oi-change', { symbol, period: '1h', lookback: 6 }),
        fetchPrice1hChangePct(symbol),
      ]);
    } catch { return; }

    const oiChangePct = oiData?.oi_change_pct ?? 0;
    if (oiChangePct >= OI_CHANGE_THRESHOLD) return;
    if (pricePct === null || pricePct >= 0) return;

    const triggerLabel = `funding ${(funding_rate * 100).toFixed(4)}% / OI ${oiChangePct.toFixed(2)}% / Δ1h ${pricePct.toFixed(2)}%`;
    console.log(`[crowded-unwind] 🔻 ${symbol} — ${triggerLabel} → analyse SHORT`);
    cooldowns.set(symbol, now);

    try {
      const result = await runAnalysis(symbol, ['crowded_unwind']);
      result.scan_count      = 1;
      result.scans           = ['crowded_unwind'];
      result.crowded_trigger = triggerLabel;

      console.log(`[crowded-unwind] ${result.signal} ${symbol} — ${result.total}/10 (TA:${result.ta_score} | DER:${result.der_score})`);
      if (result.veto_reason) console.log(`  [VETO] ${result.veto_reason}`);
      if (result.gate_block)  console.log(`  [GATE] ${result.gate_reason}`);

      if (result.signal === 'NO_TRADE' || result.total < config.minScore) return;

      await sendTelegram(buildCrowdedUnwindMessage(result, triggerLabel));
      await injectSignal(result);
    } catch (err) {
      console.error(`[crowded-unwind] Analyse ${symbol} échouée:`, err.message);
    }
  }));
}

export function startCrowdedUnwindWatcher() {
  console.log(`[crowded-unwind] Démarré — poll ${POLL_INTERVAL_MS / 60_000}min, seuils: funding>${FUNDING_THRESHOLD * 100}% / OI_1h<${OI_CHANGE_THRESHOLD}% / prix<0`);
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!getBotState().modules.crowdedUnwind) return;
      await pollOnce();
    } catch (err) {
      console.error('[crowded-unwind] tick error:', err.message);
    } finally {
      isRunning = false;
      schedule();
    }
  };
  const schedule = () => setTimeout(() => tick().catch(console.error), POLL_INTERVAL_MS);
  tick().catch(console.error);
}
