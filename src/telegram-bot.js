import { Bot, InlineKeyboard } from 'grammy';
import { config }               from './config.js';
import {
  getBotState, isPaused, isEmergencyStopped,
  setPaused, setEmergencyStop, resetEmergencyStop,
} from './bot-state.js';
import { reconcilePositions } from './position-manager.js';
import { readAllTrades }      from './trade-journal.js';

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

// ── Démarrage du bot ──────────────────────────────────────────────────────────
export function startTelegramBot() {
  if (!config.telegramBotToken) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN absent — bot Telegram désactivé.');
    return null;
  }

  const bot = new Bot(config.telegramBotToken);

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
      `👋 <b>PerpEdge Admin Bot</b>\n\nCommandes disponibles :\n/status — état du bot\n/pause — pause nouvelles entrées\n/resume — reprendre\n/stop — arrêt d'urgence`,
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
    setPaused(false);
    await ctx.reply('▶ Bot repris.', { parse_mode: 'HTML' });
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

  bot.start({ drop_pending_updates: true });
  console.log('[telegram-bot] Bot démarré (polling).');
  return bot;
}
