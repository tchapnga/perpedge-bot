import { config } from './config.js';

const HEADERS = {
  'Authorization': `Bearer ${config.perpMcpToken}`,
  'Content-Type': 'application/json',
};

export async function apiGet(path, params = {}, timeoutMs = 12000) {
  const url = new URL(`${config.perpMcpUrl}/api/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`API ${path} → HTTP ${res.status}`);
  return res.json();
}

// Phase 1 — scanners
export const scan = {
  fundingExtremes:   () => apiGet('scan/funding-extremes',   { min_abs_rate: 0.0003, limit: 30 }),
  oiMovers:          () => apiGet('scan/oi-movers',          { period: '1h', lookback: 4, min_oi_change_pct: 10, limit: 30 }, 35000),
  fundingDivergence: () => apiGet('scan/funding-divergence', { limit: 30 }),
  volatility:        () => apiGet('scan/volatility',         { min_volume_usd: 3_000_000, min_range_pct: 4, limit: 30 }),
  crossExchange:     () => apiGet('scan/cross-exchange-diff',{ min_diff_pct: 0.05, limit: 20 }),
};

// Phase 2 — TA
export const getTaAnalysis  = (symbol) => apiGet('ta-analysis', { symbol });
export const getTaV6        = (symbol) => apiGet('ta-v6',        { symbol });

// Phase 2b — context (Gemini Option A gates + modifiers)
export const getSpotPerpBasis        = (symbol) => apiGet('spot-perp-basis',         { symbol },                      15000);
export const getMarketStructureBreaks = (symbol) => apiGet('market-structure-breaks', { symbol, timeframe: '4h' },     20000);
export const getRealizedVol           = (symbol) => apiGet('realized-volatility',     { symbol },                      25000);
export const getAssetCorrelations     = (symbol) => apiGet('asset-correlations',       { symbol },                      30000);
export const getBybitSnapshot         = (symbol) => apiGet('bybit-snapshot',            { symbol },                      15000);

// Phase 2c — re-check temps réel
export const getPerpSnapshot = (symbol) => apiGet('perp-snapshot', { symbol });

// Phase 3 — derivatives
export const getDerivatives = (symbol) => Promise.all([
  apiGet('perp-snapshot',       { symbol }),
  apiGet('oi-change',           { symbol, period: '15m', lookback: 4 }),
  apiGet('oi-change',           { symbol, period: '1h',  lookback: 6 }),
  apiGet('oi-change',           { symbol, period: '4h',  lookback: 6 }),
  apiGet('funding-regime',      { symbol, days: 14 }),
  apiGet('funding-history',     { symbol, limit: 24 }),
  apiGet('orderbook-imbalance', { symbol, depth: 50 }),
  apiGet('liquidations-summary',{ symbol, hours: 24 }),
  apiGet('multi-exchange-funding', { symbol }),
  apiGet('multi-exchange-oi',      { symbol }),
]).then(([snapshot, oi15m, oi1h, oi4h, regime, history, orderbook, liquidations, meFunding, meOi]) =>
  ({ snapshot, oi15m, oi1h, oi4h, regime, history, orderbook, liquidations, meFunding, meOi })
);
