import { describe, it, expect } from 'vitest';
import {
  floorToTick,
  ceilToTick,
  toFixedSafe,
  decimalPlaces,
  calculateQuantity,
} from '../../src/order-executor.js';

describe('floorToTick()', () => {
  it('floors price to nearest tick below', () => {
    expect(floorToTick(100.37, 0.1)).toBeCloseTo(100.3, 10);
    expect(floorToTick(100.00, 0.5)).toBeCloseTo(100.0, 10);
    expect(floorToTick(99.99,  0.5)).toBeCloseTo( 99.5, 10);
  });

  it('is a no-op when price is already on tick', () => {
    expect(floorToTick(100.5, 0.5)).toBeCloseTo(100.5, 10);
    expect(floorToTick(0.001, 0.001)).toBeCloseTo(0.001, 10);
  });

  it('handles BTC-scale prices', () => {
    // BTC at ~67000 with tickSize 0.10
    const result = floorToTick(67123.45, 0.1);
    expect(result).toBeCloseTo(67123.4, 5);
  });
});

describe('ceilToTick()', () => {
  it('rounds price up to nearest tick', () => {
    expect(ceilToTick(100.31, 0.1)).toBeCloseTo(100.4, 10);
    expect(ceilToTick(100.50, 0.5)).toBeCloseTo(100.5, 10);
    expect(ceilToTick(100.51, 0.5)).toBeCloseTo(101.0, 10);
  });

  it('is a no-op when price is already on tick', () => {
    expect(ceilToTick(50.0, 0.5)).toBeCloseTo(50.0, 10);
  });
});

describe('toFixedSafe()', () => {
  it('removes trailing zeros', () => {
    expect(toFixedSafe(1.50000,  5)).toBe('1.5');
    expect(toFixedSafe(100.0,    2)).toBe('100');
    expect(toFixedSafe(0.00100, 5)).toBe('0.001');
  });

  it('keeps significant decimals intact', () => {
    expect(toFixedSafe(3.14159, 5)).toBe('3.14159');
    expect(toFixedSafe(0.123,   3)).toBe('0.123');
  });

  it('handles integer values', () => {
    expect(toFixedSafe(42, 4)).toBe('42');
  });

  it('defaults to 12 decimals', () => {
    const result = toFixedSafe(1.1);
    expect(result).toBe('1.1');
  });
});

describe('decimalPlaces()', () => {
  it('returns 0 for integers', () => {
    expect(decimalPlaces(1)).toBe(0);
    expect(decimalPlaces(100)).toBe(0);
  });

  it('counts decimal places correctly', () => {
    expect(decimalPlaces(0.1)).toBe(1);
    expect(decimalPlaces(0.01)).toBe(2);
    expect(decimalPlaces(0.001)).toBe(3);
    expect(decimalPlaces('0.0001')).toBe(4);
  });

  it('handles scientific notation (e.g. 1e-8)', () => {
    expect(decimalPlaces(1e-8)).toBe(8);
    expect(decimalPlaces(1e-5)).toBe(5);
  });
});

describe('calculateQuantity()', () => {
  const base = {
    entry: 100,
    stepSize: 0.001,
    minQty: 0,
    minNotional: 0,
    reduceSize: false,
    positionSizeUsdt: 50,
  };

  it('computes correct quantity for BTCUSDT-style params', () => {
    const qty = calculateQuantity(base);
    // 50 USDT / 100 price = 0.5 qty, floored to stepSize 0.001 → "0.5"
    expect(qty).toBe('0.5');
  });

  it('applies reduceSize=true (halves notional)', () => {
    const qty = calculateQuantity({ ...base, reduceSize: true });
    // 25 USDT / 100 = 0.25
    expect(qty).toBe('0.25');
  });

  it('throws on invalid positionSizeUsdt', () => {
    expect(() => calculateQuantity({ ...base, positionSizeUsdt: 0 })).toThrow('Invalid positionSizeUsdt');
    expect(() => calculateQuantity({ ...base, positionSizeUsdt: -10 })).toThrow('Invalid positionSizeUsdt');
  });

  it('throws on invalid stepSize', () => {
    expect(() => calculateQuantity({ ...base, stepSize: 0 })).toThrow('Invalid stepSize');
  });

  it('throws BELOW_MIN_NOTIONAL when notional < min', () => {
    expect(() =>
      calculateQuantity({ ...base, minNotional: 100, positionSizeUsdt: 10 })
    ).toThrow('BELOW_MIN_NOTIONAL');
  });

  it('throws when qty < minQty', () => {
    expect(() =>
      calculateQuantity({ ...base, entry: 100, positionSizeUsdt: 1, minQty: 10 })
    ).toThrow('minQty');
  });

  it('returns a string (not a number)', () => {
    const qty = calculateQuantity(base);
    expect(typeof qty).toBe('string');
  });
});
