# update-keys.ps1 — Met à jour les clés Binance sur le VPS et redémarre le bot
# Usage : double-clic ou PowerShell .\scripts\update-keys.ps1

$VPS_HOST = "83.228.242.106"
$VPS_USER = "ubuntu"
$VPS_PATH = "/home/ubuntu/perpedge-bot"
$SSH_KEY  = "$env:USERPROFILE\.ssh\id_ed25519"

Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "   PerpEdge — Mise à jour des clés Binance" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── 1. Choix environnement ────────────────────────────────────────────────────
Write-Host "Environnement :" -ForegroundColor Yellow
Write-Host "  [1] Mainnet (production)"
Write-Host "  [2] Testnet"
Write-Host ""
do {
    $envChoice = Read-Host "Choix (1 ou 2)"
} while ($envChoice -notin @("1","2"))

if ($envChoice -eq "1") {
    $isTestnet     = "false"
    $keyLabel      = "MAINNET"
    $envLabel      = "PRODUCTION"
} else {
    $isTestnet     = "true"
    $keyLabel      = "TESTNET"
    $envLabel      = "TESTNET"
}

Write-Host ""
Write-Host "── Clés $keyLabel ──────────────────────────────" -ForegroundColor Yellow

# ── 2. Saisie des clés ───────────────────────────────────────────────────────
$apiKey    = Read-Host "API Key    "
$apiSecret = Read-Host "API Secret "

if ([string]::IsNullOrWhiteSpace($apiKey) -or [string]::IsNullOrWhiteSpace($apiSecret)) {
    Write-Host ""
    Write-Host "❌ Clés vides — annulé." -ForegroundColor Red
    Read-Host "Appuie sur Entrée pour quitter"
    exit 1
}

Write-Host ""
Write-Host "── Récapitulatif ───────────────────────────────" -ForegroundColor Yellow
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

# ── 3. Mise à jour VPS ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "Connexion au VPS..." -ForegroundColor Cyan

if ($envChoice -eq "1") {
    $sshCmd = @"
cd $VPS_PATH
sed -i '/^BINANCE_TESTNET=/d' .env
sed -i '/^BINANCE_API_KEY=/d' .env
sed -i '/^BINANCE_API_SECRET=/d' .env
echo 'BINANCE_TESTNET=false' >> .env
echo 'BINANCE_API_KEY=$apiKey' >> .env
echo 'BINANCE_API_SECRET=$apiSecret' >> .env
echo 'OK_ENV'
"@
} else {
    $sshCmd = @"
cd $VPS_PATH
sed -i '/^BINANCE_TESTNET=/d' .env
sed -i '/^BINANCE_TESTNET_API_KEY=/d' .env
sed -i '/^BINANCE_TESTNET_API_SECRET=/d' .env
echo 'BINANCE_TESTNET=true' >> .env
echo 'BINANCE_TESTNET_API_KEY=$apiKey' >> .env
echo 'BINANCE_TESTNET_API_SECRET=$apiSecret' >> .env
echo 'OK_ENV'
"@
}

$result = ssh -i $SSH_KEY -o StrictHostKeyChecking=no "$VPS_USER@$VPS_HOST" $sshCmd 2>&1
if ($result -notcontains "OK_ENV") {
    Write-Host ""
    Write-Host "❌ Erreur lors de la mise à jour du .env :" -ForegroundColor Red
    Write-Host $result
    Read-Host "Appuie sur Entrée pour quitter"
    exit 1
}
Write-Host "✅ .env mis à jour ($envLabel)" -ForegroundColor Green

# ── 4. Redémarrage PM2 ───────────────────────────────────────────────────────
Write-Host "Redémarrage du bot..." -ForegroundColor Cyan
$pm2Result = ssh -i $SSH_KEY -o StrictHostKeyChecking=no "$VPS_USER@$VPS_HOST" "pm2 restart perpedge-bot --update-env 2>&1 | tail -3" 2>&1
Write-Host $pm2Result

# ── 5. Vérification démarrage ────────────────────────────────────────────────
Start-Sleep -Seconds 5
Write-Host ""
Write-Host "Vérification des logs..." -ForegroundColor Cyan
$logs = ssh -i $SSH_KEY -o StrictHostKeyChecking=no "$VPS_USER@$VPS_HOST" "pm2 logs perpedge-bot --lines 10 --nostream 2>&1 | grep -E '(userDataStream|bootReconcile terminé|Démarré|error|crash)'" 2>&1
Write-Host $logs

Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor Green
Write-Host "   ✅ Bot redémarré en $envLabel" -ForegroundColor Green
Write-Host "══════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Read-Host "Appuie sur Entrée pour quitter"
