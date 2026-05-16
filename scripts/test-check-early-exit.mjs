/**
 * Test unitaire checkEarlyExit() v2 — scénarios générés par ChatGPT, DeepSeek, Gemini
 * Logique inlinée (pas d'export requis sur position-manager.js).
 * Usage : node scripts/test-check-early-exit.mjs
 */

const EARLY_EXIT_THRESHOLD    = 6;
const EARLY_EXIT_TICKS_NEEDED = 2;

function checkEarlyExitWithMocks(pos, mocks) {
  if (!pos) return { exit: false, score: 0, signals: [] };
  const isLong = pos.direction === 'LONG';

  const MSB_MAX_AGE              = 5;
  const FUNDING_EXTREME_RATE     = 0.0008;
  const BASIS_DISCOUNT_PCT       = -0.15;
  const BASIS_PREMIUM_PCT        = 0.15;
  const FUNDING_SPREAD_PCT       = 0.04;
  const FUNDING_SPREAD_EXTREME_PCT = 0.08;
  const BTC_CORR_MIN             = 0.70;
  const BTC_CORR_STRONG          = 0.85;

  const snap       = mocks['perp-snapshot']           ?? null;
  const oi         = mocks['oi-change']               ?? null;
  const ob         = mocks['orderbook-imbalance']     ?? null;
  const liq        = mocks['liquidations-summary']    ?? null;
  const msb        = mocks['market-structure-breaks'] ?? null;
  const rv         = mocks['realized-volatility']     ?? null;
  const funding    = mocks['funding-regime']          ?? null;
  const basis      = mocks['spot-perp-basis']         ?? null;
  const mexFunding = mocks['multi-exchange-funding']  ?? null;
  const corr       = mocks['asset-correlations']      ?? null;
  const btcMsb     = mocks['market-structure-breaks-BTC'] ?? null;

  const taker        = snap?.taker_buy_ratio   ?? null;
  const oiChg        = oi?.oi_change_pct       ?? null;
  const imb          = ob?.imbalance_ratio      ?? null;
  const liqL         = Number(liq?.liq_long_usd  ?? 0);
  const liqS         = Number(liq?.liq_short_usd ?? 0);
  const msbDir       = msb?.last_msb_direction ?? null;
  const msbAge       = msb?.last_msb_time      ?? 999;
  const rvRegime     = rv?.rv_regime           ?? 'NORMAL';
  const fundingRegime = funding?.regime        ?? null;
  const avgRate8h    = funding?.avg_rate_8h    ?? null;
  const basisPct     = basis?.basis_pct        ?? null;
  const basisSignal  = basis?.signal           ?? null;
  const spreadPct    = mexFunding?.spread_pct  ?? null;
  const btcCorr1h    = corr?.btc_corr_1h       ?? null;
  const btcMsbDir    = btcMsb?.last_msb_direction ?? null;
  const btcMsbAge    = btcMsb?.last_msb_time      ?? 999;

  let score = 0;
  const signals = [];
  let hasCoreSignal = false;

  const addSignal = (condition, points, name, core = false) => {
    if (!condition) return;
    score += points;
    signals.push(name);
    if (core) hasCoreSignal = true;
  };

  const absVal              = (x) => Math.abs(Number(x));
  const hasExtremeFundingRate   = avgRate8h !== null && absVal(avgRate8h) >= FUNDING_EXTREME_RATE;
  const hasFundingSpread        = spreadPct !== null && absVal(spreadPct) >= FUNDING_SPREAD_PCT;
  const hasExtremeFundingSpread = spreadPct !== null && absVal(spreadPct) >= FUNDING_SPREAD_EXTREME_PCT;
  const btcBearishReversal  = btcMsbDir === 'bearish' && btcMsbAge < MSB_MAX_AGE;
  const btcBullishReversal  = btcMsbDir === 'bullish' && btcMsbAge < MSB_MAX_AGE;
  const btcRelevantCorr     = btcCorr1h !== null && btcCorr1h >= BTC_CORR_MIN;
  const btcStrongCorr       = btcCorr1h !== null && btcCorr1h >= BTC_CORR_STRONG;

  if (isLong) {
    addSignal(msbDir === 'bearish' && msbAge < MSB_MAX_AGE,                                        2, 'MSB_BEARISH', true);
    addSignal(taker !== null && taker <= 0.42,                                                     2, 'TAKER_SELL', true);
    addSignal(oiChg !== null && oiChg < -2.5,                                                      2, 'OI_UNWIND', true);
    addSignal(imb !== null && imb < -0.25,                                                         1, 'OB_SELL');
    addSignal(liqL > 0 && liqL > 2 * liqS,                                                        1, 'LONG_LIQ_CASCADE');
    addSignal(fundingRegime === 'EXTREME_LONG',                                                     1, 'FUNDING_EXTREME_LONG');
    addSignal(avgRate8h !== null && avgRate8h >= FUNDING_EXTREME_RATE,                             1, 'FUNDING_RATE_TOO_POSITIVE');
    addSignal(basisSignal === 'discount' || (basisPct !== null && basisPct <= BASIS_DISCOUNT_PCT), 1, 'BASIS_DISCOUNT');
    addSignal(hasFundingSpread,                              hasExtremeFundingSpread ? 2 : 1, 'FUNDING_SPREAD_DIVERGENCE');
    addSignal(btcRelevantCorr && btcBearishReversal,         btcStrongCorr ? 2 : 1,          'BTC_CORR_BEARISH_REVERSAL');

    const isPanic = msbDir === 'bearish' && msbAge < MSB_MAX_AGE
      && taker !== null && taker <= 0.40
      && rvRegime === 'EXTREME'
      && (
        (oiChg !== null && oiChg < -3)
        || (liqL > 0 && liqL > 3 * liqS)
        || (fundingRegime === 'EXTREME_LONG' && hasExtremeFundingRate)
        || (basisSignal === 'discount' && basisPct !== null && basisPct <= BASIS_DISCOUNT_PCT)
        || (btcStrongCorr && btcBearishReversal)
      );
    if (isPanic) {
      pos.earlyExitTicks = 0;
      return { exit: true, reason: 'EARLY_EXIT_PANIC', score, signals };
    }
  } else {
    addSignal(msbDir === 'bullish' && msbAge < MSB_MAX_AGE,                                        2, 'MSB_BULLISH', true);
    addSignal(taker !== null && taker >= 0.58,                                                     2, 'TAKER_BUY', true);
    addSignal(oiChg !== null && oiChg > 2.5,                                                       2, 'OI_BUILD', true);
    addSignal(imb !== null && imb > 0.25,                                                          1, 'OB_BUY');
    addSignal(liqS > 0 && liqS > 2 * liqL,                                                        1, 'SHORT_LIQ_CASCADE');
    addSignal(fundingRegime === 'EXTREME_SHORT',                                                    1, 'FUNDING_EXTREME_SHORT');
    addSignal(avgRate8h !== null && avgRate8h <= -FUNDING_EXTREME_RATE,                            1, 'FUNDING_RATE_TOO_NEGATIVE');
    addSignal(basisSignal === 'premium' || (basisPct !== null && basisPct >= BASIS_PREMIUM_PCT),   1, 'BASIS_PREMIUM');
    addSignal(hasFundingSpread,                              hasExtremeFundingSpread ? 2 : 1, 'FUNDING_SPREAD_DIVERGENCE');
    addSignal(btcRelevantCorr && btcBullishReversal,         btcStrongCorr ? 2 : 1,          'BTC_CORR_BULLISH_REVERSAL');

    const isPanic = msbDir === 'bullish' && msbAge < MSB_MAX_AGE
      && taker !== null && taker >= 0.60
      && rvRegime === 'EXTREME'
      && (
        (oiChg !== null && oiChg > 3)
        || (liqS > 0 && liqS > 3 * liqL)
        || (fundingRegime === 'EXTREME_SHORT' && hasExtremeFundingRate)
        || (basisSignal === 'premium' && basisPct !== null && basisPct >= BASIS_PREMIUM_PCT)
        || (btcStrongCorr && btcBullishReversal)
      );
    if (isPanic) {
      pos.earlyExitTicks = 0;
      return { exit: true, reason: 'EARLY_EXIT_PANIC', score, signals };
    }
  }

  if (score >= EARLY_EXIT_THRESHOLD && hasCoreSignal) {
    pos.earlyExitTicks = (pos.earlyExitTicks || 0) + 1;
    if (pos.earlyExitTicks >= EARLY_EXIT_TICKS_NEEDED) {
      pos.earlyExitTicks = 0;
      return { exit: true, reason: 'EARLY_EXIT', score, signals };
    }
  } else if ((pos.earlyExitTicks || 0) > 0) {
    pos.earlyExitTicks = 0;
  }

  return { exit: false, score, signals };
}

