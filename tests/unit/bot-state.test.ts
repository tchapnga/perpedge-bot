import { describe, it, expect, beforeEach, vi } from 'vitest';

// Dynamic import so setup.unit.ts env vars are loaded first
let mod: typeof import('../../src/bot-state.js');

beforeEach(async () => {
  // vi.resetModules() clears Vitest's module registry → fresh singleton each test
  vi.resetModules();
  mod = await import('../../src/bot-state.js');
});

describe('getBotState()', () => {
  it('returns a snapshot with all required fields', () => {
    const s = mod.getBotState();
    expect(s).toHaveProperty('pauseLevel');
    expect(s).toHaveProperty('mode');
    expect(s).toHaveProperty('emergencyStopped');
    expect(s).toHaveProperty('tradeProfile');
    expect(s).toHaveProperty('modules');
    expect(s).toHaveProperty('isPaused');
  });

  it('isPaused is false when pauseLevel is none', () => {
    mod.setPauseLevel('none');
    expect(mod.getBotState().isPaused).toBe(false);
    expect(mod.isEntryPaused()).toBe(false);
  });

  it('isPaused is true when pauseLevel is entries', () => {
    mod.setPauseLevel('entries');
    expect(mod.getBotState().isPaused).toBe(true);
    expect(mod.isEntryPaused()).toBe(true);
    expect(mod.isPausedAll()).toBe(false);
  });

  it('isPaused is true when pauseLevel is all', () => {
    mod.setPauseLevel('all');
    expect(mod.isEntryPaused()).toBe(true);
    expect(mod.isPausedAll()).toBe(true);
  });
});

describe('setPauseLevel()', () => {
  it('accepts valid levels', () => {
    for (const level of ['none', 'entries', 'all'] as const) {
      mod.setPauseLevel(level);
      expect(mod.getBotState().pauseLevel).toBe(level);
    }
  });

  it('ignores invalid levels', () => {
    mod.setPauseLevel('none');
    // @ts-expect-error intentional invalid value
    mod.setPauseLevel('invalid');
    expect(mod.getBotState().pauseLevel).toBe('none');
  });
});

describe('setMode()', () => {
  it('accepts LIVE and SHADOW', () => {
    mod.setMode('LIVE');
    expect(mod.getMode()).toBe('LIVE');
    mod.setMode('SHADOW');
    expect(mod.getMode()).toBe('SHADOW');
  });

  it('ignores invalid modes', () => {
    mod.setMode('SHADOW');
    // @ts-expect-error intentional invalid value
    mod.setMode('FAKE');
    expect(mod.getMode()).toBe('SHADOW');
  });
});

describe('setTradeProfile()', () => {
  it('accepts all valid profiles', () => {
    for (const p of ['conservative', 'balanced', 'aggressive'] as const) {
      mod.setTradeProfile(p);
      expect(mod.getTradeProfile()).toBe(p);
    }
  });

  it('ignores invalid profile', () => {
    mod.setTradeProfile('balanced');
    // @ts-expect-error intentional invalid value
    mod.setTradeProfile('turbo');
    expect(mod.getTradeProfile()).toBe('balanced');
  });
});

describe('setEmergencyStop() / resetEmergencyStop()', () => {
  it('sets emergencyStopped and pauseLevel=all', () => {
    mod.setEmergencyStop();
    expect(mod.isEmergencyStopped()).toBe(true);
    expect(mod.isPausedAll()).toBe(true);
  });

  it('reset clears emergencyStopped only — pauseLevel unchanged', () => {
    mod.setEmergencyStop();
    mod.resetEmergencyStop();
    expect(mod.isEmergencyStopped()).toBe(false);
    expect(mod.isPausedAll()).toBe(true); // pauseLevel stays 'all' until explicit RESUME
  });
});

describe('setModuleEnabled()', () => {
  it('disables and re-enables a valid module', () => {
    mod.setModuleEnabled('scalp', false);
    expect(mod.getBotState().modules.scalp).toBe(false);
    mod.setModuleEnabled('scalp', true);
    expect(mod.getBotState().modules.scalp).toBe(true);
  });

  it('ignores unknown module names silently', () => {
    // Should not throw
    expect(() => mod.setModuleEnabled('unknown_module', false)).not.toThrow();
  });
});

describe('recordClosedTrade() — circuit breaker', () => {
  it('does not trip on a single small loss', () => {
    const result = mod.recordClosedTrade(-10);
    expect(result.tripped).toBe(false);
  });

  it('trips on daily loss exceeding threshold', () => {
    // CB_DAILY_LOSS_USDT = 100 in tests/.env.test
    const result = mod.recordClosedTrade(-101);
    expect(result.tripped).toBe(true);
    expect(result.reason).toMatch(/Daily loss/i);
    expect(mod.isPausedAll()).toBe(true);
  });

  it('trips on consecutive losses exceeding threshold', () => {
    // CB_MAX_CONSEC_LOSSES = 5 in tests/.env.test
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(-1);
    const result = mod.recordClosedTrade(-1);
    expect(result.tripped).toBe(true);
    expect(result.reason).toMatch(/consécutives/i);
  });

  it('resets consecutive loss streak on a win', () => {
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(+5); // win resets streak
    // 2 more losses — should NOT trip (streak only at 2, threshold is 5)
    mod.recordClosedTrade(-1);
    const result = mod.recordClosedTrade(-1);
    expect(result.tripped).toBe(false);
  });

  it('break-even trade (pnl=0) does not change streak', () => {
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(0); // break-even: streak unchanged
    mod.recordClosedTrade(-1);
    mod.recordClosedTrade(-1);
    // streak is now at 4, threshold is 5 — should NOT trip yet
    const result = mod.recordClosedTrade(-1);
    expect(result.tripped).toBe(true); // 5th consecutive loss trips it
  });
});

describe('resetCircuitBreaker()', () => {
  it('clears circuit breaker flag and consecutive losses', () => {
    mod.recordClosedTrade(-200);
    expect(mod.getBotState().circuitBreaker).toBe(true);
    mod.resetCircuitBreaker();
    expect(mod.getBotState().circuitBreaker).toBe(false);
    expect(mod.getBotState().consecutiveLosses).toBe(0);
  });
});
