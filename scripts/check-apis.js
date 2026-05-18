#!/usr/bin/env node
// P9-C — Healthcheck complet de toutes les APIs avant go-live
import 'dotenv/config';
import { createHmac } from 'crypto';
import https from 'https';
import http from 'http';

const OK  = '✅';
const ERR = '❌';
const WRN = '⚠️ ';

let passed = 0, failed = 0, warned = 0;

function result(label, ok, msg) {
  if (ok === true)  { console.log(`${OK}  ${label}${msg ? ' — ' + msg : ''}`); passed++; }
  else if (ok === false) { console.log(`${ERR} ${label}${msg ? ' — ' + msg : ''}`); failed++; }
  else              { console.log(`${WRN} ${label}${msg ? ' — ' + msg : ''}`); warned++; }
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        res.body = body;
        res.usedWeight = res.headers['x-mbx-used-weight-1m'];
        try { res.json = JSON.parse(body); } catch {}
        resolve(res);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sign(queryString, secret) {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binanceSignedGet(baseUrl, path, apiKey, apiSecret, params = {}) {
  const ts = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp: ts }).toString();
  const sig = sign(qs, apiSecret);
  const url = `${baseUrl}${path}?${qs}&signature=${sig}`;
  return get(url, { 'X-MBX-APIKEY': apiKey });
}

// ── 1. Variables d'environnement critiques ────────────────────────────────────
console.log('\n── 1. Variables .env ────────────────────────────────────────────');

const isTestnet = process.env.BINANCE_TESTNET === 'true';
result('BINANCE_TESTNET=false', !isTestnet, isTestnet ? 'encore true — BLOQUER' : 'prod activé');

const dryRun = process.env.DRY_RUN === 'true';
result('DRY_RUN=true (shadow mode)', dryRun, dryRun ? 'shadow mode actif' : 'ATTENTION : ordres réels actifs');

const llmMode = process.env.LLM_MODE;
result('LLM_MODE=claude', llmMode === 'claude', llmMode ?? 'absent');

const minScore = Number(process.env.MIN_SCORE || 0);
result('MIN_SCORE >= 5.0', minScore >= 5.0, `${minScore}`);

const posSizeRaw = process.env.POSITION_SIZE_USDT;
const posSize = Number(posSizeRaw || 0);
if (!posSizeRaw) {
  result('POSITION_SIZE_USDT', null, 'absent — utilisera le défaut du code');
} else {
  result('POSITION_SIZE_USDT raisonnable (10-500)', posSize >= 10 && posSize <= 500, `${posSize} USDT`);
}

const enableSpot = process.env.ENABLE_SPOT_LIVE_TRADING;
result('ENABLE_SPOT_LIVE_TRADING=false', enableSpot === 'false', enableSpot ?? 'absent (défaut: false OK)');

const futApiKey    = process.env.BINANCE_API_KEY;
const futApiSecret = process.env.BINANCE_API_SECRET;
const spotApiKey   = process.env.BINANCE_SPOT_API_KEY;
result('BINANCE_API_KEY présent',       !!futApiKey,    futApiKey    ? `***${futApiKey.slice(-4)}`    : 'MANQUANT');
result('BINANCE_API_SECRET présent',    !!futApiSecret, futApiSecret ? '***'                          : 'MANQUANT');
result('BINANCE_SPOT_API_KEY présent',  !!spotApiKey,   spotApiKey   ? `***${spotApiKey.slice(-4)}`   : 'MANQUANT (spot DCA désactivé)');

const telegramToken  = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
result('TELEGRAM_BOT_TOKEN présent', !!telegramToken,  telegramToken  ? '***' : 'MANQUANT');
result('TELEGRAM_CHAT_ID présent',   !!telegramChatId, telegramChatId ? telegramChatId : 'MANQUANT');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
result('ANTHROPIC_API_KEY présent', !!anthropicKey, anthropicKey ? `***${anthropicKey.slice(-4)}` : 'MANQUANT');

const perpMcpUrl   = process.env.PERP_MCP_URL;
const perpMcpToken = process.env.PERP_MCP_TOKEN;
result('PERP_MCP_URL présent',   !!perpMcpUrl,   perpMcpUrl   ?? 'absent (défaut utilisé)');
result('PERP_MCP_TOKEN présent', !!perpMcpToken, perpMcpToken ? '***' : 'MANQUANT');

// ── 2. Binance Futures prod ───────────────────────────────────────────────────
console.log('\n── 2. Binance Futures (' + (isTestnet ? 'TESTNET' : 'MAINNET') + ') ──────────────────────────────');

const FAPI_BASE = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

