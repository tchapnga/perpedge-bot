# PerpEdge Bot

![Node.js](https://img.shields.io/badge/Node.js-20_ESM-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Mode](https://img.shields.io/badge/default_mode-SHADOW-orange)
![Exchange](https://img.shields.io/badge/exchange-Binance_Futures-F0B90B?logo=binance&logoColor=white)
![LLM](https://img.shields.io/badge/LLM-Claude_Anthropic-blueviolet)

Autonomous trading bot for Binance Perpetual Futures — multi-scanner signal pipeline, LLM validation, real-time position management, and a Telegram WebApp cockpit.

> ⚠️ **Disclaimer** — This software is provided for educational and personal use only. It is **not financial advice**. Cryptocurrency trading involves substantial risk of loss. Past performance is not indicative of future results. **Use at your own risk.** The author assumes no responsibility for financial losses incurred through the use of this software.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Overview](#overview)
- [Architecture](#architecture)
- [Signal Pipeline](#signal-pipeline)
- [Modules](#modules)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Trading Modes](#trading-modes)
- [Telegram Bot Commands](#telegram-bot-commands)
- [Admin API](#admin-api)
- [Mini-App Cockpit](#mini-app-cockpit)
- [Scripts Reference](#scripts-reference)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)
- [License](#license)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/tchapnga/perpedge-bot.git
cd perpedge-bot
npm install

# 2. Configure
cp .env.example .env
# Edit .env — set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY
# Leave BINANCE_API_KEY empty and BOT_MODE=SHADOW to run without real orders

# 3. Start in SHADOW mode (no real orders — recommended first run)
npm start
```

The bot will scan markets every 15 minutes, score candidates, validate with Claude, and send Telegram alerts — **without placing any real orders** until you switch to `BOT_MODE=LIVE`.

> **Minimum viable config for SHADOW:** only `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`, and `PERP_MCP_TOKEN` are required to receive signal notifications.

---

## Overview

PerpEdge Bot scans perpetual futures markets every cycle, scores candidates through a multi-layer quant + LLM pipeline, and autonomously executes orders on Binance FAPI with full SL/TP/trailing management.

Key properties:

- **Zero discretionary trades** — every order passes 5 scanner filters + 10-point scoring + LLM consensus
- **Fail-closed by default** — Gate #9 (taker ratio), LLM validator, and emergency close logic all err on the side of *not* trading
- **Modes** — `SHADOW` (simulate, no real orders) and `LIVE` (real execution); switchable at runtime via Telegram or Admin API
- **Trade profiles** — `AGGRESSIVE`, `BALANCED`, `CONSERVATIVE`; control position sizing and score thresholds
- **Multi-LLM validation** — Claude (Anthropic) reviews every qualifying signal before execution

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        index.js  (cron + orchestration)         │
│                                                                  │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────────┐ │
│  │ Phase 1  │   │  Phase 2+3   │   │    LLM Validator         │ │
│  │ scanner  │──▶│  TA + DER    │──▶│  Claude (Anthropic)      │ │
│  │ (5 scans)│   │  scoring v6  │   │  APPROVE / REJECT        │ │
│  └──────────┘   └──────────────┘   └────────────┬─────────────┘ │
│                                                  │               │
│  ┌───────────────────────────────────────────────▼─────────────┐ │
│  │              Order Executor  (LIMIT → MARKET fallback)      │ │
│  └───────────────────────────────────────────────┬─────────────┘ │
│                                                  │               │
│  ┌───────────────────────────────────────────────▼─────────────┐ │
│  │  Position Manager  (SL/TP · BE · Trailing · Early Exit)     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Side modules (independent timers)                               │
│  ├── scalp-scanner       (5m momentum entries)                   │
│  ├── capitulation-watcher (FSM: IDLE→FORMING→CONFIRMING→RECLAIM)│
│  ├── pre-squeeze-watcher  (predictive squeeze detection)         │
│  ├── oi-watcher           (OI explosion alerts)                  │
│  ├── crowded-unwind-watcher                                      │
│  ├── smart-money-scanner  (CVD + basis + MSB)                    │
│  └── spot-dca-manager     (DCA on spot pairs)                    │
└─────────────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
  Telegram Bot              Admin API (Fastify :3002)
  (Grammy)                  Mini-App Cockpit (React/Vite)
```

---

## Signal Pipeline

### Phase 1 — Scan (5 scanners in parallel)

| Scanner | Signal |
|---|---|
| `funding_extremes` | Funding rate outliers (most positive / most negative) |
| `oi_movers` | Open interest explosions & unwinds |
| `funding_divergence` | Funding rate vs. price divergence |
| `volatility` | Realized volatility anomalies |
| `cross_exchange` | Funding spread between Binance and other exchanges |

A symbol needs **≥ 2 scanner appearances** to pass Phase 1 (top 3 candidates forwarded).  
Exception: OI explosion ≥ 30% bypasses the 2-scan requirement.

### Phase 2 — Technical Analysis

Per-symbol scoring on 1H candles via `perp-mcp-server`:

- EMA trend (21 / 50 / 200)
- RSI 14 (overbought/oversold)
- VWAP 24h position
- Bollinger Bands width
- ATR-based volatility regime
- Support / Resistance levels

### Phase 3 — Derivatives Scoring

- Taker buy/sell ratio
- Funding rate regime
- Open interest momentum
- Spot-perp basis (premium / discount)
- Orderbook imbalance
- Market structure breaks (MSB)
- BTC correlation
- Multi-exchange funding spread
- Realized volatility regime
- Liquidation cascade risk

### Scoring — v6 (10 points)

Each signal receives a combined `ta_score + der_score` (max 10). Execution threshold is configurable via `MIN_SCORE` (default: 6.5).

**Gate blocks** — certain toxic derivative combinations veto execution regardless of score.

### LLM Validation

Every qualifying signal is sent to **Claude** (Anthropic) for a structured review:

- `APPROVE` — signal proceeds to execution
- `REJECT` — signal dropped, reason logged
- `PENDING` — limit order recommended, not executed
- `CONTRARIAN_FLIP` — blocked in LIVE mode, observed in SHADOW

### R:R Filter

After LLM validation, signals with `reward / risk < MIN_RR` (default: 1.5 on TP1) are discarded.

### Order Execution

1. LIMIT order placed at bid/ask (passive entry)
2. Polls every 15s for fill
3. Falls back to MARKET after `LIMIT_CANCEL_MS` (default: 3 min)
4. Position registered with Position Manager on fill

---

## Modules

| Module | File | Description |
|---|---|---|
| Scanner | `src/scanner.js` | Phase 1 — 5-scanner aggregation |
| Scorer | `src/scorer.js` | Phase 2+3 — TA + derivatives scoring |
| LLM Validator | `src/llm-validator.js` | Claude API structured output |
| Order Executor | `src/order-executor.js` | LIMIT→MARKET, partial fills |
| Position Manager | `src/position-manager.js` | SL/TP/BE/trailing/early exit/panic |
| Position Store | `src/position-store.js` | Persistent position state |
| Injector | `src/injector.js` | Signal queue writer + Gate #9 |
| Manual Trade | `src/manual-trade.js` | Telegram/WebApp manual entry |
| Scalp Scanner | `src/scalp-scanner.js` | 5m momentum scanner |
| Scalp Scorer | `src/scalp-scorer.js` | Short-term scoring |
| Scalp Manager | `src/scalp-manager.js` | T+10 min exit |
| Capitulation Watcher | `src/capitulation-watcher.js` | FSM crash detection + DCA |
| Pre-Squeeze Watcher | `src/pre-squeeze-watcher.js` | Predictive squeeze (replaces reactive) |
| OI Watcher | `src/oi-watcher.js` | Real-time OI alerts |
| Crowded Unwind | `src/crowded-unwind-watcher.js` | Crowded-trade unwind detection |
| Smart Money Scanner | `src/smart-money-scanner.js` | CVD + basis + MSB |
| Spot DCA Manager | `src/spot-dca-manager.js` | Spot accumulation |
| Bot State | `src/bot-state.js` | Mode, pause flags, counters |
| Admin API | `src/admin-api.js` | Fastify REST API (port 3002) |
| Telegram Bot | `src/telegram-bot.js` | Grammy bot (commands + callbacks) |
| Notifier | `src/notifier.js` | Telegram message builder |
| Chart Capture | `src/chart-capture.js` | Playwright chart screenshot |
| Dashboard | `src/dashboard.js` | Internal HTTP dashboard (port 3001) |
| Daily Reporter | `src/daily-reporter.js` | Daily P&L summary |
| Feedback Analyzer | `src/feedback-analyzer.js` | Trade outcome analysis |
| Feedback Applier | `src/feedback-applier.js` | Adaptive parameter tuning |
| Crash Notifier | `src/crash-notifier.js` | PM2 crash Telegram alert |
| Trade Journal | `src/trade-journal.js` | JSONL trade log |
| Config | `src/config.js` | Centralised env-based config |
| Perp Client | `src/perp-client.js` | MCP server client |

---

## Tech Stack

### Backend

| Technology | Role |
|---|---|
| Node.js 20 ESM | Runtime (no TypeScript, native ESM modules) |
| Binance FAPI v1/v2 | Perpetual futures REST + WebSocket |
| Anthropic Claude | LLM signal validation |
| Grammy | Telegram Bot framework |
| Fastify 5 | Admin REST API |
| node-cron | Cycle scheduling |
| Playwright | Chart screenshot capture |
| ws | WebSocket (User Data Stream, liquidations) |
| dotenv | Environment configuration |
| PM2 | Process management, crash recovery, logrotate |

### Frontend (Mini-App)

| Technology | Role |
|---|---|
| React 18 + Vite | SPA framework |
| TypeScript | Type safety |
| Tailwind CSS | Utility-first styling |
| Shadcn/UI | Component library |
| Telegram WebApp SDK | Native Telegram integration |

### Infrastructure

| Technology | Role |
|---|---|
| Ubuntu 22.04 VPS | Production server (83.228.242.106) |
| Caddy (Docker) | HTTPS reverse proxy + TLS (nip.io) — Docker is used **only** for Caddy |
| PM2 + pm2-logrotate | Manages the Node.js bot process directly on the host (not inside Docker); auto-restart + log rotation (10MB / 30 files) |
| GitHub | Source control + deploy trigger |

---

## Project Structure

```
perpedge-bot/
├── index.js                    # Main entry — cron orchestration
├── ecosystem.config.cjs        # PM2 config (single process: perpedge-bot)
├── package.json
├── Caddyfile                   # Caddy HTTPS config (Docker)
│
├── src/
│   ├── config.js               # Env-based centralised config
│   ├── bot-state.js            # Runtime state (mode, flags, counters)
│   ├── scanner.js              # Phase 1 — 5 scanners
│   ├── scorer.js               # Phase 2+3 — TA + derivatives
│   ├── injector.js             # Signal queue + Gate #9
│   ├── llm-validator.js        # Claude validation
│   ├── llm-validator-prompt.md # System prompt for Claude
│   ├── order-executor.js       # LIMIT → MARKET execution
│   ├── position-manager.js     # SL/TP/trailing/early-exit
│   ├── position-store.js       # Persistent position state
│   ├── manual-trade.js         # Manual trade execution
│   ├── scalp-scanner.js        # 5m scanner
│   ├── scalp-scorer.js         # Scalp scoring
│   ├── scalp-manager.js        # Scalp position management
│   ├── capitulation-watcher.js # FSM crash + DCA watcher
│   ├── pre-squeeze-watcher.js  # Predictive squeeze watcher
│   ├── oi-watcher.js           # OI explosion monitor
│   ├── crowded-unwind-watcher.js
│   ├── smart-money-scanner.js  # CVD + basis + MSB
│   ├── spot-dca-manager.js     # Spot DCA
│   ├── spot-executor.js        # Spot order execution
│   ├── admin-api.js            # Fastify admin API
│   ├── telegram-bot.js         # Grammy Telegram bot
│   ├── notifier.js             # Telegram message formatting
│   ├── chart-capture.js        # Playwright chart screenshots
│   ├── dashboard.js            # Internal HTTP dashboard
│   ├── daily-reporter.js       # Daily P&L summary
│   ├── feedback-analyzer.js    # Trade outcome analysis
│   ├── feedback-applier.js     # Adaptive tuning
│   ├── crash-notifier.js       # PM2 crash alerts
│   ├── trade-journal.js        # JSONL trade log
│   ├── perp-client.js          # perp-mcp-server client
│   └── utils/
│       └── guards.js
│
├── mini-app/                   # React Telegram WebApp cockpit
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── pages/
│   │   │   ├── Overview.tsx    # Dashboard — positions + signals
│   │   │   ├── Analyze.tsx     # Symbol analysis + manual trade
│   │   │   ├── Risk.tsx        # Risk controls
│   │   │   └── Logs.tsx        # Bot logs
│   │   ├── components/
│   │   │   ├── ExportButton.tsx
│   │   │   ├── ReconcilePanel.tsx
│   │   │   └── ui/             # Shadcn components
│   │   ├── hooks/
│   │   │   └── useMyRole.ts
│   │   └── lib/
│   │       ├── api.ts          # Admin API client
│   │       └── utils.ts
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
│
└── scripts/
    ├── deploy-ssh.sh           # Main deploy: git pull + npm ci + pm2 reload
    ├── deploy-miniapp.sh       # VPS-side mini-app rebuild
    ├── deploy-prod.js          # Pre-deploy validation (Binance + Anthropic + MCP)
    ├── setup-vps.sh            # One-time VPS setup (PM2 startup + logrotate)
    ├── smoke-test.sh           # Post-deploy health checks
    ├── smoke-test.js           # Lightweight admin/health check
    ├── test-tp1-sim.js         # Testnet TP1 simulation
    ├── test-limit-order.mjs    # Testnet LIMIT order scenarios
    ├── test-check-early-exit.mjs # Unit tests for checkEarlyExit()
    ├── test-chart-watch.mjs    # Chart capture + Telegram test
    ├── bot-control.ps1         # Windows: API keys / network switch / PM2 status
    └── bot-control.bat         # Windows: launcher for bot-control.ps1
```

---

## Configuration

All configuration is via environment variables (`.env` on VPS — **never committed**).

### Required

| Variable | Description |
|---|---|
| `BINANCE_API_KEY` | Binance Futures API key (mainnet) |
| `BINANCE_API_SECRET` | Binance Futures API secret (mainnet) |
| `ANTHROPIC_API_KEY` | Claude API key (signal validation) |
| `TELEGRAM_BOT_TOKEN` | Grammy bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `PERP_MCP_TOKEN` | perp-mcp-server auth token |

### Optional

| Variable | Default | Description |
|---|---|---|
| `BINANCE_TESTNET` | `false` | Use testnet (`true` / `false`) |
| `BINANCE_TESTNET_API_KEY` | — | Testnet API key |
| `BINANCE_TESTNET_API_SECRET` | — | Testnet API secret |
| `BOT_MODE` | `SHADOW` | `SHADOW` or `LIVE` |
| `TRADE_PROFILE` | `BALANCED` | `AGGRESSIVE`, `BALANCED`, `CONSERVATIVE` |
| `MIN_SCORE` | `6.5` | Minimum v6 score for execution (0–10) |
| `MIN_RISK_REWARD` | `1.5` | Minimum R:R on TP1 |
| `POSITION_SIZE_USDT` | `20` | Margin per trade (USDT) |
| `DEFAULT_LEVERAGE` | `10` | Default leverage |
| `MAX_OPEN_POSITIONS` | `3` | Concurrent position limit |
| `LIMIT_CANCEL_MS` | `180000` | LIMIT order timeout before MARKET fallback |
| `PERP_MCP_URL` | `http://localhost:3000` | perp-mcp-server URL |
| `CRON_SCHEDULE` | `*/15 * * * *` | Cycle frequency (cron expression) |
| `MINI_APP_URL` | — | Telegram WebApp HTTPS URL |
| `ADMIN_TELEGRAM_IDS` | — | Comma-separated Telegram IDs with admin access |
| `ENABLE_SPOT_LIVE_TRADING` | `false` | Enable live spot DCA |

### Example `.env`

```bash
# Binance Mainnet
BINANCE_API_KEY=your_key
BINANCE_API_SECRET=your_secret
BINANCE_TESTNET=false

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=8003973127

# perp-mcp-server
PERP_MCP_TOKEN=your_token
PERP_MCP_URL=https://your-mcp-server/

# Trading
BOT_MODE=SHADOW
TRADE_PROFILE=BALANCED
MIN_SCORE=6.5
POSITION_SIZE_USDT=20
DEFAULT_LEVERAGE=10
MAX_OPEN_POSITIONS=3
```

---

## Deployment

### Prerequisites

- Ubuntu 22.04 VPS with Node.js 20 + PM2 + Docker
- SSH key at `~/.ssh/id_ed25519` (or set `SSH_KEY`)
- Git remote: `github.com/tchapnga/perpedge-bot`

### First-time VPS setup

```bash
# On VPS — run once
bash scripts/setup-vps.sh
```

This configures:
- PM2 systemd startup hook (`pm2 startup`)
- `pm2-logrotate` (10 MB per file, 30 files retained, daily rotation, gzip)

### Routine deploy (from local machine)

```bash
# Deploy bot only (skip mini-app rebuild — fastest)
npm run deploy:ssh:fast

# Deploy bot + rebuild mini-app
npm run deploy:ssh
```

`deploy-ssh.sh` pipeline:
1. Checks Node.js + PM2 presence on VPS
2. Backs up `.env`
3. `git pull origin main`
4. `npm ci --omit=dev`
5. Builds mini-app locally + SCPs `dist/` to VPS *(if not skipped)*
6. `pm2 reload perpedge-bot --update-env`
7. Health checks (admin API port 3002 + perp-mcp HTTPS)

### Pre-deploy validation

```bash
node scripts/deploy-prod.js
```

Verifies: env vars, Binance FAPI connectivity, Anthropic API, perp-mcp `/health`.

### Post-deploy smoke test (on VPS)

```bash
bash scripts/smoke-test.sh
```

Checks: HTTPS root 200, `/api/positions` 200, dashboard `:3001/health`, admin `:3002/admin/health`, PM2 `perpedge-bot` online.

---

## Trading Modes

### SHADOW (default)

All logic runs — scans, scoring, LLM validation, Telegram notifications — but **no real orders** are placed. Orders are logged as simulated. Use for validation before going LIVE.

### LIVE

Real LIMIT orders placed on Binance FAPI. Requires:
- `BOT_MODE=LIVE` in `.env` (or switched via Telegram `/mode live`)
- `BINANCE_TESTNET=false`
- Valid mainnet API keys with futures trading permission

### Trade Profiles

| Profile | Position size | Score threshold | Behavior |
|---|---|---|---|
| `AGGRESSIVE` | 150% of base | 6.0 | Higher exposure, lower bar |
| `BALANCED` | 100% of base | 6.5 | Default |
| `CONSERVATIVE` | 50% of base | 7.0 | Reduced size, higher bar |

Profile is applied when `reduce_size=true` signals are detected (extreme RV regime).

---

## Telegram Bot Commands

| Command | Description |
|---|---|
| `/status` | Bot mode, positions, last cycle |
| `/positions` | Open positions with P&L |
| `/mode shadow` | Switch to SHADOW |
| `/mode live` | Switch to LIVE |
| `/pause` | Pause new entries (keep managing open positions) |
| `/resume` | Resume entries |
| `/stop` | Emergency stop all new activity |
| `/profile aggressive\|balanced\|conservative` | Set trade profile |
| `/close <symbol>` | Market-close a position |
| `/closeall` | Emergency close all positions |
| `/balance` | USDT balance |
| `/daily` | Today's P&L summary |
| `/app` | Open mini-app cockpit (WebApp button) |

---

## Admin API

Fastify server on port `3002`. All write endpoints require `X-Admin-Id` header matching a configured Telegram ID.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/health` | Health check |
| `GET` | `/admin/positions` | Tracked positions |
| `GET` | `/admin/signals` | Last 50 signals |
| `GET` | `/admin/state` | Bot mode, flags, config |
| `POST` | `/admin/mode` | `{ mode: "SHADOW"\|"LIVE" }` |
| `POST` | `/admin/pause` | Pause new entries |
| `POST` | `/admin/resume` | Resume entries |
| `POST` | `/admin/stop` | Emergency stop |
| `POST` | `/admin/close` | `{ symbol }` — close position |
| `POST` | `/admin/analyze` | `{ symbol }` — run analysis |
| `POST` | `/admin/manual-trade` | Open manual trade |
| `POST` | `/admin/config` | Update config (score, RR, size…) |

---

## Mini-App Cockpit

Telegram WebApp served at `https://perpedge-app.83-228-242-106.nip.io`.

### Pages

| Page | Description |
|---|---|
| **Overview** | Live positions, open P&L, last signals, bot state |
| **Analyze** | Symbol analysis on demand — TA + derivatives + LLM verdict + manual trade form |
| **Risk** | Pause/Resume/Stop controls, trade profile selector, config panel |
| **Logs** | Real-time bot log stream, PM2 status |

### Access

The mini-app reads your Telegram identity via `window.Telegram.WebApp.initData`. Role-based access: `ADMIN` (full control) vs `VIEWER` (read-only). Admin IDs configured via `ADMIN_TELEGRAM_IDS`.

---

## Scripts Reference

| Script | Usage | Description |
|---|---|---|
| `npm run deploy:ssh:fast` | Local | Deploy without mini-app rebuild |
| `npm run deploy:ssh` | Local | Deploy + mini-app rebuild |
| `npm run deploy:check` | Local | Pre-deploy validation |
| `bash scripts/setup-vps.sh` | VPS (once) | PM2 startup + logrotate |
| `bash scripts/smoke-test.sh` | VPS | Post-deploy health checks |
| `node scripts/test-tp1-sim.js BTCUSDT` | VPS testnet | Simulate TP1 hit |
| `node scripts/test-limit-order.mjs --mode=fill` | Local testnet | Test LIMIT fill |
| `node scripts/test-check-early-exit.mjs` | Local | Unit test checkEarlyExit() |
| `node scripts/test-chart-watch.mjs` | Local | Chart capture + Telegram |
| `scripts/bot-control.bat` | Windows | Interactive: keys / network / status |

---

## Security Notes

- `.env` is gitignored and never committed
- Admin API requires `X-Admin-Id` matching `ADMIN_TELEGRAM_IDS`
- Telegram WebApp identity verified via `initData` signature
- Gate #9 (taker ratio) is **fail-closed** — API error blocks the signal
- `registerTrade()` failure after MARKET fill triggers an **emergency reverse close** to avoid orphan positions
- All error messages sent to Telegram are HTML-escaped (prevents parse_mode injection)
- Binance mark price (`premiumIndex`) used for all SL/TP validation — not last price (avoids 2–3% divergence in trends)
- Anti double-exit guard on `uncaughtException` + `unhandledRejection` to prevent duplicate PM2 crash alerts

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Binance -1021 Timestamp` error | System clock out of sync | `ntpdate pool.ntp.org` (Linux) or `w32tm /resync` (Windows) |
| `Missing BINANCE_API_KEY` on startup | `.env` not loaded or key empty | Check `.env` file exists in project root; verify key is not blank |
| LLM rejects all signals | Score threshold too high or Claude API key invalid | Check `ANTHROPIC_API_KEY`; lower `MIN_SCORE` if needed |
| Bot starts but sends no Telegram messages | Wrong `TELEGRAM_CHAT_ID` or bot not added to chat | Send `/start` to your bot first; confirm chat ID with `@userinfobot` |
| Position not tracked after MARKET fill | `registerTrade()` failed after fill | Bot triggers emergency reverse close automatically — check PM2 logs |
| Admin API returns `401 Unauthorized` | `X-Admin-Id` header not set or ID not in `ADMIN_TELEGRAM_IDS` | Add your Telegram ID to `ADMIN_TELEGRAM_IDS` env var |
| `perp-mcp` health check fails | MCP server unreachable | Verify `PERP_MCP_URL` and that the MCP server is running |
| PM2 shows bot restarting in loop | Uncaught exception at startup | Run `npm start` directly to see the raw error before PM2 masks it |

---

## Author

**Tchapnga Rodrigue** — [tchapnga2002@yahoo.fr](mailto:tchapnga2002@yahoo.fr)

---

## License

MIT — see [LICENSE](LICENSE) for details.

> This project is provided as-is, without warranty of any kind. It is **not financial advice**. You are solely responsible for any trading decisions and financial outcomes resulting from its use.

---

*PerpEdge Bot — built and validated with multi-LLM review (Claude · ChatGPT · DeepSeek · Gemini)*
