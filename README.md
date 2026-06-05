# APEX MM v1.0 — BTC 15-Minute Polymarket Market Maker

## What This Bot Does

Posts maker limit orders on **BTC UP/DOWN 15-minute binary windows** on Polymarket.

- **Zero maker fees** — Polymarket charges $0 to liquidity providers
- **Earns 20% rebate** of all taker fees daily in PUSD (crypto category)
- **Two strategies running in parallel:**
  - **S1 WIDE** — ±3¢ spread, 0.7% capital per bid, stops 45s before close
  - **S2 TIGHT** — ±1.5¢ spread (reward farming zone), 0.4% capital per bid
- **Compounding capital** — position sizes grow automatically as capital grows
- **Velocity freeze** — pauses new quotes when price moves >4¢ in one tick
- **Emergency close** — all open positions exit as takers with <12s left

## Deployment: GitHub + Railway (Step-by-Step)

### Step 1 — Create GitHub Repository

1. Go to **github.com** → sign in
2. Click **"New"** (green button, top left)
3. Name it: `apex-mm-bot`
4. Set to **Private**
5. Click **"Create repository"**
6. On the next screen, click **"uploading an existing file"**
7. Upload ALL files (keep the folder structure):
   - `server.js`
   - `package.json`
   - `.env.example`
   - `public/index.html`
8. Click **"Commit changes"**

### Step 2 — Deploy on Railway

1. Go to **railway.app** → sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `apex-mm-bot` repository
4. Railway will auto-detect Node.js and deploy

### Step 3 — Set Environment Variables on Railway

Click your project → **"Variables"** tab → add these:

| Variable | Value |
|----------|-------|
| `DEMO_MODE` | `true` (change to `false` for live trading) |
| `DEMO_CAPITAL` | `2000` |
| `PORT` | `3000` |
| `S1_RISK` | `0.007` |
| `S2_RISK` | `0.004` |

For live trading, also add:

| Variable | Value |
|----------|-------|
| `POLYMARKET_API_KEY` | Your Polymarket API key |

### Step 4 — Access Your Dashboard

Railway gives you a URL like `https://apex-mm-bot-production.up.railway.app`

Open it in your browser or phone. The dashboard updates in real-time.

## Understanding the Dashboard

### Capital Hero
Shows your total capital, total PnL, win/loss rate, and rebate earned.

### Window Timer
A progress bar showing how much time is left in the current 15-minute window.
Goes **red** when less than 60 seconds remain.

### Live Prices
UP and DOWN prices in real-time, updated every 2.5 seconds.

### S1 WIDE / S2 TIGHT Cards
- **Open Bids** — number of resting limit orders waiting to be filled
- **Open Shares** — shares in filled bids waiting for their take-profit exit
- **Trades** — completed round-trips this window
- **Size** — current position size based on compounded capital

### Rebate Tracker
Estimated PUSD rebates accruing daily. This is paid by Polymarket separately
from your trading PnL — free money for providing liquidity.

### Capital Curve
Chart of capital growth across all completed windows.

### 30-Day Projection
Appears after 2+ windows. Shows compound growth at current pace.
(Projection is illustrative — actual results will vary)

### Fee & Rebate Matrix
Shows taker fee per 100 shares at each price level, the 20% rebate you earn,
and the minimum price move needed to break even on a stop-loss.

## How the Edge Works

**Market making earns money in two ways:**

1. **Spread income** — when price oscillates in our range, we fill bids and
   ask exits capture the spread: 6¢ (S1) or 3¢ (S2) per round-trip, zero fees.

2. **Rebate income** — 20% of taker fees flow back to us daily. Even if spread
   income is zero, rebates alone make maker orders profitable at Polymarket.

**What risks us:**

- **Adverse selection** — if BTC news breaks and price gaps 10¢+ immediately,
  takers informed before us fill our bids at stale prices. Stop-loss exits
  at 7¢ (S1) or 5¢ (S2) below entry price cap the damage.
- **Near-resolution risk** — we stop posting new bids 45s/90s before window
  close to avoid holding inventory through the binary resolution.

## Going Live

1. Get your Polymarket API key from account settings
2. Change `DEMO_MODE` to `false` on Railway
3. Add `POLYMARKET_API_KEY` to Railway variables
4. The bot uses the same code — no other changes needed

**Recommended:** Run in demo mode for at least 1-2 days first to understand
the typical PnL pattern before switching to live.

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_MODE` | `true` | Set `false` for live trading |
| `DEMO_CAPITAL` | `2000` | Starting capital in demo mode |
| `POLYMARKET_API_KEY` | — | Required for live trading |
| `PORT` | `3000` | Server port (Railway sets this automatically) |
| `S1_RISK` | `0.007` | S1 risk fraction per bid (0.7%) |
| `S2_RISK` | `0.004` | S2 risk fraction per bid (0.4%) |
