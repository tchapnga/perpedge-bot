import { config } from './config.js';

const DIR_EMOJI = {
  MARKET_LONG:   '🟢',
  MARKET_SHORT:  '🔴',
  PENDING_LIMIT: '🟡',
};

const FORCE_EMOJI = { FORT: '💪', 'MODÉRÉ': '👍', 'REJETÉ': '❌' };

const TREND_DOT = { BULLISH: '🟢', BEARISH: '🔴', NEUTRAL: '⚪', SIDEWAYS: '⚪' };

function trendDot(t) { return TREND_DOT[t] ?? '⚪'; }

function fmt(n) { return n < 0.01 ? n.toPrecision(4) : n.toFixed(4); }

function computeNotifLevels(result) {
  const close   = result.ta.tf_1h.close;
  const atr     = result.ta.tf_1h.atr_14;
  const vwap24h = result.ta.tf_1h.vwap_24h ?? close;
  const sr      = result.ta.sr;
  const dir     = result.direction;

  const entry = result.signal === 'PENDING_LIMIT'
    ? (dir === 'long' ? vwap24h - 0.3 * atr : vwap24h + 0.3 * atr)
    : close;

  const sl = dir === 'long'
    ? (sr.nearest_support    ?? entry * (1 - 0.03))
    : (sr.nearest_resistance ?? entry * (1 + 0.03));
  const tp = dir === 'long'
    ? (sr.nearest_resistance ?? entry * (1 + 0.03))
    : (sr.nearest_support    ?? entry * (1 - 0.03));

  const slPct = Math.abs((entry - sl) / entry * 100).toFixed(2);
  const tpPct = Math.abs((tp - entry) / entry * 100).toFixed(2);
  return { entry, sl, tp, slPct, tpPct };
}

export function buildMessage(result) {
  const { symbol, signal, force, total, ta_score, der_score, ta, der } = result;
  const tf   = ta.tf_1h;
  const snap = der.snapshot;

  const funding  = snap?.funding_rate_pct_8h ?? 'N/A';
  const oi1h     = der.oi1h?.oi_change_pct != null ? der.oi1h.oi_change_pct.toFixed(2) + '%' : 'N/A';
  const obSignal = der.orderbook?.signal ?? 'N/A';

  const dirEmoji   = DIR_EMOJI[signal]  ?? '⚡';
  const forceEmoji = FORCE_EMOJI[force] ?? '';
  const dirLabel   = signal === 'MARKET_LONG' ? 'LONG' : signal === 'MARKET_SHORT' ? 'SHORT' : signal;

  const { entry, sl, tp, slPct, tpPct } = computeNotifLevels(result);
  const entryLabel = signal === 'PENDING_LIMIT' ? `Limite  $${fmt(entry)}` : `Prix    $${fmt(entry)}`;

  // Trend dots
  const t1d = trendDot(ta.tf_1d.trend);
  const t4h = trendDot(ta.tf_4h.trend);
  const t1h = trendDot(ta.tf_1h.trend);

  // Orderbook emoji
  const obEmoji = obSignal.includes('BUY') ? '🟢' : obSignal.includes('SELL') ? '🔴' : '⚪';

  const lines = [
    `${dirEmoji} <b>${dirLabel} · ${symbol}</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `⭐ Score <b>${total} / 10</b>  <i>TA ${ta_score} · DER ${der_score}</i>  ${forceEmoji} <b>${force}</b>`,
    ``,
    `<b>${entryLabel}</b>`,
    `🎯 TP  <b>$${fmt(tp)}</b>  <i>(+${tpPct}%)</i>`,
    `🛡 SL  <b>$${fmt(sl)}</b>  <i>(−${slPct}%)</i>`,
    ``,
    `<b>Technique</b>`,
    `├ RSI 1H  <code>${tf.rsi.toFixed(1)}</code>  ${tf.rsi_signal}`,
    `├ MACD / EMA  ${tf.macd_signal} · ${tf.ema_structure}`,
    `├ VWAP ${tf.vwap_position}  ·  BB ${tf.bb_position}`,
    `└ 1D ${t1d} / 4H ${t4h} / 1H ${t1h}`,
    ``,
    `<b>Dérivés</b>`,
    `├ Funding 8h  <code>${funding}</code>`,
    `├ OI Δ1h      <code>${oi1h}</code>`,
    `└ Carnet      ${obEmoji} ${obSignal}`,
  ];

  // CTX block
  const ctx = [];
  if (result.rv_regime)       ctx.push(`Vol. ${result.rv_regime}`);
  if (result.reduce_size)     ctx.push(`⚠️ REDUCE SIZE 50%`);
  if (result.msb_direction)   ctx.push(`MSB 4H ${trendDot(result.msb_direction)} ${result.msb_direction}`);
  if (result.basis_signal)    ctx.push(`Basis ${result.basis_signal}`);
  if (result.btc_corr_macro != null) ctx.push(`BTC ${result.btc_corr_macro.toFixed(2)}`);
  if (ctx.length > 0) {
    lines.push(``, `<i>CTX · ${ctx.join(' · ')}</i>`);
  }

  lines.push(
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>🔁 Scan #${result.scan_count ?? '—'} · ${new Date().toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</i>`,
  );

  return lines.join('\n');
}

const NUMBERS = ['1️⃣', '2️⃣', '3️⃣'];

