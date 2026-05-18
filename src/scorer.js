import {
  getTaAnalysis,
  getTaV6,
  getDerivatives,
  getSpotPerpBasis,
  getMarketStructureBreaks,
  getRealizedVol,
  getAssetCorrelations,
  getBybitSnapshot,
} from './perp-client.js';

// ── TA Score (0–5) ──────────────────────────────────────────────
function scoreTa(ta, msb, v6 = null) {
  const tf1h = ta.tf_1h;
  const direction = tf1h.ta_direction; // "long" | "short" | "neutral"

  // Base from ta_score_1h
  const BASE_MAP = { 5: 3.0, 4: 2.5, 3: 2.0, 2: 1.5, 1: 1.0, 0: 0.0 };
  let score = BASE_MAP[ta.ta_score_1h] ?? 0.0;
  const detail = [`+${score.toFixed(1)} base (TA Score ${ta.ta_score_1h}/5)`];

  // Bonus: trend alignment total
  if (ta.trend_alignment === 'total') {
    score += 1.0;
    detail.push('+1.0 alignement TF total');
  }

  // Bonus: price at S/R (≤ 1%)
  const atSr = ta.sr.price_vs_sr === 'at_support' || ta.sr.price_vs_sr === 'at_resistance';
  if (atSr) {
    score += 0.5;
    detail.push('+0.5 prix sur S/R');
  }

  // Bonus: VWAP confirms direction
  const vwapOk = (direction === 'long'  && tf1h.vwap_position === 'above') ||
                 (direction === 'short' && tf1h.vwap_position === 'below');
  if (vwapOk) {
    score += 0.5;
    detail.push('+0.5 VWAP confirme');
  }

  // Penalty: in void AND nothing within 3%
  const inVoid = ta.sr.price_vs_sr === 'in_void' &&
    (ta.sr.nearest_support_pct    === null || ta.sr.nearest_support_pct    > 3) &&
    (ta.sr.nearest_resistance_pct === null || ta.sr.nearest_resistance_pct > 3);
  if (inVoid) {
    score -= 0.5;
    detail.push('-0.5 zone de vide');
  }

  // Penalty: 1D vs 4H contradiction
  const contradiction =
    (ta.tf_1d.trend === 'bullish' && ta.tf_4h.trend === 'bearish') ||
    (ta.tf_1d.trend === 'bearish' && ta.tf_4h.trend === 'bullish');
  if (contradiction) {
    score -= 0.5;
    detail.push('-0.5 TF contradictoires (1D vs 4H)');
  }

  // MSB modifier (Gemini Option A — direction-aware)
  if (msb?.last_msb) {
    const msbDir = msb.last_msb;
    if (msbDir === 'bullish' && direction === 'long') {
      score += 1.0;
      detail.push('+1.0 MSB 4h bullish confirme long');
    } else if (msbDir === 'bearish' && direction === 'short') {
      score += 1.0;
      detail.push('+1.0 MSB 4h bearish confirme short');
    } else if (msbDir === 'bearish' && direction === 'long') {
      score -= 1.0;
      detail.push('-1.0 MSB 4h bearish contre-signal long');
    } else if (msbDir === 'bullish' && direction === 'short') {
      score -= 1.0;
      detail.push('-1.0 MSB 4h bullish contre-signal short');
    }
  }

  return { score, detail, direction };
}

