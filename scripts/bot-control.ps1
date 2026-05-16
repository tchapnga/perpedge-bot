# bot-control.ps1 — Contrôle du bot PerpEdge sur le VPS
# Usage : double-clic sur bot-control.bat, ou : pwsh .\scripts\bot-control.ps1

# ── Encodage UTF-8 (affichage correct des accents) ──────────────────────────
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding            = [System.Text.Encoding]::UTF8

# ── Garde la fenêtre ouverte si une erreur non gérée se produit ──────────────
trap {
    Write-Host ""
    Write-Host "ERREUR INATTENDUE : $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    Write-Host ""
    Read-Host "Appuie sur Entrée pour fermer"
    exit 1
}

$VPS_HOST = "83.228.242.106"
$VPS_USER = "ubuntu"
$VPS_PATH = "/home/ubuntu/perpedge-bot"
$SSH_KEY  = Join-Path $env:USERPROFILE ".ssh\id_ed25519"

function SSH-Run([string]$cmd) {
    # Quoting explicite de $SSH_KEY pour gérer les espaces dans le chemin Windows
    & ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o BatchMode=yes "${VPS_USER}@${VPS_HOST}" $cmd 2>&1
}

function SSH-OK([object[]]$result) {
    # Vérifie si la sortie SSH contient "OK_ENV" — robuste même avec \r\n
    return ($result | ForEach-Object { "$_" } | Where-Object { $_ -match "OK_ENV" }).Count -gt 0
}

function Show-Header([string]$title) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "   PerpEdge — $title" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
}

function Show-Footer([string]$msg) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host "   OK : $msg" -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host ""
}

# ── Menu principal ─────────────────────────────────────────────────────────────
Show-Header "Contrôle du Bot"
Write-Host "Que voulez-vous faire ?" -ForegroundColor Yellow
Write-Host ""
Write-Host "  [1] Changer les clés API (testnet ou mainnet)"
Write-Host "  [2] Basculer le bot en TESTNET"
Write-Host "  [3] Basculer le bot en MAINNET"
Write-Host "  [4] Statut du bot (PM2)"
Write-Host ""
do {
    $choice = Read-Host "Choix (1-4)"
} while ($choice -notin @("1","2","3","4"))

# ── Option 4 : Statut ──────────────────────────────────────────────────────────
if ($choice -eq "4") {
    Show-Header "Statut PM2"
    Write-Host "Connexion au VPS..." -ForegroundColor Cyan
    $status = SSH-Run "pm2 show perpedge-bot 2>&1 | head -30"
    Write-Host ($status -join "`n")
    Write-Host ""
    Read-Host "Appuie sur Entrée pour quitter"
    exit 0
}

# ── Option 2/3 : Bascule d'environnement ──────────────────────────────────────
if ($choice -eq "2" -or $choice -eq "3") {
    if ($choice -eq "2") { $targetEnv = "TESTNET"; $testnetVal = "true" }
    else                 { $targetEnv = "MAINNET"; $testnetVal = "false" }

    Show-Header "Bascule vers $targetEnv"
    Write-Host "ATTENTION : Cette opération va :" -ForegroundColor Yellow
    Write-Host "   1. Mettre BINANCE_TESTNET=$testnetVal dans le .env"
    Write-Host "   2. Recharger le bot via PM2 (pm2 reload)"
    Write-Host ""
    Write-Host "Note : aucune vérification de positions n'est faite ici (admin override)."
    Write-Host "       Pour une bascule sécurisée, utilisez le cockpit Telegram."
    Write-Host ""
    $confirm = Read-Host "Confirmer la bascule vers $targetEnv ? (oui/non)"
    if ($confirm -notmatch "^(oui|o|yes|y)$") {
        Write-Host "Annulé." -ForegroundColor Yellow
        Read-Host "Appuie sur Entrée pour quitter"
        exit 0
    }

    Write-Host ""
    Write-Host "Connexion au VPS..." -ForegroundColor Cyan

    $cmd  = "cd $VPS_PATH; "
    $cmd += "sed -i '/^BINANCE_TESTNET=/d' .env; "
    $cmd += "echo 'BINANCE_TESTNET=$testnetVal' >> .env; "
    $cmd += "echo 'OK_ENV'"

    $result = SSH-Run $cmd
    if (-not (SSH-OK $result)) {
        Write-Host ""
        Write-Host "ERREUR lors de la mise à jour du .env :" -ForegroundColor Red
        Write-Host ($result -join "`n")
        Read-Host "Appuie sur Entrée pour quitter"
        exit 1
    }
    Write-Host "OK .env mis à jour (BINANCE_TESTNET=$testnetVal)" -ForegroundColor Green

    Write-Host "Rechargement du bot..." -ForegroundColor Cyan
    $pm2Out = SSH-Run "pm2 reload perpedge-bot --update-env 2>&1 | tail -3"
    Write-Host ($pm2Out -join "`n")

    Start-Sleep -Seconds 5
    Write-Host ""
    Write-Host "Vérification des logs..." -ForegroundColor Cyan
    $logs = SSH-Run "pm2 logs perpedge-bot --lines 10 --nostream 2>&1 | grep -iE '(TESTNET|MAINNET|Started|Demarre|error|crash)'"
    Write-Host ($logs -join "`n")

    Show-Footer "Bot rechargé en $targetEnv"
    Read-Host "Appuie sur Entrée pour quitter"
    exit 0
}

