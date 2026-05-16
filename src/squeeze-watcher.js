import { apiGet } from './perp-client.js';
import { buildSqueezeMessage, sendTelegram } from './notifier.js';
import { getBotState } from './bot-state.js';

// Dynamic cooldown state: symbol → { alertedAt, priceAtAlert, squeezeType }
const cooldowns = new Map();
const BASE_COOLDOWN_MS   = 30 * 60 * 1000; // 30 min base
const PRICE_BREAKOUT_PCT = 5;               // reset cooldown if price continues in squeeze direction by 5%
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // purge stale entries every hour

// Fix 3 (Gemini): directional cooldown reset — only reset if price moves in squeeze direction
function canAlert(symbol, currentPrice, squeezeType) {
  const cd = cooldowns.get(symbol);
  if (!cd) return true;
  // Only reset if price continued in the squeeze direction (not any 5% move)
  const priceDeltaPct = ((currentPrice - cd.priceAtAlert) / cd.priceAtAlert) * 100;
  const directedMove = squeezeType === 'SHORT_SQUEEZE' ? priceDeltaPct : -priceDeltaPct;
  if (directedMove >= PRICE_BREAKOUT_PCT) return true;
  // Base cooldown elapsed
  return Date.now() - cd.alertedAt >= BASE_COOLDOWN_MS;
}

// Fix 4 (Gemini): purge stale cooldown entries to prevent Map memory leak
setInterval(() => {
  const cutoff = Date.now() - BASE_COOLDOWN_MS * 2;
  for (const [sym, cd] of cooldowns) {
    if (cd.alertedAt < cutoff) cooldowns.delete(sym);
  }
}, CLEANUP_INTERVAL_MS);


let _squeezeRunning = false;
export async function runSqueezeWatch() {
  if (_squeezeRunning) return;
  if (!getBotState().modules.squeeze) return;
  _squeezeRunning = true;
  try {
    await _runSqueezeWatch();
  } finally {
    _squeezeRunning = false;
  }
}

async function _runSqueezeWatch() {
  let results;
  try {
    results = await apiGet('scan/squeeze', { min_volume_usd: 50_000_000, limit: 20 }, 30000);
  } catch (err) {
    console.error('[squeeze] Scan error:', err.message);
    return;
  }

  if (!Array.isArray(results) || !results.length) {
    console.log('[squeeze] Aucun squeeze détecté.');
    return;
  }

  // Only alert on HIGH or CONFIRMED — MEDIUM excluded (trop de faux positifs)
  const actionable = results.filter(sq =>
    sq.confidence === 'HIGH' || sq.confidence === 'CONFIRMED'
  );

  if (!actionable.length) {
    console.log(`[squeeze] ${results.length} candidat(s) LOW/MEDIUM uniquement — pas d'alerte.`);
    return;
  }

  for (const sq of actionable) {
    if (!canAlert(sq.symbol, sq.mark_price, sq.squeeze_type)) {
      console.log(`[squeeze] ${sq.symbol} cooldown actif — skip`);
      continue;
    }

    console.log(`[squeeze] 🔥 ${sq.squeeze_type} ${sq.symbol} — ${sq.confidence} (${sq.signals_fired}/5)`);

    // Cooldown posé avant l'envoi Telegram — évite la spam loop si Telegram throw
    cooldowns.set(sq.symbol, { alertedAt: Date.now(), priceAtAlert: sq.mark_price, squeezeType: sq.squeeze_type });
    try {
      const msg = buildSqueezeMessage(sq) + '\n\n<i>⚠️ Informationnel — pas de trade automatique</i>';
      await sendTelegram(msg);
      console.log(`[squeeze] Alerte Telegram envoyée: ${sq.symbol}`);
    } catch (err) {
      console.error(`[squeeze] Telegram error: ${err.message}`);
    }
  }
}