// ── Derivatives Score (0–5) ─────────────────────────────────────
function scoreDer(der, direction, ta, basis) {
  let score = 0;
  const detail = [];

  const { snapshot, oi1h, orderbook, liquidations, meFunding, meOi, regime } = der;

  // Funding extreme — seuils hybrides : max(fixe, avg14j + delta)
  const funding      = snapshot?.funding_rate ?? 0;
  const fundingAvg   = regime?.avg_rate ?? regime?.avg_funding_rate ?? 0;
  const shortThresh  = Math.max(0.0006, fundingAvg + 0.0004);
  const longThresh   = Math.min(-0.0003, fundingAvg - 0.0002);
  if ((direction === 'short' && funding > shortThresh) ||
      (direction === 'long'  && funding < longThresh)) {
    score += 1.5;
    detail.push(`+1.5 funding extrême (${(funding * 100).toFixed(4)}% > seuil ${(direction === 'short' ? shortThresh : longThresh) * 100 .toFixed(4)}%)`);
  }

  // OI matrix
  const oiPct = oi1h?.oi_change_pct ?? 0;
  const price24hPct = snapshot?.change_24h_pct ?? 0;
  const oiConfirms =
    (direction === 'long'  && oiPct > 2  && price24hPct > 0) ||   // momentum long
    (direction === 'long'  && oiPct < -2 && price24hPct > 0) ||   // short squeeze
    (direction === 'short' && oiPct > 2  && price24hPct < 0) ||   // momentum short
    (direction === 'short' && oiPct < -2 && price24hPct < 0);     // capitulation
  if (oiConfirms) {
    score += 1.5;
    detail.push('+1.5 OI matrix confirme');
  }

  // CVD divergence (remplace orderbook — flux taker exécuté > snapshot carnet manipulable)
  const cvdDiv = ta?.tf_1h?.cvd_divergence ?? 'none';
  if ((direction === 'long'  && cvdDiv === 'bullish') ||
      (direction === 'short' && cvdDiv === 'bearish')) {
    score += 0.5;
    detail.push('+0.5 CVD divergence confirme');
  }

  // Multi-exchange funding convergence — OI-weighted
  const meRates = (meFunding?.exchanges ?? [])
    .map(e => e.funding_rate)
    .filter(r => r !== null && r !== undefined);

  const meEntries = (meFunding?.exchanges ?? [])
    .map(e => {
      const oi = (meOi?.exchanges ?? []).find(o => o.exchange === e.exchange);
      return { rate: e.funding_rate, weight: oi?.open_interest_usd ?? 0 };
    })
    .filter(e => e.rate != null);

  const totalOi = meEntries.reduce((s, e) => s + e.weight, 0);
  const weightedRate = meEntries.length >= 2 && totalOi > 0
    ? meEntries.reduce((s, e) => s + e.rate * e.weight, 0) / totalOi
    : null;

  const meConverge = weightedRate != null &&
    ((direction === 'short' && weightedRate >  0.0003) ||
     (direction === 'long'  && weightedRate < -0.0002));
  if (meConverge) {
    score += 0.5;
    detail.push(`+0.5 multi-exchange converge (OI-pondéré: ${(weightedRate * 100).toFixed(4)}%)`);
  }

  // Liquidations favorable
  const liqDom = liquidations?.dominant_side ?? '';
  if ((direction === 'long'  && liqDom === 'LONGS_REKT') ||
      (direction === 'short' && liqDom === 'SHORTS_REKT')) {
    score += 0.5;
    detail.push('+0.5 liquidations favorables');
  }

  // Penalties
  const meFundSpread = meRates.length >= 2
    ? Math.max(...meRates) - Math.min(...meRates) : 0;
  if (meFundSpread > 0.001) {  // >0.10%
    score -= 0.5;
    detail.push('-0.5 funding divergent inter-exchange');
  }

  const meOiNull = !meOi || (meOi?.exchanges ?? []).filter(e => e.open_interest_usd !== null).length < 2;
  if (meOiNull) {
    score -= 0.5;
    detail.push('-0.5 OI multi-exchange indisponible');
  }

  // Basis modifier — contextuel : premium qualifié par funding delta + OI
  if (basis?.signal) {
    const sig = basis.signal;
    if (direction === 'long') {
      if (sig === 'discount' || sig === 'neutral') {
        score += 1.0;
        detail.push(`+1.0 basis ${sig} — spot-driven, breakout valide`);
      } else {
        const history      = der.history ?? [];
        const currentRate  = snapshot?.funding_rate ?? 0;
        const lastSettled  = history.length >= 1 ? parseFloat(history[history.length - 1]?.fundingRate ?? 0) : null;
        const fundingRising = lastSettled !== null && currentRate > lastSettled;
        const oiRising      = (oi1h?.oi_change_pct ?? 0) > 0;
        if (fundingRising && oiRising) {
          score += 1.0;
          detail.push(`+1.0 basis premium + funding↑ (${(currentRate*100).toFixed(4)}% > ${(lastSettled*100).toFixed(4)}%) + OI↑ — momentum sain`);
        } else {
          score -= 1.5;
          detail.push(`-1.5 basis premium — funding${fundingRising ? '↑' : '↓/='}, OI${oiRising ? '↑' : '↓'} — momentum non confirmé`);
        }
      }
    } else { // short
      if (sig === 'premium') {
        score += 1.0;
        detail.push(`+1.0 basis premium — longs surendettés, squeeze potentiel short`);
      } else if (sig === 'discount') {
        score -= 0.5;
        detail.push(`-0.5 basis discount — spot mène déjà la baisse, risque squeeze short`);
      }
    }
  }

  return { score, detail, meFundSpread };
}

