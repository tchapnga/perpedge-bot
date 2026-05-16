// Scalp Scanner — détecte opportunités 1M/5M toutes les 30s via taker flow + OI change
import { apiGet } from './perp-client.js';
import { getBotState } from './bot-state.js';

const SCAN_INTERVAL_MS     = 30_000;   // 30s
const MIN_VOLUME_USD       = 50_000_000; // 50M 24h volume
const MIN_OI_CHANGE_PCT    = 1.5;      // OI spike 15m > 1.5%
const MIN_TAKER_IMBALANCE  = 0.62;     // taker_buy_ratio > 62% (buy) or < 38% (sell)

let lastScanResults = [];

// Returns top scalp candidates with taker imbalance and OI spike
export async function runScalpScan() {
  let apiResponse;
  try {
    apiResponse = await apiGet('scan/oi-movers', {
      period: '15m', lookback: 2,
      min_oi_change_pct: MIN_OI_CHANGE_PCT,
      min_volume_usd: MIN_VOLUME_USD,
      limit: 30,
    }, 25000);
  } catch (err) {
    console.error('[scalp-scanner] oi-movers error:', err.message);
    return [];
  }

  const explosions = Array.isArray(apiResponse?.oi_explosions) ? apiResponse.oi_explosions : [];
  const unwinds    = Array.isArray(apiResponse?.oi_unwinds)    ? apiResponse.oi_unwinds    : [];
  const oiMovers   = [...explosions, ...unwinds].filter(m => m?.symbol);
  const uniqueMovers = [...new Map(oiMovers.map(m => [m.symbol, m])).values()];

  if (!uniqueMovers.length) {
    console.warn('[scalp-scanner] No data found: oi_explosions and oi_unwinds both empty.');
    lastScanResults = [];
    return [];
  }

  const candidates = await Promise.allSettled(
    uniqueMovers.slice(0, 20).map(async (m) => {
      const snap = await apiGet('perp-snapshot', { symbol: m.symbol }, 8000);
      const takerRatio = Number(snap?.taker_buy_ratio ?? 0.5);
      const side = takerRatio > MIN_TAKER_IMBALANCE ? 'LONG'
                 : takerRatio < (1 - MIN_TAKER_IMBALANCE) ? 'SHORT'
                 : null;
      if (!side) return null;
      return {
        symbol:          m.symbol,
        side,
        oi_change_pct:   m.oi_change_pct,
        taker_buy_ratio: takerRatio,
        mark_price:      snap?.mark_price ?? m.price,
        volume_24h_usd:  m.volume_24h_usd ?? 0,
      };
    })
  );

  lastScanResults = candidates
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);

  return lastScanResults;
}

export function getLastScalpScan() { return lastScanResults; }

export function startScalpScanner(onCandidate) {
  console.log(`[scalp-scanner] Démarré — cycle ${SCAN_INTERVAL_MS / 1000}s`);
  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!getBotState().modules.scalp) return;
      const results = await runScalpScan();
      if (results.length > 0) {
        console.log(`[scalp-scanner] ${results.length} candidat(s) scalp: ${results.map(r => `${r.symbol}(${r.side})`).join(', ')}`);
        if (typeof onCandidate === 'function') {
          for (const c of results) onCandidate(c);
        }
      }
    } catch (err) {
      console.error('[scalp-scanner] tick error:', err.message);
    } finally {
      isRunning = false;
      schedule();
    }
  };
  const schedule = () => setTimeout(() => tick().catch(console.error), SCAN_INTERVAL_MS);
  tick().catch(console.error);
}
