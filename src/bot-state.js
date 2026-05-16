// Singleton d'état du bot — partagé entre admin-api, telegram-bot et index.js

function todayUTC() { return new Date().toISOString().slice(0, 10); }

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
function checkDailyReset() {
  const today = todayUTC();
  if (state.signalsDate !== today) {
    state.signalsToday = 0;
    state.signalsDate  = today;
  }
}

export function recordCycle()  { state.lastCycleAt = new Date().toISOString(); state.cycleCount++; }
export function recordSignal() { checkDailyReset(); state.signalsToday++; }
export function recordTrade()  { state.tradesExecuted++; }