// ── Vetos DER toxiques ───────────────────────────────────────────
// ADR-6: seuil funding spread dynamique — 0.75% si squeeze context, 0.10% sinon
// Squeeze context = scan 'squeeze'/'crowded_unwind', |funding|>0.20%, ou OI explosion >20%
function hasToxicDerSignal(der, ta, direction, meFundSpread, scans = []) {
  const oiPct      = der.oi1h?.oi_change_pct ?? 0;
  const price24h   = der.snapshot?.change_24h_pct ?? 0;
  if (direction === 'long'  && oiPct < -15) return `OI capitulation long (${oiPct.toFixed(1)}%) — move épuisé`;
  // OI explosion SHORT veto uniquement si prix ne confirme pas (haussier ou flat) — risque squeeze
  // Si prix baissier + OI↑ = momentum short ouvert, DER score récompense déjà (+1.5 OI matrix)
  if (direction === 'short' && oiPct > 15 && price24h >= 0) return `OI explosion short (${oiPct.toFixed(1)}%) + prix non-confirmé (${price24h.toFixed(1)}%) — risque short squeeze`;

  const isSqueezeContext = scans.includes('squeeze') || scans.includes('crowded_unwind')
    || Math.abs(der.snapshot?.funding_rate ?? 0) > 0.002
    || oiPct > 20;
  const spreadThreshold = isSqueezeContext ? 0.0075 : 0.001;
  if (meFundSpread > spreadThreshold) {
    const ctx = isSqueezeContext ? ' [squeeze exempt >0.75%]' : '';
    return `Funding inter-exchange divergent (spread ${(meFundSpread * 100).toFixed(3)}%${ctx})`;
  }

  const cvdDiv = ta?.tf_1h?.cvd_divergence ?? 'none';
  if (direction === 'long'  && cvdDiv === 'bearish') return `CVD bearish contre setup long`;
  if (direction === 'short' && cvdDiv === 'bullish') return `CVD bullish contre setup short`;

  return null;
}

// ── Catégories des scans Phase 1 (pour bonus orthogonalité) ──────
const SCAN_CATEGORY = {
  funding_extremes:   'FLUX',
  funding_divergence: 'FLUX',
  cross_exchange:     'FLUX',
  oi_movers:          'ENGAGEMENT',
  volatility:         'MICROSTRUCTURE',
};

