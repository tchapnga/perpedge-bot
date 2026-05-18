import Fastify          from 'fastify';
import { appendFile, readFile, writeFile } from 'fs/promises';
import { exec }          from 'child_process';
import { createHmac, timingSafeEqual } from 'crypto';
import { config }       from './config.js';
import { getBotState, setPauseLevel, setMode, setEmergencyStop, resetEmergencyStop, setModuleEnabled, getTradeProfile, setTradeProfile } from './bot-state.js';
import { readAllTrades } from './trade-journal.js';
import { reconcilePositions, forceClosePosition, bootReconcile } from './position-manager.js';
import { NETWORK } from './utils/network.js';

// ── Log ring buffer P8D.7 — interception console.* au niveau module ───────────
const LOG_BUFFER = [];
const LOG_MAX    = 500;
const SECRET_KW  = ['key', 'secret', 'token', 'password', 'api_key', 'anthropic'];

function _hasSensitive(msg) {
  const s = String(msg).toLowerCase();
  return SECRET_KW.some(k => s.includes(k));
}
function _pushLog(level, args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (!msg || _hasSensitive(msg)) return;
  LOG_BUFFER.push({ ts: new Date().toISOString(), level, msg });
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
}
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => { _origLog(...a);   _pushLog('info',  a); };
console.warn  = (...a) => { _origWarn(...a);  _pushLog('warn',  a); };
console.error = (...a) => { _origError(...a); _pushLog('error', a); };

// ── Helpers equity/risk (P8D.5 / P8D.6) ─────────────────────────────────────
function _buildEquitySeries(trades) {
  const daily = new Map();
  for (const t of trades) {
    const raw = t.closedAt ?? t.closed_at ?? t.closedTime;
    if (!raw) continue;
    const day = new Date(raw).toISOString().slice(0, 10);
    if (!day || day.startsWith('Invalid')) continue;
    daily.set(day, (daily.get(day) ?? 0) + (Number(t.pnl_usdt ?? t.pnl ?? 0) || 0));
  }
  let cum = 0;
  return [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pnl]) => { cum += pnl; return { date, pnl: +pnl.toFixed(2), cumPnl: +cum.toFixed(2) }; });
}
function _maxDrawdownUsdt(series) {
  let peak = 0, maxDD = 0;
  for (const p of series) {
    if (p.cumPnl > peak) peak = p.cumPnl;
    const dd = peak - p.cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  return +maxDD.toFixed(2);
}

// ── CSV escape ────────────────────────────────────────────────────────────────
function _escapeCsv(v) {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = Number(process.env.ADMIN_API_PORT ?? 3002);
const AUDIT_FILE  = `admin_audit.${NETWORK}.jsonl`;
const IS_PROD     = process.env.NODE_ENV === 'production';

// Max age initData Telegram : 24h — convention standard mini-apps Telegram
const INIT_DATA_MAX_AGE_S = 86400;

// Whitelist userId Telegram autorisés — séparés par virgule dans .env
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Refus de démarrage en production sans whitelist configurée
if (IS_PROD && ADMIN_IDS.length === 0) {
  console.error('[admin-api] ⛔ FATAL: ADMIN_TELEGRAM_IDS non configuré en production. Démarrage refusé.');
  process.exit(1);
}
if (!IS_PROD && ADMIN_IDS.length === 0) {
  console.warn('[admin-api] ⚠️  ADMIN_TELEGRAM_IDS vide — mode DEV: X-Admin-Id accepté (localhost uniquement).');
}

// ── RBAC P8E.4 ────────────────────────────────────────────────────────────────
const ROLES = { VIEWER: 1, OPERATOR: 2, TRADER: 3, ADMIN: 4 };

function getUserRole(userId) {
  const env = process.env.ADMIN_ROLES;
  if (!env) return 'ADMIN'; // dev mode — pas de restriction si ADMIN_ROLES absent
  const map = Object.fromEntries(
    env.split(',').map(s => s.trim().split(':')).filter(([id, role]) => id && role && ROLES[role?.toUpperCase()])
      .map(([id, role]) => [id.trim(), role.trim().toUpperCase()])
  );
  return map[String(userId)] ?? 'VIEWER';
}

function requireRole(minRole) {
  const minLevel = ROLES[minRole];
  if (!minLevel) throw new Error(`requireRole: rôle invalide "${minRole}"`);
  return async (req, reply) => {
    const role = getUserRole(req.adminUserId);
    if ((ROLES[role] ?? 0) < minLevel) {
      return reply.code(403).send({ error: 'Insufficient permissions', required: minRole, yourRole: role });
    }
    req.adminUserRole = role;
  };
}

// ── Audit log ─────────────────────────────────────────────────────────────────
async function audit(action, userId, detail = {}) {
  // Sanitize: ne pas logger de champs sensibles
  const safe = Object.fromEntries(
    Object.entries(detail).filter(([k]) => !['token','key','secret','password'].includes(k))
  );
  const entry = JSON.stringify({ ts: new Date().toISOString(), userId, action, ...safe });
  await appendFile(AUDIT_FILE, entry + '\n').catch(err =>
    console.error('[admin-api] audit log error:', err.message)
  );
}

// ── Rate limiting in-memory (10 req/min prod / 300 req/min dev) ──────────────
const rateLimiter = new Map(); // userId → { count, windowStart }
const RATE_LIMIT  = IS_PROD ? 120 : 600;
const RATE_WINDOW = 60_000;

function checkRateLimit(userId) {
  const now  = Date.now();
  const prev = rateLimiter.get(userId);
  if (!prev || now - prev.windowStart > RATE_WINDOW) {
    rateLimiter.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (prev.count >= RATE_LIMIT) return false;
  prev.count++;
  return true;
}

// Nettoyage périodique — supprime les entrées expirées pour éviter fuite mémoire
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimiter) {
    if (now - v.windowStart > RATE_WINDOW * 2) rateLimiter.delete(k);
  }
}, 5 * 60_000);

