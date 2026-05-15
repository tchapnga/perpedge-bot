// OI Explosion Watcher — polling REST 60s sur watchlist, déclenche Phase 2+3 event-driven
import { runAnalysis } from './scorer.js';
import { getBotState } from './bot-state.js';
import { buildMessage, sendTelegram } from './notifier.js';
import { injectSignal } from './injector.js';
import { apiGet } from './perp-client.js';
import { config } from './config.js';

const OI_5M_THRESHOLD_PCT  = 2.0;    // >2% sur 5min → déclenche analyse
const OI_15M_THRESHOLD_PCT = 5.0;    // >5% sur 15min → déclenche analyse
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

      await sendTelegram(`⚡ <b>OI EXPLOSION</b> · ${label}\n` + buildMessage(result));
      await injectSignal(result);
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
