// Capitulation Watcher — détecte price 4h drop + funding négatif + OI collapse → LONG setup
import { runAnalysis } from './scorer.js';
import { getBotState } from './bot-state.js';
import { buildCombinedMessage, sendTelegram, sendTelegramPhoto } from './notifier.js';
import { injectSignal, computeLevels } from './injector.js';
import { captureChart, cleanChart } from './chart-capture.js';
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

    // R:R computation
    const lvls   = computeLevels(result);
    const risk   = Math.abs(lvls.entry - lvls.sl);
    const reward = Math.abs(lvls.tp1   - lvls.entry);
    const rr     = (risk > 1e-8 && reward > 1e-8) ? reward / risk : 0;
    result._levels = lvls;
    result._rr     = rr > 0 ? +rr.toFixed(2) : null;

    // TRADE / WATCH / IGNORE
    const againstMacro = (result.direction === 'long'  && result.msb_direction === 'BEARISH') ||
                         (result.direction === 'short' && result.msb_direction === 'BULLISH');
    let capMode;
    if (rr >= 1.5)         capMode = 'TRADE';
    else if (!againstMacro) capMode = 'WATCH';
    else                    capMode = 'IGNORE';

    console.log(`[capitulation-watcher] mode=${capMode} R:R=${result._rr ?? 'N/A'}${againstMacro ? ' (contre-macro)' : ''}`);
    if (capMode === 'IGNORE') return;

    // Set cooldown before Telegram — évite spam loop si Telegram throw
    cooldowns.set(symbol, Date.now());

    try {
      const modeTag  = capMode === 'WATCH'
        ? '\n<i>⚠️ WATCH — R:R insuffisant, pas de trade automatique</i>'
        : '';
      const rrLine   = `R:R <b>${result._rr ?? 'N/A'}</b>  ·  Mode <b>${capMode}</b>${modeTag}`;
      const header   = buildCapitulationHeader(setup);
      const body     = buildCombinedMessage([result]);
      await sendTelegram(`${header}\n${rrLine}\n\n${body}`);
      console.log(`[capitulation-watcher] Alerte ${capMode} envoyée: ${symbol} (${confidence} ${signals_fired}/3)`);
    } catch (err) {
      console.error(`[capitulation-watcher] Telegram error ${symbol}:`, err.message);
    }

    // Chart — async, fail-open, uniquement si R:R ≥ 2.0
    if (result._rr != null && result._rr >= 2.0) {
      const dir    = result.direction === 'long' ? 'LONG' : 'SHORT';
      const levels = { entry: lvls.entry, sl: lvls.sl, tp: lvls.tp1, signal: dir };
      captureChart(symbol, '1h', levels)
        .then(path => {
          if (!path) return;
          const cap = `📊 <b>${symbol}</b> · 1H · ${dir} · 💀 Capitulation · R:R ${result._rr}`;
          return sendTelegramPhoto(path, cap).then(() => cleanChart(path));
        })
        .catch(err => console.warn(`[capitulation-watcher] chart ${symbol}:`, err.message));
    }

    if (capMode === 'TRADE') {
      try {
        await injectSignal(result);
      } catch (err) {
        console.error(`[capitulation-watcher] injectSignal ${symbol}:`, err.message);
      }
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
