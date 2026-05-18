import { describe, it, expect } from 'vitest';
import { computeLevels } from '../../src/injector.js';

function makeResult(direction: 'long' | 'short', overrides: Record<string, unknown> = {}) {
  return {
    signal: 'TRADE',
    direction,
    ta: {
      sr: { nearest_support: null, nearest_resistance: null },
      tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 },
      ...overrides.ta,
    },
    ...overrides,
  } as any;
}

describe('computeLevels() — SHORT', () => {
  it('TP2 < TP1 when support is shallower than 2R target (standard case)', () => {
    // entry=100, sl≈103 (3% above), support=98 — 2R target ≈ 94
    const r = computeLevels(makeResult('short', {
      ta: { sr: { nearest_support: 98, nearest_resistance: 103 }, tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 } },
    }));
    expect(r).not.toBeNull();
    expect(r!.tp2).toBeLessThan(r!.tp1);
  });

  it('TP2 < TP1 when support is DEEPER than 2R target — the FIDA bug case', () => {
    // entry=0.50, sl=0.55 (slDist=0.05), support=0.35 (deeper than 2R=0.40)
    const r = computeLevels(makeResult('short', {
      ta: { sr: { nearest_support: 0.35, nearest_resistance: 0.55 }, tf_1h: { close: 0.50, atr_14: 0.01, vwap_24h: 0.50 } },
    }));
    expect(r).not.toBeNull();
    expect(r!.tp1).not.toBe(r!.tp2);
    expect(r!.tp2).toBeLessThan(r!.tp1);
  });

  it('TP2 < TP1 when no S/R available (fallback values)', () => {
    // fallback: tp1 = entry*0.97, sl = entry*1.03
    const r = computeLevels(makeResult('short', {
      ta: { sr: { nearest_support: null, nearest_resistance: null }, tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 } },
    }));
    expect(r).not.toBeNull();
    expect(r!.tp2).toBeLessThan(r!.tp1);
  });
});

describe('computeLevels() — LONG', () => {
  it('TP2 > TP1 when resistance is shallower than 2R target (standard case)', () => {
    // entry=100, sl=97, resistance=102 — 2R target=106
    const r = computeLevels(makeResult('long', {
      ta: { sr: { nearest_support: 97, nearest_resistance: 102 }, tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 } },
    }));
    expect(r).not.toBeNull();
    expect(r!.tp2).toBeGreaterThan(r!.tp1);
  });

  it('TP2 > TP1 when resistance is BEYOND 2R target — same bug mirrored for LONG', () => {
    // entry=100, sl=97, resistance=112 (beyond 2R=106)
    const r = computeLevels(makeResult('long', {
      ta: { sr: { nearest_support: 97, nearest_resistance: 112 }, tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 } },
    }));
    expect(r).not.toBeNull();
    expect(r!.tp1).not.toBe(r!.tp2);
    expect(r!.tp2).toBeGreaterThan(r!.tp1);
  });

  it('TP2 > TP1 when no S/R available (fallback values)', () => {
    const r = computeLevels(makeResult('long', {
      ta: { sr: { nearest_support: null, nearest_resistance: null }, tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 } },
    }));
    expect(r).not.toBeNull();
    expect(r!.tp2).toBeGreaterThan(r!.tp1);
  });

  it('all levels are strictly positive finite numbers', () => {
    const r = computeLevels(makeResult('long', {
      ta: { sr: { nearest_support: 97, nearest_resistance: 105 }, tf_1h: { close: 100, atr_14: 2, vwap_24h: 100 } },
    }));
    expect(r).not.toBeNull();
    for (const key of ['entry', 'sl', 'tp1', 'tp2'] as const) {
      expect(Number.isFinite(r![key])).toBe(true);
      expect(r![key]).toBeGreaterThan(0);
    }
  });

  it('returns null when TA data produces NaN (atr undefined)', () => {
    const r = computeLevels(makeResult('long', {
      signal: 'PENDING_LIMIT',
      ta: { sr: { nearest_support: 97, nearest_resistance: 105 }, tf_1h: { close: 100, atr_14: undefined, vwap_24h: 100 } },
    }));
    expect(r).toBeNull();
  });
});
