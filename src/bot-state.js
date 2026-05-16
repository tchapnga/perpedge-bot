// Singleton d'état du bot — partagé entre admin-api, telegram-bot et index.js

function todayUTC() { return new Date().toISOString().slice(0, 10); }

// P0.4 — Circuit breaker config (env-overridable)
const CB_DAILY_LOSS_USDT   = Number.isFinite(Number(process.env.CIRCUIT_BREAKER_DAILY_LOSS_USDT))
  ? Number(process.env.CIRCUIT_BREAKER_DAILY_LOSS_USDT) : 50;
const CB_MAX_CONSEC_LOSSES = Number.isFinite(Number(process.env.CIRCUIT_BREAKER_MAX_LOSSES))
  ? Number(process.env.CIRCUIT_BREAKER_MAX_LOSSES) : 3;

const state = {
  isPaused:         false,
  mode:             'LIVE',        // 'LIVE' | 'SHADOW'
  emergencyStopped: false,

  modules: {
    scalp:         true,
    capitulation:  true,
    smartMoney:    true,
    oi:            true,
    squeeze:       true,
    crowdedUnwind: true,
  },

  lastCycleAt:    null,
  cycleCount:     0,
  signalsToday:   0,
  signalsDate:    todayUTC(),      // FIX: date de référence pour reset quotidien
  tradesExecuted: 0,
  startedAt:      new Date().toISOString(),

  // P0.4 — Circuit breaker state
  dailyPnlUsdt:         0,
  dailyPnlDate:         todayUTC(),  // date indépendante de signalsDate
  consecutiveLosses:    0,
  circuitBreaker:       false,
  circuitBreakerReason: null,
};

// Getters
export function getBotState() { return { ...state, modules: { ...state.modules } }; }
export function isPaused()            { return state.isPaused; }
export function isEmergencyStopped()  { return state.emergencyStopped; }
export function getMode()             { return state.mode; }

// Setters
export function setPaused(v)          { state.isPaused = Boolean(v); }
export function setMode(m)            { if (['LIVE','SHADOW'].includes(m)) state.mode = m; }

export function setEmergencyStop() {
  state.emergencyStopped = true;
  state.isPaused = true;
}

// FIX: clearEmergencyFlag ne reprend pas le bot automatiquement.
// L'opérateur doit appeler setPaused(false) / RESUME explicitement après.
export function resetEmergencyStop() {
  state.emergencyStopped = false;
  // isPaused reste true — l'opérateur doit envoyer RESUME séparément
}

export function setModuleEnabled(name, v) {
  if (name in state.modules) state.modules[name] = Boolean(v);
}

// FIX: reset signalsToday si on change de jour UTC
// P0.4: reset PnL/streak sur date indépendante pour éviter couplage
function checkDailyReset() {
  const today = todayUTC();
  if (state.signalsDate !== today) {
    state.signalsToday = 0;
    state.signalsDate  = today;
  }
  if (state.dailyPnlDate !== today) {
    state.dailyPnlUsdt      = 0;
    state.dailyPnlDate      = today;
    state.consecutiveLosses = 0;
    // circuitBreaker reste actif si déclenché — intervention manuelle requise
  }
}

export function recordCycle()  { state.lastCycleAt = new Date().toISOString(); state.cycleCount++; }
export function recordSignal() { checkDailyReset(); state.signalsToday++; }
export function recordTrade()  { state.tradesExecuted++; }

// P0.4 — Circuit breaker
export function recordClosedTrade(pnlUsdt) {
  checkDailyReset();
  state.dailyPnlUsdt = Math.round((state.dailyPnlUsdt + pnlUsdt) * 100) / 100;
  if      (pnlUsdt < 0) state.consecutiveLosses++;
  else if (pnlUsdt > 0) state.consecutiveLosses = 0;
  // pnlUsdt === 0 (break-even) : streak inchangée

  if (!state.circuitBreaker) {
    if (state.dailyPnlUsdt <= -CB_DAILY_LOSS_USDT) {
      state.circuitBreaker       = true;
      state.circuitBreakerReason = `Daily loss: ${state.dailyPnlUsdt.toFixed(2)} USDT (limit -${CB_DAILY_LOSS_USDT})`;
      state.isPaused             = true;
      return { tripped: true, reason: state.circuitBreakerReason };
    }
    if (state.consecutiveLosses >= CB_MAX_CONSEC_LOSSES) {
      state.circuitBreaker       = true;
      state.circuitBreakerReason = `${state.consecutiveLosses} pertes consécutives (limit ${CB_MAX_CONSEC_LOSSES})`;
      state.isPaused             = true;
      return { tripped: true, reason: state.circuitBreakerReason };
    }
  }
  return { tripped: false, reason: null };
}

// Reset manuel via /resetcb — isPaused reste true, opérateur doit /resume séparément
export function resetCircuitBreaker() {
  state.circuitBreaker       = false;
  state.circuitBreakerReason = null;
  state.consecutiveLosses    = 0;
}
