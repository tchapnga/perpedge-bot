# PerpEdge — TODO Backlog Autonome
> Mis à jour automatiquement par Claude à chaque étape.
> Protocole : Gemini+ChatGPT codent · DeepSeek+Claude reviewent · Décisions par consensus 4 LLMs · Zéro mock · Tout testé.

---

## LÉGENDE
- `[ ]` À faire
- `[→]` En cours
- `[✓]` Terminé & testé
- `[✗]` Bloqué / Rejeté
- `[?]` En attente de consensus LLMs

---

## ✅ REVUE MULTI-LLM COMPLÈTE — Session 2026-05-18

> Tous les fichiers en attente de revue ont été traités. Aucune revue en suspens.
>
> **Fichiers traités cette session (2026-05-18) :**
> - `src/telegram-bot.js` — fix 409 Conflict : `_isPollingActive` avant `await bot.start()`, stop silencieux — **consensus 3/3 LLMs, déployé VPS, validé logs** ✅
> - `src/order-executor.js` + `src/position-manager.js` — guard no-double-position : `checkExistingPosition()` + `_symbolLocks` — **consensus 3/3 LLMs, déployé VPS** ✅
>
> **Revue précédente (2026-05-18 début de session) :**
> - `src/injector.js`, `src/scanner.js`, `src/crash-notifier.js`, `index.js`, `src/llm-validator.js`, `src/manual-trade.js` — **consensus 3/3, tous corrigés** ✅

---

## CONFIGURATION ENVIRONNEMENTS

| Env | Bot Telegram | Username | Token | Chat ID |
|-----|-------------|----------|-------|---------|
| **Production (VPS)** | Bot principal | `@bouketbot` | dans `.env` VPS | dans `.env` VPS |
| **Local (dev)** | Bot de test | `@RodrigueperpBot` | dans `.env` local | `8003973127` |

> Règle : ne jamais utiliser le même token sur local et VPS → conflit 409 Telegram (une seule instance polling autorisée par token).

---

## P0 — Patches scorer.js + injector.js
> Priorité absolue. 4 gates déterministes manquantes identifiées en sim #4 (-$129).

| ID | Tâche | Fichier | Statut | Assigné à | Testé |
|---|---|---|---|---|---|
| P0.1 | Gate #7 : block si prix Bybit écart > 1.5% vs Binance | scorer.js | `[✓]` | Gemini + ChatGPT | [✓] |
| P0.2 | Gate #8 : block si MSB < 120 min ET contre signal | scorer.js | `[✓]` | Gemini + ChatGPT | [✓] |
| P0.3 | Gate #9 : re-check taker < 60s avant injection | injector.js | `[✓]` | Gemini + ChatGPT | [✓] |
| P0.4 | Contrarian flag : funding extrême contre TA → flag sans bloquer | scorer.js | `[✓]` | ChatGPT (Gemini rejeté: bugs scope) | [✓] |

---

## P0-ter — Améliorations Scorer / Executor (session 2026-05-16)
> Protocole multi-LLM appliqué (ChatGPT + DeepSeek + Gemini consultés avant chaque impl).

| ID | Tâche | Fichier | Statut |
|---|---|---|---|
| P0t.1 | LIMIT GTC orders avec cancel auto 3min + bookTicker price + polling fill | order-executor.js | `[✓]` testnet PASS |
| P0t.2 | Dynamic position sizing : RISK_PCT% × availableBalance (fallback v3→v2 balance) + BELOW_MIN_NOTIONAL gate | order-executor.js | `[✓]` testnet PASS |
| P0t.3 | LEVERAGE env var (défaut 20, modifiable) | order-executor.js / .env | `[✓]` |
| P0t.4 | Gate 7 — Funding VETO extrême : LONG+funding>0.15% ou SHORT+funding<-0.15% → hard block | scorer.js | `[✓]` ChatGPT+DeepSeek+Gemini consensus |
| P0t.5 | P1.2 — PENDING state : redondant avec cron 15min — supprimé | — | `[✗]` |
| P0t.6 | P1.3 — Filtre R:R minimum TP1 ≥ 1.5 : bloque notification + ordre (avant sendTelegram). computeLevels() cachée dans result._levels | index.js | `[✓]` ChatGPT+DeepSeek+Gemini consensus |
| P0t.7 | P2 — Enrichir message Telegram : R:R + SL dist% + TP2 (taille USD/slippage/equity omis — balance inconnue à notif time) + R:R dans caption photo | notifier.js / index.js | `[✓]` ChatGPT+DeepSeek+Gemini consensus |
| P0t.8 | P-NOTIFY — Lifecycle trade notifications : TP1 hit, SL/BREAKEVEN/TRAIL, early exit (+ panic). fmt() exporté de notifier.js. gainPct % affiché. fail-open + console.error | position-manager.js / notifier.js | `[✓]` ChatGPT+DeepSeek+Gemini consensus |

---

## P0-quad — Revue exhaustive des 14 types de signaux Telegram
> Priorité actuelle (2026-05-17). Examiner et améliorer chaque type de signal avant de passer à P-ROBUSTNESS et P9.
> Protocole : multi-LLM obligatoire avant chaque impl. Ordre fixé par l'utilisateur.

| ID | Signal | Fichier | Statut |
|---|---|---|---|
| P0q.1 | buildCombinedMessage — signal principal cycle 15min | notifier.js / index.js | `[✓]` P0t.7 |
| P0q.2 | Chart photo + caption (R:R) | index.js / chart-capture.js | `[✓]` P0t.7 |
| P0q.3 | ⚡ OI EXPLOSION + buildMessage | oi-watcher.js | `[✓]` buildCombinedMessage + R:R TRADE/WATCH/IGNORE + classifyOiMove + chart async R:R≥2 |
| P0q.4 | 🔻 CROWDED UNWIND + score + TP/SL | crowded-unwind-watcher.js / notifier.js | `[✓]` R:R TRADE/WATCH/IGNORE + buildCrowdedUnwindMessage header + buildCombinedMessage + chart async R:R≥2. LLM SKIP (Gemini tiebreak) |
| P0q.5 | 🚀 SHORT/LONG SQUEEZE + funding + OI + CVD + liquidations | squeeze-watcher.js / notifier.js | `[✓]` Signal informatif pur — ajout footer ⚠️. No runAnalysis, no LLM, no chart, no auto-trade (consensus 3 LLMs) |
| P0q.6 | Header capitulation + buildCombinedMessage | capitulation-watcher.js | `[✓]` Pattern P0q.4 appliqué : R:R TRADE/WATCH/IGNORE + computeLevels + chart async R:R≥2. LLM SKIP. Gemini : "100% compatible" |
| P0q.7 | 💎 SMART MONEY + score/5 + détail | smart-money-scanner.js | `[✓]` Signal spot DCA — pas de R:R perp (no runAnalysis). Séparateur + footer ⚠️ + fix catch silencieux |
| P0q.8 | Message DCA spot confirmé — tranches + prix moyen | spot-dca-manager.js | `[✓]` Incompatible R:R perp (Gemini). buildDCAMessage OK. Fix catch silencieux → console.error |
| P0q.9 | ⚠️ CRASH + stack trace (PM2 restart) | crash-notifier.js | `[✓]` P9B.5 |
| P0q.10 | Alerte LLM fallback (Chrome verrouillé / < 2 LLMs) | llm-validator.js | `[✓]` Déjà implémenté : sendTelegramFallbackAlert() appelé sur 2 cas. Fix AbortSignal.timeout(8000) ajouté |
| P0q.11 | 📊 Rapport quotidien 08:00 UTC | daily-reporter.js | `[✓]` Déjà complet (trades, winrate, PnL net, best/worst) |
| P0q.12 | Rapport hebdo feedback + recommandations (dimanche 08:00 UTC) | feedback-analyzer.js | `[✓]` Déjà complet (PnL, espérance, exits, top scans, score moyen) |
| P0q.13 | /stats — win rate, PnL, nb trades | feedback-applier.js | `[✓]` Déjà complet. Fix catch silencieux → console.error |
| P0q.14 | /apply_N — confirmation recommandation appliquée | feedback-applier.js | `[✓]` Déjà complet. Fix catch silencieux → console.error |
| P0q.15 | Lifecycle scalp (TP/SL scalp-manager.js) | scalp-manager.js | `[✓]` TP/SL/T+10 notifications ajoutées. PnL estimé (markPrice au moment du hit). fail-open |

