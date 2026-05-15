// Scalp Scorer — taker-first scoring 0-10 sur 1M/5M
import { apiGet } from './perp-client.js';

export async function scoreScalp(candidate) {
  const { symbol, side } = candidate;
  if (!symbol || !side) return null;

  let ta, snap, oi15m;
  try {
    [ta, snap, oi15m] = await Promise.all([
      apiGet('ta-scalp', { symbol }, 15000),
      apiGet('perp-snapshot', { symbol }, 8000),
      apiGet('oi-change', { symbol, period: '15m', lookback: 2 }, 10000),
    ]);
  } catch (err) {
    console.error(`[scalp-scorer] fetch error ${symbol}:`, err.message);
    return null;
  }

  const isLong = side === 'LONG';
  let score = 0;
  const detail = [];

  // 1. Taker flow (primary) — 0-4 pts
  const takerRatio = snap?.taker_buy_ratio ?? 0.5;
  if (isLong) {
    if      (takerRatio > 0.70) { score += 4; detail.push('TAKER_STRONG_BUY'); }
    else if (takerRatio > 0.62) { score += 2; detail.push('TAKER_BUY'); }
    else                        { detail.push('TAKER_WEAK'); }
  } else {
    if      (takerRatio < 0.30) { score += 4; detail.push('TAKER_STRONG_SELL'); }
    else if (takerRatio < 0.38) { score += 2; detail.push('TAKER_SELL'); }
    else                        { detail.push('TAKER_WEAK'); }
  }

  // 2. TA scalp signal confirmation — 0-3 pts
  if (ta?.scalp_signal === side) {
    score += 3; detail.push('TA_CONFIRM');
  } else if (ta?.taker_bias === (isLong ? 'bullish' : 'bearish')) {
    score += 1; detail.push('TA_PARTIAL');
  } else {
    detail.push('TA_MISS');
  }

  // 3. OI 15m spike in direction — 0-2 pts
  const oiPct = oi15m?.oi_change_pct ?? 0;
  if (isLong  && oiPct > 2)  { score += 2; detail.push(`OI_LONG+${oiPct.toFixed(1)}%`); }
  else if (!isLong && oiPct < -2) { score += 2; detail.push(`OI_SHORT${oiPct.toFixed(1)}%`); }
  else if (Math.abs(oiPct) > 1)  { score += 1; detail.push(`OI_MID${oiPct.toFixed(1)}%`); }

  // 4. RSI not overbought/oversold — 0-1 pt
  const rsi5m = ta?.tf_5m?.rsi ?? 50;
  if (isLong  && rsi5m < 70 && rsi5m > 30) { score += 1; detail.push('RSI_OK'); }
  else if (!isLong && rsi5m > 30 && rsi5m < 70) { score += 1; detail.push('RSI_OK'); }
  else { detail.push(`RSI_${rsi5m.toFixed(0)}`); }

  // Hard veto: taker flowing against signal
  const vetoTaker = (isLong && takerRatio < 0.45) || (!isLong && takerRatio > 0.55);
  if (vetoTaker) {
    return {
      symbol, side, score: 0, total: 0, detail,
      signal: 'NO_TRADE', veto_reason: `Taker flow against signal (${(takerRatio * 100).toFixed(0)}%)`,
      ta, snap, oi15m,
    };
  }

  const signal = score >= 5 ? side : 'NO_TRADE';
  return {
    symbol, side, score, total: score,
    signal, detail, veto_reason: null,
    mark_price: snap?.mark_price ?? candidate.mark_price,
    ta, snap, oi15m,
    taker_buy_ratio: takerRatio,
    rsi_5m: rsi5m,
    oi_change_15m_pct: oiPct,
  };
}
