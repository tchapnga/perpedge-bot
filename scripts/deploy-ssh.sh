#!/usr/bin/env bash
# P9-H — Déploiement SSH unifié depuis le poste local
# Usage : bash scripts/deploy-ssh.sh [--skip-miniapp]
# Prérequis : SSH key configurée, VPS_HOST défini ou en .deploy.env
set -euo pipefail

# ── Config (override via .deploy.env ou variables d'env) ─────────────────────
VPS_HOST="${VPS_HOST:-83.228.242.106}"
VPS_USER="${VPS_USER:-ubuntu}"
VPS_PATH="${VPS_PATH:-/home/ubuntu/perpedge-bot}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SKIP_MINIAPP="${1:-}"

# Charger .deploy.env si présent
[ -f "$(dirname "$0")/../.deploy.env" ] && source "$(dirname "$0")/../.deploy.env"

SSH=( ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$VPS_USER@$VPS_HOST" )
SCP=( scp -i "$SSH_KEY" -o StrictHostKeyChecking=no )

ok()  { echo -e "\033[32m✅ $*\033[0m"; }
err() { echo -e "\033[31m❌ $*\033[0m"; }
hdr() { echo -e "\n\033[1m── $* ──────────────────────────────────────────\033[0m"; }

fail() { err "$*"; exit 1; }

hdr "PerpEdge Deploy SSH → $VPS_USER@$VPS_HOST:$VPS_PATH"

# ── 1. Prérequis VPS ──────────────────────────────────────────────────────────
hdr "1/6 Prérequis VPS"
NODE_VER=$("${SSH[@]}" "node --version 2>/dev/null || echo 'missing'")
PM2_VER=$("${SSH[@]}" "pm2 --version 2>/dev/null || echo 'missing'")
[[ "$NODE_VER" == "missing" ]] && fail "Node.js absent du VPS."
[[ "$PM2_VER"  == "missing" ]] && fail "PM2 absent du VPS."
ok "Node $NODE_VER · PM2 $PM2_VER"

# ── 2. Backup .env ────────────────────────────────────────────────────────────
hdr "2/6 Backup .env"
"${SSH[@]}" "cp $VPS_PATH/.env $VPS_PATH/.env.backup.\$(date +%Y%m%d%H%M%S) 2>/dev/null && echo ok || echo skipped"
ok ".env sauvegardé"

# ── 3. Git pull ───────────────────────────────────────────────────────────────
hdr "3/6 git pull"
PULL_OUT=$("${SSH[@]}" "cd $VPS_PATH && git pull origin main 2>&1")
echo "$PULL_OUT"
[[ "$PULL_OUT" == *"error"* ]] || [[ "$PULL_OUT" == *"conflict"* ]] && fail "git pull a échoué."
COMMIT=$("${SSH[@]}" "cd $VPS_PATH && git log -1 --format='%h %s'")
ok "Commit : $COMMIT"

# ── 4. npm ci bot ─────────────────────────────────────────────────────────────
hdr "4/6 npm ci (bot)"
"${SSH[@]}" "cd $VPS_PATH && npm ci --omit=dev 2>&1 | tail -3"
ok "Dépendances bot installées"

# ── 5. Build + deploy mini-app ────────────────────────────────────────────────
if [[ "$SKIP_MINIAPP" != "--skip-miniapp" ]]; then
  hdr "5/6 Build mini-app"
  # Build local si mini-app/ existe
  if [ -d "mini-app" ]; then
    cd mini-app && npm ci --silent && npm run build --silent && cd ..
    ok "Build mini-app local OK (mini-app/dist/)"
    # Copier le dist vers VPS
    "${SCP[@]}" -r mini-app/dist/* "$VPS_USER@$VPS_HOST:$VPS_PATH/mini-app/dist/"
    ok "mini-app/dist/ copié sur VPS"
  else
    echo "  (mini-app/ absent en local — skip build)"
  fi
else
  echo "  (--skip-miniapp : build sauté)"
fi

# ── 6. Reload PM2 ─────────────────────────────────────────────────────────────
hdr "6/6 Reload PM2"
"${SSH[@]}" "pm2 reload perpedge-bot --update-env 2>&1 | grep -E '(✓|✗|error)' || true"
"${SSH[@]}" "pm2 save 2>&1 | tail -1"
ok "perpedge-bot rechargé"

# ── Health checks ─────────────────────────────────────────────────────────────
hdr "Health checks"
sleep 4

BOT_HEALTH=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/admin/health --max-time 5 2>/dev/null || echo '000'")
if [[ "$BOT_HEALTH" == "200" ]] || [[ "$BOT_HEALTH" == "401" ]]; then
  ok "Bot admin API → HTTP $BOT_HEALTH (port 3002)"
else
  err "Bot admin API → HTTP $BOT_HEALTH — vérifier pm2 logs perpedge-bot"
fi

MCP_HEALTH=$("${SSH[@]}" "curl -sk -o /dev/null -w '%{http_code}' https://83-228-242-106.nip.io/health --max-time 5 2>/dev/null || echo '000'")
if [[ "$MCP_HEALTH" == "200" ]]; then
  ok "perp-mcp-server → HTTP $MCP_HEALTH"
else
  err "perp-mcp-server → HTTP $MCP_HEALTH"
fi

# ── Rapport final ─────────────────────────────────────────────────────────────
echo ""
echo -e "\033[1m\033[32m🎉 Déploiement terminé — $COMMIT\033[0m"
"${SSH[@]}" "pm2 list --no-color 2>&1 | grep -E '(perpedge|pm2-logrotate|name)'"