// ── Main scoring entry point ─────────────────────────────────────
export async function runAnalysis(symbol, scans = []) {
  // Fetch TA, derivatives, context endpoints and BTC context in parallel
  // .catch(() => null) on context endpoints — graceful degradation if VPS not yet deployed
  // btcTa fetched unconditionally in Promise.all to avoid sequential latency in Gate 3
  const [ta, der, rv, corr, msb, basis, btcTa, v6Native, bybitSnap] = await Promise.all([
    getTaAnalysis(symbol),
    getDerivatives(symbol),
    getRealizedVol(symbol).catch(() => null),
    getAssetCorrelations(symbol).catch(() => null),
    getMarketStructureBreaks(symbol).catch(() => null),
    getSpotPerpBasis(symbol).catch(() => null),
    getTaAnalysis('BTCUSDT').catch(() => null),
    getTaV6(symbol).catch(() => null),
    getBybitSnapshot(symbol).catch(() => null),
  ]);

  const taResult  = scoreTa(ta, msb);
  const derResult = scoreDer(der, taResult.direction, ta, basis);

  // Bonus orthogonalité : +0.5 DER si ≥2 catégories distinctes en Phase 1
  const categories = new Set(scans.map(s => SCAN_CATEGORY[s]).filter(Boolean));
  if (categories.size >= 2) {
    derResult.score = Math.min(5.0, derResult.score + 0.5);
    derResult.detail.push(`+0.5 confluence orthogonale (${[...categories].join('+')})`);
  }

  // Scores not clamped to 0 — negative values propagate to total and trigger rejection correctly
  let total = taResult.score + derResult.score;

  // V6 native — régime multiplier + bonus divergences/Wyckoff alignés
  const direction = taResult.direction;
  let v6GateOppose = false;
  let v6GateDetail = '';
  if (v6Native) {
    const regime = v6Native.regime?.regime ?? 'MIXED';
    // Regime multiplier (validated formula: aligned ×1.1, ranging ×0.9, opposing → gate)
    if ((regime === 'TREND_UP' && direction === 'long') ||
        (regime === 'TREND_DOWN' && direction === 'short')) {
      total = +(total * 1.1).toFixed(2);
      taResult.detail.push(`×1.1 régime ${regime} aligné`);
    } else if ((regime === 'TREND_UP' && direction === 'short') ||
               (regime === 'TREND_DOWN' && direction === 'long')) {
      v6GateOppose = true;
      v6GateDetail = `Régime ${regime} oppose direction ${direction}`;
    } else if (regime === 'RANGING') {
      total = +(total * 0.9).toFixed(2);
      taResult.detail.push(`×0.9 régime RANGING (trend-following découragé)`);
    }
    // V6 bonus — seulement si biais aligné avec direction du trade
    const v6BiasLower = (v6Native.v6_bias ?? 'NEUTRAL').toLowerCase();
    if (v6BiasLower === direction && v6Native.v6_bonus > 0) {
      total = +(total + v6Native.v6_bonus).toFixed(2);
      taResult.detail.push(`+${v6Native.v6_bonus.toFixed(2)} V6 [${(v6Native.v6_detail ?? []).join(' | ')}]`);
    } else if (v6BiasLower !== 'neutral' && v6BiasLower !== direction) {
      // Dynamic threshold: extreme funding → V6 opposition requires stronger conviction (consensus 3/3 LLMs)
      const absFunding  = Math.abs(der?.snapshot?.funding_rate ?? 0);
      const v6Threshold = absFunding >= 0.005 ? 4.0   // |funding| ≥ 0.50% — signal très directionnel
                        : absFunding >= 0.002 ? 3.0   // |funding| ≥ 0.20%
                        : 2.0;                         // default
      if (v6Native.v6_bonus >= v6Threshold) {
        v6GateOppose = true;
        v6GateDetail = `V6 opposition forte (${v6Native.v6_bias} vs ${direction} bonus=${v6Native.v6_bonus.toFixed(1)} seuil=${v6Threshold})`;
      }
    }
  }
  total = Math.min(10, Math.max(0, total));

  const vetoReason = hasToxicDerSignal(der, ta, taResult.direction, derResult.meFundSpread, scans);
  const hardFloor = vetoReason != null || (taResult.score < 3.0 && derResult.score < 2.5);
  // Soft floor TA : si TA ≤ 1.0 → exige DER ≥ 4.0 ET OI Δ1h < 0
  const taLowFloor = taResult.score <= 1.0 &&
    (derResult.score < 4.0 || (der.oi1h?.oi_change_pct ?? 0) >= 0);

  // ── Gates (Gemini Option A — Hard Blocks) ───────────────────────
  let gateBlock  = false;
  let gateReason = null;
  let reduceSize = false;

  // Gate 1+2: RV elevated (P80+) → reduce_size_50pct. Hard block via DER veto only (consensus 3/3 LLMs)
  // P95+ alone is not a hard block — only when combined with toxic DER (handled by hasToxicDerSignal below)
  if (rv?.regime === 'climax' || rv?.regime === 'extreme') {
    reduceSize = true;
  }

  // Gate 3: V6 opposition forte (régime contradictoire ou Wyckoff/divergences opposés)
  if (!gateBlock && v6GateOppose) {
    gateBlock  = true;
    gateReason = v6GateDetail;
    taResult.detail.push(`${v6GateDetail} → blocage signal`);
  }

  // Gate 5: Bybit vs Binance price divergence > 1.5% → arb bots will converge → SL risk
  if (!gateBlock && bybitSnap?.last_price != null && der?.snapshot?.price != null) {
    const binancePrice = Number(der.snapshot.price);
    const bybitPrice   = Number(bybitSnap.last_price);
    const dir          = taResult.direction;
    if (Number.isFinite(binancePrice) && Number.isFinite(bybitPrice) && dir) {
      const divergence  = bybitPrice / binancePrice;
      const isDivergent = (dir === 'long'  && divergence < 0.985) ||
                          (dir === 'short' && divergence > 1.015);
      if (isDivergent) {
        gateBlock  = true;
        gateReason = `Bybit/Binance divergence ${((divergence - 1) * 100).toFixed(2)}% (Binance:${binancePrice}, Bybit:${bybitPrice})`;
      }
    }
  }

  // Gate 6: MSB < 120 min ET oppose signal → structure trop récente pour entrer contre
  if (!gateBlock && msb?.last_msb && msb?.last_msb_time && taResult?.direction) {
    const msbTimeMs = Date.parse(msb.last_msb_time);
    if (Number.isFinite(msbTimeMs)) {
      const msbAgeMinutes = (Date.now() - msbTimeMs) / 60000;
      if (msbAgeMinutes >= 0 && msbAgeMinutes < 120) {
        const isOpposingMsb =
          (taResult.direction === 'long'  && msb.last_msb === 'bearish') ||
          (taResult.direction === 'short' && msb.last_msb === 'bullish');
        if (isOpposingMsb) {
          gateBlock  = true;
          gateReason = `Gate #8 MSB opposant trop récent (${msb.last_msb}, ${msbAgeMinutes.toFixed(1)} min ago)`;
        }
      }
    }
  }

  // Gate 4: BTC correlation > 0.80 AND BTC at CONTRADICTORY S/R → systemic risk
  // Direction-aware (Gemini fix): LONG+BTC@support = best confluence, NOT a block
  // Block only: LONG+BTC@resistance OR SHORT+BTC@support
  const btcCorrMacro = corr?.vs_btc?.macro_7d_4h ?? 0;
  if (!gateBlock && btcCorrMacro > 0.80) {
    const btcState = btcTa?.sr?.price_vs_sr;
    const isBlockedLong  = taResult.direction === 'long'  && btcState === 'at_resistance';
    const isBlockedShort = taResult.direction === 'short' && btcState === 'at_support';
    if (isBlockedLong || isBlockedShort) {
      gateBlock  = true;
      gateReason = `BTC corr macro ${btcCorrMacro.toFixed(2)} + BTC contradictoire (${btcState}) — risque systémique`;
    }
  }

  // Gate 7: Funding extrême contre le signal → hard veto (P1.1)
  const FUNDING_VETO_RATE = (Number(process.env.FUNDING_VETO_PCT) || 0.15) / 100;
  const fundingForVeto = Number.isFinite(Number(der?.snapshot?.funding_rate))
    ? Number(der.snapshot.funding_rate) : null;
  if (!gateBlock && fundingForVeto !== null) {
    const fundingVeto =
      (taResult.direction === 'long'  && fundingForVeto >  FUNDING_VETO_RATE) ||
      (taResult.direction === 'short' && fundingForVeto < -FUNDING_VETO_RATE);
    if (fundingVeto) {
      gateBlock  = true;
      gateReason = `Funding veto: ${taResult.direction} — ${(fundingForVeto * 100).toFixed(4)}% dépasse seuil ±${(FUNDING_VETO_RATE * 100).toFixed(2)}%`;
    }
  }

  const rejected  = hardFloor || taLowFloor || gateBlock;
  const force     = rejected ? 'REJETÉ' : total >= 7.0 ? 'FORT' : total >= 5.0 ? 'MODÉRÉ' : 'REJETÉ';
  const inVoid    = ta.sr.price_vs_sr === 'in_void';
  const orderType = rejected || force === 'REJETÉ' ? 'NO_TRADE'
    : inVoid ? 'PENDING_LIMIT'
    : taResult.direction === 'long'  ? 'MARKET_LONG'
    : taResult.direction === 'short' ? 'MARKET_SHORT'
    : 'NO_TRADE';

  // Contrarian flag : funding extrême OPPOSÉ à la direction TA → foule piégée → LLM tranché
  const cFundingRate = Number(der?.snapshot?.funding_rate);
  const cFundingAvg  = Number(der?.regime?.avg_rate ?? der?.regime?.avg_funding_rate ?? 0);
  const cShortThresh = Number.isFinite(cFundingAvg) ? Math.max(0.0006, cFundingAvg + 0.0004) : 0.0006;
  const cLongThresh  = Number.isFinite(cFundingAvg) ? Math.min(-0.0003, cFundingAvg - 0.0002) : -0.0003;
  const contrarianSignal = Number.isFinite(cFundingRate) && (
    (taResult.direction === 'short' && cFundingRate < cLongThresh) ||
    (taResult.direction === 'long'  && cFundingRate > cShortThresh)
  );

  return {
    symbol,
    signal:    orderType,
    force,
    total:     +total.toFixed(1),
    ta_score:  +taResult.score.toFixed(1),
    der_score: +derResult.score.toFixed(1),
    direction: taResult.direction,
    ta_detail:  taResult.detail,
    der_detail: derResult.detail,
    ta,
    der,
    // Context fields (Gemini Option A)
    rv_regime:      rv?.regime      ?? null,
    reduce_size:    reduceSize,
    gate_block:     gateBlock,
    gate_reason:    gateReason,
    veto_reason:    vetoReason,
    msb_direction:  msb?.last_msb   ?? null,
    basis_signal:   basis?.signal   ?? null,
    btc_corr_macro: corr?.vs_btc?.macro_7d_4h ?? null,
    v6_bias:        v6Native?.v6_bias         ?? null,
    v6_bonus:       v6Native?.v6_bonus        ?? null,
    v6_regime:      v6Native?.regime?.regime  ?? null,
    v6_detail:      v6Native?.v6_detail       ?? [],
    contrarian_signal: contrarianSignal,
  };
}
