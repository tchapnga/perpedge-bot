#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cp .env .env.backup 2>/dev/null || true

git pull origin main
npm ci --omit=dev
pm2 reload ecosystem.config.cjs --only perpedge-bot --update-env

sleep 5

HEALTH=$(curl -s http://localhost:3002/admin/health || echo '{"ok":false}')

if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "Deployment successful: health check passed."
  exit 0
else
  echo "Deployment failed: health check did not return ok:true."
  echo "Health response: $HEALTH"
  exit 1
fi
