# 🤖 Polymarket BTC 15-Min Demo Bot

Paper-trading replica of the Polymarket BTC 15-minute strategy.  
**No real money — $2,000 virtual capital — deploy in 5 minutes.**

---

## 📁 Files (3 total)

| File | Purpose |
|---|---|
| `bot.py` | Entire bot — signals, paper trading, logging |
| `requirements.txt` | Only one dependency: `requests` |
| `Procfile` | Tells Railway how to start the bot |

---

## 🚀 Deploy to Railway

1. **Create a new GitHub repo** and upload these 3 files
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo → Railway auto-detects the `Procfile`
4. Click **Deploy** — that's it!

> The bot runs as a **Worker** (background process), not a web server.  
> In Railway, make sure the service type is set to **Worker**.

---

## ⚙️ Optional: Customize via Environment Variables

Set these in Railway → your service → **Variables** tab:

| Variable | Default | Description |
|---|---|---|
| `DEMO_CAPITAL` | `2000` | Starting virtual cash ($) |
| `MAX_TRADE_USD` | `20` | Max $ per single trade |
| `MAX_OPEN_POSITIONS` | `10` | Max concurrent open bets |
| `STOP_LOSS_PCT` | `0.30` | Close at 30% loss |
| `TAKE_PROFIT_PCT` | `0.20` | Close at 20% gain |
| `SPIKE_THRESHOLD` | `0.003` | BTC move % to trigger spike signal |
| `LOOP_INTERVAL` | `900` | Seconds between cycles (900 = 15 min) |

---

## 📊 How It Works

Every 15 minutes the bot:

1. **Fetches** live BTC price (Binance) + Fear & Greed Index
2. **Finds** an active BTC 15-min market on Polymarket
3. **Runs 3 signals:**
   - 🔺 **Price Spike** — did BTC move >0.3% since last check?
   - 📈 **Trend** — are the last 3 prices going up or down?
   - 😱 **Sentiment** — is the market greedy (>70) or fearful (<30)?
4. **Fuses signals** → votes YES, NO, or SKIP
5. **Paper trades** if there's a clear signal and market has good odds (35–65%)
6. **Closes** any positions that hit stop-loss or take-profit
7. **Logs** a full portfolio snapshot to the console

---

## 📜 View Logs

In Railway: **your service → Deployments → View Logs**

Sample output:
```
2026-05-31 12:00:00  INFO    ═══════════════ CYCLE START ═══════════════
2026-05-31 12:00:01  INFO    BTC: $68,432.10  |  Fear/Greed: 62/100
2026-05-31 12:00:02  INFO    Market: Will BTC be higher at 12:15 than 12:00?
2026-05-31 12:00:02  INFO    Prices  YES=0.541  NO=0.459
2026-05-31 12:00:02  INFO    Signal: YES  confidence=68%
2026-05-31 12:00:02  INFO      • Spike UP 0.41% (score 1.00)
2026-05-31 12:00:02  INFO      • Trend UP (3-bar)
2026-05-31 12:00:02  INFO    📥 DEMO TRADE  YES  $13.60  →  25.14 shares @ 0.541
2026-05-31 12:00:02  INFO    📊 PORTFOLIO SNAPSHOT
2026-05-31 12:00:02  INFO       Cash            : $1,986.40
2026-05-31 12:00:02  INFO       Total Equity    : $2,000.00 (+0.00 vs start)
2026-05-31 12:00:02  INFO       Win / Loss      : 0 W  /  0 L
```

---

## ⚠️ Disclaimer

This bot is for **educational and demo purposes only**.  
It places **no real trades** and uses **no real money**.  
Past simulated performance does not guarantee future results.
