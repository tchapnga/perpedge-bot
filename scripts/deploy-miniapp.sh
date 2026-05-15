#!/usr/bin/env bash
# Deploy mini-app to VPS — rebuilds React SPA + reloads bot
# Caddy sert les fichiers via bind-mount Docker → pas de restart Caddy nécessaire
set -euo pipefail

APP_URL="https://perpedge-app.83-228-242-106.nip.io"
PROJECT_DIR="$HOME/perpedge-bot"
MINI_APP_DIR="$PROJECT_DIR/mini-app"
ENV_FILE="$PROJECT_DIR/.env"

echo "[1/4] Building mini-app..."
cd "$MINI_APP_DIR"
printf 'VITE_API_BASE=\n' > .env.production
npm ci --include=dev
npm run build

echo "[2/4] Updating MINI_APP_URL in .env..."
if grep -q '^MINI_APP_URL=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^MINI_APP_URL=.*|MINI_APP_URL=$APP_URL|" "$ENV_FILE"
else
  printf '\nMINI_APP_URL=%s\n' "$APP_URL" >> "$ENV_FILE"
fi

echo "[3/4] Reloading bot..."
cd "$PROJECT_DIR"
pm2 reload ecosystem.config.cjs --only perpedge-bot --update-env

echo "[4/4] Health check..."
sleep 3
HEALTH=$(curl -s http://localhost:3002/admin/health || echo '{"ok":false}')
if echo "$HEALTH" | grep -q '"ok":true'; then
  echo "Deploy complete. WebApp: $APP_URL"
else
  echo "WARNING: health check: $HEALTH"
fi
