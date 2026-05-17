// OI Explosion Watcher — polling REST 60s sur watchlist, déclenche Phase 2+3 event-driven
import { runAnalysis } from './scorer.js';
import { getBotState } from './bot-state.js';
import { buildCombinedMessage, sendTelegram, sendTelegramPhoto } from './notifier.js';
import { injectSignal, computeLevels } from './injector.js';
import { captureChart, cleanChart } from './chart-capture.js';
import { apiGet } from './perp-client.js';
import { config } from './config.js';

const OI_5M_THRESHOLD_PCT  = 2.0;    // >2% sur 5min → déclenche analyse
const OI_15M_THRESHOLD_PCT = 5.0;    // >5% sur 15min → déclenche analyse
const OI_WATCH_MULTIPLIER  = 2.0;    // WATCH mode : OI ≥ 2× le seuil normal requis
const POLL_INTERVAL_MS     = 60_000; // poll OI toutes les 60s
const COOLDOWN_MS          = 10 * 60_000; // 10min entre deux analyses du même token
const MAX_HISTORY_MS       = 20 * 60_000; // buffer de 20min max

// oiHistory : symbol → [{ts, oi}]
const oiHistory = new Map();
const cooldowns = new Map();

// Watchlist dynamique — top tokens funding extrême + top volume statique
let watchlist = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT'];

async function refreshWatchlist() {
  try {
    const res = await apiGet('scan/funding-extremes', { min_abs_rate: 0.0002, limit: 25 });
    const dynamic = [
      ...(res.most_positive ?? []).map(e => e.symbol),
      ...(res.most_negative ?? []).map(e => e.symbol),
    ];
    watchlist = [...new Set([...watchlist, ...dynamic])].slice(0, 40);
    console.log(`[oi-watcher] Watchlist: ${watchlist.length} tokens`);
  } catch (err) {
    console.warn('[oi-watcher] Watchlist refresh failed:', err.message);
  }
}

async function fetchOI(symbol) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return parseFloat(data.openInterest);
}

function getOiAtAge(history, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ts <= cutoff) return history[i];
  }
  return null;
}

function pruneHistoryInPlace(hist) {
  const cutoff = Date.now() - MAX_HISTORY_MS;
  while (hist.length > 0 && hist[0].ts < cutoff) hist.shift();
}

// Matrice OI × Prix → interprétation institutionnelle
function classifyOiMove(oiDelta, trend) {
  const oiUp    = oiDelta > 0;
  const priceUp = trend === 'BULLISH';
  if (oiUp  &&  priceUp) return 'Long Buildup';
  if (oiUp  && !priceUp) return 'Short Buildup';
  if (!oiUp &&  priceUp) return 'Short Squeeze';
  return 'Long Squeeze';
}