// ── Validation initData Telegram ──────────────────────────────────────────────
// FIX: timingSafeEqual + vérification auth_date (anti-replay)
function validateTelegramInitData(initData) {
  if (!config.telegramBotToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) return null;

    // Vérification anti-replay : auth_date obligatoire et < INIT_DATA_MAX_AGE_S
    const authDateRaw = params.get('auth_date');
    if (!authDateRaw) return null;
    const authDate = Number(authDateRaw);
    if (!Number.isFinite(authDate)) return null;
    const ageSecs = Math.floor(Date.now() / 1000) - authDate;
    if (ageSecs < 0 || ageSecs > INIT_DATA_MAX_AGE_S) return null;

    params.delete('hash');
    const dataStr  = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret   = createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
    const computed = createHmac('sha256', secret).update(dataStr).digest('hex');

    // Comparaison constant-time pour éviter timing attack
    if (computed.length !== hash.length) return null;
    const eq = timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
    if (!eq) return null;

    const user = JSON.parse(params.get('user') ?? 'null');
    return user?.id ? String(user.id) : null;
  } catch { return null; }
}

// ── Auth middleware ────────────────────────────────────────────────────────────
function authMiddleware(req, reply, done) {
  if (req.url === '/admin/health') { done(); return; }

  let userId = null;

  // Mode 1 : Telegram initData (Mini App) — avec vérif auth_date + timingSafeEqual
  const initData = req.headers['x-telegram-init-data'];
  if (initData) userId = validateTelegramInitData(initData);

  // Mode 2 : X-Admin-Id — uniquement en DEV (ADMIN_IDS vide + non-prod + localhost)
  if (!userId && !IS_PROD && ADMIN_IDS.length === 0) {
    const ip = req.socket?.remoteAddress ?? '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      userId = req.headers['x-admin-id'] ?? null;
    }
  }

  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(userId)) {
    reply.code(403).send({ error: 'Forbidden' });
    return;
  }

  if (!checkRateLimit(userId)) {
    reply.code(429).send({ error: `Rate limit exceeded (${RATE_LIMIT} req/min)` });
    return;
  }

  req.adminUserId = userId;
  done();
}