---

## P0-bis — Prompt Engineering LLM
> Session dédiée. Critique pour P1.

| ID | Tâche | Statut |
|---|---|---|
| P0b.1 | Concevoir system prompt LLM (structure + cas spéciaux) | `[✓]` |
| P0b.2 | Définir format JSON response du LLM | `[✓]` |
| P0b.3 | Cas spéciaux : contrarian / NO_TRADE / PENDING_LIMIT | `[✓]` |

---

## P1 — LLM Validator (src/llm-validator.js)
> RÈGLE FONDAMENTALE : aucun signal sans validation LLM.

| ID | Tâche | Statut |
|---|---|---|
| P1.1 | Mode VPS : intégration Claude API (claude-sonnet-4-6) | `[✓]` |
| P1.2 | Mode local : DeepSeek + ChatGPT + Gemini → Claude juge consensus | `[✓]` 3/3 LLMs PASS (BTCUSDT APPROVE + ETHUSDT REJECT) |
| P1.3 | Intégration dans index.js (entre scorer et notifier) | `[✓]` |
| P1.4 | Tests sur signaux réels | `[✓]` |

---

## P1-bis — Order Executor (src/order-executor.js)
> Ordres réels Binance Futures.

| ID | Tâche | Statut |
|---|---|---|
| P1b.1 | Passage d'ordres market/limit Binance Futures | `[✓]` |
| P1b.2 | Levier x20 par défaut | `[✓]` |
| P1b.3 | Dry-run testnet obligatoire avant prod | `[✓]` |
| P1b.4 | Tests sur Binance Testnet | `[✓]` |

---

## P2 — Position Manager (src/position-manager.js)

| ID | Tâche | Statut |
|---|---|---|
| P2.1 | SL/TP dynamique (polling 60s) | `[✓]` |
| P2.2 | TP1 → Breakeven automatique | `[✓]` |
| P2.3 | Trailing stop | `[✓]` |

- [✓] P2 Position Manager — src/position-manager.js créé (ChatGPT code, Gemini rejeté bugs: string roundToTick + pas workingType MARK_PRICE). computeLevels exporté depuis injector.js. executeOrder + registerTrade intégrés dans index.js. startPositionManager démarré à t+9s.

---

## P2-bis — Dashboard (src/dashboard.js)

| ID | Tâche | Statut |
|---|---|---|
| P2b.1 | Interface Telegram élégante | `[✓]` |
| P2b.2 | Endpoint HTTP dashboard | `[✓]` |

## P2-ter — Capitulation Watcher (src/capitulation-watcher.js)

| ID | Tâche | Statut |
|---|---|---|
| P2t.1 | Endpoint /api/scan/capitulation (perp-mcp-server) | `[✓]` |
| P2t.2 | Watcher : WATCH 4h + TRIGGER 5min | `[✓]` |
| P2t.3 | Redéployer perp-mcp-server sur VPS — endpoint /api/scan/capitulation retourne 404 en prod | `[✓]` docker compose build --no-cache + up — 2026-05-16 |

---

## P3 — Formats signaux Telegram

| ID | Tâche | Statut |
|---|---|---|
| P3.1 | buildCombinedMessage amélioré | `[✓]` |
| P3.2 | Format squeeze | `[✓]` |
| P3.3 | Format crowded unwind | `[✓]` |

---

## P4 — Chart TradingView (optionnel)

| ID | Tâche | Statut |
|---|---|---|
| P4.1 | Chart TradingView snapshot dans le message Telegram (P1 actif = prérequis rempli) | `[✓]` chart-capture.js + sendTelegramPhoto OK |

---

## P5 — Module Scalp

| ID | Tâche | Statut |
|---|---|---|
| P5.1 | Endpoint /api/ta-scalp (1M/5M) dans perp-mcp-server | `[✓]` |
| P5.2 | src/scalp-scanner.js (cycle 30s) | `[✓]` |
| P5.3 | src/scalp-scorer.js (taker-first) | `[✓]` |
| P5.4 | src/scalp-manager.js (polling 15s, T+10 forcé) | `[✓]` |

---

## P6 — Feedback Loop Automatisée

| ID | Tâche | Statut |
|---|---|---|
| P6.1 | trade_journal.jsonl — log exhaustif par trade | `[✓]` |
| P6.2 | src/trade-journal.js — écriture auto au close | `[✓]` |
| P6.3 | src/feedback-analyzer.js — cron dimanche 08:00 UTC | `[✓]` |
| P6.4 | src/feedback-applier.js — /apply_N Telegram | `[✓]` |

---

## P7 — Smart Money Spot DCA

| ID | Tâche | Statut |
|---|---|---|
| P7.1 | src/smart-money-scanner.js (scan 4H) | `[✓]` |
| P7.2 | src/spot-dca-manager.js (tranches) | `[✓]` |
| P7.3 | src/spot-executor.js (API Binance SPOT) | `[✓]` |

---

## P8 — Admin Cockpit Telegram (Mini App)
> Spec par consensus 3 LLMs (ChatGPT + Gemini + DeepSeek) — 2026-05-15.
> Architecture hybride : Bot classique (commandes rapides) + Telegram Mini App (cockpit complet).
> Stack : React + Tailwind + Shadcn/UI · Fastify (API) · grammy (bot) · Redis · WebSocket.

### P8-A — Infrastructure (Prérequis)

| ID | Tâche | Statut |
|---|---|---|
| P8A.1 | `src/admin-api.js` — serveur Fastify sur port 3002, routes `/admin/*` | `[✓]` reviewed DeepSeek+ChatGPT |
| P8A.2 | Middleware auth : userId whitelist + initData HMAC + auth_date + timingSafeEqual | `[✓]` reviewed |
| P8A.3 | Rate limiting in-memory (10 req/min par userId) | `[✓]` reviewed |
| P8A.4 | Audit log : chaque action admin écrite dans `admin_audit.jsonl` | `[✓]` reviewed |
| P8A.5 | `src/bot-state.js` — Singleton état bot (isPaused, mode, cycle, stats + daily reset) | `[✓]` reviewed |

### P8-B — Bot classique (commandes rapides)

| ID | Tâche | Statut |
|---|---|---|
| P8B.1 | `src/telegram-bot.js` — polling grammy, commandes `/status` `/pause` `/resume` | `[✓]` reviewed |
| P8B.2 | `/status` → message HTML : positions ouvertes, PnL, cycle actuel, dernier signal | `[✓]` reviewed |
| P8B.3 | Inline keyboard avec bouton "Ouvrir Cockpit" (web_app) + "Pause/Resume" + "Emergency Stop" | `[✓]` reviewed |
| P8B.4 | Confirmation double pour Emergency Stop + pendingEmergency cleanup auto | `[✓]` reviewed |
| P8B.5 | Alertes push auto : `bot.pushAlert()` prêt, intégration position-manager à faire en P8-E | `[✓]` reviewed |

### P8-C — API interne

| ID | Tâche | Statut |
|---|---|---|
| P8C.1 | `GET /admin/status` — état bot complet (positions, PnL, cycle, health) | `[✓]` implémenté dans P8-A |
| P8C.2 | `GET /admin/positions` — positions trackées + PnL non réalisé | `[✓]` implémenté dans P8-A |
| P8C.3 | `GET /admin/symbols?q=` — autocomplete tokens Binance Futures (fuzzy) | `[✓]` commit df87fce — cache 1h, anti-race, score pertinence, filter TRADING, limit 20 |
| P8C.4 | `POST /admin/analyze` — analyse manuelle d'un token (TA + dérivés + LLM) + timeout 30s | `[✓]` implémenté dans P8-A |
| P8C.5 | `POST /admin/commands` — PAUSE / RESUME / EMERGENCY_STOP / RESET_EMERGENCY | `[✓]` implémenté dans P8-A |
| P8C.6 | `GET /admin/signals` — historique signaux récents (50 derniers) | `[✓]` implémenté dans P8-A |
| P8C.7 | `GET /admin/config` + `PATCH /admin/config` — lire/modifier mode, MIN_SCORE | `[✓]` implémenté dans P8-A |
| P8C.8 | `GET /admin/health` — uptime, mémoire, ts | `[✓]` implémenté dans P8-A |

### P8-D — Telegram Mini App (cockpit)