export function buildCombinedMessage(results) {
  const timestamp = new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });

  const header = [
    `🎯 <b>${results.length} SIGNAL${results.length > 1 ? 'S' : ''} ACTIF${results.length > 1 ? 'S' : ''}</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];

  const blocks = results.map((result, i) => {
    const { symbol, signal, force, total, ta_score, der_score, ta, der } = result;
    const dirEmoji   = DIR_EMOJI[signal]  ?? '⚡';
    const forceEmoji = FORCE_EMOJI[force] ?? '';
    const dirLabel   = signal === 'MARKET_LONG' ? 'LONG' : signal === 'MARKET_SHORT' ? 'SHORT' : signal;
    const funding    = der.snapshot?.funding_rate_pct_8h ?? 'N/A';
    const oi1h       = der.oi1h?.oi_change_pct != null ? der.oi1h.oi_change_pct.toFixed(2) + '%' : 'N/A';
    const { entry, sl, tp } = computeNotifLevels(result);
    const num        = NUMBERS[i] ?? `${i + 1}.`;

    const extraLines = [];
    if (result.llm_flip === true) {
      extraLines.push(`   🔄 FLIP CONTRARIANT`);
    }
    if (result.llm_validation) {
      const v = result.llm_validation;
      extraLines.push(`   🤖 LLM ${v.decision} conf=${(v.confidence * 100).toFixed(0)}%  <i>${v.reasoning}</i>`);
    }
    if (result.order_result?.success) {
      extraLines.push(`   ✅ Ordre #${result.order_result.orderId} ${result.order_result.qty}@${result.order_result.price}`);
    }

    return [
      `${num} ${dirEmoji} <b>${dirLabel} · ${symbol}</b>  ${forceEmoji} <b>${total}/10</b>  <i>TA ${ta_score} · DER ${der_score}</i>`,
      `   <b>$${fmt(entry)}</b>  ·  TP $${fmt(tp)}  ·  SL $${fmt(sl)}`,
      ...extraLines,
      `   Funding <code>${funding}</code>  ·  OI Δ1h <code>${oi1h}</code>`,
    ].join('\n');
  });

  const footer = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>🔁 ${timestamp} UTC</i>`,
  ];

  return [...header, ...blocks, ...footer].join('\n');
}

export function buildSqueezeMessage(sq) {
  const emoji     = sq.squeeze_type === 'SHORT_SQUEEZE' ? '🚀' : '💥';
  const confEmoji = { CONFIRMED: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '⚪' }[sq.confidence] ?? '⚪';
  const sqLabel   = sq.squeeze_type === 'SHORT_SQUEEZE' ? 'SHORT SQUEEZE' : 'LONG SQUEEZE';
  const fundingSign = sq.funding_rate < 0 ? '' : '+';
  const price20   = sq.price_20m_pct  != null ? sq.price_20m_pct.toFixed(2)  + '%' : 'N/A';
  const oi20      = sq.oi_20m_pct     != null ? sq.oi_20m_pct.toFixed(2)     + '%' : 'N/A';
  const cvd       = sq.taker_buy_ratio != null ? (sq.taker_buy_ratio * 100).toFixed(0) + '%' : 'N/A';
  const liqs      = sq.liq_total_usd  != null
    ? `$${Math.round(sq.liq_total_usd / 1000)}k (${sq.liq_dominant})`
    : '—';
  const ts = new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  return [
    `${emoji} <b>${sqLabel}  ·  ${sq.symbol}</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${confEmoji} Confiance  <b>${sq.confidence}</b>  <i>(${sq.signals_fired} / 5 signaux)</i>`,
    ``,
    `<code>Prix       $${sq.mark_price}`,
    `Funding    ${fundingSign}${sq.funding_rate_pct}`,
    `Prix 20m   ${price20}`,
    `OI 20m     ${oi20}`,
    `CVD ratio  ${cvd}`,
    `Liqs 30m   ${liqs}</code>`,
    ``,
    `<b>Signaux déclencheurs</b>`,
    `└ <i>${sq.signals_detail.join('  ·  ')}</i>`,
    ``,
    `<i>${ts} UTC</i>`,
  ].join('\n');
}

export function buildCrowdedUnwindMessage(result, triggerLabel) {
  const { symbol, signal, force, total, ta_score, der_score } = result;
  const dir       = result.direction ?? (signal === 'MARKET_SHORT' || signal === 'SHORT' ? 'short' : 'long');
  const dirEmoji  = DIR_EMOJI[signal] ?? '🔻';
  const forceEmoji = FORCE_EMOJI[force] ?? '';
  const ts = new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  let levels = {};
  try { levels = computeNotifLevels(result); } catch { levels = {}; }
  const { entry, sl, tp, slPct, tpPct } = levels;
  const entryLine = entry != null ? `<b>$${fmt(entry)}</b>  ·  TP $${fmt(tp)}  ·  SL $${fmt(sl)}` : '';

  return [
    `🔻 <b>CROWDED UNWIND</b>  ·  ${symbol}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `⭐ Score <b>${total}/10</b>  <i>TA ${ta_score} · DER ${der_score}</i>  ${forceEmoji} <b>${force}</b>`,
    entryLine ? `\n${entryLine}` : '',
    ``,
    `<i>Trigger : ${triggerLabel}</i>`,
    `<i>${ts} UTC</i>`,
  ].filter(l => l !== '').join('\n');
}

export async function sendTelegram(text) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log('[notifier] Telegram not configured — printing to console:\n', text);
    return;
  }
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    config.telegramChatId,
      text,
      parse_mode: 'HTML',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram error ${res.status}: ${err}`);
  }
}

export async function sendTelegramPhoto(imagePath, caption) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const { readFile } = await import('fs/promises');
  const imageBuffer = await readFile(imagePath);

  const form = new FormData();
  form.append('chat_id',    config.telegramChatId);
  form.append('parse_mode', 'HTML');
  if (caption) form.append('caption', caption.slice(0, 1024));
  form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), `chart_${Date.now()}.png`);

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`;
  const res = await fetch(url, {
    method: 'POST',
    body:   form,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram sendPhoto error ${res.status}: ${err}`);
  }
}