if (futApiKey && futApiSecret) {
  try {
    const r = await binanceSignedGet(FAPI_BASE, '/fapi/v2/account', futApiKey, futApiSecret);
    if (r.statusCode === 200 && r.json?.totalWalletBalance !== undefined) {
      const bal = parseFloat(r.json.totalWalletBalance);
      result('Binance Futures /fapi/v2/account', bal > 0, `balance: ${bal.toFixed(2)} USDT`);
      if (r.usedWeight) result('Rate limit weight < 1200', parseInt(r.usedWeight) < 1200, `weight: ${r.usedWeight}/min`);
    } else {
      result('Binance Futures /fapi/v2/account', false, `HTTP ${r.statusCode} — ${r.body.slice(0, 120)}`);
    }
  } catch (e) {
    result('Binance Futures /fapi/v2/account', false, e.message);
  }

  try {
    const r = await binanceSignedGet(FAPI_BASE, '/fapi/v2/positionRisk', futApiKey, futApiSecret);
    result('Binance Futures /fapi/v2/positionRisk', r.statusCode === 200, `HTTP ${r.statusCode}`);
  } catch (e) {
    result('Binance Futures /fapi/v2/positionRisk', false, e.message);
  }
} else {
  result('Binance Futures', false, 'clés manquantes — skip');
}

// ── 3. Binance Spot prod ──────────────────────────────────────────────────────
console.log('\n── 3. Binance Spot (MAINNET) ────────────────────────────────────');

const spotKey    = process.env.BINANCE_SPOT_API_KEY    || futApiKey;
const spotSecret = process.env.BINANCE_SPOT_API_SECRET || futApiSecret;

if (spotKey && spotSecret) {
  try {
    const r = await binanceSignedGet('https://api.binance.com', '/api/v3/account', spotKey, spotSecret);
    if (r.statusCode === 200 && r.json?.balances) {
      const usdtBal = r.json.balances.find(b => b.asset === 'USDT');
      const free = parseFloat(usdtBal?.free ?? 0);
      result('Binance Spot /api/v3/account', true, `USDT libre: ${free.toFixed(2)}`);
    } else {
      result('Binance Spot /api/v3/account', false, `HTTP ${r.statusCode} — ${r.body.slice(0, 120)}`);
    }
  } catch (e) {
    result('Binance Spot /api/v3/account', false, e.message);
  }
} else {
  result('Binance Spot', null, 'clés non configurées — skip (ENABLE_SPOT_LIVE_TRADING=false)');
}

// ── 4. Perp MCP Server ───────────────────────────────────────────────────────
console.log('\n── 4. Perp MCP Server ───────────────────────────────────────────');

const mcpBase = perpMcpUrl || 'https://83-228-242-106.nip.io';
const mcpHeaders = perpMcpToken ? { Authorization: `Bearer ${perpMcpToken}` } : {};

try {
  const r = await get(`${mcpBase}/health`, mcpHeaders);
  result('MCP /health', r.statusCode === 200, `HTTP ${r.statusCode}`);
} catch (e) {
  result('MCP /health', false, e.message);
}

try {
  const r = await get(`${mcpBase}/tools/get_perp_snapshot?symbol=BTCUSDT`, mcpHeaders);
  result('MCP get_perp_snapshot BTCUSDT', r.statusCode === 200, `HTTP ${r.statusCode}`);
} catch (e) {
  result('MCP get_perp_snapshot', false, e.message);
}

// ── 5. Telegram ───────────────────────────────────────────────────────────────
console.log('\n── 5. Telegram ──────────────────────────────────────────────────');

if (telegramToken) {
  try {
    const r = await get(`https://api.telegram.org/bot${telegramToken}/getMe`);
    const ok = r.statusCode === 200 && r.json?.ok;
    result('Telegram getMe', ok, ok ? `@${r.json.result.username}` : r.body.slice(0, 80));
  } catch (e) {
    result('Telegram getMe', false, e.message);
  }
} else {
  result('Telegram', false, 'TELEGRAM_BOT_TOKEN absent');
}

// ── 6. Anthropic (Claude) ────────────────────────────────────────────────────
console.log('\n── 6. Anthropic API ─────────────────────────────────────────────');

if (anthropicKey) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: anthropicKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'say ok' }],
    });
    result('Anthropic API (claude-haiku test)', msg.content?.[0]?.text?.length > 0, `réponse: "${msg.content?.[0]?.text}"`);
  } catch (e) {
    result('Anthropic API', false, e.message.slice(0, 100));
  }
} else {
  result('Anthropic API', false, 'ANTHROPIC_API_KEY absent');
}

// ── Résumé ────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`Résultat : ${OK} ${passed} OK · ${ERR} ${failed} ÉCHEC · ${WRN} ${warned} AVERTISSEMENT`);
if (failed > 0) {
  console.log('❌ BLOQUEUR GO-LIVE détecté — corriger avant de passer en LIVE.');
  process.exit(1);
} else if (warned > 0) {
  console.log('⚠️  Avertissements présents — vérifier avant go-live.');
} else {
  console.log('✅ Toutes les APIs opérationnelles — prêt pour shadow mode 24h (P9-D).');
}
