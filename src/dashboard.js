import { createServer } from 'http';

const PORT = process.env.DASHBOARD_PORT || 3001;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmt(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toString() : '';
  if (typeof v === 'boolean') return v ? '✅' : '❌';
  return String(v);
}

function pick(obj, keys) {
  for (const k of keys) if (obj?.[k] != null) return obj[k];
  return '';
}

function renderPositionsRows(positions) {
  if (!positions.length) return `<tr><td colspan="6" class="empty">Aucune position active</td></tr>`;
  return positions.map(p => `
    <tr>
      <td>${escapeHtml(fmt(pick(p, ['symbol', 'pair'])))}</td>
      <td>${escapeHtml(fmt(pick(p, ['direction', 'side'])))}</td>
      <td>${escapeHtml(fmt(pick(p, ['entry', 'entryPrice'])))}</td>
      <td>${escapeHtml(fmt(pick(p, ['sl', 'stopLoss'])))}</td>
      <td>${escapeHtml(fmt(pick(p, ['tp1', 'tp'])))}</td>
      <td>${escapeHtml(fmt(pick(p, ['beReached', 'be_reached'])))}</td>
    </tr>`).join('');
}

function renderSignalsRows(signals) {
  if (!signals.length) return `<tr><td colspan="5" class="empty">Aucun signal récent</td></tr>`;
  return signals.slice(0, 50).map(s => `
    <tr>
      <td>${escapeHtml(fmt(pick(s, ['time', 'timestamp'])))}</td>
      <td>${escapeHtml(fmt(pick(s, ['symbol', 'pair'])))}</td>
      <td>${escapeHtml(fmt(pick(s, ['signal', 'side', 'direction'])))}</td>
      <td>${escapeHtml(fmt(pick(s, ['total', 'score'])))}</td>
      <td>${escapeHtml(fmt(s?.llm_validation?.decision ?? ''))}</td>
    </tr>`).join('');
}

function renderDashboard(positions, signals) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PerpEdge Dashboard</title>
  <style>
    body { margin: 0; padding: 24px; font-family: Arial, sans-serif; background: #0f172a; color: #e5e7eb; }
    h1   { margin: 0 0 4px; font-size: 28px; }
    h2   { margin: 28px 0 12px; font-size: 20px; }
    .meta { margin-bottom: 20px; color: #94a3b8; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; background: #111827; border: 1px solid #1f2937; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #1f2937; text-align: left; font-size: 14px; }
    th { background: #1e293b; color: #f8fafc; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    .empty { color: #94a3b8; text-align: center; padding: 18px; }
  </style>
</head>
<body>
  <h1>PerpEdge Dashboard</h1>
  <div class="meta">Auto-refresh toutes les 30 secondes · <a href="/health" style="color:#60a5fa">/health</a> · <a href="/api/positions" style="color:#60a5fa">/api/positions</a> · <a href="/api/signals" style="color:#60a5fa">/api/signals</a></div>
  <section>
    <h2>Positions actives (${positions.length})</h2>
    <table>
      <thead><tr><th>Symbol</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP1</th><th>Breakeven</th></tr></thead>
      <tbody>${renderPositionsRows(positions)}</tbody>
    </table>
  </section>
  <section>
    <h2>Signaux récents (${Math.min(signals.length, 50)})</h2>
    <table>
      <thead><tr><th>Time</th><th>Symbol</th><th>Signal</th><th>Score</th><th>LLM Decision</th></tr></thead>
      <tbody>${renderSignalsRows(signals)}</tbody>
    </table>
  </section>
</body>
</html>`;
}

export function startDashboard(getPositions, getSignalLog) {
  const server = createServer((req, res) => {
    try {
      const url       = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method !== 'GET') { sendJson(res, 404, { error: 'Not found' }); return; }
      const positions = Array.isArray(getPositions?.()) ? getPositions() : [];
      const signals   = Array.isArray(getSignalLog?.()) ? getSignalLog().slice(0, 50) : [];
      if (url.pathname === '/')              { sendHtml(res, 200, renderDashboard(positions, signals)); return; }
      if (url.pathname === '/health')        { sendJson(res, 200, { status: 'ok', uptime: process.uptime(), positions: positions.length, signals: signals.length }); return; }
      if (url.pathname === '/api/positions') { sendJson(res, 200, positions); return; }
      if (url.pathname === '/api/signals')   { sendJson(res, 200, signals);   return; }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: 'Internal server error', message: err?.message ?? String(err) });
    }
  });
  server.listen(PORT, () => console.log(`[dashboard] PerpEdge Dashboard running on port ${PORT}`));
  return server;
}
