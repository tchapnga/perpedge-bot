import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';
import { getPerpSnapshot } from './perp-client.js';

const QUEUE_PATH = process.env.QUEUE_PATH || './signals_queue.jsonl';
try { mkdirSync(dirname(QUEUE_PATH), { recursive: true }); } catch { /* already exists */ }

export function computeLevels(result) {
  const { ta, direction, signal } = result;
  const sr      = ta.sr;
  const close   = ta.tf_1h.close;
  const atr     = ta.tf_1h.atr_14;
  const vwap24h = ta.tf_1h.vwap_24h ?? close;
  const entry   = signal === 'PENDING_LIMIT'
    ? (direction === 'long' ? vwap24h - 0.3 * atr : vwap24h + 0.3 * atr)
    : close;
  let sl, tp1, tp2;
  if (direction === 'long') {
    // S/R must be on correct side of entry — stale data can place it wrong
    sl  = (sr.nearest_support    != null && sr.nearest_support    < entry) ? sr.nearest_support    : entry * (1 - 0.03);
    tp1 = (sr.nearest_resistance != null && sr.nearest_resistance > entry) ? sr.nearest_resistance : entry * (1 + 0.03);
    tp2 = Math.max(tp1, entry + 2.0 * (entry - sl));
  } else {
    sl  = (sr.nearest_resistance != null && sr.nearest_resistance > entry) ? sr.nearest_resistance : entry * (1 + 0.03);
    tp1 = (sr.nearest_support    != null && sr.nearest_support    < entry) ? sr.nearest_support    : entry * (1 - 0.03);
    tp2 = Math.min(tp1, entry - 2.0 * (sl - entry));
  }
  // NaN/Infinity guard — atr=undefined or bad TA data propagates as NaN which bypasses comparison guards
  for (const [name, val] of [['entry', entry], ['sl', sl], ['tp1', tp1], ['tp2', tp2]]) {
    if (!Number.isFinite(val) || val <= 0) {
      console.warn(`[injector] Niveau invalide (${name}=${val}) — skip`);
      return null;
    }
  }
  return { entry, sl, tp1, tp2 };
}

export async function injectSignal(result) {
  if (result.signal === 'NO_TRADE') return false;
  if (!['long', 'short'].includes(result.direction)) { console.warn('[injector] Direction invalide — skip'); return false; }

  const levels = computeLevels(result);
  if (!levels) return false;
  const { entry, sl, tp1, tp2 } = levels;

  // Validate SL direction
  if (result.direction === 'long'  && sl >= entry) { console.warn('[injector] SL invalide (long) — skip'); return false; }
  if (result.direction === 'short' && sl <= entry) { console.warn('[injector] SL invalide (short) — skip'); return false; }

  // Validate R:R >= 1.8
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(entry - tp2);
  if (slDist === 0 || tpDist / slDist < 1.8) {
    console.warn(`[injector] R:R insuffisant (${slDist === 0 ? 'SL=0' : (tpDist / slDist).toFixed(2)}) — skip`);
    return false;
  }

  // Gate #9: re-check taker en temps réel avant injection
  try {
    const snap9 = await getPerpSnapshot(result.symbol);
    const rawRatio = snap9?.taker_buy_sell_ratio;
    const takerRatio = (rawRatio !== undefined && rawRatio !== null) ? Number(rawRatio) : NaN;
    if (Number.isFinite(takerRatio)) {
      if (result.direction === 'long' && takerRatio < 0.8) {
        console.warn(`[injector] Gate #9 Skip LONG ${result.symbol}: taker=${takerRatio} < 0.8`);
        return false;
      }
      if (result.direction === 'short' && takerRatio > 1.2) {
        console.warn(`[injector] Gate #9 Skip SHORT ${result.symbol}: taker=${takerRatio} > 1.2`);
        return false;
      }
    }
  } catch (err) {
    // Fail-closed in LIVE — a Gate#9 API failure blocks the signal rather than silently passing it
    console.warn(`[injector] Gate #9 error — fail-closed (${result.symbol}): ${err?.message ?? err}`);
    return false;
  }

  const signal = {
    signal_id:   crypto.randomBytes(6).toString('hex'),
    symbol:      result.symbol,
    side:        result.direction === 'long' ? 'LONG' : 'SHORT',
    v6_score:    result.total,
    entry,
    sl,
    tp1,
    tp2,
    pattern_name: 'PERPEDGE_SIGNAL',
    timeframe:   'H1',
    btc_trend:   'NEUTRAL',
    source:      'perpedge',
    enqueued_at: new Date().toISOString(),
    extra: {
      ta_score:               result.ta_score,
      der_score:              result.der_score,
      force:                  result.force,
      scan_count:             result.scan_count ?? 0,
      perpedge_confirmation:  1.0,   // TV bypassed — perpedge has its own TA
      ta_detail:              result.ta_detail,
      der_detail:             result.der_detail,
      rv_regime:              result.rv_regime      ?? null,
      reduce_size:            result.reduce_size    ?? false,
      msb_direction:          result.msb_direction  ?? null,
      basis_signal:           result.basis_signal   ?? null,
      btc_corr_macro:         result.btc_corr_macro ?? null,
      v6_bias:                result.v6_bias        ?? null,
      v6_bonus:               result.v6_bonus       ?? null,
      v6_regime:              result.v6_regime      ?? null,
      v6_detail:              result.v6_detail      ?? [],
    },
  };

  try {
    appendFileSync(QUEUE_PATH, JSON.stringify(signal) + '\n', 'utf8');
  } catch (err) {
    console.error(`[injector] Écriture queue échouée: ${err.message}`);
    return false;
  }
  console.log(`[injector] Injecté → queue: ${signal.side} ${signal.symbol} score=${signal.v6_score} rr=${(tpDist/slDist).toFixed(2)}`);
  return true;
}