| ID | Tâche | Statut |
|---|---|---|
| P8D.1 | `miniapp/` — projet React + Vite + Tailwind + Shadcn/UI | `[✓]` |
| P8D.2 | Page Overview : état bot, positions actives, PnL session, boutons Pause/Resume/Reset Emergency | `[✓]` |
| P8D.3 | Autocomplete crypto : composant avec fuzzy search → endpoint `/admin/symbols` | `[✓]` |
| P8D.4 | Formulaire analyse manuelle : résultat complet TA (ta_detail, der_detail, gate/veto) + LLM | `[✓]` |
| P8D.5 | Equity curve PnL 24h/7j/30j — SVG sparkline (aucune dépendance) | `[✓]` |
| P8D.6 | Page Risk cockpit : exposition levier effectif, marge utilisée, drawdown | `[✓]` |
| P8D.7 | Log streamer : onglet logs temps réel (polling incrémental 2 s) | `[✓]` |
| P8D.8 | Dark/light mode automatique (variables CSS Telegram `--tg-theme-*`) | `[✓]` |

### P8-F — Déploiement Mini App Telegram (HTTPS requis)
> Telegram WebApp impose HTTPS strict. `pm2 serve` localhost ne fonctionne pas.
> Le bouton "Ouvrir Cockpit" dans telegram-bot.js ligne 67 attend `process.env.MINI_APP_URL`.

| ID | Tâche | Détail | Statut |
|---|---|---|---|
| P8F.1 | Choisir hébergement HTTPS mini-app | Option A : nginx + Let's Encrypt sur VPS (sous-domaine ex: `app.perpedge.yourdomain.com`) · Option B : Cloudflare Pages / Vercel (gratuit, auto-HTTPS, push git) | `[ ]` |
| P8F.2 | Build mini-app et déployer | `npm run build` → copier `dist/` sur le serveur choisi | `[ ]` |
| P8F.3 | Configurer BotFather | `/setmenubutton` sur le bot → URL HTTPS de la mini-app · OU laisser le bouton inline WebApp (déjà codé) | `[✓]` 2026-05-18 |
| P8F.4 | Mettre `MINI_APP_URL=https://...` dans `.env` VPS | Le bouton "Ouvrir Cockpit" s'active automatiquement dès que la variable est définie | `[✓]` déjà présent |
| P8F.5 | Vérifier CORS sur admin-api.js | L'admin API (:3002) doit accepter les requêtes depuis l'origine HTTPS de la mini-app (`Access-Control-Allow-Origin`) | `[ ]` |
| P8F.6 | Test end-to-end dans Telegram | Ouvrir le cockpit depuis Telegram mobile · Vérifier auth initData · Vérifier chaque onglet avec données réelles | `[ ]` |

#### Options d'hébergement recommandées

| Option | Avantages | Inconvénients |
|---|---|---|
| **Cloudflare Pages** | Gratuit, HTTPS auto, deploy via git push, CDN mondial | Séparé du VPS, 2 deployments à gérer |
| **nginx sur VPS** | Tout en un, sous-domaine dédié, contrôle total | Besoin d'un domaine + Let's Encrypt setup |
| **Vercel** | Gratuit, HTTPS auto, preview deployments | Séparé du VPS |

### P8-E — Features avancées (post-MVP)

| ID | Tâche | Statut |
|---|---|---|
| P8E.0 | Page Settings mini-app : sliders/inputs `LEVERAGE`, `RISK_PCT`, `POSITION_SIZE_USDT` — `PATCH /admin/config` pour persister (extend P8C.7) | `[ ]` |
| P8E.1 | Position reconciliation : compare état bot vs Binance API → alerte si désync | `[✓]` |
| P8E.2 | Trading mode switcher : LIVE / SHADOW (signaux sans exécution) / DRY_RUN | `[✓]` |
| P8E.3 | Strategy on/off : activer/désactiver scalp, capitulation, smart-money à chaud | `[✓]` |
| P8E.4 | RBAC 4 niveaux : VIEWER / OPERATOR / TRADER / ADMIN (userId → rôle) | `[✓]` |
| P8E.5 | Reports auto : `/report daily` envoyé à 08:00 UTC (win rate, PnL, nb trades) | `[✓]` |
| P8E.6 | Export CSV : trades journal depuis Telegram | `[✓]` |

---

## P9 — Passage en Production
> Migration testnet → production. Prérequis : test SL/TP validé ✅ (2026-05-15), position-manager reviewed ✅.
> Ordre obligatoire : P9-A (clés + permissions) → P9-B (VPS) → P9-C (smoke test) → P9-D (go-live).

### P9-A — Clés API & Permissions Binance

| ID | Tâche | Détail |
|---|---|---|
| P9A.1 | Créer clé API Futures prod sur binance.com | Permissions requises : **Futures trading** ✅ · Lecture ✅ · Pas de retrait ❌ |
| P9A.2 | Créer clé API Spot prod (si différente) | Permissions : **Spot trading** ✅ · Pas de retrait ❌ |
| P9A.3 | Whitelist IP du VPS dans les deux clés | IP statique VPS obligatoire — sans whitelist, clé invalide si IP change |
| P9A.4 | Mettre à jour `.env` prod : désactiver `BINANCE_TESTNET=false` | `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_SPOT_API_KEY`, `BINANCE_SPOT_API_SECRET` |
| P9A.5 | Vérifier `POSITION_SIZE_USDT` adapté au capital réel | Testnet = 50 USDT. Prod : calibrer selon capital (ex: 1-2% du compte) |
| P9A.6 | Vérifier `MIN_SCORE` (seuil signal) — ne pas relâcher en prod | Rester ≥ 5.0 sauf décision explicite après backtests |

### P9-B — VPS & Déploiement PM2

| ID | Tâche | Détail |
|---|---|---|
| P9B.1 | Variables d'env Windows → `.env` VPS Linux | Copier `.env` sur VPS, jamais dans le repo git |
| P9B.2 | Configurer PM2 : `ecosystem.config.js` avec restart policy | `max_restarts: 5`, `min_uptime: 10s`, `watch: false` |
| P9B.3 | PM2 startup : survie aux redémarrages VPS | `pm2 startup` + `pm2 save` | `[✓]` systemctl enable pm2-ubuntu OK — 2026-05-16 |
| P9B.4 | Logs PM2 rotatifs | `pm2 install pm2-logrotate` — max 10 MB par fichier, 30 fichiers, rotation minuit, compress | `[✓]` 2026-05-16 |
| P9B.5 | Alertes crash Telegram | Si PM2 relance le bot → envoyer message Telegram avec raison du crash | `[✓]` src/crash-notifier.js + uncaughtException/unhandledRejection dans index.js — 2026-05-16 |
| P9B.6 | Firewall VPS : n'exposer que les ports nécessaires | Port 3001 (dashboard HTTP) + 3002 (admin API P8) uniquement en local ou via tunnel | `[✓]` UFW nettoyé (3000+8000 public supprimés, 80/443 ajoutés). DOCKER-USER rules (drop 3000/6379/8000/8001/8086/8123/9000 hors 172.x). Persistance via `/etc/systemd/system/docker-fw.service`. — 2026-05-16 |

### P9-C — Vérification APIs avant Go-Live

| ID | Tâche | Détail | API cible |
|---|---|---|---|
| P9C.1 | `node scripts/check-apis.js` — script de healthcheck complet | Vérifier chaque API avant de lancer en prod | Toutes |
| P9C.2 | Check Binance Futures prod : `GET /fapi/v2/account` | Solde > 0, levier par défaut, marge croisée/isolée | `fapi.binance.com` |
| P9C.3 | Check Binance Spot prod : `GET /api/v3/account` | Solde USDT disponible pour DCA spot | `api.binance.com` |
| P9C.4 | Check perp-mcp-server : `GET /health` + `apiGet('perp-snapshot', {symbol:'BTCUSDT'})` | Serveur VPS joignable, token valide | `83-228-242-106.nip.io` |
| P9C.5 | Check Telegram : `getMe` + envoi message test | Bot actif, chat_id correct | `api.telegram.org` |
| P9C.6 | Check Anthropic : appel test `claude-sonnet-4-6` avec prompt minimal | Clé valide, quota disponible | Anthropic SDK |
| P9C.7 | Vérifier rate limits Binance : weight actuel < 1200/min | `X-MBX-USED-WEIGHT-1M` dans les headers des réponses | `fapi.binance.com` |
| P9C.8 | Vérifier `LLM_MODE=claude` (pas `local`) dans le `.env` VPS | Playwright ne fonctionne pas sur VPS headless | `.env` |