// ── État interne partagé (injecté depuis index.js) ────────────────────────────
let _getPositions = () => [];
let _getSignalLog = () => [];
let _getScalpPos  = () => [];

// ── Binance data cache (TTL 5s) — shared by /admin/positions and /admin/risk ──
let _binanceCache = { ts: 0, data: new Map(), ok: false };

async function _fetchBinanceData(positions) {
  if (!positions.length) return { data: new Map(), ok: true };
  if (Date.now() - _binanceCache.ts < 5_000) return _binanceCache;
  try {
    const recon = await reconcilePositions();
    const m = new Map();
    for (const b of (recon?.binancePositions ?? [])) m.set(b.symbol, b);
    _binanceCache = { ts: Date.now(), data: m, ok: true };
    return _binanceCache;
  } catch {
    return { ..._binanceCache, ok: false };
  }
}

export function injectAdminDeps({ getPositions, getSignalLog, getScalpPositions }) {
  _getPositions = getPositions;
  _getSignalLog = getSignalLog;
  _getScalpPos  = getScalpPositions ?? (() => []);
}

// ── Symbols cache (P8C.3) ─────────────────────────────────────────────────────
let _symCache = { ts: 0, data: [] };
let _symFetch = null;
const SYM_TTL = 60 * 60 * 1000;