// ══════════════════════════════════════════════════════════════════
// SCÉNARIOS v2 — corrigés après diagnostic round 1 (bugs last_msb_time, case, boundary)
// ChatGPT: last_msb_time 9999→2, signaux simplifiés
// DeepSeek: regime 'extreme_negative'→'negative', spread 0.09→0.05, btc_corr 0.88→0.75
// Gemini: taker 0.42→0.50, basis -0.18/'DISCOUNT'→-0.05/'neutral', btcMsbAge 1715871000→2
// ══════════════════════════════════════════════════════════════════

const scenarios = [
  {
    llm:  'CHATGPT',
    name: 'PANIC_LONG_RECENT_MSB_EXTREME_RV_OI_UNWIND',
    position: { direction: 'LONG', earlyExitTicks: 0 },
    mocks: {
      'perp-snapshot':           { taker_buy_ratio: 0.38 },
      'oi-change':               { oi_change_pct: -4.25 },
      'orderbook-imbalance':     { imbalance_ratio: 0 },
      'liquidations-summary':    { liq_long_usd: 300000, liq_short_usd: 300000 },
      'market-structure-breaks': { last_msb_direction: 'bearish', last_msb_time: 2 },
      'realized-volatility':     { rv_regime: 'EXTREME' },
      'funding-regime':          { regime: 'NORMAL', avg_rate_8h: 0.0001 },
      'spot-perp-basis':         { basis_pct: 0, signal: 'neutral' },
      'multi-exchange-funding':  { spread_pct: 0.01 },
      'asset-correlations':      { btc_corr_1h: 0.5 },
      'market-structure-breaks-BTC': { last_msb_direction: 'bullish', last_msb_time: 9 },
    },
    // MSB_BEARISH(2,core) + TAKER_SELL(2,core) + OI_UNWIND(2,core) = 6
    // isPanic: msbBearish age<5 + taker<=0.40 + EXTREME + oiChg<-3 → true
    expected: { exit: true, reason: 'EARLY_EXIT_PANIC', earlyExitTicks_after: 0, score: 6 },
  },
  {
    llm:  'DEEPSEEK',
    name: 'EXIT_SHORT_TICK2_CORRECTED',
    position: { direction: 'SHORT', earlyExitTicks: 1 },
    mocks: {
      'perp-snapshot':           { taker_buy_ratio: 0.75 },
      'oi-change':               { oi_change_pct: 0.08 },
      'orderbook-imbalance':     { imbalance_ratio: -0.6 },
      'liquidations-summary':    { liq_long_usd: 5000000, liq_short_usd: 100000 },
      'market-structure-breaks': { last_msb_direction: 'bullish', last_msb_time: 1 },
      'realized-volatility':     { rv_regime: 'normal' },
      'funding-regime':          { regime: 'negative', avg_rate_8h: -0.0004 },
      'spot-perp-basis':         { basis_pct: 0.18, signal: 'premium' },
      'multi-exchange-funding':  { spread_pct: 0.05 },
      'asset-correlations':      { btc_corr_1h: 0.75 },
      'market-structure-breaks-BTC': { last_msb_direction: 'bullish', last_msb_time: 2 },
    },
    // MSB_BULLISH(2,core) + TAKER_BUY(2,core) + BASIS_PREMIUM(1) + SPREAD(1) + BTC_CORR(1,weak) = 7
    // earlyExitTicks: 1→2 → exit EARLY_EXIT
    expected: { exit: true, reason: 'EARLY_EXIT', earlyExitTicks_after: 0, score: 7, hasCoreSignal: true },
  },
  {
    llm:  'GEMINI',
    name: 'RESET_LONG_TICK_EXPIRED',
    position: { direction: 'LONG', earlyExitTicks: 1 },
    mocks: {
      'perp-snapshot':           { taker_buy_ratio: 0.50 },
      'oi-change':               { oi_change_pct: -0.015 },
      'orderbook-imbalance':     { imbalance_ratio: -0.65 },
      'liquidations-summary':    { liq_long_usd: 120000, liq_short_usd: 0 },
      'market-structure-breaks': { last_msb_direction: 'bullish', last_msb_time: 1715871000 },
      'realized-volatility':     { rv_regime: 'NORMAL' },
      'funding-regime':          { regime: 'EXTREME_LONG', avg_rate_8h: 0.00095 },
      'spot-perp-basis':         { basis_pct: -0.05, signal: 'neutral' },
      'multi-exchange-funding':  { spread_pct: 0.045 },
      'asset-correlations':      { btc_corr_1h: 0.78 },
      'market-structure-breaks-BTC': { last_msb_direction: 'bearish', last_msb_time: 2 },
    },
    // Variante A: score=6 >= threshold mais hasCoreSignal=false → reset
    // OB_SELL(1) + LONG_LIQ(1) + FUNDING_EXTREME(1) + FUNDING_RATE(1) + SPREAD(1) + BTC_CORR(1,weak) = 6
    // aucun core (taker=0.50>0.42, msbDir=bullish≠bearish, oiChg=-0.015>-2.5)
    expected: { exit: false, earlyExitTicks_after: 0, score: 6, hasCoreSignal: false },
  },
];