# ── Option 1 : Changement de clés ─────────────────────────────────────────────
Show-Header "Mise à jour des clés Binance"
Write-Host "Environnement :" -ForegroundColor Yellow
Write-Host "  [1] Mainnet (production)"
Write-Host "  [2] Testnet"
Write-Host ""
do {
    $envChoice = Read-Host "Choix (1 ou 2)"
} while ($envChoice -notin @("1","2"))

if ($envChoice -eq "1") {
    $isTestnet = "false"
    $keyLabel  = "MAINNET"
    $envLabel  = "PRODUCTION"
} else {
    $isTestnet = "true"
    $keyLabel  = "TESTNET"
    $envLabel  = "TESTNET"
}

Write-Host ""
Write-Host "-- Clés $keyLabel --" -ForegroundColor Yellow
Write-Host "(La saisie est visible — ne pas laisser l'écran sans surveillance)" -ForegroundColor DarkGray

$apiKey    = Read-Host "API Key    "
$apiSecret = Read-Host "API Secret "

if ([string]::IsNullOrWhiteSpace($apiKey) -or [string]::IsNullOrWhiteSpace($apiSecret)) {
    Write-Host ""
    Write-Host "ERREUR : Clés vides — annulé." -ForegroundColor Red
    Read-Host "Appuie sur Entrée pour quitter"
    exit 1
}

Write-Host ""
Write-Host "-- Récapitulatif --" -ForegroundColor Yellow
Write-Host "  Environnement : $envLabel"
Write-Host "  API Key       : $($apiKey.Substring(0, [Math]::Min(8, $apiKey.Length)))***"
Write-Host "  API Secret    : $($apiSecret.Substring(0, [Math]::Min(8, $apiSecret.Length)))***"
Write-Host ""
$confirm = Read-Host "Confirmer la mise à jour ? (oui/non)"
if ($confirm -notmatch "^(oui|o|yes|y)$") {
    Write-Host "Annulé." -ForegroundColor Yellow
    Read-Host "Appuie sur Entrée pour quitter"
    exit 0
}

Write-Host ""
Write-Host "Connexion au VPS..." -ForegroundColor Cyan

if ($envChoice -eq "1") {
    $cmd  = "cd $VPS_PATH; "
    $cmd += "sed -i '/^BINANCE_TESTNET=/d' .env; "
    $cmd += "sed -i '/^BINANCE_API_KEY=/d' .env; "
    $cmd += "sed -i '/^BINANCE_API_SECRET=/d' .env; "
    $cmd += "echo 'BINANCE_TESTNET=false' >> .env; "
    $cmd += "echo 'BINANCE_API_KEY=$apiKey' >> .env; "
    $cmd += "echo 'BINANCE_API_SECRET=$apiSecret' >> .env; "
    $cmd += "echo 'OK_ENV'"
} else {
    $cmd  = "cd $VPS_PATH; "
    $cmd += "sed -i '/^BINANCE_TESTNET=/d' .env; "
    $cmd += "sed -i '/^BINANCE_TESTNET_API_KEY=/d' .env; "
    $cmd += "sed -i '/^BINANCE_TESTNET_API_SECRET=/d' .env; "
    $cmd += "echo 'BINANCE_TESTNET=true' >> .env; "
    $cmd += "echo 'BINANCE_TESTNET_API_KEY=$apiKey' >> .env; "
    $cmd += "echo 'BINANCE_TESTNET_API_SECRET=$apiSecret' >> .env; "
    $cmd += "echo 'OK_ENV'"
}

$result = SSH-Run $cmd
if (-not (SSH-OK $result)) {
    Write-Host ""
    Write-Host "ERREUR lors de la mise à jour du .env :" -ForegroundColor Red
    Write-Host ($result -join "`n")
    Read-Host "Appuie sur Entrée pour quitter"
    exit 1
}
Write-Host "OK .env mis à jour ($envLabel)" -ForegroundColor Green

Write-Host "Rechargement du bot..." -ForegroundColor Cyan
$pm2Out = SSH-Run "pm2 reload perpedge-bot --update-env 2>&1 | tail -3"
Write-Host ($pm2Out -join "`n")

Start-Sleep -Seconds 5
Write-Host ""
Write-Host "Vérification des logs..." -ForegroundColor Cyan
$logs = SSH-Run "pm2 logs perpedge-bot --lines 10 --nostream 2>&1 | grep -iE '(TESTNET|MAINNET|Started|Demarre|error|crash)'"
Write-Host ($logs -join "`n")

Show-Footer "Bot rechargé en $envLabel"
Read-Host "Appuie sur Entrée pour quitter"
