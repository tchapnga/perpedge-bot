import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NETWORK } from './utils/network.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '..', 'data');
const STORE_PATH = join(DATA_DIR, `positions.${NETWORK}.json`);

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }

export function loadPositions() {
  try {
    const text    = readFileSync(STORE_PATH, 'utf8');
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) return new Map();
    const map = new Map();
    for (const [k, v] of entries) {
      if (k && v && typeof v === 'object') map.set(k, v);
    }
    console.log(`[position-store] ${map.size} position(s) chargée(s) depuis ${STORE_PATH}`);
    return map;
  } catch {
    return new Map();
  }
}

export function savePositions(map) {
  try {
    writeFileSync(STORE_PATH, JSON.stringify([...map.entries()], null, 2), 'utf8');
  } catch (err) {
    console.error('[position-store] save error:', err.message);
  }
}