### P9-D — Smoke Test Prod (mode SHADOW avant LIVE)

| ID | Tâche | Détail |
|---|---|---|
| P9D.1 | Lancer le bot avec `DRY_RUN=true` pendant 24h | Génère signaux + logs mais n'exécute aucun ordre |
| P9D.2 | Vérifier que les signaux arrivent bien sur Telegram | Format correct, scores cohérents, pas d'erreur LLM |
| P9D.3 | Vérifier que position-manager ne crée aucun ordre (`executeOrder` bloqué si `DRY_RUN=true`) | Ajouter guard `if (process.env.DRY_RUN === 'true') return mockOrder()` dans order-executor |
| P9D.4 | Vérifier les logs PM2 : 0 erreur critique sur 24h | Aucun crash, aucune erreur Binance 4xx/5xx |
| P9D.5 | Valider manuellement 3 signaux via analyse manuelle (P8D.4) avant go-live | S'assurer que la qualité des signaux est conforme aux attentes |

### P9-E — Go-Live & Monitoring continu

| ID | Tâche | Détail |
|---|---|---|
| P9E.1 | Désactiver `DRY_RUN`, premier trade LIVE avec `POSITION_SIZE_USDT=25` (moitié) | Augmenter progressivement après validation première semaine |
| P9E.2 | Daily report automatique (P8E.5) actif dès J+1 | Win rate, PnL, nb trades, drawdown max |
| P9E.3 | Kill-switch manuel documenté : `pm2 stop perpedge-bot` + annulation ordres manuels | Procédure d'urgence connue par l'utilisateur |
| P9E.4 | Rotation clés API tous les 90 jours | Binance recommande de régénérer les clés régulièrement |
| P9E.5 | Backup `.env` chiffré (hors VPS) | Ne jamais perdre les clés prod — stocker dans gestionnaire de mots de passe |

### P9-G — Script de déploiement production (`scripts/deploy-prod.js`)
> À utiliser SYSTÉMATIQUEMENT avant chaque mise en production.
> Refuse le déploiement si une variable est manquante, invalide ou dangereuse.

| ID | Vérification | Condition de blocage |
|---|---|---|
| P9G.1 | `BINANCE_TESTNET=false` | Bloque si `true` ou absent |
| P9G.2 | `LLM_MODE=claude` | Bloque si `local` ou absent |
| P9G.3 | `ANTHROPIC_API_KEY` présent et format valide (`sk-ant-*`) | Bloque si absent ou malformé |
| P9G.4 | `BINANCE_API_KEY` + `BINANCE_API_SECRET` présents | Bloque si l'un ou l'autre absent |
| P9G.5 | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` présents | Bloque si absent |
| P9G.6 | `PERP_MCP_URL` + `PERP_MCP_TOKEN` présents | Bloque si absent |
| P9G.7 | `DRY_RUN` absent ou `false` | Avertissement si `true` (ne bloque pas) |
| P9G.8 | `POSITION_SIZE_USDT` entre 10 et 500 | Bloque si valeur aberrante |
| P9G.9 | `MIN_SCORE >= 4.0` | Bloque si trop bas (risque capital) |
| P9G.10 | Appel Binance Futures prod `GET /fapi/v2/account` → solde > 0 | Bloque si clé invalide ou testnet |
| P9G.11 | Appel Anthropic test minimal → réponse OK | Bloque si clé expirée |
| P9G.12 | Sortie : rapport complet ✅/❌ + exit code 1 si blocage | Intégrable dans CI/CD ou hook PM2 pre-start |

---

### P9-F — Inventaire complet des variables `.env` production

```env
# Bot core
BINANCE_TESTNET=false
BINANCE_API_KEY=<futures_prod_key>
BINANCE_API_SECRET=<futures_prod_secret>
BINANCE_SPOT_API_KEY=<spot_prod_key>          # ou même que BINANCE_API_KEY si même compte
BINANCE_SPOT_API_SECRET=<spot_prod_secret>

# Trading params
POSITION_SIZE_USDT=50                          # À calibrer selon capital
MIN_SCORE=5.0
CRON_SCHEDULE=*/15 * * * *                     # Cycle 15 min

# Telegram
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat_id>
TELEGRAM_ADMIN_IDS=<user_id>                   # P8 — whitelist admin

# LLM
ANTHROPIC_API_KEY=<claude_key>                 # NE JAMAIS envoyer aux LLMs externes
LLM_MODE=claude                                # local = Playwright | claude = API Anthropic (VPS = toujours claude)

# perp-mcp-server
PERP_MCP_URL=https://83-228-242-106.nip.io
PERP_MCP_TOKEN=<token>

# Admin cockpit (P8)
DASHBOARD_PORT=3001
ADMIN_API_PORT=3002

# Safety
DRY_RUN=false                                  # true = smoke test, false = live
```

### P9-H — Script de déploiement SSH production complet (`scripts/deploy-prod.sh`)
> Script maître lancé depuis le poste local. Se connecte au VPS via SSH et orchestre le déploiement complet de tous les services.
> Prérequis locaux : `ssh-keygen` configuré, clé publique sur le VPS (`~/.ssh/authorized_keys`), `VPS_HOST` + `VPS_USER` + `VPS_PATH` en variables d'env ou en arguments.

#### Périmètre — 3 services à assurer

| Service | Process manager | Port | Health check attendu |
|---|---|---|---|
| Bot principal (`index.js`) | PM2 (`perpedge-bot`) | 3002 (admin API) | `GET /admin/health` → `{"ok":true}` |
| perp-mcp-server (TypeScript) | PM2 (`perp-mcp`) | variable | `GET /health` → HTTP 200 |
| Mini-app React (build statique) | PM2 `serve` ou nginx | 5173 ou 80 | HTTP 200 sur `/` |

#### Tâches

| ID | Tâche | Détail |
|---|---|---|
| P9H.1 | Prérequis VPS : vérifier Node ≥ 20, npm, PM2, git | Bloquer si version insuffisante, afficher version trouvée |
| P9H.2 | Backup `.env` avant toute modification | `cp .env .env.backup.$(date +%Y%m%d%H%M%S)` |
| P9H.3 | `git pull origin main` + afficher hash du dernier commit | Bloquer si conflicts non résolus |
| P9H.4 | `npm ci --omit=dev` sur le bot principal | |
| P9H.5 | Build mini-app : `cd mini-app && npm ci && npm run build` | Build statique → `mini-app/dist/` |
| P9H.6 | PM2 reload bot : `pm2 reload ecosystem.config.cjs --only perpedge-bot --update-env` | |
| P9H.7 | PM2 reload perp-mcp : `pm2 reload ecosystem.config.cjs --only perp-mcp --update-env` (ou `pm2 start` si absent) | Dépend de l'ecosystem perp-mcp-server |
| P9H.8 | PM2 serve mini-app : `pm2 serve mini-app/dist 5173 --name perpedge-miniapp --spa` | Ou vérifier si nginx sert déjà le build |
| P9H.9 | `pm2 save` — persister les process pour redémarrage VPS | |
| P9H.10 | Health checks séquentiels avec retry 3× (intervalle 3s) | Bot `/admin/health`, perp-mcp `/health`, mini-app HTTP 200 |
| P9H.11 | Rapport final : ✅/❌ par service + uptime + version Node + hash commit | Exit 0 si tout OK, exit 1 si un service KO |
| P9H.12 | En cas d'échec : afficher les 20 dernières lignes de logs PM2 du service KO | `pm2 logs <name> --lines 20 --nostream` |

#### Interface d'appel (depuis Windows/local)

```bash
# Avec variables d'env
VPS_HOST=12.34.56.78 VPS_USER=ubuntu VPS_PATH=/opt/perpedge-bot bash scripts/deploy-prod.sh

