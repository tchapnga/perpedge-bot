#!/usr/bin/env node
// Production pre-deployment validation — checks all external dependencies
// Usage: node scripts/deploy-prod.js
import 'dotenv/config';
import crypto from 'crypto';

const REQUIRED_VARS = ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PERP_MCP_TOKEN'];
const PERP_MCP_URL  = process.env.PERP_MCP_URL || 'http://localhost:3000';

// ANSI helpers
const ok  = msg => console.log(`\x1b[32m✅ ${msg}\x1b[0m`);
const err = msg => console.error(`\x1b[31m❌ ${msg}\x1b[0m`);
const tip = msg => console.error(`\x1b[33m👉 ${msg}\x1b[0m`);

function fail(msg) { err(msg); process.exit(1); }

// ── 1. Required env vars ──────────────────────────────────────────────────────
function checkEnvVars() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length) fail(`Variables d'environnement manquantes : ${missing.join(', ')}`);
  ok(`Variables d'environnement OK (${REQUIRED_VARS.length} vérifiées)`);
}

// ── 2. Binance Futures API (fapi/v2/account — vérifie clé + compte actif) ────
async function checkBinance() {
  const key    = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  const ts     = Date.now();
  const qs     = `timestamp=${ts}`;
  const sig    = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  try {
    const res  = await fetch(`https://fapi.binance.com/fapi/v2/account?${qs}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': key },
      signal:  AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data?.code === -1021) {
        err(`Binance -1021 : timestamp désynchronisé (>1000 ms du serveur Binance).`);
        tip(`Synchroniser l'horloge système : ntpdate pool.ntp.org  (Linux) ou w32tm /resync (Windows)`);
      } else {
        err(`Binance HTTP ${res.status} : ${data?.msg ?? 'erreur inconnue'}`);
      }
      fail(`Binance API inaccessible.`);
    }
    ok(`Binance Futures API OK (compte actif)`);
  } catch (e) {
    if (e.name === 'TimeoutError') fail(`Binance API timeout (>8 s).`);
    fail(`Binance API réseau : ${e.message}`);
  }
}

// ── 3. Anthropic API ──────────────────────────────────────────────────────────
async function checkAnthropic() {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body:   JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      fail(`Anthropic HTTP ${res.status} : ${JSON.stringify(e)}`);
    }
    ok(`Anthropic API OK (claude-haiku-4-5)`);
  } catch (e) {
    if (e.name === 'TimeoutError') fail(`Anthropic API timeout (>10 s).`);
    fail(`Anthropic API : ${e.message}`);
  }
}

// ── 4. perp-mcp-server /health ────────────────────────────────────────────────
async function checkPerpMcp() {
  try {
    const res = await fetch(`${PERP_MCP_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) fail(`perp-mcp /health → HTTP ${res.status}`);
    ok(`perp-mcp OK (${PERP_MCP_URL}/health)`);
  } catch (e) {
    if (e.name === 'TimeoutError') fail(`perp-mcp timeout (>5 s) sur ${PERP_MCP_URL}/health`);
    fail(`perp-mcp : ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\x1b[1m🚀 Vérifications pré-déploiement (production)...\x1b[0m\n');
  checkEnvVars();
  await checkBinance();
  await checkAnthropic();
  await checkPerpMcp();
  console.log('\n\x1b[1m\x1b[32m🎉 Tous les feux sont au vert. Déploiement autorisé.\x1b[0m');
}

run();
