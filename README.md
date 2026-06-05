# 📊 Polymarket Market Maker Bot — DEMO MODE

A simulated two-sided market making bot for **Polymarket BTC/ETH/SOL 15-minute binary windows**, with a live real-time dashboard.

---

## 🧠 Strategy Overview

### How It Makes Money

The bot runs **two maker quote engines simultaneously** on 3 assets:

| Engine | Half-Spread | Full Spread | Per 100sh Round-Trip | Fees |
|--------|-------------|-------------|----------------------|------|
| Maker  | ±2¢         | 4¢          | **$4.00**            | $0   |
| Scalp  | ±1.5¢       | 3¢          | **$3.00**            | $0   |

**Edge sources (3 stacked):**
1. **Spread capture** — Buy the bid, sell the ask, pocket the difference. Zero taker fees as a maker.
2. **Liquidity Rewards** — Polymarket pays daily USDC to orders resting near the midpoint. Scoring is **quadratic**: twice as close = 4× the score.
3. **Maker Rebates** — ~20% of the taker fee on every fill returned to makers. Funded by taker volume.

### Risk Management
- Max **35% of capital** in open positions at once
- **Adverse selection guard**: if mid moves >7¢ against open quotes, scalp engine pauses
- **Emergency flatten** at T-12 seconds: all open asks sold at market (taker) before expiry
- **Cooldown system**: 3 ticks (7.5s) before reposting at the same price level
- **Requote on drift**: cancel stale quotes if mid has moved >1.5¢

### Position Sizing (Compounding)
```
shares = floor(capital × 0.5% / price / 5) × 5
```
At $2,000 → ~20 shares/bid.  
At $4,000 → ~40 shares/bid.  
Returns stay constant % as capital grows.

---

## 🚀 Quick Start

### 1. Run Locally

```bash
# Clone or create the project folder
cd polymarket-mm-bot

# Install dependencies
npm install

# Copy env file
cp .env.example .env

# Start (demo mode by default)
npm start

# Open dashboard
open http://localhost:3000
```

### 2. Deploy to Railway

1. Push this folder to a **GitHub repository**
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Railway auto-detects Node.js and runs `node server.js`
5. Add environment variables in Railway dashboard (Settings → Variables):
   ```
   DEMO_MODE=true
   DEMO_CAPITAL=2000
   PORT=3000
   ```
6. Click **Deploy** → your bot is live with a public URL

> Railway free tier: 500 hours/month. Upgrade to Hobby ($5/mo) for 24/7.

---

## 📈 Dashboard Features

| Panel | What It Shows |
|-------|---------------|
| **KPI Row** | Total P&L, round-trips, liquidity rewards, maker rebates, fees, exposure, session time, net edge |
| **Window Timer** | Countdown to expiry — turns red at <60s |
| **Asset Cards** | BTC/ETH/SOL: binary probability bar, open orders, reward score, per-window P&L |
| **Equity Curve** | Real-time chart of $2,000 capital, auto-colors green/red |
| **Open Bids** | All resting bids with reward score per quote |
| **Open Asks** | Exit leg orders with unrealized P&L |
| **Fill Log** | Every trade with price, shares, P&L |
| **Trade Stream** | Live feed of BUY/SELL events |
| **System Log** | Engine events, warnings, reward drips |
| **Window History** | P&L and round-trips per completed 15m window |
| **Config Panel** | Adjust spreads and exposure live |

---

## ⚙️ Configuration

Edit `.env` or use the dashboard Config panel:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_MODE` | `true` | Set `false` for live (requires credentials) |
| `DEMO_CAPITAL` | `2000` | Starting capital in USD |
| `PORT` | `3000` | Server port |
| `ASSETS` | `btc,eth,sol` | Which assets to quote |

---

## 🔬 Reward System (Demo Simulation)

### Liquidity Rewards
- Polymarket samples the order book **every minute**
- Score formula: `S = (1 - spread/maxSpread)²`
- At ±1.5¢ spread, score ≈ **0.91** (near-perfect)
- At ±3¢ spread, score ≈ **0.64**
- Daily payout ∝ your score share of total market pool

### Maker Rebates
- Formula: `rebate = taker_fee × 0.20`
- Taker fee: `0.07 × shares × p × (1-p)` 
- At p=0.50, 100 shares: fee = $1.75 → your rebate = **$0.35**
- Paid daily in USDC, min $1 threshold

---

## 🗂️ File Structure

```
polymarket-mm-bot/
├── server.js          ← Bot engine + WebSocket + REST API
├── public/
│   └── index.html     ← Dashboard (self-contained)
├── package.json
├── railway.json       ← Railway deploy config
├── .env.example
└── .gitignore
```

---

## 🔒 Going Live (When Ready)

When switching `DEMO_MODE=false`, you'll need:
1. A Polymarket account + Polygon wallet
2. `POLYMARKET_API_KEY` from app.polymarket.com → Settings → API
3. `POLYGON_PRIVATE_KEY` (your wallet key — keep secret)
4. `POLYGON_RPC_URL` (e.g. `https://polygon-rpc.com`)

The bot will use the real CLOB API: POST `/order` with limit orders, signed via your private key.

---

## ⚠️ Disclaimer

This is a **demo simulation** only. All fills, prices, and rewards are simulated. Real trading involves execution risk, adverse selection, oracle delays, and market risk. Past simulated performance does not predict real results.