# Ou avec fichier .deploy.env (non versionné)
source .deploy.env && bash scripts/deploy-prod.sh
```

#### `.deploy.env.example` (non versionné, à créer localement)
```bash
VPS_HOST=YOUR_VPS_IP
VPS_USER=ubuntu
VPS_PATH=/opt/perpedge-bot
SSH_KEY=~/.ssh/id_rsa   # optionnel si clé par défaut
```

---

## 🔴 P-NETWORK-TOGGLE — Toggle Testnet ↔ Mainnet dans la mini-app
> Priorité haute · Backend 100% prêt (`GET/POST /admin/network` + pm2 restart auto) · Frontend incomplet.
> **Pas de LLM requis** — fix simple et ciblé.

| ID | Fichier | Tâche | Statut |
|---|---|---|---|
| NT.1 | `mini-app/src/lib/api.ts` | Ajouter `postNetwork(network: NetworkEnv)` → `POST /admin/network` | `[ ]` |
| NT.2 | `mini-app/src/pages/Overview.tsx` | Badge TESTNET/MAINNET → clic = confirmation modale + appel `postNetwork()` + `mutateNetwork()` | `[ ]` |

---

## P-WEBAPP-RESILIENCE — Robustesse et résilience de la Mini-App React
> Spec établie 2026-05-18 après audit complet du code (`api.ts`, `App.tsx`, `Overview.tsx`).
> **Multi-LLM requis avant implémentation.** Questions précises définies ci-dessous.
> Objectif : la mini-app reste utilisable et informative même quand l'API bot est lente, hors ligne ou retourne des erreurs.

### Problèmes identifiés (code audit)

| # | Problème | Localisation | Impact réel |
|---|---|---|---|
| 1 | `request()` sans timeout — API freeze = requête en attente infinie | `api.ts:135` | UI bloquée, spinner infini |
| 2 | SWR `error` ignoré partout — l'UI affiche "—" en silence | Tous les useSWR | Utilisateur croit que le bot est down sans savoir pourquoi |
| 3 | Pas de React Error Boundary | `App.tsx` | Erreur de rendu dans un onglet → écran blanc complet |
| 4 | Pas de SWRConfig global | `App.tsx` / `main.tsx` | Retries SWR infinis par défaut sur erreur persistante |
| 5 | 401/403 non distingués — si initData Telegram expire | `api.ts:149` | Boucle retry silencieuse, log d'erreurs côté bot |
| 6 | Pas de détection offline (`navigator.onLine`) | — | Sur mobile Telegram : requêtes silencieusement perdues |
| 7 | Pas de skeleton sur chargement initial | `Overview.tsx`, `Risk.tsx` | Flash de "—" partout, layout shift |

### Spec détaillée

| ID | Feature | Fichier(s) cibles | Priorité |
|---|---|---|---|
| RES.1 | Timeout 10s sur toutes les requêtes `request()` via `AbortController` | `api.ts` | 🔴 CRITIQUE |
| RES.2 | `SWRConfig` global : `errorRetryCount: 3`, `errorRetryInterval: 2000`, `keepPreviousData: true` | `main.tsx` | 🔴 CRITIQUE |
| RES.3 | Gestion 401/403 : classe `AuthError` → bannière "Session expirée — Fermer et rouvrir le bot Telegram" | `api.ts` + `App.tsx` | 🔴 CRITIQUE |
| RES.4 | `<ErrorBoundary>` par onglet : catch render errors → "Erreur inattendue — Recharger" + bouton retry | `App.tsx` + `ErrorBoundary.tsx` (nouveau) | 🔴 CRITIQUE |
| RES.5 | Bannière API inaccessible : 3 échecs consécutifs `/admin/status` → sticky top banner avec last-seen | `App.tsx` + contexte | 🟡 HAUTE |
| RES.6 | Offline detection : `useOnlineStatus()` → bannière "Hors ligne" + `SWRConfig isPaused` quand offline | `hooks/useOnlineStatus.ts` (nouveau) | 🟡 HAUTE |
| RES.7 | Error states SWR dans l'UI : chaque page affiche `<ErrorCard message retry>` si `error && !data` | Toutes les pages | 🟡 HAUTE |
| RES.8 | Loading skeletons Overview + Risk : `animate-pulse` placeholder pendant chargement initial | `Overview.tsx`, `Risk.tsx` | 🟢 NORMALE |
| RES.9 | Indicateur données périmées : "⚠ {X}s" à côté de `HeartbeatDot` si dernière synchro > 60s | `Overview.tsx` | 🟢 NORMALE |

### Questions à soumettre aux 3 LLMs (Étape 3 du protocole)

```
Root cause : mini-app React sans error handling systématique — 7 failles identifiées.

Fix proposé RES.1 — Timeout request() :
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), path === '/admin/analyze' ? 30_000 : 10_000);
  fetch(..., { signal: controller.signal }).finally(() => clearTimeout(timeoutId))

Fix proposé RES.2 — SWRConfig :
  <SWRConfig value={{ errorRetryCount: 3, errorRetryInterval: 2000, keepPreviousData: true, dedupingInterval: 2000 }}>

Fix proposé RES.3 — AuthError :
  if (response.status === 401 || response.status === 403) throw new AuthError('Session expirée');
  // App.tsx : catch AuthError dans SWR onError → setAuthExpired(true) → bannière sticky

Fix proposé RES.4 — ErrorBoundary :
  class ErrorBoundary extends React.Component { componentDidCatch ... }
  // Wrap chaque <TabsContent> avec key={tabValue} pour reset auto au changement d'onglet

Questions (3 max) :
1. RES.1 : `AbortController` partagé ou créé dans chaque appel ? Risque de race condition si SWR revalide avant que le précédent soit annulé ?
2. RES.3 : SWR `onError` global dans SWRConfig ou hook `useEffect` sur `error` dans chaque composant ? Lequel est le plus propre pour détecter AuthError à travers tous les hooks ?
3. RES.4 : `key={activeTab}` sur ErrorBoundary suffit-il pour reset l'état après changement d'onglet, ou faut-il un getDerivedStateFromError + resetErrorBoundary explicite ?

