// smart-money-scanner.js v2 — Spec validée 3/3 LLMs 2026-05-17
// Revue code 3/3 LLMs 2026-05-17 — 9 corrections appliquées
// Signal: CVD bullish divergence + spot/perp basis premium + MSB 15m
// Philosophie: smart money accumule spot avant push perp

import { getBotState, getMode, isPaused, isEmergencyStopped, recordTrade } from './bot-state.js';
import { startDCA } from './spot-dca-manager.js';
import { sendTelegram } from './notifier.js';
import { executeOrder } from './order-executor.js';
import { registerTrade } from './position-manager.js';
import { isCapWatcherActive } from './capitulation-watcher.js';

// ─── Constantes ───────────────────────────────────────────────────────────────
const FAPI             = 'https://fapi.binance.com';
const SAPI             = 'https://api.binance.com';
const SCAN_INTERVAL_MS = 4 * 3600_000;
const COOLDOWN_MS      = 4 * 3600_000;
const MIN_VOLUME_USDT  = 50_000_000;
const CANDIDATE_LIMIT  = 30;

// CVD
const CVD_ABS_RATIO    = -0.005;  // cvdChange4h >= -0.5%
const CVD_DIV_RATIO    =  0.001;  // cvdChange4h >  0.1%
const PRICE_STABLE_MIN = -0.003;  // priceChange4h >= -0.3% (borne basse — correction revue code)
const PRICE_STABLE_MAX =  0.003;  // priceChange4h <= +0.3%
const PRICE_DOWN_MIN   = -0.001;  // priceChange4h <  -0.1%

// Basis — spot > perp = smart money achète spot = BULLISH (consensus Gemini+DeepSeek spec design)
const BASIS_THRESHOLD  = 0.0003;

// OI
const OI_STABLE_LO     = -0.015;
const OI_STABLE_HI     =  0.020;
const OI_BULL_MIN      =  0.050;

// Funding
const FUNDING_SCORE_LO = -0.0002;
const FUNDING_SCORE_HI = -0.0005;

// Score seuils
const SCORE_PERP       = 4;
const SCORE_SPOT       = 3;

const cooldowns = new Map();
let scannerStarted = false; // singleton module-level (correction revue code #9)

// ─── Fetch candidats — top USDT perps par volume ──────────────────────────────
async function fetchCandidates() {
  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ticker/24hr ${res.status}`);
  const tickers = await res.json();
  return tickers
    .filter(t => t.symbol.endsWith('USDT') && Number(t.quoteVolume) >= MIN_VOLUME_USDT)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, CANDIDATE_LIMIT)
    .map(t => ({ symbol: t.symbol, lastPrice: Number(t.lastPrice) }));
}

// ─── CVD via klines 1m (240 bougies = 4h) ────────────────────────────────────
async function fetchCVD(symbol) {
  const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=241`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`klines 1m ${res.status}`);
  const klines = await res.json();
  const closed = klines.slice(0, -1);
  // Guard: données insuffisantes (correction revue code #7)
  if (closed.length < 2) return { cvdChange4h: 0, priceChange4h: 0 };
  const firstOpen = Number(closed[0][1]);
  if (!firstOpen) return { cvdChange4h: 0, priceChange4h: 0 };
  let cvdSum = 0, absVol = 0;
  for (const k of closed) {
    const vol    = Number(k[5]);
    const buyVol = Number(k[9]);
    cvdSum += buyVol - (vol - buyVol);
    absVol += vol;
  }
  if (absVol === 0) return { cvdChange4h: 0, priceChange4h: 0 };
  const lastClose = Number(closed[closed.length - 1][4]);
  return {
    cvdChange4h:   cvdSum / absVol,
    priceChange4h: (lastClose - firstOpen) / firstOpen,
  };
}

