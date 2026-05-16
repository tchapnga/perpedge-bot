/**
 * Script de simulation TP1 — Testnet uniquement
 *
 * Envoie un SELL MARKET partiel (qty_half) pour simuler un hit TP1 sans
 * attendre que le marché atteigne le prix TP1.
 * pollPositions() détectera la réduction de positionAmt et déclenchera
 * le workflow TP1 → BE → trailing.
 *
 * Usage: node scripts/test-tp1-sim.js BTCUSDT
 */

import 'dotenv/config';
import { createHmac } from 'crypto';

const symbol = process.argv[2]?.toUpperCase();
if (!symbol) { console.error('Usage: node scripts/test-tp1-sim.js SYMBOL'); process.exit(1); }

const isTestnet = String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';
if (!isTestnet) { console.error('⛔ Ce script est réservé au testnet (BINANCE_TESTNET=true)'); process.exit(1); }

const BASE_URL   = 'https://testnet.binancefuture.com';
const API_KEY    = process.env.BINANCE_TESTNET_API_KEY?.trim();
const API_SECRET = process.env.BINANCE_TESTNET_API_SECRET?.trim();
if (!API_KEY || !API_SECRET) { console.error('⛔ Clés testnet manquantes'); process.exit(1); }

function sign(params) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig = createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${sig}`;
}

async function req(method, path, params = {}) {
  const url = `${BASE_URL}${path}?${sign(params)}`;
  const res  = await fetch(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.msg || `HTTP ${res.status}`);
  return body;
}

(async () => {
  // 1. Lire la position actuelle
  const posRisk = await req('GET', '/fapi/v2/positionRisk', { symbol });
  const pos = Array.isArray(posRisk) ? posRisk.find(p => p.symbol === symbol) : null;
  if (!pos || Number(pos.positionAmt) === 0) {
    console.error(`❌ Aucune position ouverte pour ${symbol}`);
    process.exit(1);
  }

  const posAmt = Number(pos.positionAmt);
  const isLong = posAmt > 0;
  const qty    = Math.abs(posAmt);

  // 2. Simuler TP1 en fermant la moitié
  const simQty = +(qty / 2).toFixed(3);
  if (simQty <= 0) { console.error('❌ qty trop petite pour diviser'); process.exit(1); }

  const side = isLong ? 'SELL' : 'BUY';
  console.log(`[test-tp1-sim] Position: ${isLong ? 'LONG' : 'SHORT'} ${qty} ${symbol}`);
  console.log(`[test-tp1-sim] Simulation TP1 — envoi ${side} MARKET ${simQty} (moitié)`);

  // Lire stepSize pour arrondir correctement
  const info = await req('GET', '/fapi/v1/exchangeInfo', { symbol });
  const symInfo = info?.symbols?.find(s => s.symbol === symbol);
  const stepSize = Number(symInfo?.filters?.find(f => f.filterType === 'LOT_SIZE')?.stepSize ?? 0.001);
  const precision = (String(stepSize).split('.')[1] || '').length;
  const roundedQty = (Math.floor(simQty / stepSize) * stepSize).toFixed(precision);

  const order = await req('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: roundedQty,
    reduceOnly: true,
  });

  console.log(`[test-tp1-sim] ✅ Ordre exécuté — orderId=${order.orderId} status=${order.status}`);
  console.log(`[test-tp1-sim] pollPositions() devrait détecter le TP1 dans ≤60s`);
  console.log(`[test-tp1-sim] Surveiller les logs PM2: pm2 logs perpedge-bot --lines 50`);
})().catch(err => { console.error('❌ Erreur:', err.message); process.exit(1); });