Répondre : ✅ OK / ⚠️ problème + correction
```

### Ordre d'implémentation (4 sessions max)

```
Session 1 : RES.1 + RES.2 + RES.3 — api.ts + main.tsx (atomique, peu risqué)
Session 2 : RES.4 — ErrorBoundary.tsx + wrap App.tsx (composant isolé)
Session 3 : RES.5 + RES.6 + RES.7 — banners + error states dans chaque page
Session 4 : RES.8 + RES.9 — polish (skeletons + stale indicator)
```

---

## P10 — PerpEdge Terminal (SaaS Public Dashboard)
> Spec par consensus 3 LLMs (ChatGPT + Gemini + DeepSeek) — validée utilisateur 2026-05-15.
> **Niche** : Perpetual Futures Decision Intelligence — gap entre data brute (Coinglass) et exécution (3Commas).
> **Pipeline** : data → régime → setup → validation → risque → alerte → exécution readiness → feedback.
> **Pitch** : "Coinglass vous montre où le vent souffle. PerpEdge vous dit où atterrir et pilote l'avion pour vous."
> **Note** : Grand chantier final. 3 agents Claude seront chargés de prospecter le marché et vendre le produit.

### P10-A — Infrastructure & Stack

| ID | Tâche | Statut |
|---|---|---|
| P10A.1 | Monorepo : `apps/dashboard` (Next.js 14+ App Router, TypeScript, Tailwind + shadcn/ui) | `[ ]` |
| P10A.2 | Backend API Gateway : Node.js/Fastify, routes publiques + authentifiées | `[ ]` |
| P10A.3 | WebSocket proxy : normalisation données multi-exchange, push vers clients | `[ ]` |
| P10A.4 | Base de données : PostgreSQL (users/billing) + ClickHouse (séries temporelles) + Redis (cache/pub-sub) | `[ ]` |
| P10A.5 | Auth & billing : Clerk/BetterAuth + Stripe + Customer Portal + quotas API par plan | `[ ]` |
| P10A.6 | CDN/WAF : Cloudflare, rate limiting strict, séparation analytics/execution | `[ ]` |
| P10A.7 | Observabilité : OpenTelemetry + Grafana + Sentry + uptime monitoring | `[ ]` |

### P10-B — Market Intelligence (MVP public)

| ID | Tâche | Statut |
|---|---|---|
| P10B.1 | Market Overview page : régime global, squeeze scores, crowded scores, top 10 opps/risques | `[ ]` |
| P10B.2 | Market Regime Engine : feu tricolore (🔴 No-trade / 🟡 Wait / 🟢 Ready) par actif + timeframe | `[ ]` |
| P10B.3 | Crowded Trade Detector : funding z-score + OI expansion + liquidation asymmetry → score propriétaire | `[ ]` |
| P10B.4 | Cross-Exchange Divergence Scanner : Binance vs Bybit vs OKX (funding, OI, basis, price premium) | `[ ]` |
| P10B.5 | Liquidation War Room : clusters, cascade probability, distance pain zones, directional imbalance | `[ ]` |
| P10B.6 | Asset Detail Page : TA multi-TF + funding + OI + liquidations + orderbook imbalance + basis + signal history | `[ ]` |
| P10B.7 | No-Trade Zone Dashboard : protection (funding dangereux, OI contradictoire, volatilité insuffisante) | `[ ]` |

### P10-C — Signal Board & Explainability

| ID | Tâche | Statut |
|---|---|---|
| P10C.1 | Signal Board live : setup type, confidence score, risk score, direction, invalidation, timeframe dominant | `[ ]` |
| P10C.2 | **Signal Rejection Intelligence** : afficher POURQUOI un signal est refusé (killer feature rare) | `[ ]` |
| P10C.3 | Explainability Panel ("Why this signal?") : chaque donnée prise en compte, scénario alternatif, invalidation | `[ ]` |
| P10C.4 | LLM Validation transparente : données, décision, objections, confiance, "what would change my mind" | `[ ]` |
| P10C.5 | Trade Quality Score (0-100) : directional edge + timing + liquidity + volatility + crowding + RR | `[ ]` |
| P10C.6 | Signal Replay : historique signaux + évolution prix 5m/15m/1h/4h + MFE/MAE + raison succès/échec | `[ ]` |
| P10C.7 | Public Shareable Signal Pages : URL unique par signal, indexable SEO (avec disclaimer) | `[ ]` |

### P10-D — Shadow Bot & Smart Terminal

| ID | Tâche | Statut |
|---|---|---|
| P10D.1 | Shadow Bot Mode : simulation PerpEdge sans clé API (TP1/trailing/early exit visible) | `[ ]` |
| P10D.2 | Smart Terminal (Elite) : connexion API Binance read-only + position manager PerpEdge | `[ ]` |
| P10D.3 | Capitulation Sniper : bouton action directe quand scan détecte capitulation (scalp 30s) | `[ ]` |
| P10D.4 | Proactive Early-Exit SaaS : sortie avant SL classique sur retournement micro-structure | `[ ]` |
| P10D.5 | Trade Journal auto : erreurs répétées, trades contre régime, comparaison vs PerpEdge | `[ ]` |
| P10D.6 | Backtesting des scans avec LLM : "que se serait-il passé si ce scan avait été suivi ?" | `[ ]` |

### P10-E — Alerts, API & Monétisation

| ID | Tâche | Statut |
|---|---|---|
| P10E.1 | Alert Builder no-code : conditions composées → Telegram/Discord/webhook/email/API callback | `[ ]` |
| P10E.2 | API publique intelligente (pay-per-request) : `/regime`, `/squeeze-score`, `/crowding-score`, `/signal/explain`, `/cross-exchange` | `[ ]` |
| P10E.3 | Freemium : Free (15min delay, Top 10, 3 alertes) / Pro $59/mo / Elite $199/mo | `[ ]` |
| P10E.4 | API Developer plan : Free 1000 calls/mo → Starter $49 → Pro $199 → Business $499-999 | `[ ]` |
| P10E.5 | B2B / White-label : dashboard brandé, bot Discord/Telegram, API dédiée, multi-users ($500-5000/mo) | `[ ]` |

### P10-F — SEO & Acquisition

| ID | Tâche | Statut |
|---|---|---|
| P10F.1 | Pages SEO statiques ISR : `/crypto/futures/btc`, `/funding-rate/binance/btc`, `/squeeze-scanner` | `[ ]` |
| P10F.2 | Pages "compare" : `/compare/coinglass-alternative`, `/compare/hyblock-alternative` | `[ ]` |
| P10F.3 | Pages éducatives : `/learn/funding-rate`, `/learn/open-interest`, `/learn/liquidation-cascade` | `[ ]` |
| P10F.4 | 3 agents Claude dédiés prospection/vente marché (à définir lors du lancement) | `[ ]` |

---

## JOURNAL DES DÉCISIONS

| Date | Sujet | Verdict LLMs | Décision |
|---|---|---|---|
| 2026-05-15 | Protocole de travail | Consensus | Gemini+ChatGPT codent, DeepSeek+Claude reviewent, zéro mock |
| 2026-05-15 | Early exit strategy | Consensus ChatGPT+Gemini+DeepSeek | Score ≥5/9 (MSB+2,taker+2,OI+2,OB+1,liq+1), core requis, 2 ticks. PANIC: MSB+taker≤0.40+rv_EXTREME → 1 tick. Funding exclu unanime. |
| 2026-05-15 | TP1 design (50% vs 100%) | Consensus 3/3 LLMs → Option B | TP1 ferme 50%, trailing server-side APRÈS TP1 (bug activationPrice évité). Revue : recréer SL qty_half, cancel tout à posAmt=0, seuil 0.6. |
| 2026-05-15 | Admin Cockpit Telegram | Consensus 3/3 LLMs (ChatGPT+Gemini+DeepSeek) | Architecture hybride Bot classique + Mini App (WebApp). Stack React+Tailwind+Shadcn/UI+Fastify+Redis. Autocomplete web (pas inline query). Pause via botState interne (jamais pm2 stop). Sécurité : userId whitelist + initData + RBAC + confirmation double. Features ajoutées : Emergency Stop, Equity curve, Health monitor, Config editor, Log streamer, Position reconciliation, Trading mode SHADOW. |
| 2026-05-15 | SaaS Public Dashboard P10 | Consensus 3/3 LLMs (ChatGPT+Gemini+DeepSeek) · Validé utilisateur | Niche : "Perpetual Futures Decision Intelligence". Gap entre data brute (Coinglass) et exécution (3Commas). Pipeline : data→régime→setup→validation→risque→alerte→exécution readiness→feedback. Nom : PerpEdge Terminal. Pitch : "Coinglass vous montre où le vent souffle. PerpEdge vous dit où atterrir et pilote l'avion pour vous." Pricing : Free/Pro $59/Elite $199/API usage/B2B $500-5000. Stack : Next.js 14+·Fastify·ClickHouse·PostgreSQL·Redis·WebGL. 3 agents Claude dédiés prospection/vente (phase finale). |
| 2026-05-15 | P1.2 Mode local multi-LLM | Implémenté & testé ✅ | Playwright séquentiel (DeepSeek textarea selector + ChatGPT + Gemini). Consensus 3/3. Vérification dynamique ANTHROPIC_API_KEY dans validateSignal(). Fail-open si chrome_profile_locked ou playwright_not_installed. |

---

## JOURNAL DES TESTS

| Date | Composant | Token testé | Résultat | Notes |
|---|---|---|---|---|
| 2026-05-15 | Order Executor (P1b.3) | ETHUSDT LONG | ✅ PASS | orderId=8707540580 qty=0.022@2265.49 leverage=20x testnet |
| 2026-05-15 | Order Executor (P1b.4) | BTCUSDT LONG | ✅ PASS | orderId=13146634191 qty=0.0007@80458.2 leverage=20x testnet — fix minNotional |
| 2026-05-15 | Gate #7 (P0.1) | CHIPUSDT | ✅ PASS | Bybit 0.06077 / Binance 0.06071 = +0.10% → NON bloqué |
| 2026-05-15 | Gate #7 (P0.1) | SOLUSDT | ✅ PASS | Bybit 92.15 / Binance 92.13 = +0.02% → NON bloqué |
| 2026-05-15 | Gate #7 (P0.1) | SIREMUSDT | ✅ PASS | Token absent Bybit → null → gate silencieuse |
| 2026-05-15 | Gate #8 (P0.2) | CHIPUSDT | ✅ PASS | last_msb_time=null → gate skippée |
| 2026-05-15 | Gate #8 (P0.2) | SOLUSDT SHORT | ✅ PASS | MSB bullish 0.4min ago → BLOQUÉ |
| 2026-05-15 | Gate #8 (P0.2) | SOLUSDT LONG | ✅ PASS | MSB bullish confirme long → NON bloqué |
| 2026-05-15 | Gate #9 (P0.3) | CHIPUSDT LONG | ✅ PASS | taker=0.6662 < 0.8 → BLOQUÉ |
| 2026-05-15 | Gate #9 (P0.3) | CHIPUSDT SHORT | ✅ PASS | taker=0.6662 < 1.2 → NON bloqué |
| 2026-05-15 | Gate #9 (P0.3) | SOLUSDT LONG | ✅ PASS | taker=0.6136 < 0.8 → BLOQUÉ |
| 2026-05-15 | Gate #9 (P0.3) | null taker | ✅ PASS | rawRatio=null → NaN → gate skippée (fail-open) |
| 2026-05-15 | Contrarian (P0.4) | CHIPUSDT SHORT | ✅ PASS | funding=-0.000462 < longThresh(-0.0003) → contrarianSignal=true |
| 2026-05-15 | Contrarian (P0.4) | CHIPUSDT LONG | ✅ PASS | funding=-0.000462 < shortThresh(0.0006) → contrarianSignal=false |
| 2026-05-15 | Contrarian (P0.4) | BTCUSDT | ✅ PASS | funding=-0.0000374 → mild → contrarianSignal=false |
| 2026-05-15 | LLM Validator (P1.1) | BTCUSDT LONG 7/10 | ✅ PASS | APPROVE confidence=0.85 — MSB bullish + RV normal + contango |
| 2026-05-15 | LLM Validator (P1.1) | ETHUSDT gate_block | ✅ PASS | REJECT confidence=0.98 — règle absolue gate_block |
| 2026-05-15 | LLM Validator (P1.1) | CHIPUSDT contrarian | ✅ PASS | CONTRARIAN_FLIP confidence=0.92 — shorts crowded + MSB bullish |
| 2026-05-15 | LLM Validator (P1.1) | SOLUSDT FAIBLE 4/10 | ✅ PASS | REJECT confidence=0.85 — ta<3 + total<6 + force FAIBLE |

---

## COMPTE RENDU SESSION EN COURS

### 2026-05-15 (session 2 — Mini-App P8-D)
- [✓] P8D.1 — mini-app/ initialisé (React + Vite + TypeScript + Tailwind + Shadcn/UI)
- [✓] P8D.2 — Overview.tsx : status, positions, PnL, Equity SVG sparkline, boutons Pause/Resume/Reset Emergency, Dialog Emergency Stop
- [✓] P8D.3 — Analyze.tsx : autocomplete datalist → /admin/symbols, analyse manuelle, résultat complet (ta_detail, der_detail, gate/veto, LLM)
- [✓] P8D.4 — Idem P8D.3 (même page Trade)
- [✓] P8D.5 — Equity curve SVG pure (no deps), fillPts + zeroY baseline, couleur verte/rouge selon PnL
- [✓] P8D.6 — Risk.tsx : 6 MetricCards (winRate, trades, drawdown, PnL, exposition, marge), seuils d'alerte
- [✓] P8D.7 — Logs.tsx : polling incrémental 2s, sinceRef, terminal bg-black font-mono, auto-scroll, badge erreurs, clear
- [✓] P8D.8 — App.tsx : bottom nav 5 onglets, Telegram theme setHeaderColor/setBackgroundColor/data-theme
- [✓] index.css : .no-scrollbar ajouté
- [✓] api.ts : getLogs / getEquity / getRisk + types LogEntry / EquityPoint / RiskData
- [✓] admin-api.js : GET /admin/equity + GET /admin/risk + GET /admin/logs + ring buffer 500 logs (interception console.*)
- [✓] Build TypeScript propre (250 KB / 81 KB gzip)
- [✓] Règle mémorisée : zéro mock, zéro workaround — si endpoint manquant → backlog + nettoyage
- [✓] P8C.3 optimisation symbols : validé 3 LLMs (ChatGPT/DeepSeek/Gemini) · commit df87fce — filter TRADING, log errors, limit 20

### 2026-05-15 (session 1)
- [✓] TODO.md créé dans le projet
- [✓] Backlog complet structuré P0→P7
- [✓] P0.1 Gate #7 — implémenté, testé 3 tokens ✅
- [✓] P0.2 Gate #8 — implémenté, testé 3 cas ✅
- [✓] P0.3 Gate #9 — implémenté (injector.js async), testé CHIP+SOL ✅ — await ajouté dans index.js + crowded-unwind-watcher.js + oi-watcher.js
- [✓] P0.4 Contrarian flag — implémenté dans scorer.js (contrarianSignal dans result), testé CHIP+BTC ✅
- [✓] P0-bis Prompt Engineering LLM — consensus 4 LLMs atteint. System prompt final écrit dans src/llm-validator-prompt.md ✅
- [✓] P1 LLM Validator — src/llm-validator.js créé (consensus 4 LLMs: ChatGPT code, DeepSeek+Claude review). Intégré dans index.js. @anthropic-ai/sdk installé. Testé 4 cas réels ✅
  - BTCUSDT LONG 7/10 → APPROVE 0.85 ✅
  - ETHUSDT SHORT gate_block → REJECT 0.98 ✅
  - CHIPUSDT contrarian_signal+rv_extreme → CONTRARIAN_FLIP 0.92 ✅
  - SOLUSDT FAIBLE 4/10 → REJECT 0.85 ✅
- [✓] P1-bis order-executor.js créé (consensus 4 LLMs: ChatGPT code, DeepSeek+Claude review). HMAC-SHA256, leverage 20x, testnet flag, qty precision (notation scientifique), minQty validation ✅
- [✓] P1b.3/P1b.4 : Tests Binance Testnet — ETHUSDT orderId=8707540580 ✅ · BTCUSDT orderId=13146634191 ✅ · Fix minNotional (ajout stepSize si notional < MIN_NOTIONAL) · Clés BINANCE_DEMO_* renommées → BINANCE_TESTNET_* · Vars Windows synchronisées
- [✓] P2 Position Manager — src/position-manager.js (polling 60s, breakeven, trailing 1.5%)
- [✓] P2-bis Dashboard — src/dashboard.js (HTTP :3001, dark theme, auto-refresh 30s) · buildCombinedMessage LLM+order lines
- [✓] P2-ter Capitulation Watcher — /api/scan/capitulation (perp-mcp-server TypeScript) + src/capitulation-watcher.js (poll 5min, conf HIGH|MEDIUM)
- [✓] P3 Formats Telegram — buildSqueezeMessage + buildCrowdedUnwindMessage centralisés dans notifier.js · squeeze-watcher + crowded-unwind-watcher mis à jour
- [✓] P5 Scalp Module — /api/ta-scalp (1m+5m, perp-mcp-server) + scalp-scanner.js (30s) + scalp-scorer.js (taker-first 0-10) + scalp-manager.js (15s, T+10 forcé)
- [✓] P6 Feedback Loop — trade-journal.js (JSONL auto au close) + logTrade() dans position-manager + feedback-analyzer.js (cron dim 08:00) + feedback-applier.js (/apply_N /stats Telegram polling)
- [✓] P7 Smart Money Spot DCA — smart-money-scanner.js (4H) + spot-dca-manager.js (3 tranches) + spot-executor.js (Binance SPOT API)
- [✓] Early Exit Proactif — checkEarlyExit() ajouté dans position-manager.js. Consensus 3 LLMs (ChatGPT+Gemini+DeepSeek). Score 0-9: MSB+2, taker+2, OI_15m+2, orderbook+1, liq+1. Seuil ≥5 + core requis. 2 ticks consécutifs / PANIC 1 tick (MSB+taker≤0.40+rv_EXTREME). Symétrique LONG/SHORT. exit_reason EARLY_EXIT/EARLY_EXIT_PANIC dans trade_journal.
- [✓] Option B TP1 50% — Consensus 3 LLMs (ChatGPT+Gemini+DeepSeek). TP1 ferme 50%, trailing server-side placé APRÈS TP1 détecté (bug activationPrice contourné). 4 corrections revue : recréer SL sur qty_half, cancelAllAlgoOrders à posAmt=0, seuil 0.6 détection TP1, trailing sans activationPrice.

---

## PROCHAINE SESSION — Point de départ précis (2026-05-18)

> **Dernière session** : guard no-double-position + fix Telegram 409 livrés en prod. Commits `36f8a11` + `3f394e0`. VPS propre.
> **Prochaine priorité** : P9-A (action utilisateur) + [VPS] + P-NOTIFY.

---

### 🔴 IMMÉDIAT — P9-A + .env VPS (bloqueur go-live)

**Étape 1 — Utilisateur** : créer les clés API Binance prod sur binance.com
- Clé Futures : permissions Futures Trading + lecture, **pas de retrait**, whitelist IP `83.228.242.106`
- Clé Spot : permissions Spot Trading + lecture, **pas de retrait**, même whitelist

**Étape 2 — Claude** (après réception des clés) :
```bash
ssh ubuntu@83.228.242.106
# Ajouter dans .env VPS :
BINANCE_TESTNET=false
BINANCE_API_KEY=<futures_key>
BINANCE_API_SECRET=<futures_secret>
BINANCE_SPOT_API_KEY=<spot_key>
BINANCE_SPOT_API_SECRET=<spot_secret>
ENABLE_SPOT_LIVE_TRADING=false   # ← MANQUANT ACTUELLEMENT, ajouter maintenant
pm2 reload perpedge-bot --update-env
```

**Étape 3 — Claude** : `node scripts/check-apis.js` (P9-C)

**Étape 4** : 24h shadow mode `DRY_RUN=true` (P9-D)

---

### 🟡 EN PARALLÈLE — P-NOTIFY (lifecycle trades) `[ ]`

> **Non commencé.** 5 événements à notifier via `bot.pushAlert()` dans `position-manager.js`.
> **Protocole** : lire `position-manager.js` → formuler spec → 3 LLMs → code.

| ID | Événement | Message attendu |
|---|---|---|
| PN.1 | TP1 touché (50% fermé) | `🎯 TP1 {symbol}` — 50% @{price}, trailing activé, SL→breakeven, PnL partiel |
| PN.2 | SL touché | `🔴 SL {symbol}` — clôturé @{price}, PnL final |
| PN.3 | TP2 / trailing stop | `✅ TP2 {symbol}` — clôturé @{price}, PnL final |
| PN.4 | Early exit | `⚡ EXIT ANTICIPÉ {symbol}` — score early_exit/9, raison, PnL |
| PN.5 | Breakeven activé | `🛡️ BREAKEVEN {symbol}` — SL déplacé à {be_price} |

---

### [✓] P8C.3 — Optimisation endpoint `/admin/symbols` — commit df87fce
> Validé 3 LLMs (ChatGPT/DeepSeek/Gemini) · 2026-05-18

- Cache `exchangeInfo` 1h TTL avec anti-race condition (`_symFetch` singleton)
- Filtre `contractType === 'PERPETUAL' && status === 'TRADING'` (évite contrats suspendus)
- Score pertinence : exact/+USDT=0, startsWith=1, includes=2
- Log `console.error` sur échec fetch (observabilité)
- Limite `.slice(0, 20)` — consensus 2/3 LLMs (Gemini+DeepSeek)

---

### [ ] Suite P8-D — Mini-App tests fonctionnels complets
> Bot testnet actif · Mini-app sur http://localhost:5173 · API sur port 3002

- Tester chaque onglet avec données réelles testnet
- Valider boutons Pause / Resume / Reset Emergency sur état réel
- Valider analyse manuelle sur un symbole réel (BTCUSDT)
- Valider onglet Logs (polling 2s)
- Valider onglet Risk (données trade_journal.jsonl)
- Valider onglet Config (mode switcher + modules)

---

### [ ] P8-E — Features avancées (après validation P8-D)
Voir tableau P8-E ci-dessus (P8E.1 à P8E.6).

---

### [✓] P9-H — Script de déploiement SSH complet — 2026-05-16
> `scripts/deploy-ssh.sh` · 6 étapes : prérequis → backup .env → git pull → npm ci → build mini-app → pm2 reload --update-env
> npm run deploy:ssh · npm run deploy:ssh:fast (--skip-miniapp)
> Health checks : /admin/health (bot) + /health (perp-mcp) — testés ✅ HTTP 200

---

### [?] P-LLM-VPS — Réflexion : remplacer Playwright par APIs directes en production
> Statut actuel : en prod, seul Claude API est utilisé (fallback automatique quand `chrome_locked`).
> Playwright + Chrome headless sur VPS est techniquement possible mais fragile (sessions LLM expirables, CAPTCHAs, maintenance).
>
> **Option étudiée :** remplacer les 3 LLMs locaux (browser) par leurs APIs directes en prod :
> - Claude API → déjà actif ✅
> - OpenAI API → `OPENAI_API_KEY` + appel direct `api.openai.com/v1/chat/completions`
> - Gemini API → `GEMINI_API_KEY` + appel direct `generativelanguage.googleapis.com`
>
> **Avantages :** 0 dépendance navigateur, fiable, pas de maintenance session.
> **Inconvénients :** coût par token sur 3 APIs, clés supplémentaires à gérer.
>
> **Décision en attente** — soumettre aux 4 LLMs avant implémentation. En attendant : Claude API seul en prod, Playwright local uniquement.

---

### [ ] P-NOTIFY — Notifications Telegram cycle de vie des trades ⚠️ CRITIQUE

> **Contexte :** `position-manager.js` logue tous les événements dans `trade_journal.jsonl` mais n'envoie **aucune notification Telegram** lors des événements critiques de gestion de position. L'utilisateur ne sait pas en temps réel ce qui se passe sur ses trades ouverts.
>
> **Impact :** trade TP1 atteint → trailing activé → SL hit → position fermée, tout ça en silence.
> **Fichier principal :** `src/position-manager.js` · utiliser `bot.pushAlert()` (déjà disponible via `src/telegram-bot.js` P8B.5)
>
> **Travaux à faire (protocole multi-LLM) :**

| ID | Événement | Détail du message Telegram | Statut |
|---|---|---|---|
| PN.1 | TP1 touché (50% fermé) | `🎯 TP1 {symbol}` — PnL partiel brut, trailing activé, SL → breakeven | `[✓]` commit b2989e3 |
| PN.2 | SL touché (perte) | `🔴 Stop Loss {symbol}` — clôturé @{price}, PnL final | `[✓]` commit b2989e3 |
| PN.3 | TP2 / Trailing stop exécuté (gain) | `✅ TP2 / Trailing {symbol}` — clôturé @{price}, PnL final | `[✓]` commit b2989e3 |
| PN.4 | Early exit déclenché | `⚡ Early Exit {symbol}` — score/THRESHOLD pts, signaux, PnL | `[✓]` commit b2989e3 |
| PN.5 | Breakeven activé | Intégré dans PN.1 — consensus 3 LLMs (anti-spam, ordering async) | `[✓]` commit b2989e3 |

> **Prérequis :** passer en revue `position-manager.js` avec 4 LLMs avant implémentation — identifer les hooks exacts (après `cancelAllAlgoOrders`, après `recordClose`, etc.)

---

### [ ] P-ROBUSTNESS — Durcir le bot local et production

> **Contexte :** plusieurs incidents de fragilité identifiés en session 2026-05-16.
>
> **Problèmes observés :**
> - `node --watch` redémarre immédiatement après crash 409 → boucle infinie grammy (local)
> - `LLM_MODE=local` sur VPS avec `DISPLAY` défini → Playwright tenté → `chrome_locked` → alerte Telegram polluante
> - Pas de retry gracieux sur 409 dans `telegram-bot.js` → crash process complet
> - Pas de guard "une seule instance" au niveau du process (token lock file, PM2 watch:false déjà OK en prod)
>
> **Travaux à faire (minimum 2 reviewers, protocole multi-LLM) :**
> - [ ] `telegram-bot.js` : catch 409 + retry avec délai 35s (3 tentatives max) au lieu de crash
> - [ ] `llm-validator.js` : supprimer le test `!process.env.DISPLAY` fragile → forcer `LLM_MODE=claude` si `process.platform === 'linux'`
> - [ ] `scripts/start-dev.sh` (nouveau) : wrapper local qui vérifie qu'aucun node ne tourne avant de démarrer
> - [ ] `.env` local : documenter que `LLM_MODE` doit rester `local` en dev (Playwright actif) et `claude` en prod

---

### [✓] P2t.3 — Redéployer perp-mcp-server
> `docker compose build --no-cache && docker compose up -d perp-mcp` — 2026-05-16. Endpoint `/api/scan/capitulation` HTTP 200 confirmé.
