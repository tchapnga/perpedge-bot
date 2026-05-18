import cron from 'node-cron';
import { appendFileSync, readFileSync } from 'fs';
import { sendCrashAlert } from './src/crash-notifier.js';
import { config } from './src/config.js';

// P9B.5 — PM2 crash alerts: notify Telegram before process exits so PM2 can restart
// Anti double-exit guard: both handlers funnel through _fatalExit
let _exiting = false;
async function _fatalExit(err) {
  if (_exiting) return;
  _exiting = true;
  const e = err instanceof Error ? err : new Error(String(err));
  console.error('[crash] fatal:', e);
  try { await sendCrashAlert(e); } finally { process.exit(1); }
}
process.on('uncaughtException', _fatalExit);
process.on('unhandledRejection', _fatalExit);
import { runPhase1 } from './src/scanner.js';
import { runAnalysis } from './src/scorer.js';
import { buildCombinedMessage, sendTelegram, sendTelegramPhoto, fmt } from './src/notifier.js';
import { captureChart, cleanChart } from './src/chart-capture.js';
import { injectSignal, computeLevels } from './src/injector.js';
import { executeOrder } from './src/order-executor.js';
import { registerTrade, startPositionManager, getTrackedPositions, bootReconcile, startUserDataStream, stopUserDataStream } from './src/position-manager.js';
import { startDashboard } from './src/dashboard.js';
import { startPreSqueezeWatcher } from './src/pre-squeeze-watcher.js';
import { startOiWatcher } from './src/oi-watcher.js';
import { startCrowdedUnwindWatcher } from './src/crowded-unwind-watcher.js';
import { startCapitulationWatcher } from './src/capitulation-watcher.js';
import { validateSignal } from './src/llm-validator.js';
import { startFeedbackAnalyzer } from './src/feedback-analyzer.js';
import { startFeedbackApplier } from './src/feedback-applier.js';
import { startSmartMoneyScanner } from './src/smart-money-scanner.js';
import { startSpotDCAManager } from './src/spot-dca-manager.js';
import { startScalpScanner } from './src/scalp-scanner.js';
import { scoreScalp } from './src/scalp-scorer.js';
import { registerScalpTrade, startScalpManager, getScalpPositions } from './src/scalp-manager.js';
import { startAdminApi, injectAdminDeps } from './src/admin-api.js';
import { startTelegramBot, stopTelegramBot, injectBotDeps } from './src/telegram-bot.js';
import { startDailyReporter }              from './src/daily-reporter.js';
import { recordCycle, recordSignal, recordTrade, isEntryPaused, isPausedAll, isEmergencyStopped, getMode } from './src/bot-state.js';
import { registerShadowTrade, getShadowPositions, initShadowTracker } from './src/shadow-position-manager.js';

// Préfixe [MAINNET]/[TESTNET] sur chaque ligne — filtrable via grep
const _NET = process.env.BINANCE_TESTNET === 'true' ? '[TESTNET]' : '[MAINNET]';
{ const { log, error, warn } = console;
  console.log   = (...a) => log(_NET, ...a);
  console.error = (...a) => error(_NET, ...a);
  console.warn  = (...a) => warn(_NET, ...a); }

