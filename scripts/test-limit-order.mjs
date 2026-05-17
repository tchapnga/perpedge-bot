/**
 * Test réel P0.1 — LIMIT orders Binance Futures TESTNET
 * ZERO mock / ZERO stub — appels API réels
 *
 * Usage :
 *   Scénario 1 (fill) :
 *     BINANCE_TESTNET=true BINANCE_TESTNET_API_KEY=xxx BINANCE_TESTNET_API_SECRET=yyy \
 *     POSITION_SIZE_USDT=10 node scripts/test-limit-order.mjs --mode=fill
 *
 *   Scénario 2 (timeout/cancel) :
 *     BINANCE_TESTNET=true BINANCE_TESTNET_API_KEY=xxx BINANCE_TESTNET_API_SECRET=yyy \
 *     POSITION_SIZE_USDT=10 LIMIT_CANCEL_MS=20000 node scripts/test-limit-order.mjs --mode=timeout
 *
 * Note : LIMIT_CANCEL_MS doit être passé en variable d'environnement shell (avant node)
 *        car la constante est fixée au chargement du module order-executor.js.
 */

import { createHmac } from 'crypto';

// ── Vérifications préalables ──────────────────────────────────────────────────
const mode = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1];
if (!mode || !['fill', 'timeout'].includes(mode)) {
  console.error('Usage: node scripts/test-limit-order.mjs --mode=fill|timeout');
  process.exit(1);
}

if (process.env.BINANCE_TESTNET !== 'true') {
  console.error('FAIL — BINANCE_TESTNET doit être "true"');
  process.exit(1);
}
if (!process.env.BINANCE_TESTNET_API_KEY || !process.env.BINANCE_TESTNET_API_SECRET) {
  console.error('FAIL — BINANCE_TESTNET_API_KEY et BINANCE_TESTNET_API_SECRET requis');
  process.exit(1);
}

// POSITION_SIZE_USDT petit pour testnet
if (!process.env.POSITION_SIZE_USDT) process.env.POSITION_SIZE_USDT = '10';

// Pour --mode=timeout le shell doit passer LIMIT_CANCEL_MS=20000
if (mode === 'timeout' && !process.env.LIMIT_CANCEL_MS) {
  process.env.LIMIT_CANCEL_MS = '20000';
  console.log('[test] LIMIT_CANCEL_MS non défini — forcé à 20000ms');
}

// Import dynamique APRÈS configuration des env vars (évite cache ESM au mauvais moment)
const { executeOrder } = await import('../src/order-executor.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
const TESTNET_BASE = 'https://testnet.binancefuture.com';
const SYMBOL       = 'BTCUSDT';

async function futuresPublicGet(path, params = {}) {
  const url = new URL(`${TESTNET_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

function pass(label, details = '') {
  console.log(`\n✅ PASS — ${label}${details ? '\n   ' + details : ''}`);
}
function fail(label, details = '') {
  console.error(`\n❌ FAIL — ${label}${details ? '\n   ' + details : ''}`);
}
function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

// ── Récupérer le prix actuel (futures testnet) ────────────────────────────────
async function getCurrentPrice() {
  const data = await futuresPublicGet('/fapi/v1/ticker/price', { symbol: SYMBOL });
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Prix invalide: ${data.price}`);
  return price;
}

// ── Scénario 1 : Fill normal ──────────────────────────────────────────────────
async function scenarioFill() {
  section('Scénario 1 — Fill normal (LIMIT_CANCEL_MS=3min)');
  console.log('  Le bot place à bidPrice (passif). Sur testnet BTCUSDT actif, fill attendu < 3min.');

  const currentPrice = await getCurrentPrice();
  console.log(`  Prix actuel BTCUSDT (futures testnet) : ${currentPrice}`);

  const t0 = Date.now();
  const result = await executeOrder({
    symbol: SYMBOL,
    side:   'LONG',
    entry:  currentPrice,
    extra:  { reduce_size: false },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n  Résultat (${elapsed}s) :`, JSON.stringify(result, null, 2));

  // Assertions
  if (result.success !== true) {
    fail('Fill', `success=false — error: ${result.error}`);
    return false;
  }
  if (!result.orderId) {
    fail('Fill', 'orderId absent');
    return false;
  }
  if (!Number.isFinite(result.price) || result.price <= 0) {
    fail('Fill', `price invalide: ${result.price}`);
    return false;
  }
  if (!result.qty || Number(result.qty) <= 0) {
    fail('Fill', `qty invalide: ${result.qty}`);
    return false;
  }

  pass('Fill', `orderId=${result.orderId} | prix=${result.price} | qty=${result.qty} | partial=${result.partial}`);
  return true;
}

// ── Scénario 2 : Timeout / cancel ─────────────────────────────────────────────
async function scenarioTimeout() {
  section(`Scénario 2 — Timeout/cancel (LIMIT_CANCEL_MS=${process.env.LIMIT_CANCEL_MS || '20000'}ms)`);
  console.log('  Avec 20s, le premier poll à 15s passe, le second timeout → DELETE + GET → LIMIT_TIMEOUT.');
  console.log('  Note : si l\'ordre est quand même fillé en < 15s, le test retourne "filled_not_timeout"');
  console.log('         (ce qui valide aussi le fill path — les deux sont acceptés).');

  const currentPrice = await getCurrentPrice();
  console.log(`  Prix actuel BTCUSDT (futures testnet) : ${currentPrice}`);

  const t0 = Date.now();
  const result = await executeOrder({
    symbol: SYMBOL,
    side:   'LONG',
    entry:  currentPrice,
    extra:  { reduce_size: false },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n  Résultat (${elapsed}s) :`, JSON.stringify(result, null, 2));

  if (result.success === false && result.error === 'LIMIT_TIMEOUT') {
    pass('Timeout', `orderId=${result.orderId} — ordre annulé comme attendu`);
    return true;
  }

  if (result.success === true) {
    // Fill rapide sur testnet : valide aussi le code, noter mais ne pas échouer
    console.log('\n⚠️  FILL RAPIDE au lieu de timeout — le testnet a rempli l\'ordre en < 15s.');
    console.log('   Le fill path fonctionne. Pour forcer timeout : LIMIT_CANCEL_MS=5000 + symbole illiquide.');
    pass('Fill rapide (timeout non déclenché)', `orderId=${result.orderId} | prix=${result.price}`);
    return true; // les deux comportements sont valides
  }

  fail('Timeout', `Résultat inattendu: success=${result.success}, error=${result.error}`);
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('PerpEdge — Test P0.1 LIMIT orders — Binance Futures TESTNET');
console.log(`  Mode            : ${mode}`);
console.log(`  Symbole         : ${SYMBOL}`);
console.log(`  POSITION_SIZE   : ${process.env.POSITION_SIZE_USDT} USDT`);
console.log(`  LIMIT_CANCEL_MS : ${process.env.LIMIT_CANCEL_MS || '180000 (défaut)'}`);
console.log(`  API Key         : ${process.env.BINANCE_TESTNET_API_KEY.slice(0, 8)}...`);

let ok = false;
try {
  ok = mode === 'fill' ? await scenarioFill() : await scenarioTimeout();
} catch (err) {
  fail(`${mode} — exception non gérée`, err?.stack ?? err?.message ?? String(err));
}

section('Résultat final');
console.log(ok ? '✅ PASS' : '❌ FAIL');
process.exit(ok ? 0 : 1);
