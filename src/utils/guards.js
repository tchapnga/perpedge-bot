// guards.js — guards de sécurité spot partagés (consensus 3/3 LLMs 2026-05-17)
// Binance Spot API n'a pas de testnet — tout appel spot est TOUJOURS en production.
// Activer le trading spot réel requiert BINANCE_TESTNET=false ET ENABLE_SPOT_LIVE_TRADING=true.

export const isTestnet = () =>
  String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true';

export const isSpotLiveAllowed = () =>
  String(process.env.ENABLE_SPOT_LIVE_TRADING || '').toLowerCase() === 'true';

export const isSpotTradingBlocked = () => isTestnet() || !isSpotLiveAllowed();