async function runCycle() {
  if (isEmergencyStopped() || isPausedAll()) {
    console.log('[cycle] PAUSED ALL — cycle ignoré.');
    return;
  }

  const now  = new Date().toISOString();
  const mode = getMode();
  console.log(`\n[${now}] ── Cycle PerpEdge ──────────────────────`);
  recordCycle();

  // Phase 1 — scan (returns top 3 candidates)
  let candidates;
  try {
    candidates = await runPhase1();
  } catch (err) {
    console.error('[phase1] Error:', err.message);
    return;
  }

  if (!candidates.length) {
    console.log('[phase1] NO_TRADE — aucun token ≥ 2 scans.');
    return;
  }

  console.log(`[phase1] ${candidates.length} candidat(s): ${candidates.map(c => `${c.symbol}(${c.scan_count}${c.oi_exception ? '+OI💥' : ''})`).join(', ')}`);

  // Phase 2+3 — TA + derivatives + scoring (parallel on all candidates)
  const settled = await Promise.allSettled(
    candidates.map(async (c) => {
      const r = await runAnalysis(c.symbol, c.scans ?? []);
      r.scan_count = c.scan_count;
      r.scans      = c.scans;
      return r;
    })
  );

  const qualifying = [];
  for (const [i, s] of settled.entries()) {
    if (s.status !== 'fulfilled') {
      console.error(`[analysis] ${candidates[i].symbol} Error:`, s.reason?.message);
      continue;
    }
    const result = s.value;
    console.log(`[result] ${result.signal} ${result.symbol} — ${result.total}/10 (TA: ${result.ta_score} | DER: ${result.der_score}) — ${result.force}`);
    console.log(`  TA : ${result.ta_detail.join(' | ')}`);
    console.log(`  DER: ${result.der_detail.join(' | ')}`);
    if (result.rv_regime)   console.log(`  CTX: RV=${result.rv_regime} | MSB=${result.msb_direction ?? 'N/A'} | Basis=${result.basis_signal ?? 'N/A'} | BTCcorr=${result.btc_corr_macro != null ? result.btc_corr_macro.toFixed(2) : 'N/A'}`);
    if (result.gate_block)  console.log(`  [GATE] BLOQUÉ — ${result.gate_reason}`);
    if (result.veto_reason) console.log(`  [VETO] DER toxique — ${result.veto_reason}`);
    if (result.reduce_size) console.log(`  [GATE] ⚠️ reduce_size_50pct (RV ${result.rv_regime ?? 'elevated'})`);

    if (result.signal !== 'NO_TRADE' && result.total >= config.minScore) {
      if (isCoolingDown(result.symbol)) {
        console.log(`[cooldown] ${result.symbol} — signal ignoré (déjà notifié il y a moins de 60min)`);
      } else {
        qualifying.push(result);
      }
    }
  }

  if (!qualifying.length) {
    console.log('[notifier] NO_TRADE — pas de notification.');
    return;
  }

  // LLM Validation — aucun signal sans consensus LLM
  const llmValidated = [];
  for (const result of qualifying) {
    const v = await validateSignal(result);
    if (v.decision === 'REJECT') {
      console.log(`[llm-validator] REJECT ${result.symbol} — ${v.reasoning}`);
      continue;
    }
    if (v.decision === 'PENDING') {
      console.log(`[llm-validator] PENDING ${result.symbol} — signal ignoré (ordre limit recommandé)`);
      continue;
    }
    if (v.decision === 'CONTRARIAN_FLIP') {
      if (mode === 'LIVE') {
        result.llm_validation = { ...v, blocked: true, blocked_reason: 'CONTRARIAN_FLIP_LIVE' };
        result.llm_rejected   = true;
        console.log(`[llm-validator] CONTRARIAN_FLIP blocked in LIVE — ${result.symbol} ${result.signal} rejected (quant signal preserved): ${v.reasoning}`);
        continue;
      }
      // SHADOW / DRY_RUN : flip appliqué pour observation uniquement
      const flippedDir = result.direction === 'long' ? 'short' : 'long';
      result.direction = flippedDir;
      result.signal    = flippedDir === 'long' ? 'LONG' : 'SHORT';
      result.llm_flip  = true;
      console.log(`[llm-validator] CONTRARIAN_FLIP ${result.symbol} → ${result.signal} (${v.reasoning})`);
    }
    result.llm_validation = v;
    llmValidated.push(result);
  }

  if (!llmValidated.length) {
    console.log('[llm-validator] Tous les signaux rejetés/pending — pas de notification.');
    return;
  }

  // P1.3 — R:R minimum filter (block notification + order if R:R on TP1 < MIN_RR)
  const MIN_RR = Number(process.env.MIN_RISK_REWARD) || 1.5;
  const rrValidated = [];
  for (const result of llmValidated) {
    const lvls   = computeLevels(result);
    const risk   = Math.abs(lvls.entry - lvls.sl);
    const reward = Math.abs(lvls.tp1   - lvls.entry);
    if (risk < 1e-8 || reward < 1e-8) {
      console.log(`[rr-filter] REJETÉ ${result.symbol} — niveaux invalides (risk=${risk.toFixed(4)}, reward=${reward.toFixed(4)})`);
      continue;
    }
    const rr = reward / risk;
    if (rr < MIN_RR) {
      console.log(`[rr-filter] REJETÉ ${result.symbol} — R:R ${rr.toFixed(2)} < min ${MIN_RR}`);
      continue;
    }
    result._levels = lvls;
    result._rr     = +rr.toFixed(2);
    rrValidated.push(result);
  }
  if (!rrValidated.length) {
    console.log('[rr-filter] Tous les signaux rejetés (R:R insuffisant) — pas de notification.');
    return;
  }

  try {
    await sendTelegram(buildCombinedMessage(rrValidated));
    console.log(`[notifier] Notification envoyée (${rrValidated.length} signal(s)).`);
    for (const result of rrValidated) { setCooldown(result.symbol); recordSignal(); }
  } catch (err) {
    console.error('[notifier] Error:', err.message);
  }

  // Charts Lightweight — EMA 21/50 + niveaux entry/SL/TP tracés, fail-open
  for (const result of rrValidated) {
    try {
      const dir    = result.signal === 'MARKET_LONG' || result.signal === 'LONG' ? 'LONG' : 'SHORT';
      const lvls   = result._levels;
      const levels = { entry: lvls.entry, sl: lvls.sl, tp: lvls.tp1, signal: dir };
      const rrTag   = result._rr != null ? ` · R:R ${result._rr}` : '';
      const caption = `📊 <b>${result.symbol}</b> · 1H · ${dir} · Score ${result.total}/10${rrTag}`;
      const path   = await captureChart(result.symbol, '1h', levels);
      if (path) {
        await sendTelegramPhoto(path, caption);
        await cleanChart(path);
        console.log(`[chart-capture] Chart ${result.symbol} envoyé sur Telegram.`);
      }
    } catch (err) {
      console.warn(`[chart-capture] ${result.symbol}: ${err.message}`);
    }
  }

  for (const result of rrValidated) {
    try { await injectSignal(result); }
    catch (err) { console.error('[injector] Error:', err.message); }

    logSignal(result);

    if (mode === 'LIVE' && isEntryPaused()) {
      console.log(`[cycle] PAUSE_NEW_ENTRIES — ordre ${result.symbol} ignoré.`);
      continue;
    }
    if (mode === 'LIVE') {
      try {
        const levels = result._levels;
        const order  = await executeOrder({
          symbol: result.symbol,
          side:   result.signal,
          entry:  levels.entry,
          extra:  { reduce_size: result.reduce_size ?? false },
        });
        result.order_result = order;
        if (order.success) {
          if (order.partial) console.log(`[order-executor] Partial fill ${result.symbol} — qty réelle: ${order.qty}`);
          recordTrade();
          await registerTrade({
            symbol: result.symbol,
            side:   result.signal,
            entry:  order.price ?? levels.entry,
            sl:     levels.sl,
            tp1:    levels.tp1,
            tp2:    levels.tp2,
            qty:    order.qty,
          });
        } else {
          console.error(`[order-executor] Échec ${result.symbol}: ${order.error}`);
        }
      } catch (err) {
        console.error(`[order-executor] Error ${result.symbol}:`, err.message);
      }
    } else {
      // SHADOW — simuler l'entrée sans aucun appel Binance
      const levels = result._levels;
      registerShadowTrade({
        symbol:         result.symbol,
        side:           result.signal,
        entry:          levels.entry,
        sl:             levels.sl,
        tp1:            levels.tp1,
        tp2:            levels.tp2,
        ta_score:       result.ta_score,
        der_score:      result.der_score,
        total:          result.total,
        llm_validation: result.llm_validation,
      });
    }
  }
}