// ─── Basis spot / perp ────────────────────────────────────────────────────────
async function fetchBasis(symbol) {
  const [spotRes, perpRes] = await Promise.all([
    fetch(`${SAPI}/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`${FAPI}/fapi/v1/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  if (!spotRes.ok || !perpRes.ok) throw new Error(`basis fetch failed`);
  const [spot, perp] = await Promise.all([spotRes.json(), perpRes.json()]);
  const spotPrice = Number(spot.price);
  const perpPrice = Number(perp.price);
  if (!perpPrice) throw new Error('perpPrice is 0');
  return { spotPrice, perpPrice, basis: (spotPrice - perpPrice) / perpPrice };
}

// ─── OI régime ────────────────────────────────────────────────────────────────
async function fetchOIRegime(symbol, priceChange4h, cvdChange4h) {
  try {
    const res = await fetch(
      `${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=5`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return { regime: 'OI_NEUTRAL', score: 0, oiChangePct: 0 };
    const hist = await res.json();
    if (!Array.isArray(hist) || hist.length < 2) return { regime: 'OI_NEUTRAL', score: 0, oiChangePct: 0 };
    // Sort ascending by timestamp pour garantir oldest=hist[0] (correction revue code #6)
    hist.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const oiOld = Number(hist[0].sumOpenInterest);
    const oiNew = Number(hist[hist.length - 1].sumOpenInterest);
    if (!oiOld) return { regime: 'OI_NEUTRAL', score: 0, oiChangePct: 0 };
    const oiChangePct = (oiNew - oiOld) / oiOld;
    if (oiChangePct >= OI_STABLE_LO && oiChangePct <= OI_STABLE_HI) {
      return { regime: 'OI_STABLE_ACCUMULATION', score: 1, oiChangePct };
    }
    if (oiChangePct > OI_BULL_MIN && priceChange4h > 0 && cvdChange4h > 0) {
      return { regime: 'OI_BULL_EXPANSION', score: 2, oiChangePct };
    }
    if (oiChangePct > OI_BULL_MIN && priceChange4h <= 0) {
      return { regime: 'OI_BEAR_BUILD', score: 0, oiChangePct };
    }
    return { regime: 'OI_NEUTRAL', score: 0, oiChangePct };
  } catch {
    return { regime: 'OI_NEUTRAL', score: 0, oiChangePct: 0 };
  }
}

// ─── MSB : clôture au-dessus du plus haut des 5 bougies précédentes ──────────
async function fetchMSB(symbol, interval) {
  const res = await fetch(
    `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=7`,
    { signal: AbortSignal.timeout(5_000) }
  );
  if (!res.ok) return false;
  const klines = await res.json();
  const closed = klines.slice(0, -1);
  if (closed.length < 6) return false;
  const prev5    = closed.slice(0, 5);
  const last     = closed[5];
  const prevHigh = Math.max(...prev5.map(k => Number(k[2]))); // k[2] = high
  return Number(last[4]) > prevHigh;                          // k[4] = close (body break)
}

// ─── Funding — fail-closed si API down (correction revue code #5) ─────────────
async function fetchFunding(symbol) {
  const res = await fetch(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return null;
  const d = await res.json();
  const rate = Number(d.lastFundingRate);
  return Number.isFinite(rate) ? rate : null;
}

// ─── Analyse complète d'un symbole ───────────────────────────────────────────
async function analyzeSymbol(symbol, lastPrice) {
  let cvd, basisData;
  try {
    [cvd, basisData] = await Promise.all([
      fetchCVD(symbol),
      fetchBasis(symbol).catch(() => null),
    ]);
  } catch (err) {
    console.warn(`[smart-money] ${symbol} CVD/basis error: ${err.message}`);
    return null;
  }

  const { cvdChange4h, priceChange4h } = cvd;

  let oiData, msb15m, msb1h, fundingRate;
  try {
    [oiData, msb15m, msb1h, fundingRate] = await Promise.all([
      fetchOIRegime(symbol, priceChange4h, cvdChange4h),
      fetchMSB(symbol, '15m'),
      fetchMSB(symbol, '1h'),
      fetchFunding(symbol).catch(() => null), // fail-closed (correction revue code #5)
    ]);
  } catch (err) {
    console.warn(`[smart-money] ${symbol} OI/MSB/funding error: ${err.message}`);
    return null;
  }

  // cvdAbsorption : borne haute ET basse prix (correction revue code #4)
  const cvdAbsorption       = cvdChange4h >= CVD_ABS_RATIO
    && priceChange4h >= PRICE_STABLE_MIN
    && priceChange4h <= PRICE_STABLE_MAX;
  const cvdStrongDivergence = cvdChange4h > CVD_DIV_RATIO && priceChange4h < PRICE_DOWN_MIN;
  const basis               = basisData?.basis ?? 0;
  const basisBullish        = basis > BASIS_THRESHOLD;

  // Funding fail-closed : si null (API down), perp interdit (correction revue code #5)
  const fundingAvailable   = fundingRate !== null;
  const fr                 = fundingRate;
  const fundingScore       = fundingAvailable && fr <= FUNDING_SCORE_LO && fr >= FUNDING_SCORE_HI ? 1 : 0;
  const fundingPerpAllowed = fundingAvailable && fr >= FUNDING_SCORE_HI;
  const fundingSpotPriority = fundingAvailable && fr < FUNDING_SCORE_HI;

  // Score — CVD bloque max 1 point : cvdStrongDivergence prioritaire (correction revue code #3)
  let score = 0;
  const detail = [];
  if (cvdStrongDivergence)  { score += 1; detail.push(`CVD_DIV ${(cvdChange4h * 100).toFixed(2)}%`); }
  else if (cvdAbsorption)   { score += 1; detail.push(`CVD_ABS ${(cvdChange4h * 100).toFixed(2)}%`); }
  if (basisBullish)         { score += 1; detail.push(`BASIS ${(basis * 100).toFixed(3)}%`); }
  score += oiData.score;
  if (oiData.score > 0) detail.push(`${oiData.regime} OI${(oiData.oiChangePct * 100).toFixed(1)}%`);
  if (msb1h)                { score += 1; detail.push('MSB_1H'); }
  if (fundingScore)         { score += 1; detail.push(`FUNDING ${(fr * 100).toFixed(4)}%`); }

  return {
    symbol, lastPrice, score,
    cvdAbsorption, cvdStrongDivergence,
    basisBullish, basis,
    oiRegime: oiData.regime, oiChangePct: oiData.oiChangePct,
    msb15m, msb1h,
    fr, fundingAvailable, fundingPerpAllowed, fundingSpotPriority,
    detail, cvdChange4h, priceChange4h,
  };
}

// ─── Scan principal ───────────────────────────────────────────────────────────
async function scanSmartMoney() {
  let candidates;
  try {
    candidates = await fetchCandidates();
  } catch (err) {
    console.error('[smart-money] fetchCandidates error:', err.message);
    return;
  }
  if (!candidates.length) return;

  const now  = Date.now();
  const mode = getMode();

  await Promise.allSettled(candidates.map(async ({ symbol, lastPrice }) => {
    const cooldownUntil = cooldowns.get(symbol);
    if (cooldownUntil && now < cooldownUntil) return;

    const data = await analyzeSymbol(symbol, lastPrice).catch(err => {
      console.warn(`[smart-money] analyzeSymbol ${symbol}:`, err.message);
      return null;
    });
    if (!data) return;

    const capActive  = isCapWatcherActive(symbol);
    const perpSignal = data.score >= SCORE_PERP
      && data.cvdStrongDivergence
      && data.basisBullish
      && data.msb15m
      && data.fundingPerpAllowed
      && !capActive;

    const spotSignal = data.score >= SCORE_SPOT
      && (data.cvdAbsorption || data.cvdStrongDivergence)
      && !capActive;

    if (!perpSignal && !spotSignal) return;

    console.log(`[smart-money] 💎 ${symbol} score=${data.score}/6 perp=${perpSignal} spot=${spotSignal} cap=${capActive} — ${data.detail.join(' | ')}`);
    cooldowns.set(symbol, now + COOLDOWN_MS);

    const lines = [
      `💎 <b>SMART MONEY</b>  ·  ${symbol}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Score <b>${data.score}/6</b>  ·  <i>${data.detail.join(' · ')}</i>`,
      `Prix <code>$${lastPrice.toFixed(4)}</code>  ·  Basis <code>${(data.basis * 100).toFixed(3)}%</code>`,
      `CVD4h <code>${(data.cvdChange4h * 100).toFixed(2)}%</code>  ·  Δprix4h <code>${(data.priceChange4h * 100).toFixed(2)}%</code>`,
      `MSB15m <b>${data.msb15m ? '✅' : '❌'}</b>  ·  MSB1h <b>${data.msb1h ? '✅' : '❌'}</b>  ·  OI <i>${data.oiRegime}</i>`,
    ];
    if (perpSignal) lines.push(`\n⚡ <b>PERP LONG</b> — CVD div + basis + MSB15m + funding ✅`);
    if (spotSignal && data.fundingSpotPriority) lines.push(`\n💰 <b>SPOT DCA prioritaire</b> — funding extrême <code>${(data.fr * 100).toFixed(4)}%</code>`);
    else if (spotSignal)                        lines.push(`\n💰 <b>SPOT DCA</b>`);
    if (!data.fundingAvailable) lines.push(`\n⚠️ <i>Funding API indisponible — perp bloqué</i>`);
    lines.push(`\n<i>⚠️ Accumulation smart money — pas de trade perp sans confirmation manuelle sauf LIVE</i>`);

    try { await sendTelegram(lines.join('\n')); }
    catch (err) { console.error(`[smart-money] Telegram ${symbol}:`, err.message); }

    // Garde canTradeLive pour DCA ET perp (correction revue code #6 + refactor)
    const canTradeLive = mode === 'LIVE' && !isPaused() && !isEmergencyStopped();

    if (spotSignal) {
      if (canTradeLive) {
        await startDCA(symbol, lastPrice).catch(err =>
          console.error(`[smart-money] startDCA ${symbol}:`, err.message)
        );
      } else {
        console.log(`[smart-money] ${mode} — DCA simulé ${symbol}`);
      }
    }

    if (perpSignal) {
      if (canTradeLive) {
        try {
          const order = await executeOrder({ symbol, side: 'LONG', entry: lastPrice, extra: { reduce_size: false } });
          if (order.success) {
            const fill = order.price ?? lastPrice;
            const risk = fill * 0.02;
            // registerTrade avant recordTrade (correction revue code #8)
            await registerTrade({ symbol, side: 'LONG', entry: fill, sl: fill - risk, tp1: fill + risk * 2, tp2: fill + risk * 3, qty: order.qty });
            recordTrade();
            console.log(`[smart-money] PERP LONG ${symbol} fill=${fill.toFixed(4)} sl=${(fill - risk).toFixed(4)}`);
          } else {
            console.error(`[smart-money] ordre échoué ${symbol}: ${order.error}`);
          }
        } catch (err) {
          console.error(`[smart-money] executeOrder ${symbol}:`, err.message);
        }
      } else {
        console.log(`[smart-money] ${mode} — ordre simulé PERP LONG ${symbol}`);
      }
    }
  }));
}

// ─── Export ───────────────────────────────────────────────────────────────────
export function startSmartMoneyScanner() {
  // Singleton module-level — empêche multi-start (correction revue code #9)
  if (scannerStarted) return;
  scannerStarted = true;
  console.log('[smart-money] v2 démarré — CVD+basis+MSB, scan toutes les 4h');

  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      // Optional chaining — robustesse si modules absent (correction revue code)
      if (!getBotState()?.modules?.smartMoney) return;
      await scanSmartMoney();
    } catch (err) {
      console.error('[smart-money] tick error:', err.message);
    } finally {
      isRunning = false;
      schedule();
    }
  };
  const schedule = () => setTimeout(() => tick().catch(console.error), SCAN_INTERVAL_MS);
  tick().catch(console.error);
}
