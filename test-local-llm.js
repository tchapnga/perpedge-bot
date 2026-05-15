// Test P1.2 — Mode local multi-LLM (DeepSeek + ChatGPT + Gemini via Playwright)
// Prérequis : LLM_MODE=local dans .env + Chrome fermé (profil C:\tools\chrome-playwright-profile)
import 'dotenv/config';
import { validateSignal } from './src/llm-validator.js';

// Signal BTCUSDT LONG fort — attendu APPROVE
const BTCUSDT_LONG_FORT = {
  symbol:           'BTCUSDT',
  signal:           'LONG',
  direction:        'LONG',
  force:            'FORT',
  total:            8,
  ta_score:         4,
  der_score:        3,
  gate_block:       false,
  veto_reason:      null,
  contrarian_signal: false,
  rv_regime:        'normal',
  crowded_trigger:  false,
  btc_corr:         1.0,
  msb_direction:    'bullish',
  funding:          -0.00005,
};

// Signal ETHUSDT — gate_block forcé — attendu REJECT
const ETHUSDT_GATE_BLOCK = {
  symbol:           'ETHUSDT',
  signal:           'SHORT',
  direction:        'SHORT',
  force:            'MODERE',
  total:            6,
  ta_score:         3,
  der_score:        2,
  gate_block:       true,
  veto_reason:      'gate_bybit_ecart',
  contrarian_signal: false,
  rv_regime:        'high',
  crowded_trigger:  false,
  btc_corr:         0.8,
  msb_direction:    'bearish',
  funding:          0.0002,
};

async function run() {
  console.log('=== Test P1.2 — Mode local multi-LLM ===\n');
  console.log('[ATTENTION] Chrome doit être fermé avant de lancer ce test.\n');

  // Test 1 : BTCUSDT LONG FORT → attendu APPROVE
  console.log('--- Test 1 : BTCUSDT LONG FORT ---');
  console.log('Signal:', JSON.stringify(BTCUSDT_LONG_FORT, null, 2));
  const r1 = await validateSignal(BTCUSDT_LONG_FORT);
  console.log('Résultat:', JSON.stringify(r1, null, 2));
  const ok1 = r1.decision === 'APPROVE';
  console.log(ok1 ? '✅ PASS — APPROVE attendu' : `❌ FAIL — attendu APPROVE, obtenu ${r1.decision}`);

  console.log('\n--- Test 2 : ETHUSDT gate_block=true ---');
  console.log('Signal:', JSON.stringify(ETHUSDT_GATE_BLOCK, null, 2));
  const r2 = await validateSignal(ETHUSDT_GATE_BLOCK);
  console.log('Résultat:', JSON.stringify(r2, null, 2));
  const ok2 = r2.decision === 'REJECT';
  console.log(ok2 ? '✅ PASS — REJECT attendu' : `❌ FAIL — attendu REJECT, obtenu ${r2.decision}`);

  console.log('\n=== Résumé ===');
  console.log(`Test 1 BTCUSDT LONG : ${ok1 ? '✅' : '❌'}`);
  console.log(`Test 2 ETHUSDT gate : ${ok2 ? '✅' : '❌'}`);

  process.exit(ok1 && ok2 ? 0 : 1);
}

run().catch(err => {
  console.error('Erreur non gérée:', err.message);
  process.exit(1);
});
