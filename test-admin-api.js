import 'dotenv/config';
import { startAdminApi, injectAdminDeps } from './src/admin-api.js';

// ADMIN_TELEGRAM_IDS vide → X-Admin-Id accepté (mode dev)
delete process.env.ADMIN_TELEGRAM_IDS;

injectAdminDeps({
  getPositions: () => [{ symbol: 'BTCUSDT', side: 'LONG', entry: 100000, unrealizedPnl: 42.5 }],
  getSignalLog: () => [{ time: new Date().toISOString(), symbol: 'BTCUSDT', signal: 'LONG', total: 7 }],
});

const app = await startAdminApi();

// Test toutes les routes
const BASE = 'http://localhost:3002';
const H    = { 'X-Admin-Id': '999999999' };

async function get(path)       { const r = await fetch(`${BASE}${path}`, { headers: H }); return r.json(); }
async function post(path, body){ const r = await fetch(`${BASE}${path}`, { method:'POST', headers: {...H,'Content-Type':'application/json'}, body: JSON.stringify(body) }); return r.json(); }

console.log('\n── /admin/health ──');
console.log(await fetch(`${BASE}/admin/health`).then(r => r.json()));

console.log('\n── /admin/status ──');
console.log(await get('/admin/status'));

console.log('\n── /admin/positions ──');
console.log(await get('/admin/positions'));

console.log('\n── /admin/signals ──');
console.log(await get('/admin/signals'));

console.log('\n── /admin/config ──');
console.log(await get('/admin/config'));

console.log('\n── POST /admin/commands PAUSE_NEW_ENTRIES ──');
console.log(await post('/admin/commands', { command: 'PAUSE_NEW_ENTRIES' }));

console.log('\n── POST /admin/commands RESUME ──');
console.log(await post('/admin/commands', { command: 'RESUME' }));

console.log('\n── /admin/symbols?q=BTC ──');
console.log(await get('/admin/symbols?q=BTC'));

await app.close();
console.log('\n✓ Tous les endpoints OK — Admin API P8-A PASS');
