#!/usr/bin/env bash
# deploy.sh — PerpEdge P9 deploy script
set -Eeuo pipefail

VPS_HOST="${VPS_HOST:-83.228.242.106}"
VPS_USER="${VPS_USER:-ubuntu}"
VPS="${VPS_USER}@${VPS_HOST}"
LOCAL_DIST="${LOCAL_DIST:-./mini-app/dist}"
LOCAL_CADDYFILE="${LOCAL_CADDYFILE:-./Caddyfile}"
LOCAL_ECOSYSTEM="${LOCAL_ECOSYSTEM:-./ecosystem.config.cjs}"
REMOTE_MINIAPP_DIR="${REMOTE_MINIAPP_DIR:-/home/ubuntu/perpedge-miniapp}"
REMOTE_RELEASES_DIR="${REMOTE_RELEASES_DIR:-${REMOTE_MINIAPP_DIR}/releases}"
REMOTE_DIST_DIR="${REMOTE_DIST_DIR:-${REMOTE_MINIAPP_DIR}/dist}"
REMOTE_BOT_DIR="${REMOTE_BOT_DIR:-/home/ubuntu/perpedge-bot}"
REMOTE_ECOSYSTEM="${REMOTE_ECOSYSTEM:-${REMOTE_BOT_DIR}/ecosystem.config.cjs}"
REMOTE_CADDYFILE="${REMOTE_CADDYFILE:-/etc/caddy/Caddyfile}"

RELEASE_ID="$(date +%Y%m%d%H%M%S)"
REMOTE_RELEASE_DIR="${REMOTE_RELEASES_DIR}/${RELEASE_ID}"

require_file() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        echo "Missing required file: $file" >&2
        exit 1
    fi
}

require_dir() {
    local dir="$1"
    if [[ ! -d "$dir" ]]; then
        echo "Missing required directory: $dir" >&2
        exit 1
    fi
}

require_dir "$LOCAL_DIST"
require_file "$LOCAL_CADDYFILE"
require_file "$LOCAL_ECOSYSTEM"

echo "[deploy] Creating release dir ${RELEASE_ID} on VPS..."
ssh "$VPS" "mkdir -p '$REMOTE_RELEASE_DIR' '$REMOTE_BOT_DIR/logs'"

echo "[deploy] Syncing dist..."
rsync -az --delete "${LOCAL_DIST}/" "${VPS}:${REMOTE_RELEASE_DIR}/"

echo "[deploy] Uploading ecosystem + Caddyfile..."
scp "$LOCAL_ECOSYSTEM" "${VPS}:/tmp/ecosystem.config.cjs"
scp "$LOCAL_CADDYFILE" "${VPS}:/tmp/Caddyfile"

echo "[deploy] Applying on VPS..."
ssh "$VPS" bash -s <<EOF
set -Eeuo pipefail
sudo mkdir -p /etc/caddy
sudo cp /tmp/Caddyfile "$REMOTE_CADDYFILE"
cp /tmp/ecosystem.config.cjs "$REMOTE_ECOSYSTEM"

# symlink AVANT pm2/caddy — ln -sfT evite de creer le lien a l'interieur du dossier existant
ln -sfT "$REMOTE_RELEASE_DIR" "$REMOTE_DIST_DIR"

cd "$REMOTE_BOT_DIR"
pm2 startOrReload "$REMOTE_ECOSYSTEM" --env production --update-env
pm2 save

sudo caddy validate --config "$REMOTE_CADDYFILE"
sudo systemctl reload caddy

find "$REMOTE_RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +6 | xargs -r rm -rf
EOF

echo "[deploy] Deploy completed: ${RELEASE_ID}"
