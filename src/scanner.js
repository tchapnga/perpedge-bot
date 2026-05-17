import { scan } from './perp-client.js';

const MAX_CANDIDATES       = 3;
const OI_EXPLOSION_MIN_PCT = 30; // Exception ADR-5.3 : bypass ≥2 scans si OI >30%

// Tokens blacklistés — HTTP 500 persistant sur ta-analysis (retirer si perp-mcp corrige)
const SYMBOL_BLACKLIST = new Set(['STARUSDT']);

// Adapters par format de réponse — chaque scanner a sa structure propre
function normalizeFundingExtremes(data) {
  return [
    ...(data?.most_positive ?? []),
    ...(data?.most_negative ?? []),
  ].map(e => (e?.symbol || '').trim()).filter(Boolean);
}

function normalizeOiMovers(data) {
  return [
    ...(data?.oi_explosions ?? []),
    ...(data?.oi_unwinds    ?? []),
  ].map(e => (e?.symbol || '').trim()).filter(Boolean);
}

function normalizeFlat(data) {
  const arr = Array.isArray(data) ? data : (data?.results || data?.data || []);
  return arr.map(item => {
    if (typeof item === 'string') return item.trim();
    return (item?.symbol || item?.coin || '').trim();
  }).filter(s => s.length > 0);
}

const SCANNER_ADAPTERS = {
  funding_extremes:   normalizeFundingExtremes,
  oi_movers:          normalizeOiMovers,
  funding_divergence: normalizeFlat,
  volatility:         normalizeFlat,
  cross_exchange:     normalizeFlat,
};

function extractSymbols(data, scannerName) {
  const adapter = SCANNER_ADAPTERS[scannerName] ?? normalizeFlat;
  const symbols = adapter(data);
  if (symbols.length === 0) {
    console.warn(`[scanner] WARN: ${scannerName} a retourné 0 symboles — schéma API changé ?`);
  }
  return symbols;
}

function extractOiExplosions(data) {
  const arr = [...(data?.oi_explosions ?? []), ...(data?.oi_unwinds ?? [])];
  return arr
    .filter(item => Math.abs(parseFloat(item?.oi_change_pct ?? 0)) >= OI_EXPLOSION_MIN_PCT)
    .map(item => (item?.symbol || '').trim()).filter(Boolean);
}

export async function runPhase1() {
  const results = await Promise.allSettled([
    scan.fundingExtremes(),
    scan.oiMovers(),
    scan.fundingDivergence(),
    scan.volatility(),
    scan.crossExchange(),
  ]);

  const scanNames = ['funding_extremes', 'oi_movers', 'funding_divergence', 'volatility', 'cross_exchange'];
  const counts      = {};
  const sources     = {};
  const oiExplosion = new Set();

  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.warn(`[scanner] ${scanNames[i]} failed:`, r.reason?.message);
      return;
    }
    if (scanNames[i] === 'oi_movers') {
      for (const sym of extractOiExplosions(r.value)) oiExplosion.add(sym);
    }
    for (const sym of new Set(extractSymbols(r.value, scanNames[i]))) {
      counts[sym]  = (counts[sym]  || 0) + 1;
      sources[sym] = [...(sources[sym] || []), scanNames[i]];
    }
  });

  const allSymbols = new Set([...Object.keys(counts), ...oiExplosion]);
  const candidates = [...allSymbols]
    .filter(sym => counts[sym] >= 2 && !SYMBOL_BLACKLIST.has(sym))
    .sort((a, b) => {
      const aOi = oiExplosion.has(a) && (counts[a] ?? 0) < 2 ? 1 : 0;
      const bOi = oiExplosion.has(b) && (counts[b] ?? 0) < 2 ? 1 : 0;
      if (bOi !== aOi) return bOi - aOi;
      return (counts[b] ?? 0) - (counts[a] ?? 0);
    })
    .map(sym => ({
      symbol:       sym,
      scan_count:   counts[sym] ?? 1,
      scans:        sources[sym] ?? ['oi_movers'],
      oi_exception: oiExplosion.has(sym) && (counts[sym] ?? 0) < 2,
    }));

  if (!candidates.length) return [];

  const top = candidates.slice(0, MAX_CANDIDATES);
  console.log(`[scanner] ${candidates.length} candidat(s). Top ${top.length}: ${top.map(c => `${c.symbol}(${c.scan_count}${c.oi_exception ? '+OI💥' : ''})`).join(', ')}`);
  return top;
}