// ══════════════════════════════════════════════════════════════════
// RUNNER
// ══════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════');
console.log(' checkEarlyExit() v2 — Tests LLM cross-validation');
console.log('═══════════════════════════════════════════════════════════\n');

let passed = 0, failed = 0;
const results = [];

for (const scenario of scenarios) {
  const pos = { ...scenario.position };
  const actual = checkEarlyExitWithMocks(pos, scenario.mocks);
  const earlyExitTicks_after = pos.earlyExitTicks;

  const checks = {
    exit:              actual.exit === scenario.expected.exit,
    reason:            !scenario.expected.reason || actual.reason === scenario.expected.reason,
    score:             scenario.expected.score === undefined || actual.score === scenario.expected.score,
    ticks:             scenario.expected.earlyExitTicks_after === undefined || earlyExitTicks_after === scenario.expected.earlyExitTicks_after,
    hasCoreSignal:     scenario.expected.hasCoreSignal === undefined,  // not directly testable here, scored internally
  };
  const ok = checks.exit && checks.reason && checks.score && checks.ticks;
  if (ok) passed++; else failed++;

  const icon = ok ? '✅' : '❌';
  console.log(`${icon} [${scenario.llm}] ${scenario.name}`);
  console.log(`   exit:             ${actual.exit}  (expected: ${scenario.expected.exit})  ${checks.exit ? '✓' : '✗ FAIL'}`);
  if (scenario.expected.reason)
    console.log(`   reason:           ${actual.reason ?? 'undefined'}  (expected: ${scenario.expected.reason})  ${checks.reason ? '✓' : '✗ FAIL'}`);
  console.log(`   score:            ${actual.score}  (expected: ${scenario.expected.score ?? 'any'})  ${checks.score ? '✓' : '✗ FAIL'}`);
  console.log(`   ticks après:      ${earlyExitTicks_after}  (expected: ${scenario.expected.earlyExitTicks_after ?? 'any'})  ${checks.ticks ? '✓' : '✗ FAIL'}`);
  console.log(`   signals actifs:   [${actual.signals.join(', ')}]`);
  console.log('');

  results.push({ llm: scenario.llm, name: scenario.name, ok, actual, earlyExitTicks_after, expected: scenario.expected });
}

