import { Bot, InlineKeyboard } from 'grammy';
import { exec }                from 'node:child_process';
import { promisify }           from 'node:util';
import fs                      from 'node:fs/promises';
import path                    from 'node:path';
import { config }               from './config.js';
import {
  getBotState, isPaused, isEmergencyStopped,
  setPaused, setEmergencyStop, resetEmergencyStop, resetCircuitBreaker,
  getTradeProfile, setTradeProfile,
} from './bot-state.js';
import { getSmartMoneyDetail } from './smart-money-scanner.js';
import { reconcilePositions, checkStability } from './position-manager.js';
import { readAllTrades }      from './trade-journal.js';

const execAsync = promisify(exec);
let _isSwitching = false;

async function updateEnvFile(isTestnet) {
  const envPath = path.resolve(process.cwd(), '.env');
  const tmpPath = `${envPath}.tmp`;
  let content;
  try { content = await fs.readFile(envPath, 'utf8'); } catch { content = ''; }
  const regex = /^BINANCE_TESTNET\s*=.*/m;
  const newLine = `BINANCE_TESTNET=${isTestnet}`;
  if (regex.test(content)) {
    content = content.replace(regex, newLine);
  } else {
    content = content.trimEnd() + `\n${newLine}\n`;
  }
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, envPath);
}

// ── Dépendances injectées depuis index.js ─────────────────────────────────────
let _getPositions = () => [];
let _getSignalLog = () => [];

export function injectBotDeps({ getPositions, getSignalLog }) {
  _getPositions = getPositions;
  _getSignalLog = getSignalLog;
}

// ── Helpers HTML ──────────────────────────────────────────────────────────────
function fmt(n) { return n < 0.01 ? n.toPrecision(4) : n.toFixed(4); }