async function _loadSymbols() {
  const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const body = await res.json();
  _symCache = { ts: Date.now(), data: (body.symbols ?? []).filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING').map(s => s.symbol) };
  return _symCache.data;
}

function _getSymbols() {
  if (_symCache.data.length && Date.now() - _symCache.ts < SYM_TTL) return Promise.resolve(_symCache.data);
  if (!_symFetch) _symFetch = _loadSymbols().catch(err => { console.error('[symbols] exchangeInfo fetch failed:', err.message); return _symCache.data; }).finally(() => { _symFetch = null; });
  return _symFetch;
}

// ── Symbol scoring (P8C.3) ────────────────────────────────────────────────────
function _symbolScore(symbol, q) {
  if (symbol === q || symbol === `${q}USDT`) return 0;
  if (symbol.startsWith(q)) return 1;
  if (symbol.includes(q)) return 2;
  return 3;
}

// ── Fastify ────────────────────────────────────────────────────────────────────
export async function startAdminApi() {
  const app = Fastify({ logger: false });

  _getSymbols().catch(() => {});

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('Access-Control-Allow-Origin',  '*');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,X-Telegram-Init-Data,X-Admin-Id');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    if (req.method === 'OPTIONS') { reply.code(204).send(); return; }
    done();
  });

  app.addHook('preHandler', authMiddleware);

  // ── Health (sans auth) ────────────────────────────────────────────────────
  app.get('/admin/health', async () => ({
    ok:     true,
    uptime: Math.round(process.uptime()),
    ts:     new Date().toISOString(),
  }));

  // ── Status ────────────────────────────────────────────────────────────────
  app.get('/admin/status', async () => {
    const positions = _getPositions();
    const state     = getBotState();
    const pnl       = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    return { ...state, openPositions: positions.length, unrealizedPnl: +pnl.toFixed(2), lastSignal: _getSignalLog()[0] ?? null };
  });

  // ── Positions ─────────────────────────────────────────────────────────────
  app.get('/admin/positions', async () => {
    const perpRaw  = _getPositions();
    const scalpRaw = _getScalpPos();
    const allRaw   = [...perpRaw, ...scalpRaw];
    const { data: binMap } = await _fetchBinanceData(allRaw);
    const enrich   = p => {
      const b = binMap.get(p.symbol);
      return {
        ...p,
        side:          p.direction ?? p.side,
        markPrice:     b?.markPrice     ?? null,
        unrealizedPnl: Number.isFinite(b?.unrealizedProfit) ? b.unrealizedProfit : (p.unrealizedPnl ?? 0),
      };
    };
    return { positions: perpRaw.map(enrich), scalp: scalpRaw.map(enrich) };
  });

  // ── Symbols autocomplete (P8C.3 — cached, sorted, anti-race) ────────────
  app.get('/admin/symbols', async (req) => {
    const q = String(req.query.q ?? '').trim().toUpperCase();
    if (!q) return { symbols: [] };
    try {
      const all  = await _getSymbols();
      const hits = all
        .filter(s => s.includes(q))
        .sort((a, b) => _symbolScore(a, q) - _symbolScore(b, q) || a.localeCompare(b))
        .slice(0, 20);
      return { symbols: hits };
    } catch { return { symbols: [] }; }
  });

  // ── Signal history ────────────────────────────────────────────────────────
  app.get('/admin/signals', async () => ({ signals: _getSignalLog() }));

  // ── Reconciliation P8E.1 ─────────────────────────────────────────────────
  app.get('/admin/reconcile', async () => reconcilePositions());

  // ── Force-close une position par symbole (test + urgence) ─────────────────
  app.post('/admin/force-close/:symbol', { preHandler: [requireRole('OPERATOR')] }, async (req, reply) => {
    const symbol = String(req.params.symbol).toUpperCase();
    const result = await forceClosePosition(symbol);
    await audit(`FORCE_CLOSE:${symbol}`, req.adminUserId);
    return result;
  });

  // ── Boot-reconcile manuel (reload store + compare Binance) ───────────────
  app.post('/admin/boot-reconcile', { preHandler: [requireRole('OPERATOR')] }, async () => {
    await bootReconcile();
    return { ok: true };
  });

  // ── Commands (OPERATOR minimum) ──────────────────────────────────────────
  app.post('/admin/commands', { preHandler: [requireRole('OPERATOR')] }, async (req, reply) => {
    const { command } = req.body ?? {};
    const allowed = ['PAUSE_NEW_ENTRIES','PAUSE_ALL','RESUME','EMERGENCY_STOP','RESET_EMERGENCY'];
    if (!allowed.includes(command))
      return reply.code(400).send({ error: `Unknown command. Allowed: ${allowed.join(', ')}` });
    switch (command) {
      case 'PAUSE_NEW_ENTRIES': setPauseLevel('entries'); break;
      case 'PAUSE_ALL':         setPauseLevel('all');    break;
      case 'RESUME':            setPauseLevel('none');   break;
      case 'EMERGENCY_STOP':    setEmergencyStop();    break;
      case 'RESET_EMERGENCY':   resetEmergencyStop();  break;
    }
    await audit(command, req.adminUserId);
    return { ok: true, command, state: getBotState() };
  });

  // ── Manual analyze ────────────────────────────────────────────────────────
  app.post('/admin/analyze', async (req, reply) => {
    const { symbol } = req.body ?? {};
    if (!symbol) return reply.code(400).send({ error: 'symbol required' });
    const sym = String(symbol).toUpperCase().trim();
    // Validate symbol against known PERP list
    const syms = await _getSymbols().catch(() => []);
    if (syms.length > 0 && !syms.includes(sym)) {
      const auto = syms.find(s => s === sym + 'USDT') ?? null;
      if (!auto) return reply.code(400).send({ error: `Symbole inconnu : ${sym}. Exemple : ETHUSDT` });
      return reply.code(400).send({ error: `Symbole inconnu : ${sym}. Vouliez-vous dire ${auto} ?` });
    }
    await audit('ANALYZE', req.adminUserId, { symbol: sym });
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('TIMEOUT')), 30_000)
    );
    try {
      const { runAnalysis }    = await import('./scorer.js');
      const { validateSignal } = await import('./llm-validator.js');
      const result = await Promise.race([runAnalysis(sym, []), timeout]);
      if (result.signal === 'NO_TRADE') return { symbol: sym, signal: 'NO_TRADE', total: result.total ?? 0, result };
      const v = await Promise.race([validateSignal(result), timeout]);
      return { symbol: sym, signal: result.signal, total: result.total, llm: v, result };
    } catch (err) {
      const status = err.message === 'TIMEOUT' ? 504 : 500;
      return reply.code(status).send({ error: err.message });
    }
  });

  // ── Config ────────────────────────────────────────────────────────────────
  app.get('/admin/config', async () => ({
    POSITION_SIZE_USDT: Number(process.env.POSITION_SIZE_USDT ?? 50),
    MIN_SCORE:          config.minScore,
    LLM_MODE:           process.env.LLM_MODE ?? 'auto',
    MODE:               getBotState().mode,
    tradeProfile:       getTradeProfile(),
  }));

  app.patch('/admin/config', { preHandler: [requireRole('OPERATOR')] }, async (req, reply) => {
    const { mode, tradeProfile } = req.body ?? {};
    if (mode) {
      const valid = ['LIVE','SHADOW'].includes(mode);
      if (!valid) return reply.code(400).send({ error: 'Invalid mode. Allowed: LIVE, SHADOW' });
      setMode(mode);
      await audit('SET_MODE', req.adminUserId, { mode });
    }
    if (tradeProfile !== undefined) {
      const valid = ['conservative','balanced','aggressive'].includes(tradeProfile);
      if (!valid) return reply.code(400).send({ error: 'Invalid tradeProfile. Allowed: conservative, balanced, aggressive' });
      setTradeProfile(tradeProfile);
      await audit('SET_TRADE_PROFILE', req.adminUserId, { tradeProfile });
    }
    return { ok: true, state: getBotState() };
  });

  // ── Module toggle (OPERATOR minimum) ─────────────────────────────────────
  app.post('/admin/modules', { preHandler: [requireRole('OPERATOR')] }, async (req, reply) => {
    const { module: name, enabled } = req.body ?? {};
    if (!name || enabled === undefined) return reply.code(400).send({ error: 'module + enabled required' });
    const modules = getBotState().modules;
    if (!(name in modules)) return reply.code(400).send({ error: `Unknown module. Allowed: ${Object.keys(modules).join(', ')}` });
    setModuleEnabled(name, enabled);
    await audit('MODULE_TOGGLE', req.adminUserId, { module: name, enabled });
    return { ok: true, modules: getBotState().modules };
  });

  // ── Equity curve (P8D.5) ─────────────────────────────────────────────────
  app.get('/admin/equity', async () => {
    try {
      const trades = await readAllTrades();
      return { series: _buildEquitySeries(trades) };
    } catch (err) {
      console.error('[admin-api] equity error:', err.message);
      return { series: [] };
    }
  });

  // ── Risk cockpit (P8D.6) ──────────────────────────────────────────────────
  app.get('/admin/risk', async () => {
    try {
      const positions     = _getPositions();
      const trades        = await readAllTrades({ limit: 10_000 });
      const closed        = trades.filter(t => t.closedAt || t.closed_at || t.closedTime);
      const posSize       = Number(process.env.POSITION_SIZE_USDT ?? 50);
      const wins          = closed.filter(t => (Number(t.pnl_usdt ?? t.pnl ?? 0) || 0) > 0);
      const losses        = closed.filter(t => (Number(t.pnl_usdt ?? t.pnl ?? 0) || 0) < 0);
      const decidedTrades = wins.length + losses.length;
      const totalPnl      = closed.reduce((s, t) => s + (Number(t.pnl_usdt ?? t.pnl ?? 0) || 0), 0);

      // unrealizedPnl : utilise unRealizedProfit natif Binance (via reconcilePositions),
      // fallback sur calcul local entry×qty si le champ est absent
      let unrealizedPnl = 0;
      let pnlRealtimeAvailable = positions.length === 0;
      if (positions.length > 0) {
        const { data: binMap, ok: binOk } = await _fetchBinanceData(positions);
        pnlRealtimeAvailable = binOk;
        unrealizedPnl = positions.reduce((sum, p) => {
          const bin = binMap.get(p.symbol);
          if (!bin) return sum;
          if (Number.isFinite(bin.unrealizedProfit)) return sum + bin.unrealizedProfit;
          // fallback : calcul depuis mark price
          const mark  = Number(bin.markPrice);
          const entry = Number(p.entry);
          const qty   = Number(p.qty);
          const dir   = String(p.direction ?? '').toUpperCase();
          if (!Number.isFinite(mark) || !Number.isFinite(entry) || !Number.isFinite(qty)) return sum;
          return sum + (dir === 'LONG' ? (mark - entry) * qty : (entry - mark) * qty);
        }, 0);
      }

      // margin : champ réel si présent, sinon posSize par défaut
      const totalMargin   = +positions.reduce((s, p) => s + (Number(p.margin) || posSize), 0).toFixed(2);
      // exposure : entry×qty si disponibles (notional réel), sinon margin×leverage
      const totalExposure = +positions.reduce((s, p) => {
        const notional = (Number(p.entry) > 0 && Number(p.qty) > 0)
          ? Number(p.entry) * Number(p.qty)
          : (Number(p.margin) || posSize) * (Number(p.leverage) || 20);
        return s + notional;
      }, 0).toFixed(2);
      const series        = _buildEquitySeries(trades);
      return {
        openPositions: positions.length,
        totalExposure,
        totalMargin,
        unrealizedPnl:        +unrealizedPnl.toFixed(2),
        pnlRealtimeAvailable: pnlRealtimeAvailable,
        winRate:              decidedTrades > 0 ? +((wins.length / decidedTrades) * 100).toFixed(1) : null,
        totalTrades:   closed.length,
        wins:          wins.length,
        losses:        losses.length,
        maxDrawdown:   _maxDrawdownUsdt(series),
        totalPnl:      +totalPnl.toFixed(2),
      };
    } catch (err) {
      console.error('[admin-api] risk error:', err.message);
      return { error: err.message };
    }
  });

  // ── Log streamer (P8D.7) ─────────────────────────────────────────────────
  app.get('/admin/logs', async (req) => {
    const since = req.query.since;
    let logs = LOG_BUFFER;
    if (since) {
      const ts = new Date(since).getTime();
      if (Number.isFinite(ts)) logs = logs.filter(l => new Date(l.ts).getTime() > ts);
    }
    return { logs: logs.slice(-200) };
  });

  // ── Me — userId + role courant (P8E) ─────────────────────────────────────
  app.get('/admin/me', async (req) => ({
    userId: req.adminUserId,
    role:   getUserRole(req.adminUserId),
  }));

  // ── Network — lire/basculer testnet ↔ mainnet ────────────────────────────
  app.get('/admin/network', async () => ({
    network:        process.env.BINANCE_TESTNET === 'true' ? 'TESTNET' : 'MAINNET',
    binanceTestnet: process.env.BINANCE_TESTNET === 'true',
  }));

  app.post('/admin/network', { preHandler: [requireRole('ADMIN')] }, async (req, reply) => {
    const { network } = req.body ?? {};
    if (!['TESTNET', 'MAINNET'].includes(network))
      return reply.code(400).send({ error: 'network must be TESTNET or MAINNET' });

    const targetVal = network === 'TESTNET' ? 'true' : 'false';
    const envPath   = `${process.cwd()}/.env`;

    try {
      let content = await readFile(envPath, 'utf8');
      content = content.split('\n').filter(l => !l.startsWith('BINANCE_TESTNET=')).join('\n');
      if (!content.endsWith('\n')) content += '\n';
      content += `BINANCE_TESTNET=${targetVal}\n`;
      await writeFile(envPath, content, 'utf8');
    } catch (err) {
      console.error('[admin-api] network switch .env error:', err.message);
      return reply.code(500).send({ error: `Failed to update .env: ${err.message}` });
    }

    await audit(`SWITCH_NETWORK:${network}`, req.adminUserId);
    setTimeout(() => exec('pm2 restart perpedge-bot', () => {}), 800);
    return { ok: true, network, restarting: true };
  });

  // ── Quote (prix mark actuel) ──────────────────────────────────────────────
  app.get('/admin/quote', async (req, reply) => {
    const symbol = String(req.query.symbol ?? '').trim().toUpperCase();
    if (!symbol) return reply.code(400).send({ error: 'symbol required' });
    try {
      const base = process.env.BINANCE_TESTNET === 'true'
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com';
      const res  = await fetch(`${base}/fapi/v1/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { symbol, price: null };
      const data = await res.json();
      return { symbol, price: Number(data.price) || null };
    } catch {
      return { symbol, price: null };
    }
  });

  // ── Trade manuel (OPERATOR minimum) ──────────────────────────────────────
  app.post('/admin/manual-trade', { preHandler: [requireRole('OPERATOR')] }, async (req, reply) => {
    const { symbol, side, size_usdt, leverage, sl_price, tp_price } = req.body ?? {};
    const missing = ['symbol','side','size_usdt','leverage','sl_price','tp_price']
      .filter(k => (req.body ?? {})[k] === undefined || (req.body ?? {})[k] === null || (req.body ?? {})[k] === '');
    if (missing.length > 0)
      return reply.code(400).send({ ok: false, error_code: 'MISSING_FIELDS', message: `Champs requis : ${missing.join(', ')}` });
    try {
      const { executeManualTrade } = await import('./manual-trade.js');
      const result = await executeManualTrade({
        symbol, side,
        size_usdt: Number(size_usdt),
        leverage:  Number(leverage),
        sl_price:  Number(sl_price),
        tp_price:  Number(tp_price),
      });
      await audit('MANUAL_TRADE', req.adminUserId, { symbol, side, size_usdt, leverage });
      return result;
    } catch (err) {
      const known = ['INVALID_SYMBOL','INVALID_SIDE','INVALID_SIZE','INVALID_LEVERAGE','SL_TP_INVALID','BELOW_MIN_NOTIONAL'];
      const code  = known.find(c => err.message?.includes(c)) ?? 'EXECUTION_ERROR';
      return reply.code(400).send({ ok: false, error_code: code, message: err.message });
    }
  });

  // ── Export CSV des trades (P8E — OPERATOR minimum) ───────────────────────
  app.get('/admin/export', { preHandler: [requireRole('OPERATOR')] }, async (req, reply) => {
    try {
      const trades = await readAllTrades();
      if (!trades || trades.length === 0) return reply.code(404).send({ error: 'no trades' });

      const cols = ['date_closed','symbol','direction','entry_price','exit_price','qty','pnl_usdt','pnl_pct','exit_reason'];
      const rows = [cols.join(',')];
      for (const t of trades) {
        rows.push(cols.map(c => {
          const v = t[c] ?? '';
          if (c === 'exit_reason') return _escapeCsv(String(v));
          return String(v);
        }).join(','));
      }

      const dateStr  = new Date().toISOString().split('T')[0];
      const filename = `trades_${dateStr}.csv`;
      reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(rows.join('\n'));
    } catch (err) {
      console.error('[admin-api] export error:', err.message);
      return reply.code(500).send({ error: 'Export failed' });
    }
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[admin-api] Fastify démarré sur :${PORT}`);
  return app;
}