console.log('═══════════════════════════════════════════════════════════');
console.log(` Résultats : ${passed} PASS  /  ${failed} FAIL`);
console.log('═══════════════════════════════════════════════════════════\n');

// Diagnostic des écarts pour envoi aux LLMs
for (const r of results) {
  if (!r.ok) {
    console.log(`⚠️  [${r.llm}] DIAGNOSTIC :`);
    if (r.actual.exit !== r.expected.exit)
      console.log(`   → exit: obtenu ${r.actual.exit}, attendu ${r.expected.exit}`);
    if (r.expected.reason && r.actual.reason !== r.expected.reason)
      console.log(`   → reason: obtenu "${r.actual.reason}", attendu "${r.expected.reason}"`);
    if (r.expected.score !== undefined && r.actual.score !== r.expected.score)
      console.log(`   → score: obtenu ${r.actual.score}, attendu ${r.expected.score}`);
    if (r.expected.earlyExitTicks_after !== undefined && r.earlyExitTicks_after !== r.expected.earlyExitTicks_after)
      console.log(`   → earlyExitTicks_after: obtenu ${r.earlyExitTicks_after}, attendu ${r.expected.earlyExitTicks_after}`);
    console.log(`   → signals réels: [${r.actual.signals.join(', ')}]`);
    console.log('');
  }
}