function buildStatusMessage() {
  const state = getBotState();
  const positions = _getPositions();
  const pnl = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
  const lastSignal = _getSignalLog()[0];

  const modeLabel = state.emergencyStopped ? '🛑 EMERGENCY STOP'
    : state.isPaused ? '⏸ PAUSED'
    : `▶ ${state.mode}`;

  const posLines = positions.length
    ? positions.map(p => `  • ${p.symbol} ${p.side}  $${fmt(p.entry)}  PnL <code>${p.unrealizedPnl != null ? (p.unrealizedPnl > 0 ? '+' : '') + p.unrealizedPnl.toFixed(2) : '—'}</code>`).join('\n')
    : '  <i>Aucune position ouverte</i>';

  const lines = [
    `📊 <b>PerpEdge Status</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Mode     <b>${modeLabel}</b>`,
    `Cycles   ${state.cycleCount}   Signaux  ${state.signalsToday}   Trades  ${state.tradesExecuted}`,
    ``,
    `<b>Positions (${positions.length})</b>  PnL total <code>${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT</code>`,
    posLines,
  ];

  if (lastSignal) {
    lines.push(``, `<b>Dernier signal</b>`);
    lines.push(`  ${lastSignal.signal} ${lastSignal.symbol}  ${lastSignal.total}/10  <i>${lastSignal.time.slice(0, 16).replace('T', ' ')} UTC</i>`);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>Uptime ${Math.round(process.uptime() / 60)} min</i>`);
  return lines.join('\n');
}

function buildInlineKeyboard(state) {
  const kb = new InlineKeyboard();
  if (state.emergencyStopped) {
    kb.text('🔄 Reset Emergency', 'cmd:reset_emergency');
  } else if (state.isPaused) {
    kb.text('▶ Reprendre', 'cmd:resume');
  } else {
    kb.text('⏸ Pause', 'cmd:pause');
  }
  kb.text('🛑 Emergency Stop', 'cmd:emergency_confirm').row();
  // Bouton ouvrir cockpit si MINI_APP_URL configuré
  if (process.env.MINI_APP_URL) {
    kb.webApp('🖥 Ouvrir Cockpit', process.env.MINI_APP_URL);
  }
  return kb;
}

// ── État module-level pour retry polling + stop propre ────────────────────────
let _bot             = null;
let _pollingRetryTimer = null;
let _isStopping      = false;
let _currentDelay    = 5_000;

const _isTelegramConflict409 = (err) =>
  err?.error?.error_code === 409 ||
  err?.error_code === 409 ||
  err?.message?.includes('409: Conflict');

export async function stopTelegramBot() {
  if (_isStopping) return;
  _isStopping = true;
  console.log('[telegram-bot] Arrêt gracieux en cours...');
  if (_pollingRetryTimer) { clearTimeout(_pollingRetryTimer); _pollingRetryTimer = null; }
  if (_bot) {
    try { await _bot.stop(); console.log('[telegram-bot] Bot arrêté.'); }
    catch (err) { console.error('[telegram-bot] bot.stop() error:', err.message); }
  }
}

// ── Démarrage du bot ──────────────────────────────────────────────────────────
export function startTelegramBot() {
  if (!config.telegramBotToken) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN absent — bot Telegram désactivé.');
    return null;
  }

  _bot = new Bot(config.telegramBotToken);
  const bot = _bot;

  // État temporaire pour confirmation Emergency Stop (userId → timestamp)
  const pendingEmergency = new Map();
  // FIX: cleanup auto des confirmations expirées pour éviter fuite mémoire
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingEmergency) {
      if (now - v > 60_000) pendingEmergency.delete(k);
    }
  }, 60_000);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `👋 <b>PerpEdge Admin Bot</b>\n\nCommandes disponibles :\n/status — état du bot\n/pause — pause nouvelles entrées\n/resume — reprendre\n/stop — arrêt d'urgence\n/resetcb — réarmer le circuit breaker\n/profile — profil de risque Smart Money\n/testnet — basculer en TESTNET (si stable)\n/mainnet — basculer en MAINNET (si stable)\n/reconcile — réconciliation positions\n/export — export CSV des trades`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const state = getBotState();
    await ctx.reply(buildStatusMessage(), {
      parse_mode:   'HTML',
      reply_markup: buildInlineKeyboard(state),
    });
  });

  // ── /pause ────────────────────────────────────────────────────────────────
  bot.command('pause', async (ctx) => {
    setPaused(true);
    await ctx.reply('⏸ Bot en pause. Les nouvelles entrées sont bloquées.', { parse_mode: 'HTML' });
  });

  // ── /resume ───────────────────────────────────────────────────────────────
  bot.command('resume', async (ctx) => {
    if (isEmergencyStopped()) {
      await ctx.reply('⚠️ Emergency Stop actif — utilisez /reset_emergency d\'abord.', { parse_mode: 'HTML' });
      return;
    }
    const st = getBotState();
    if (st.circuitBreaker) {
      await ctx.reply(`⚠️ <b>Circuit Breaker actif</b>\n\n${st.circuitBreakerReason}\n\nUtilisez /resetcb d'abord, puis /resume.`, { parse_mode: 'HTML' });
      return;
    }
    setPaused(false);
    await ctx.reply('▶ Bot repris.', { parse_mode: 'HTML' });
  });

  // ── /resetcb — réarmement manuel du circuit breaker ──────────────────────
  bot.command('resetcb', async (ctx) => {
    const st = getBotState();
    if (!st.circuitBreaker) {
      await ctx.reply('ℹ️ Circuit Breaker non actif — aucune action.', { parse_mode: 'HTML' });
      return;
    }
    resetCircuitBreaker();
    await ctx.reply(
      `🔄 <b>Circuit Breaker réinitialisé.</b>\n\nRaison précédente : ${st.circuitBreakerReason}\n\n<b>Le bot reste en PAUSE.</b> Envoyez /resume pour reprendre les cycles.`,
      { parse_mode: 'HTML' }
    );
  });

  // ── /profile — profil de risque Smart Money ──────────────────────────────
  const PROFILE_LABELS = {
    conservative: '🌱 Conservateur — Spot DCA uniquement',
    balanced:     '⚖️ Équilibré — Perp ou Spot selon indicateurs',
    aggressive:   '🔥 Agressif — Perp + Spot simultanés (0.5x chacun)',
  };
  const pendingAggressiveConfirm = new Map(); // userId → timestamp

  // Cleanup auto
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAggressiveConfirm) {
      if (now - v > 60_000) pendingAggressiveConfirm.delete(k);
    }
  }, 60_000);

  bot.command('profile', async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    const current = getTradeProfile();
    const st = getBotState();

    if (!arg) {
      const kb = new InlineKeyboard()
        .text('🌱 Conservateur', 'profile:set:conservative').row()
        .text('⚖️ Équilibré',    'profile:set:balanced').row()
        .text('🔥 Agressif',     'profile:set:aggressive');
      const zoneDesc = {
        conservative: '→ Zone Rouge/Grise/Verte : Spot toujours',
        balanced:     '→ Zone Rouge : Spot · Zone Grise : Perp si score≥5 · Zone Verte : Perp ou Spot',
        aggressive:   '→ Zone Rouge : Spot · Zone Grise : Perp si score≥5 · Zone Verte : Perp+Spot (0.5x)',
      };
      await ctx.reply(
        `📊 <b>Profil de risque Smart Money</b>\n\nActif : <b>${PROFILE_LABELS[current] ?? current}</b>\n\n${zoneDesc[current] ?? ''}\n\n<i>Circuit breaker : stop auto si perte > ${st.circuitBreakerReason ?? `${process.env.CIRCUIT_BREAKER_DAILY_LOSS_USDT ?? 50} USDT`}</i>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
      return;
    }

    const validProfiles = { conservative: true, balanced: true, aggressive: true };
    if (!validProfiles[arg]) {
      await ctx.reply('❌ Profil inconnu. Options : conservative · balanced · aggressive', { parse_mode: 'HTML' });
      return;
    }

    if (arg === 'aggressive') {
      const userId = String(ctx.from?.id ?? 'unknown');
      pendingAggressiveConfirm.set(userId, Date.now());
      const cbLimit = process.env.CIRCUIT_BREAKER_DAILY_LOSS_USDT ?? 50;
      const kb = new InlineKeyboard()
        .text('✅ Confirmer Agressif', 'profile:confirm:aggressive')
        .text('❌ Annuler', 'profile:cancel');
      await ctx.reply(
        `⚠️ <b>Profil Agressif — Confirmation requise</b>\n\nCe profil déclenche <b>Perp + Spot DCA simultanément</b> à 0.5× taille normale.\nExposition totale : 1.0× par signal Smart Money.\n\n🛡️ Circuit breaker : stop auto si perte > <b>${cbLimit} USDT/jour</b>\n\n<i>La confirmation vaut pour toutes les positions futures jusqu'au prochain changement de profil.</i>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
      return;
    }

    setTradeProfile(arg);
    await ctx.reply(`✅ Profil mis à jour : <b>${PROFILE_LABELS[arg]}</b>`, { parse_mode: 'HTML' });
  });

  // ── Callbacks inline — profile + smart money detail ──────────────────────
  bot.callbackQuery(/^profile:set:(.+)$/, async (ctx) => {
    const profile = ctx.match[1];
    if (!['conservative','balanced','aggressive'].includes(profile)) {
      await ctx.answerCallbackQuery('Profil inconnu');
      return;
    }
    if (profile === 'aggressive') {
      const userId = String(ctx.from?.id ?? 'unknown');
      pendingAggressiveConfirm.set(userId, Date.now());
      const cbLimit = process.env.CIRCUIT_BREAKER_DAILY_LOSS_USDT ?? 50;
      const kb = new InlineKeyboard()
        .text('✅ Confirmer Agressif', 'profile:confirm:aggressive')
        .text('❌ Annuler', 'profile:cancel');
      await ctx.editMessageText(
        `⚠️ <b>Profil Agressif — Confirmation requise</b>\n\nPerp + Spot DCA simultanément à 0.5× chacun.\nCircuit breaker : stop auto si perte > <b>${cbLimit} USDT/jour</b>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } else {
      setTradeProfile(profile);
      await ctx.editMessageText(`✅ Profil mis à jour : <b>${PROFILE_LABELS[profile]}</b>`, { parse_mode: 'HTML' });
    }
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('profile:confirm:aggressive', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    const ts = pendingAggressiveConfirm.get(userId);
    if (!ts || Date.now() - ts > 60_000) {
      pendingAggressiveConfirm.delete(userId);
      await ctx.answerCallbackQuery('⏱ Confirmation expirée — relancez /profile');
      return;
    }
    pendingAggressiveConfirm.delete(userId);
    setTradeProfile('aggressive');
    await ctx.editMessageText(`✅ Profil <b>Agressif</b> activé — Perp + Spot DCA simultanés à 0.5× chacun.`, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('profile:cancel', async (ctx) => {
    await ctx.editMessageText(`ℹ️ Changement de profil annulé. Profil actif : <b>${PROFILE_LABELS[getTradeProfile()]}</b>`, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();
  });

  // Callback détail Smart Money signal (sm:d:{shortId})
  bot.callbackQuery(/^sm:d:(.+)$/, async (ctx) => {
    const shortId = ctx.match[1];
    const detail = getSmartMoneyDetail(shortId);
    if (!detail) {
      await ctx.answerCallbackQuery('⏱ Détail expiré (>15 min)');
      return;
    }
    const zoneEmoji = { RED: '🔴', GREY: '🟡', GREEN: '🟢', UNKNOWN: '⚪' };
    const lines = [
      `📊 <b>Indicateurs Smart Money</b>  ·  ${detail.symbol}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Score : <b>${detail.score}/6</b>`,
      `CVD 4h : <code>${(detail.cvdChange4h * 100).toFixed(2)}%</code>`,
      `Basis : ${detail.basisBullish ? '📈 Haussier' : '➡️ Neutre'}`,
      `MSB 15m : ${detail.msb15m ? '✅' : '❌'}  ·  MSB 1h : ${detail.msb1h ? '✅' : '❌'}`,
      `OI : <i>${detail.oiRegime}</i>`,
      `Funding : <code>${detail.fundingRate !== null ? (detail.fundingRate * 100).toFixed(4) : 'N/A'}%</code>  →  Zone ${zoneEmoji[detail.zone] ?? ''} ${detail.zone}`,
      ``,
      `Profil : <b>${PROFILE_LABELS[detail.profile] ?? detail.profile}</b>`,
      `Décision : <i>${detail.reason}</i>`,
      detail.execPerp && detail.execSpot ? `Size : Perp ${detail.perpSizeMultiplier}× · Spot ${detail.spotSizeMultiplier}×` : '',
    ].filter(Boolean);
    await ctx.answerCallbackQuery();
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // ── /stop (Emergency Stop) ────────────────────────────────────────────────
  bot.command('stop', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    pendingEmergency.set(userId, Date.now());
    await ctx.reply(
      `⚠️ <b>Confirmation requise</b>\n\nVous allez déclencher un EMERGENCY STOP.\nToutes les nouvelles entrées seront bloquées.\n\n<b>Tapez /confirm_stop pour confirmer</b> (expire dans 30s).`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('confirm_stop', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    const ts = pendingEmergency.get(userId);
    if (!ts || Date.now() - ts > 30_000) {
      pendingEmergency.delete(userId);
      await ctx.reply('⏱ Confirmation expirée. Relancez /stop.', { parse_mode: 'HTML' });
      return;
    }
    pendingEmergency.delete(userId);
    setEmergencyStop();
    await ctx.reply('🛑 <b>EMERGENCY STOP activé.</b> Toutes les nouvelles entrées sont bloquées.', { parse_mode: 'HTML' });
  });

  bot.command('reset_emergency', async (ctx) => {
    resetEmergencyStop();
    // isPaused reste true — l'opérateur doit /resume explicitement
    await ctx.reply('🔄 Flag Emergency Stop effacé. <b>Le bot reste en PAUSE.</b> Envoyez /resume pour reprendre les cycles.', { parse_mode: 'HTML' });
  });

  // ── /testnet et /mainnet — bascule d'environnement ───────────────────────
  async function handleEnvSwitch(ctx, target) {
    if (_isSwitching) {
      await ctx.reply('⚙️ Bascule déjà en cours — patientez.', { parse_mode: 'HTML' });
      return;
    }
    const currentTestnet = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
    const wantTestnet    = target === 'testnet';
    if (currentTestnet === wantTestnet) {
      await ctx.reply(`ℹ️ Le bot est déjà en mode <b>${target.toUpperCase()}</b>.`, { parse_mode: 'HTML' });
      return;
    }
    _isSwitching = true;
    try {
      await ctx.reply(`🔍 Vérification stabilité avant bascule vers <b>${target.toUpperCase()}</b>...`, { parse_mode: 'HTML' });
      const stability = await checkStability();
      if (!stability.ok) {
        _isSwitching = false;
        await ctx.reply(`❌ <b>Bascule refusée</b>\n\n${stability.reason}\n\nFerme toutes les positions et ordres avant de basculer.`, { parse_mode: 'HTML' });
        return;
      }
      setPaused(true);
      await ctx.reply(`✅ Bot stable. Bascule vers <b>${target.toUpperCase()}</b> en cours...\n\n⚠️ Le bot va redémarrer dans 2 secondes.`, { parse_mode: 'HTML' });
      await updateEnvFile(wantTestnet);
      console.log(`[telegram-bot] Bascule ${target.toUpperCase()} — restart PM2 dans 1s`);
      await new Promise(r => setTimeout(r, 1000));
      await execAsync('pm2 restart perpedge-bot');
      process.exit(0);
    } catch (err) {
      _isSwitching = false;
      console.error('[telegram-bot] handleEnvSwitch error:', err.message);
      await ctx.reply(`💥 Erreur lors de la bascule: <code>${err.message}</code>`, { parse_mode: 'HTML' });
    }
  }

  bot.command('testnet', (ctx) => handleEnvSwitch(ctx, 'testnet'));
  bot.command('mainnet', (ctx) => handleEnvSwitch(ctx, 'mainnet'));

  // ── Callbacks inline keyboard ─────────────────────────────────────────────
  bot.callbackQuery('cmd:pause', async (ctx) => {
    setPaused(true);
    await ctx.answerCallbackQuery({ text: '⏸ Pause activée' });
    await ctx.editMessageReplyMarkup({ reply_markup: buildInlineKeyboard(getBotState()) });
  });

  bot.callbackQuery('cmd:resume', async (ctx) => {
    if (isEmergencyStopped()) {
      await ctx.answerCallbackQuery({ text: '⚠️ Emergency Stop actif' });
      return;
    }
    setPaused(false);
    await ctx.answerCallbackQuery({ text: '▶ Bot repris' });
    await ctx.editMessageReplyMarkup({ reply_markup: buildInlineKeyboard(getBotState()) });
  });

  bot.callbackQuery('cmd:emergency_confirm', async (ctx) => {
    const userId = String(ctx.from?.id ?? 'unknown');
    pendingEmergency.set(userId, Date.now());
    await ctx.answerCallbackQuery({ text: '⚠️ Confirmez avec /confirm_stop' });
    await ctx.reply(
      '⚠️ Tapez /confirm_stop pour confirmer l\'Emergency Stop (expire dans 30s).',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('cmd:reset_emergency', async (ctx) => {
    resetEmergencyStop();
    await ctx.answerCallbackQuery({ text: '🔄 Flag effacé — /resume pour reprendre' });
    await ctx.editMessageReplyMarkup({ reply_markup: buildInlineKeyboard(getBotState()) });
  });


  // ── /reconcile P8E.1 ─────────────────────────────────────────────────────
  bot.command('reconcile', async (ctx) => {
    try {
      const result = await reconcilePositions();
      let message;
      if (!result.ok && result.error) {
        message = `❌ <b>Réconciliation impossible</b>\n\n<code>${result.error}</code>`;
      } else if (result.ok) {
        message = `✅ <b>OK</b> — ${result.binancePositions?.length ?? 0} position(s) synchronisée(s).`;
      } else {
        const lines = ['⚠️ <b>Désync détectée</b>', ''];
        if (result.botOnly?.length)     lines.push(`Bot only : ${result.botOnly.map(p => p.symbol).join(', ')}`);
        if (result.binanceOnly?.length) lines.push(`Binance only : ${result.binanceOnly.map(p => p.symbol).join(', ')}`);
        if (result.mismatch?.length) {
          lines.push('Mismatch :');
          result.mismatch.forEach(m => lines.push(`• ${m.symbol} bot:${m.botDirection} ${m.botQty} / binance:${m.binanceDirection} ${m.binanceQty}`));
        }
        message = lines.join('\n');
      }
      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`❌ Erreur réconciliation: ${err.message}`);
    }
  });

  // ── /export P8E.6 ─────────────────────────────────────────────────────────
  bot.command('export', async (ctx) => {
    try {
      const trades = await readAllTrades();
      if (!trades.length) { await ctx.reply('Aucun trade enregistré.'); return; }
      const headers = ['date_closed','symbol','direction','entry_price','exit_price','qty','pnl_usdt','pnl_pct','exit_reason'];
      const rows = [headers.join(',')];
      for (const t of trades) {
        rows.push([
          t.closed_at || '', t.symbol || '', t.direction || '',
          t.entry_price ?? '', t.exit_price ?? '', t.qty ?? '',
          t.pnl_usdt ?? '', t.pnl_pct ?? '',
          t.exit_reason ? `"${String(t.exit_reason).replace(/"/g, '""')}"` : '',
        ].join(','));
      }
      const csv = rows.join('\n');
      await bot.api.sendDocument(
        ctx.chat.id,
        { source: Buffer.from(csv, 'utf8'), filename: `trades_${new Date().toISOString().slice(0,10)}.csv` },
        { caption: '📊 Export trades PerpEdge' }
      );
    } catch (err) {
      await ctx.reply(`❌ Erreur export CSV: ${err.message}`);
    }
  });

  // ── Alertes push (appelées depuis position-manager et index.js) ────────────
  const chatId = config.telegramChatId;

  bot.pushAlert = async (text) => {
    if (!chatId) return;
    try { await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }); }
    catch (err) { console.error('[telegram-bot] pushAlert error:', err.message); }
  };

  // bot.catch : erreurs de handlers update (pas les erreurs de polling)
  bot.catch((err) => {
    if (err.error?.error_code === 409) {
      console.warn('[telegram-bot] 409 via bot.catch — ignoré.');
      return;
    }
    console.error('[telegram-bot] Grammy error:', err.message);
  });

  // Polling avec retry backoff exponentiel sur 409
  const _startPolling = async () => {
    if (_isStopping) return;
    try {
      await bot.start({ drop_pending_updates: true });
      _currentDelay = 5_000;
    } catch (err) {
      if (_isStopping) return;
      if (_isTelegramConflict409(err)) {
        console.warn(`[telegram-bot] 409 Conflict — retry dans ${_currentDelay / 1000}s (backoff)`);
        _pollingRetryTimer = setTimeout(() => {
          _pollingRetryTimer = null;
          _currentDelay = Math.min(_currentDelay * 2, 45_000);
          _startPolling();
        }, _currentDelay);
        return;
      }
      console.error('[telegram-bot] Polling error:', err.message);
      _pollingRetryTimer = setTimeout(() => { _pollingRetryTimer = null; _startPolling(); }, 10_000);
    }
  };

  _startPolling();
  console.log('[telegram-bot] Bot démarré (polling).');
  return bot;
}
