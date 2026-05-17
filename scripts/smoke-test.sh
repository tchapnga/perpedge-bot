#!/usr/bin/env bash
# smoke-test.sh — PerpEdge P9 post-deploy health checks
set -Eeuo pipefail

HOST="${HOST:-perpedge-app.83-228-242-106.nip.io}"
BASE_URL="${BASE_URL:-https://${HOST}}"
DASHBOARD_HEALTH_URL="${DASHBOARD_HEALTH_URL:-http://localhost:3001/health}"
ADMIN_HEALTH_URL="${ADMIN_HEALTH_URL:-http://localhost:3002/admin/health}"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "PASS: $*"
}

command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v pm2  >/dev/null 2>&1 || fail "pm2 is not installed"
command -v node >/dev/null 2>&1 || fail "node is not installed"

# HTTPS root (SPA via Docker Caddy)
HTTP_CODE="$(curl -sS -o /tmp/perpedge-miniapp-smoke.html -w '%{http_code}' "$BASE_URL/")" \
    || fail "HTTPS root request failed"
[[ "$HTTP_CODE" == "200" ]] || fail "HTTPS root returned HTTP $HTTP_CODE"
pass "HTTPS root returned HTTP 200"

# /api/positions (dashboard port 3001 via Caddy → proxy /api/*)
API_CODE="$(curl -sS -o /tmp/perpedge-api-smoke.json -w '%{http_code}' "${BASE_URL}/api/positions")" \
    || fail "/api/positions request failed"
[[ "$API_CODE" == "200" ]] || fail "/api/positions returned HTTP $API_CODE"
pass "/api/positions returned HTTP 200"

# Dashboard health (port 3001 — direct localhost)
DASH_CODE="$(curl -sS -o /tmp/perpedge-dash-health.json -w '%{http_code}' "$DASHBOARD_HEALTH_URL")" \
    || fail "dashboard /health request failed on localhost:3001"
[[ "$DASH_CODE" == "200" ]] || fail "dashboard /health returned HTTP $DASH_CODE on localhost:3001"
pass "dashboard /health returned HTTP 200 on localhost:3001"

# /admin/health (Fastify port 3002 — sans auth, direct localhost)
ADMIN_HEALTH_CODE="$(curl -sS -o /tmp/perpedge-admin-health-smoke.json -w '%{http_code}' "$ADMIN_HEALTH_URL")" \
    || fail "/admin/health request failed on localhost:3002"
[[ "$ADMIN_HEALTH_CODE" == "200" ]] || fail "/admin/health returned HTTP $ADMIN_HEALTH_CODE on localhost:3002"
pass "/admin/health returned HTTP 200 on localhost:3002"

# Attendre stabilisation PM2 (evite faux positif crash-loop early 'online')
sleep 3

pm2 describe perpedge-bot >/dev/null 2>&1 || fail "PM2 process perpedge-bot not found"

pm2 jlist > /tmp/perpedge-pm2-smoke.json

node <<'NODE'
const fs = require('fs');
const apps = JSON.parse(fs.readFileSync('/tmp/perpedge-pm2-smoke.json', 'utf8'));
const app = apps.find((entry) => entry.name === 'perpedge-bot');
if (!app) {
    console.error('FAIL: PM2 process perpedge-bot missing');
    process.exit(1);
}
const status = (app.pm2_env || {}).status;
if (status !== 'online') {
    console.error(`FAIL: PM2 process perpedge-bot is ${status}`);
    process.exit(1);
}
console.log('PASS: perpedge-bot is online');
NODE

pm2 list
echo "Smoke tests completed successfully"
