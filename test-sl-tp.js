// Test SL/TP placement sur Binance Testnet
// Usage: node test-sl-tp.js
import 'dotenv/config';
import { executeOrder } from './src/order-executor.js';
import { registerTrade } from './src/position-manager.js';

const SYMBOL = 'BTCUSDT';

async function run() {
  console.log(`\n=== Test SL/TP placement — ${SYMBOL} (testnet) ===\n`);

  // 1. Récupérer le mark price actuel
  console.log('[0] Récupération mark price...');
  const priceRes = await fetch(`https://testnet.binancefuture.com/fapi/v1/premiumIndex?symbol=${SYMBOL}`);
  const priceData = await priceRes.json();
  const currentPrice = Number(priceData.markPrice);
  console.log(`[0] Mark price: ${currentPrice}`);

  // 2. Ouvrir un ordre MARKET LONG
  console.log('[1] Passage ordre MARKET LONG...');
  const order = await executeOrder({
    symbol: SYMBOL,
    side:   'LONG',
    entry:  currentPrice,
    extra:  { reduce_size: false },
  });
  console.log('[1] Résultat ordre:', JSON.stringify(order, null, 2));

  if (!order.success) {
    console.error('[1] ❌ Ordre échoué — test arrêté');
    process.exit(1);
  }

  const entry = order.avgPrice ?? order.price ?? currentPrice;
  if (!entry) {
    console.error('[1] ❌ Prix d\'entrée introuvable — test arrêté');
    process.exit(1);
  }

  console.log(`[1] ✅ Ordre exécuté — orderId=${order.orderId} qty=${order.qty} @${entry}`);

  // 2. Calculer SL/TP (2% SL, 3% TP1)
  const sl  = entry * (1 - 0.02);
  const tp1 = entry * (1 + 0.03);
  const tp2 = entry * (1 + 0.06);

  console.log(`\n[2] Placement SL=${sl.toFixed(2)} TP1=${tp1.toFixed(2)} TP2=${tp2.toFixed(2)}`);

  // 3. Enregistrer la position avec SL/TP
  const tracked = await registerTrade({
    symbol: SYMBOL,
    side:   'LONG',
    entry,
    sl,
    tp1,
    tp2,
    qty:    order.qty,
  });

  if (!tracked) {
    console.error('[3] ❌ registerTrade a échoué');
    process.exit(1);
  }

  console.log('\n[3] Résultat registerTrade:');
  console.log(`  slOrderId      = ${tracked.slOrderId      ?? '❌ NULL — SL non placé'}`);
  console.log(`  tp1OrderId     = ${tracked.tp1OrderId     ?? '❌ NULL — TP1 non placé'}`);
  console.log(`  trailingOrderId= ${tracked.trailingOrderId ?? 'null (normal — placé après TP1)'}`);
  console.log(`  qty            = ${tracked.qty}`);
  console.log(`  qty_half       = ${tracked.qty_half}`);
  console.log(`  sl             = ${tracked.sl}`);
  console.log(`  tp1            = ${tracked.tp1}`);

  if (tracked.slOrderId && tracked.tp1OrderId) {
    console.log('\n✅ SL et TP1 (50%) correctement placés. Trailing sera activé après TP1 touché.');
  } else {
    console.log('\n❌ Un ou plusieurs ordres non placés — voir logs ci-dessus.');
  }

  process.exit(0);
}

run().catch(err => {
  console.error('Erreur non gérée:', err.message);
  process.exit(1);
});
