// Capitulation Watcher — détecte price 4h drop + funding négatif + OI collapse → LONG setup
import { runAnalysis } from './scorer.js';
import { getBotState } from './bot-state.js';
import { buildCombinedMessage, sendTelegram } from './notifier.js';
import { injectSignal } from './injector.js';
import { apiGet } from './perp-client.js';
import { config } from './config.js';

const POLL_INTERVAL_MS = 5 * 60_000;   // 5min
const COOLDOWN_MS      = 20 * 60_000;  // 20min

const cooldowns = new Map();

function isInCooldown(symbol) {
  const last = cooldowns.get(symbol);
  return last && Date.now() - last < COOLDOWN_MS;
}

function buildCapitulationHeader(setup) {
  const price = setup.mark_price < 0.01
    ? setup.mark_price.toPrecision(4)
    : setup.mark_price.toFixed(4);
  return [
    `💀 <b>CAPITULATION</b> · ${setup.symbol}`,
    `Conf <b>${setup.confidence}</b> · ${setup.signals_fired}/3 signaux`,
    `<code>$${price}  ·  Δ4h ${setup.price_4h_pct.toFixed(1)}%  ·  Funding ${(setup.funding_rate_pct).toFixed(3)}%  ·  OI Δ1h ${setup.oi_1h_change_pct.toFixed(1)}%</code>`,
  ].join('\n');
}

async function pollOnce() {
  let setups;
  try {
    setups = await apiGet('scan/capitulation', { limit: 20 }, 30000);
  } catch (err) {
    console.error('[capitulation-watcher] Scan error:', err.message);
    return;
  }

  if (!Array.isArray(setups) || !setups.length) {
    console.log('[capitulation-watcher] Aucune capitulation détectée.');
    return;
  }

  const actionable = setups.filter(s => s.confidence === 'HIGH' || s.confidence === 'MEDIUM');
  if (!actionable.length) {
    console.log(`[capitulation-watcher] ${setups.length} LOW uniquement — pas d'alerte.`);
    return;
  }

  await Promise.allSettled(actionable.map(async (setup) => {
    const { symbol, confidence, signals_fired } = setup;
    if (isInCooldown(symbol)) {
      console.log(`[capitulation-watcher] ${symbol} cooldown actif — skip`);
      return;
    }

    let result;
    try {
      result = await runAnalysis(symbol, ['capitulation']);
      result.scan_count        = 1;
      result.scans             = ['capitulation'];
      result.capitulation_data = setup;
    } catch (err) {
      console.error(`[capitulation-watcher] runAnalysis ${symbol}:`, err.message);
      return;
    }

    console.log(`[capitulation-watcher] ${result.signal} ${symbol} — ${result.total}/10 (TA:${result.ta_score} | DER:${result.der_score}) conf=${confidence}`);
    if (result.veto_reason) console.log(`  [VETO] ${result.veto_reason}`);
    if (result.gate_block)  console.log(`  [GATE] ${result.gate_reason}`);

    if (result.signal === 'NO_TRADE' || result.total < config.minScore) return;

    // Set cooldown before Telegram — évite spam loop si Telegram throw
    cooldowns.set(symbol, Date.now());

    try {
      const header  = buildCapitulationHeader(setup);
      const body    = buildCombinedMessage([result]);
      await sendTelegram(`${header}\n${body}`);
      console.log(`[capitulation-watcher] Alerte envoyée: ${symbol} (${confidence} ${signals_fired}/3)`);
    } catch (err) {
      console.error(`[capitulation-watcher] Telegram error ${symbol}:`, err.message);
    }

    try {
      await injectSignal(result);
    } catch (err) {
      console.error(`[capitulation-watcher] injectSignal ${symbol}:`, err.message);
    }
  }));
}

export function startCapitulationWatcher() {
  console.log(`[capitulation-watcher] Démarré — poll ${POLL_INTERVAL_MS / 60_000}min, conf: HIGH|MEDIUM`);
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!getBotState().modules.capitulation) return;
      await pollOnce();
    } catch (err) {
      console.error('[capitulation-watcher] tick error:', err.message);
    } finally {
      isRunning = false;
      schedule();
    }
  };
  const schedule = () => setTimeout(() => tick().catch(console.error), POLL_INTERVAL_MS);
  tick().catch(console.error);
}
