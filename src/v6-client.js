import { config } from './config.js';

async function fetchV6(path) {
  try {
    const res = await fetch(`${config.v6Url}/v6${path}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getV6Signal(symbol) {
  const data = await fetchV6(`/signal/${symbol.toUpperCase()}`);
  if (!data || !data.bias || typeof data.score !== 'number' || data.score <= 0) return null;
  if (data.age_s !== undefined && data.age_s > 180) return null;
  return data;
}

export async function getV6TopSignals(minScore = 7.0) {
  const data = await fetchV6(`/top-signals?min_score=${minScore}`);
  return Array.isArray(data) ? data : [];
}
