#!/usr/bin/env bash
# One-time VPS setup: PM2 startup hook (P9B.3) + logrotate (P9B.4)
# Run as user ubuntu, NOT as root. Node.js doit être installé globalement (pas NVM).
set -euo pipefail

PROJECT_DIR="$HOME/perpedge-bot"

# ── P9B.3 — PM2 startup hook ──────────────────────────────────────────────────
echo "[P9B.3] Configuration du hook PM2 au démarrage..."
cd "$PROJECT_DIR"

# Démarrer le bot s'il ne tourne pas déjà
if ! pm2 describe perpedge-bot >/dev/null 2>&1; then
  pm2 start ecosystem.config.cjs --only perpedge-bot
fi
pm2 status

# Générer la commande sudo (PM2 auto-détecte systemd, user, home en v5)
echo ""
echo "============================================================"
echo "  PM2 va afficher une commande sudo ci-dessous."
echo "  Copiez-collez-la EXACTEMENT dans ce terminal, puis appuyez Entrée."
echo "============================================================"
echo ""
pm2 startup
echo ""
echo "Appuyez sur Entrée une fois la commande sudo exécutée..."
read -r

# Sauvegarder la liste des processus
pm2 save

# Vérification sans tuer PM2
echo ""
echo "[P9B.3] Vérification du hook systemd..."
sudo systemctl is-enabled pm2-ubuntu
sudo systemctl status pm2-ubuntu --no-pager

echo ""
echo "[P9B.3] ✅ Startup hook configuré. Test complet (optionnel, cause coupure ~5s) :"
echo "   sudo systemctl stop pm2-ubuntu && sudo systemctl start pm2-ubuntu && pm2 status"

# ── P9B.4 — pm2-logrotate ─────────────────────────────────────────────────────
echo ""
echo "[P9B.4] Installation et configuration de pm2-logrotate..."
pm2 install pm2-logrotate

pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:workerInterval 30

# Redémarrer le module pour appliquer les paramètres
pm2 restart pm2-logrotate
pm2 save

# Vérification
echo ""
echo "[P9B.4] Configuration logrotate active :"
pm2 conf pm2-logrotate

# Test de rotation manuelle
pm2 trigger pm2-logrotate rotate
sleep 2
ls -lh ~/.pm2/logs/

echo ""
echo "[P9B.4] ✅ Logrotate configuré (10M/fichier, 30 fichiers, rotation minuit)."
echo ""
echo "  IMPORTANT — Lecture des logs archivés (.gz) :"
echo "    zcat ~/.pm2/logs/perpedge-bot-out__*.gz | tail -100"
echo "    zgrep 'ERROR' ~/.pm2/logs/perpedge-bot-error__*.gz"
echo ""
echo "Setup VPS complet."
