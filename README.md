# Polymarket BTC 15m Demo Trading Bot

A **paper-trading** (demo money only) bot that watches Polymarket's BTC Up/Down 15-minute binary markets and places simulated $2,000 virtual bets based on technical analysis signals.

## ✅ Market Confirmed
Polymarket lists active `btc-updown-15m-{timestamp}` markets 24/7. The bot auto-discovers the current 15-minute window via the Gamma API.

## Features
- **$2,000 virtual capital** — zero real money involved
- **Auto-discovers** the current BTC 15m Polymarket window using the Gamma API
- **Multi-factor signal engine**: RSI, MACD, VWAP, momentum
- **Edge filter**: only enters when model probability exceeds market price by ≥4%
- **Live dashboard** at your Railway URL — auto-refreshes every 10 seconds
- **Trade history** with P&L tracking
- **BTC price sparkline** from Binance

## Signal Logic
| Indicator | Bullish signal | Bearish signal |
|-----------|---------------|----------------|
| RSI (14) | < 35 (oversold) | > 65 (overbought) |
| MACD | Line > Signal, above 0 | Line < Signal, below 0 |
| VWAP | Price below VWAP | Price above VWAP |
| Momentum 3m | Positive | Negative |
| Momentum 10m | Positive | Negative |

A trade is placed only when:
1. Signal confidence ≥ 52%
2. Edge over market price ≥ 4%
3. < 2 open positions at once

## Deploy on Railway (one-click)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select your repo — Railway auto-detects the `Procfile`
4. Click **Deploy** — your dashboard URL appears in seconds

**No environment variables needed.** No API keys. No wallet. Pure demo.

## Files
```
bot.py            ← entire bot + dashboard (single file)
requirements.txt  ← empty (uses Python stdlib only)
Procfile          ← tells Railway how to start
README.md         ← this file
```

## Disclaimer
This is a **demo bot** with simulated capital. It does **not** place real trades on Polymarket. Past signal performance does not guarantee future results.