async function pollOnce() {
  const now = Date.now();

  await Promise.allSettled(watchlist.map(async (symbol) => {
    let oi;
    try { oi = await fetchOI(symbol); } catch { return; }

    const hist = oiHistory.get(symbol) ?? [];
    if (!oiHistory.has(symbol)) oiHistory.set(symbol, hist);
    pruneHistoryInPlace(hist);
    hist.push({ ts: now, oi });

    if (hist.length < 2) return;

    // Calcul des deltas
    const snap5m  = getOiAtAge(hist, 5 * 60_000);
    const snap15m = getOiAtAge(hist, 15 * 60_000);

    const delta5m  = snap5m  ? ((oi - snap5m.oi)  / snap5m.oi)  * 100 : null;
    const delta15m = snap15m ? ((oi - snap15m.oi) / snap15m.oi) * 100 : null;

    const triggered = (delta5m  != null && Math.abs(delta5m)  >= OI_5M_THRESHOLD_PCT) ||
                      (delta15m != null && Math.abs(delta15m) >= OI_15M_THRESHOLD_PCT);

    if (!triggered) return;

    // Cooldown check
    const lastAlert = cooldowns.get(symbol) ?? 0;
    if (now - lastAlert < COOLDOWN_MS) return;

    const label = delta5m != null && Math.abs(delta5m) >= OI_5M_THRESHOLD_PCT
      ? `Δ5m ${delta5m > 0 ? '+' : ''}${delta5m.toFixed(2)}%`
      : `Δ15m ${delta15m > 0 ? '+' : ''}${delta15m.toFixed(2)}%`;

    console.log(`[oi-watcher] 🔥 OI explosion ${symbol} — ${label} — déclenche analyse`);
    cooldowns.set(symbol, now);

    try {
      const result = await runAnalysis(symbol, ['oi_movers']);
      result.scan_count = 1;
      result.scans      = ['oi_movers'];
      result.oi_trigger = label;

      console.log(`[oi-watcher] ${result.signal} ${symbol} — ${result.total}/10 (TA:${result.ta_score} | DER:${result.der_score})`);
      if (result.veto_reason)  console.log(`  [VETO] ${result.veto_reason}`);
      if (result.gate_block)   console.log(`  [GATE] ${result.gate_reason}`);

      if (result.signal === 'NO_TRADE' || result.total < config.minScore) return;

      // R:R computation
      const lvls   = computeLevels(result);
      const risk   = Math.abs(lvls.entry - lvls.sl);
      const reward = Math.abs(lvls.tp1   - lvls.entry);
      const rr     = (risk > 1e-8 && reward > 1e-8) ? reward / risk : 0;
      result._levels = lvls;
      result._rr     = rr > 0 ? +rr.toFixed(2) : null;

      // OI direction × prix → interprétation
      const oiDelta  = delta5m ?? delta15m ?? 0;
      const trend    = result.ta?.tf_1h?.trend ?? 'NEUTRAL';
      const oiInterp = classifyOiMove(oiDelta, trend);

      // WATCH / TRADE / IGNORE
      const againstMacro = (result.direction === 'long'  && result.msb_direction === 'BEARISH') ||
                           (result.direction === 'short' && result.msb_direction === 'BULLISH');
      const oiMassif = Math.abs(oiDelta) >= OI_5M_THRESHOLD_PCT * OI_WATCH_MULTIPLIER ||
                       (delta15m != null && Math.abs(delta15m) >= OI_15M_THRESHOLD_PCT * OI_WATCH_MULTIPLIER);

      let oiMode;
      if (rr >= 1.5)                    oiMode = 'TRADE';
      else if (!againstMacro && oiMassif) oiMode = 'WATCH';
      else                               oiMode = 'IGNORE';

      console.log(`[oi-watcher] mode=${oiMode} R:R=${result._rr ?? 'N/A'} interp=${oiInterp}${againstMacro ? ' (contre-macro)' : ''}`);
      if (oiMode === 'IGNORE') return;

      // Message : header OI custom + buildCombinedMessage
      const watchTag = oiMode === 'WATCH' ? '⚠️ ' : '';
      const modeTag  = oiMode === 'WATCH'
        ? '\n<i>⚠️ WATCH — R:R insuffisant, pas de trade automatique</i>'
        : '';
      const headerOI = [
        `⚡ <b>${watchTag}OI EXPLOSION</b> · ${symbol}  <i>(${label})</i>`,
        `<code>${oiInterp}</code>  ·  R:R <b>${result._rr ?? 'N/A'}</b>${modeTag}`,
      ].join('\n');
      const msg = headerOI + '\n\n' + buildCombinedMessage([result]);

      await sendTelegram(msg);
      console.log(`[oi-watcher] Notification ${oiMode} envoyée — ${symbol}`);

      // Chart — async, fail-open : WATCH toujours (décision manuelle), TRADE si R:R ≥ 2.0
      if (oiMode === 'WATCH' || (result._rr != null && result._rr >= 2.0)) {
        const dir    = result.direction === 'long' ? 'LONG' : 'SHORT';
        const levels = { entry: lvls.entry, sl: lvls.sl, tp: lvls.tp1, signal: dir };
        captureChart(symbol, '1h', levels)
          .then(path => {
            if (!path) return;
            const cap = `📊 <b>${symbol}</b> · 1H · ${dir} · ⚡ OI · R:R ${result._rr}`;
            return sendTelegramPhoto(path, cap).then(() => cleanChart(path));
          })
          .catch(err => console.warn(`[oi-watcher] chart ${symbol}:`, err.message));
      }

      if (oiMode === 'TRADE') await injectSignal(result);
    } catch (err) {
      console.error(`[oi-watcher] Analyse ${symbol} échouée:`, err.message);
    }
  }));
}

export function startOiWatcher() {
  console.log(`[oi-watcher] Démarré — poll ${POLL_INTERVAL_MS / 1000}s, seuils: Δ5m>${OI_5M_THRESHOLD_PCT}% / Δ15m>${OI_15M_THRESHOLD_PCT}%`);
  refreshWatchlist();
  setInterval(refreshWatchlist, 30 * 60_000); // watchlist refresh reste sur setInterval (léger, pas de signaux)
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!getBotState().modules.oi) return;
      await pollOnce();
    } catch (err) {
      console.error('[oi-watcher] tick error:', err.message);
    } finally {
      isRunning = false;
      schedule();
    }
  };
  const schedule = () => setTimeout(() => tick().catch(console.error), POLL_INTERVAL_MS);
  tick().catch(console.error);
}