// Cooldown : évite de re-notifier le même symbole dans la fenêtre définie
const SIGNAL_COOLDOWN_MS = 60 * 60_000; // 60 min
const signalCooldowns = new Map();

function isCoolingDown(symbol) {
  const last = signalCooldowns.get(symbol);
  return last && Date.now() - last < SIGNAL_COOLDOWN_MS;
}
function setCooldown(symbol) { signalCooldowns.set(symbol, Date.now()); }

// Signal log persisté sur disque — survit aux redémarrages (max 50 en mémoire)
const _SIGNAL_LOG_NET = process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet';
const SIGNAL_LOG_PATH = `./signal_log.${_SIGNAL_LOG_NET}.jsonl`;
const signalLog = [];
try {
  const raw   = readFileSync(SIGNAL_LOG_PATH, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  const loaded = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  signalLog.push(...loaded.reverse());
} catch { /* fichier inexistant au premier démarrage */ }

function logSignal(result) {
  const entry = {
    time:          new Date().toISOString(),
    symbol:        result.symbol,
    signal:        result.signal,
    total:         result.total,
    ta_score:      result.ta_score      ?? null,
    der_score:     result.der_score     ?? null,
    ta_detail:     result.ta_detail     ?? [],
    der_detail:    result.der_detail    ?? [],
    entry_price:   result._levels?.entry ?? null,
    sl:            result._levels?.sl    ?? null,
    tp1:           result._levels?.tp1   ?? null,
    tp2:           result._levels?.tp2   ?? null,
    rr:            result._rr            ?? null,
    llm_validation: result.llm_validation ?? null,
  };
  signalLog.unshift(entry);
  if (signalLog.length > 50) signalLog.length = 50;
  try { appendFileSync(SIGNAL_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* ignore */ }
}

console.log(`PerpEdge Bot démarré — schedule: "${config.cronSchedule}"`);
cron.schedule(config.cronSchedule, runCycle);
// pre-squeeze-watcher gère ses propres timers (IDLE 60s + WATCHING 15s)

// Stagger immediate startup to avoid thundering herd on API
runCycle();
setTimeout(() => startOiWatcher(),             3_000);
setTimeout(() => startPreSqueezeWatcher(),     5_000);
setTimeout(() => startCrowdedUnwindWatcher(), 7_000);
setTimeout(async () => {
  startPositionManager();
  await bootReconcile().catch(err => console.error('[bootReconcile] error:', err.message));
  startUserDataStream().catch(err => console.error('[userDataStream] start error:', err.message));
},                                             9_000);
if (process.env.DRY_RUN === 'true') setTimeout(() => initShadowTracker(), 11_000);
setTimeout(() => startCapitulationWatcher(),                              11_000);
setTimeout(() => startDashboard(() => getTrackedPositions(), () => signalLog), 13_000);
startFeedbackAnalyzer();
startFeedbackApplier();
setTimeout(() => startSpotDCAManager(),    17_000);
setTimeout(() => startSmartMoneyScanner(), 19_000);

// Scalp module — cooldown per symbol to avoid double-entry
const scalpCooldowns = new Map();
const SCALP_COOLDOWN_MS = 5 * 60_000; // 5min

setTimeout(() => {
  startScalpScanner(async (candidate) => {
    const last = scalpCooldowns.get(candidate.symbol);
    if (last && Date.now() - last < SCALP_COOLDOWN_MS) return;

    const scored = await scoreScalp(candidate).catch(() => null);
    if (!scored || scored.signal === 'NO_TRADE' || scored.total < 5) return;

    console.log(`[scalp] ${scored.signal} ${scored.symbol} ${scored.total}/10 — ${scored.detail.join(' | ')}`);
    scalpCooldowns.set(scored.symbol, Date.now());

    if (getMode() === 'LIVE') {
      try {
        const atr    = scored.ta?.tf_5m?.atr_14 ?? (scored.mark_price * 0.003);
        const isLong = scored.side === 'LONG';
        const order  = await executeOrder({
          symbol: scored.symbol,
          side:   scored.signal,
          entry:  scored.mark_price,
          extra:  { reduce_size: false },
        });
        if (order.success) {
          if (order.partial) console.log(`[scalp] Partial fill ${scored.symbol} — qty réelle: ${order.qty}`);
          const fillPrice = order.price ?? scored.mark_price;
          const sl = isLong  ? fillPrice - atr : fillPrice + atr;
          const tp = isLong  ? fillPrice + 2 * atr : fillPrice - 2 * atr;
          sendTelegram([
            `⚡ <b>Scalp ENTRÉE</b> — <code>${scored.symbol}</code>`,
            `📈 <b>${scored.signal}</b> | <code>${fmt(fillPrice)}</code> | Score <b>${scored.total}/10</b>`,
            `🎯 TP <code>${fmt(tp)}</code> | 🛑 SL <code>${fmt(sl)}</code> | T+10`,
          ].join('\n')).catch(() => {});
          registerScalpTrade({ symbol: scored.symbol, side: scored.signal, entry: fillPrice, sl, tp, qty: order.qty });
        } else {
          console.error(`[scalp] ordre échoué ${scored.symbol}: ${order.error}`);
        }
      } catch (err) {
        console.error(`[scalp] executeOrder error ${scored.symbol}:`, err.message);
      }
    } else {
      console.log(`[scalp] ${getMode()} — ordre simulé ${scored.symbol} ${scored.signal}`);
    }
  });
  startScalpManager();
}, 15_000);

// Admin API + Telegram Bot — démarrage avec injection des getters partagés
injectAdminDeps({
  getPositions:       getTrackedPositions,
  getSignalLog:       () => signalLog,
  getScalpPositions:  getScalpPositions,
  getShadowPositions: getShadowPositions,
});
injectBotDeps({ getPositions: getTrackedPositions, getSignalLog: () => signalLog });
startAdminApi().catch(err => console.error('[admin-api] Erreur démarrage:', err.message));
startTelegramBot();
startDailyReporter();

// SIGTERM/SIGINT : arrêt propre du bot avant process.exit (piloté ici, pas dans telegram-bot.js)
const _handleShutdown = async () => {
  await Promise.allSettled([stopTelegramBot(), stopUserDataStream()]);
  process.exit(0);
};
process.once('SIGTERM', _handleShutdown);
process.once('SIGINT',  _handleShutdown);
