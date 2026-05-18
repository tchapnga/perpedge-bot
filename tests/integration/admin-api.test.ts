import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Dynamic imports: env vars from setup.integration.ts must be loaded first
let app: FastifyInstance;

// Shared inject options — simulates a localhost DEV request with test user
const DEV_HEADERS = {
  'x-admin-id': 'test-admin',
};

beforeAll(async () => {
  const { injectAdminDeps, buildAdminApi } = await import('../../src/admin-api.js');

  injectAdminDeps({
    getPositions:      () => [],
    getSignalLog:      () => [],
    getScalpPositions: () => [],
    getShadowPositions: () => [],
  });

  app = await buildAdminApi();
}, 15_000);

afterAll(async () => {
  await app?.close();
});

// Helper — DEV mode auth requires localhost remoteAddress + X-Admin-Id header
function inject(method: string, url: string, opts: object = {}) {
  return app.inject({
    method: method as any,
    url,
    remoteAddress: '127.0.0.1',
    headers: DEV_HEADERS,
    ...opts,
  });
}

describe('GET /admin/health', () => {
  it('returns 200 with ok:true — no auth required', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
    expect(body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('GET /admin/status', () => {
  it('returns 200 with bot state fields', async () => {
    const res = await inject('GET', '/admin/status');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('mode');
    expect(body).toHaveProperty('pauseLevel');
    expect(body).toHaveProperty('emergencyStopped');
    expect(body).toHaveProperty('openPositions');
  });

  it('returns 401 without auth headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/status' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /admin/config', () => {
  it('returns config object with expected keys', async () => {
    const res = await inject('GET', '/admin/config');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('MIN_SCORE');
    expect(body).toHaveProperty('LLM_MODE');
    expect(body).toHaveProperty('MODE');
    expect(body).toHaveProperty('tradeProfile');
    expect(body).toHaveProperty('POSITION_SIZE_USDT');
  });
});

describe('PATCH /admin/config', () => {
  it('updates tradeProfile successfully', async () => {
    const res = await inject('PATCH', '/admin/config', {
      body: { tradeProfile: 'conservative' },
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.state.tradeProfile).toBe('conservative');
  });

  it('rejects invalid tradeProfile with 400', async () => {
    const res = await inject('PATCH', '/admin/config', {
      body: { tradeProfile: 'invalid_profile' },
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /admin/positions', () => {
  it('returns 200 with positions/scalp/shadow keys', async () => {
    const res = await inject('GET', '/admin/positions');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.positions)).toBe(true);
    expect(Array.isArray(body.scalp)).toBe(true);
    expect(Array.isArray(body.shadow)).toBe(true);
  });
});

describe('GET /admin/me', () => {
  it('returns current user id and role', async () => {
    const res = await inject('GET', '/admin/me');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('userId');
    expect(body).toHaveProperty('role');
    expect(body.userId).toBe('test-admin');
  });
});

describe('GET /admin/equity', () => {
  it('returns 200 with equity series under body.series', async () => {
    const res = await inject('GET', '/admin/equity');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.series)).toBe(true);
  });
});

describe('GET /admin/risk', () => {
  it('returns 200 with risk metrics', async () => {
    const res = await inject('GET', '/admin/risk');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('winRate');
    expect(body).toHaveProperty('totalTrades');
    expect(body).toHaveProperty('maxDrawdown');
    expect(body).toHaveProperty('totalPnl');
    expect(body).toHaveProperty('openPositions');
  });
});

describe('GET /admin/logs', () => {
  it('returns 200 with logs array', async () => {
    const res = await inject('GET', '/admin/logs');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('logs');
    expect(Array.isArray(body.logs)).toBe(true);
  });
});

describe('GET /admin/network', () => {
  it('returns current network (MAINNET in test env)', async () => {
    const res = await inject('GET', '/admin/network');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(['MAINNET', 'TESTNET']).toContain(body.network);
    expect(typeof body.binanceTestnet).toBe('boolean');
  });
});

describe('POST /admin/commands', () => {
  it('PAUSE_NEW_ENTRIES pauses entries', async () => {
    const res = await inject('POST', '/admin/commands', {
      body: { command: 'PAUSE_NEW_ENTRIES' },
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('RESUME unpauses', async () => {
    const res = await inject('POST', '/admin/commands', {
      body: { command: 'RESUME' },
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('rejects unknown command with 400', async () => {
    const res = await inject('POST', '/admin/commands', {
      body: { command: 'INVALID_CMD' },
      headers: { ...DEV_HEADERS, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });
});
