#!/usr/bin/env python3
"""
=============================================================
  Polymarket BTC 15m Demo Trading Bot
  $2,000 virtual capital | Web Dashboard
  Deploy on Railway — zero config needed
=============================================================
"""

import os, json, time, math, random, threading, logging
from datetime import datetime, timezone, timedelta
from collections import deque
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request, urllib.error

# ─────────────── CONFIG ───────────────
DEMO_CAPITAL      = 2000.0   # Starting virtual balance ($)
BET_FRACTION      = 0.04     # Risk 4% of balance per trade
MIN_EDGE          = 0.04     # Need ≥4% edge over market price to enter
MIN_PROB          = 0.52     # Only bet when our model says ≥52% confidence
MAX_OPEN_TRADES   = 2        # Hold at most 2 positions simultaneously
POLL_INTERVAL     = 45       # Seconds between market checks
PORT              = int(os.environ.get("PORT", 8080))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("btc-bot")

# ─────────────── MARKET DISCOVERY ───────────────

def get_current_15m_timestamp():
    """Return the Unix timestamp for the current 15-minute window (floor)."""
    now = int(time.time())
    return (now // 900) * 900

def build_slug(ts):
    return f"btc-updown-15m-{ts}"

def fetch_gamma_market(slug):
    """Query Polymarket Gamma API for a market by slug."""
    url = f"https://gamma-api.polymarket.com/markets?slug={slug}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "btc-demo-bot/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            if isinstance(data, list) and len(data) > 0:
                return data[0]
    except Exception as e:
        log.warning(f"Gamma API error for {slug}: {e}")
    return None

def fetch_clob_prices(condition_id):
    """Fetch best buy prices from the CLOB order book."""
    url = f"https://clob.polymarket.com/book?token_id={condition_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "btc-demo-bot/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            ob = json.loads(r.read())
            bids = ob.get("bids", [])
            best_bid = float(bids[0]["price"]) if bids else None
            return best_bid
    except Exception as e:
        log.debug(f"CLOB error: {e}")
    return None

def fetch_btc_price():
    """Fetch current BTC/USD price from Binance public API."""
    try:
        url = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
        req = urllib.request.Request(url, headers={"User-Agent": "btc-demo-bot/1.0"})
        with urllib.request.urlopen(req, timeout=6) as r:
            return float(json.loads(r.read())["price"])
    except Exception as e:
        log.debug(f"Binance error: {e}")
    return None

def fetch_btc_klines(interval="1m", limit=30):
    """Fetch recent klines (OHLCV) from Binance."""
    try:
        url = f"https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval={interval}&limit={limit}"
        req = urllib.request.Request(url, headers={"User-Agent": "btc-demo-bot/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = json.loads(r.read())
            # [open_time, open, high, low, close, volume, ...]
            return [(float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])) for k in raw]
    except Exception as e:
        log.debug(f"Klines error: {e}")
    return []

def find_active_market():
    """Try current and previous 15m window slots to find an open market."""
    for offset in [0, -1, 1, -2]:
        ts = get_current_15m_timestamp() + (offset * 900)
        slug = build_slug(ts)
        market = fetch_gamma_market(slug)
        if market and market.get("active", False) and not market.get("closed", True):
            log.info(f"Found active market: {slug}")
            return market, slug, ts
    return None, None, None

# ─────────────── SIGNAL ENGINE ───────────────

def compute_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

def compute_ema(values, period):
    if not values:
        return 0.0
    k = 2 / (period + 1)
    ema = values[0]
    for v in values[1:]:
        ema = v * k + ema * (1 - k)
    return ema

def compute_macd(closes):
    if len(closes) < 26:
        return 0.0, 0.0
    ema12 = compute_ema(closes[-26:], 12)
    ema26 = compute_ema(closes[-26:], 26)
    macd_line = ema12 - ema26
    # Signal = 9-period EMA of MACD (approximate)
    signal = compute_ema([macd_line] * 9, 9)
    return macd_line, signal

def compute_vwap(klines):
    if not klines:
        return 0.0
    numerator = sum(((h + l + c) / 3) * v for _, h, l, c, v in klines)
    denominator = sum(v for _, _, _, _, v in klines)
    return numerator / denominator if denominator else 0.0

def generate_signal(klines_1m, klines_5m, btc_price):
    """
    Multi-factor signal engine.
    Returns: direction ('UP'|'DOWN'|None), probability (0-1), reasons (list)
    """
    if len(klines_1m) < 20 or btc_price is None:
        return None, 0.5, ["Insufficient data"]

    closes_1m = [k[3] for k in klines_1m]
    closes_5m = [k[3] for k in klines_5m] if klines_5m else closes_1m

    rsi = compute_rsi(closes_1m)
    macd, macd_sig = compute_macd(closes_1m)
    vwap = compute_vwap(klines_1m[-15:])

    # Momentum: last 3 closes direction
    short_mom = closes_1m[-1] - closes_1m[-4] if len(closes_1m) >= 4 else 0
    # Medium momentum: last 10 closes
    med_mom = closes_1m[-1] - closes_1m[-11] if len(closes_1m) >= 11 else 0

    scores = []
    reasons = []

    # RSI
    if rsi < 35:
        scores.append(+0.20)
        reasons.append(f"RSI oversold ({rsi:.1f})")
    elif rsi > 65:
        scores.append(-0.20)
        reasons.append(f"RSI overbought ({rsi:.1f})")
    elif 45 <= rsi <= 55:
        scores.append(0)
        reasons.append(f"RSI neutral ({rsi:.1f})")
    elif rsi < 50:
        scores.append(+0.08)
    else:
        scores.append(-0.08)

    # MACD crossover
    if macd > macd_sig and macd > 0:
        scores.append(+0.18)
        reasons.append("MACD bullish crossover")
    elif macd < macd_sig and macd < 0:
        scores.append(-0.18)
        reasons.append("MACD bearish crossover")
    else:
        scores.append(+0.05 if macd > macd_sig else -0.05)

    # Price vs VWAP
    if vwap > 0:
        pct_from_vwap = (btc_price - vwap) / vwap * 100
        if pct_from_vwap > 0.05:
            scores.append(-0.10)
            reasons.append(f"Price above VWAP (+{pct_from_vwap:.2f}%)")
        elif pct_from_vwap < -0.05:
            scores.append(+0.10)
            reasons.append(f"Price below VWAP ({pct_from_vwap:.2f}%)")
        else:
            scores.append(0)

    # Short momentum
    if short_mom > 0:
        scores.append(+0.12)
        reasons.append("Positive 3m momentum")
    elif short_mom < 0:
        scores.append(-0.12)
        reasons.append("Negative 3m momentum")

    # Medium momentum
    if med_mom > 0:
        scores.append(+0.08)
    elif med_mom < 0:
        scores.append(-0.08)

    total = sum(scores)
    # Convert score to probability (sigmoid-like)
    prob_up = 0.5 + total * 0.5
    prob_up = max(0.30, min(0.70, prob_up))

    if prob_up >= MIN_PROB:
        return "UP", prob_up, reasons
    elif (1 - prob_up) >= MIN_PROB:
        return "DOWN", 1 - prob_up, reasons
    return None, prob_up, reasons + ["No clear edge"]

# ─────────────── STATE ───────────────

state = {
    "balance": DEMO_CAPITAL,
    "initial": DEMO_CAPITAL,
    "trades": [],            # completed trades
    "open_positions": [],    # active bets
    "btc_price": None,
    "last_market_slug": None,
    "last_market_end_ts": None,
    "status": "Starting…",
    "signal": None,
    "signal_prob": 0.5,
    "signal_reasons": [],
    "rsi": 50.0,
    "last_update": None,
    "errors": deque(maxlen=10),
    "btc_history": deque(maxlen=60),  # last 60 price ticks
    "total_bets": 0,
    "wins": 0,
    "losses": 0,
    "market_found": False,
}
state_lock = threading.Lock()

# ─────────────── BOT LOOP ───────────────

def resolve_open_positions():
    """Check if any open positions should be resolved (market ended)."""
    now_ts = int(time.time())
    with state_lock:
        still_open = []
        for pos in state["open_positions"]:
            end_ts = pos["end_ts"]
            if now_ts >= end_ts + 30:  # 30s grace after window ends
                # Fetch resolution from Gamma API
                market = fetch_gamma_market(pos["slug"])
                resolved = False
                if market:
                    resolution = market.get("resolution", "")
                    if resolution in ("UP", "DOWN"):
                        won = (resolution == pos["direction"])
                        pnl = pos["stake"] * (1 / pos["entry_price"] - 1) if won else -pos["stake"]
                        state["balance"] += pos["stake"] + (pnl if won else 0)
                        trade = {**pos, "pnl": round(pnl, 2), "won": won,
                                 "resolution": resolution,
                                 "closed_at": datetime.now(timezone.utc).isoformat()}
                        state["trades"].insert(0, trade)
                        if len(state["trades"]) > 50:
                            state["trades"] = state["trades"][:50]
                        state["total_bets"] += 1
                        if won:
                            state["wins"] += 1
                        else:
                            state["losses"] += 1
                        log.info(f"Trade resolved: {pos['direction']} {resolution} | PnL ${pnl:.2f}")
                        resolved = True
                    elif resolution in ("", None) and not market.get("active"):
                        # Market closed but no resolution yet — simulate with Binance price
                        # We use the BTC price change as a proxy
                        if state["btc_price"] and pos.get("btc_at_entry"):
                            price_diff = state["btc_price"] - pos["btc_at_entry"]
                            resolution = "UP" if price_diff >= 0 else "DOWN"
                            won = (resolution == pos["direction"])
                            pnl = pos["stake"] * (1 / pos["entry_price"] - 1) if won else -pos["stake"]
                            state["balance"] += pos["stake"] + (pnl if won else 0)
                            trade = {**pos, "pnl": round(pnl, 2), "won": won,
                                     "resolution": resolution + "*",
                                     "closed_at": datetime.now(timezone.utc).isoformat()}
                            state["trades"].insert(0, trade)
                            if len(state["trades"]) > 50:
                                state["trades"] = state["trades"][:50]
                            state["total_bets"] += 1
                            if won: state["wins"] += 1
                            else: state["losses"] += 1
                            resolved = True
                if not resolved:
                    still_open.append(pos)
            else:
                still_open.append(pos)
        state["open_positions"] = still_open

def bot_loop():
    log.info("Bot loop started.")
    while True:
        try:
            # 1. Fetch BTC price
            btc_price = fetch_btc_price()
            klines_1m = fetch_btc_klines("1m", 30)
            klines_5m = fetch_btc_klines("5m", 20)

            with state_lock:
                if btc_price:
                    state["btc_price"] = btc_price
                    state["btc_history"].append({"t": int(time.time()), "p": btc_price})
                closes_1m = [k[3] for k in klines_1m]
                state["rsi"] = compute_rsi(closes_1m) if closes_1m else 50.0
                state["last_update"] = datetime.now(timezone.utc).isoformat()

            # 2. Resolve completed positions
            resolve_open_positions()

            # 3. Find active market
            market, slug, ts = find_active_market()
            with state_lock:
                if market:
                    state["market_found"] = True
                    state["last_market_slug"] = slug
                    state["last_market_end_ts"] = ts + 900
                    state["status"] = f"Market found: {slug}"
                else:
                    state["market_found"] = False
                    state["status"] = "Waiting for next 15m window…"

            # 4. Generate signal
            direction, prob, reasons = generate_signal(klines_1m, klines_5m, btc_price)
            with state_lock:
                state["signal"] = direction
                state["signal_prob"] = round(prob, 3)
                state["signal_reasons"] = reasons

            # 5. Decide whether to place a trade
            if market and direction and btc_price:
                with state_lock:
                    open_count = len(state["open_positions"])
                    balance = state["balance"]
                    already_in_this_market = any(p["slug"] == slug for p in state["open_positions"])

                if open_count < MAX_OPEN_TRADES and not already_in_this_market:
                    # Fetch market token IDs
                    tokens_raw = market.get("tokens") or market.get("clobTokenIds") or "[]"
                    if isinstance(tokens_raw, str):
                        try:
                            tokens = json.loads(tokens_raw)
                        except:
                            tokens = []
                    else:
                        tokens = tokens_raw if isinstance(tokens_raw, list) else []

                    # Determine UP/DOWN token (UP is usually first)
                    token_idx = 0 if direction == "UP" else 1
                    token_id = tokens[token_idx] if len(tokens) > token_idx else None

                    # Get market price
                    market_price = None
                    if token_id:
                        market_price = fetch_clob_prices(str(token_id))

                    # Fallback: use outcome prices from market metadata
                    if market_price is None:
                        outcomes_prices = market.get("outcomePrices") or "[]"
                        if isinstance(outcomes_prices, str):
                            try:
                                op = json.loads(outcomes_prices)
                                market_price = float(op[token_idx]) if len(op) > token_idx else 0.5
                            except:
                                market_price = 0.5
                        elif isinstance(outcomes_prices, list) and len(outcomes_prices) > token_idx:
                            market_price = float(outcomes_prices[token_idx])
                        else:
                            market_price = 0.5

                    # Edge check: our prob vs market implied prob
                    edge = prob - market_price
                    if edge >= MIN_EDGE and market_price < 0.95:
                        stake = round(balance * BET_FRACTION, 2)
                        if stake >= 1.0:
                            end_ts = ts + 900
                            pos = {
                                "slug": slug,
                                "direction": direction,
                                "stake": stake,
                                "entry_price": market_price,
                                "prob": round(prob, 3),
                                "edge": round(edge, 3),
                                "end_ts": end_ts,
                                "btc_at_entry": btc_price,
                                "reasons": reasons,
                                "opened_at": datetime.now(timezone.utc).isoformat(),
                                "window_end": datetime.fromtimestamp(end_ts, tz=timezone.utc).strftime("%H:%M UTC"),
                            }
                            with state_lock:
                                state["balance"] -= stake
                                state["open_positions"].append(pos)
                            log.info(f"Placed {direction} bet | Stake ${stake:.2f} | Price {market_price:.3f} | Edge {edge:.3f} | Prob {prob:.3f}")
                        else:
                            log.info("Stake too small, skipping")
                    else:
                        log.info(f"No edge ({edge:.3f} < {MIN_EDGE}) or price too high ({market_price:.2f}), skipping")

        except Exception as e:
            log.error(f"Bot loop error: {e}")
            with state_lock:
                state["errors"].appendleft(f"{datetime.now().strftime('%H:%M:%S')} {e}")

        time.sleep(POLL_INTERVAL)

# ─────────────── WEB DASHBOARD ───────────────

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BTC-15m Demo Bot</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0c10;--surface:#111318;--border:#1e2230;
  --green:#00e5a0;--red:#ff4560;--blue:#3d9eff;--amber:#ffb800;--muted:#6b7280;
  --text:#e8eaf0;--subtext:#9ca3af;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Space Mono',monospace;font-size:13px;line-height:1.5;min-height:100vh}
a{color:var(--blue);text-decoration:none}

/* grid */
.wrap{max-width:1200px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;justify-content:space-between;padding:12px 0 20px;border-bottom:1px solid var(--border);margin-bottom:20px}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:20px;letter-spacing:-.5px}
.logo span{color:var(--green)}
.badge{background:#1a2a1a;color:var(--green);padding:3px 10px;border-radius:20px;font-size:11px;border:1px solid #2a3a2a}

.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px}

/* cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
.card-head{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px}
.card-val{font-family:'Syne',sans-serif;font-size:26px;font-weight:800}
.card-sub{font-size:11px;color:var(--subtext);margin-top:4px}

.green{color:var(--green)} .red{color:var(--red)} .blue{color:var(--blue)} .amber{color:var(--amber)} .muted{color:var(--muted)}

/* signal box */
.signal-box{border-radius:10px;padding:20px;border:2px solid;text-align:center}
.signal-box.up{border-color:var(--green);background:#0d1f16}
.signal-box.down{border-color:var(--red);background:#1f0d0d}
.signal-box.wait{border-color:var(--border);background:var(--surface)}
.signal-dir{font-family:'Syne',sans-serif;font-size:32px;font-weight:800;letter-spacing:2px}
.signal-prob{font-size:13px;margin-top:4px}

/* trade table */
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid #161a22}
tr:last-child td{border-bottom:none}
tr:hover td{background:#141820}

/* progress bar */
.bar-track{background:#1a1e28;border-radius:4px;height:6px;margin-top:6px}
.bar-fill{height:6px;border-radius:4px;transition:width .5s ease}

/* reasons list */
.reasons{font-size:11px;color:var(--subtext);list-style:none}
.reasons li::before{content:"› ";color:var(--green)}

/* sparkline canvas */
canvas{display:block;width:100%;height:60px}

/* status dot */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.green{background:var(--green);box-shadow:0 0 6px var(--green)}
.dot.red{background:var(--red)}
.dot.amber{background:var(--amber);box-shadow:0 0 6px var(--amber)}

/* open position chip */
.pos-chip{background:#0d1a2a;border:1px solid #1e3450;border-radius:8px;padding:12px;margin-bottom:8px}
.pos-chip:last-child{margin-bottom:0}

/* refresh */
.refresh{font-size:10px;color:var(--muted);text-align:right;margin-bottom:8px}

/* scrollable */
.scroll-area{max-height:260px;overflow-y:auto}
.scroll-area::-webkit-scrollbar{width:4px}
.scroll-area::-webkit-scrollbar-track{background:#111}
.scroll-area::-webkit-scrollbar-thumb{background:#2a2e3a;border-radius:2px}

@media(max-width:700px){
  .grid-4,.grid-3{grid-template-columns:1fr 1fr}
  .grid-2{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">BTC <span>15m</span> Bot</div>
    <div style="display:flex;gap:10px;align-items:center">
      <span id="marketBadge" class="badge">⟳ Checking…</span>
      <span style="color:var(--muted);font-size:11px" id="lastUpdate">—</span>
    </div>
  </header>

  <!-- KPI row -->
  <div class="grid-4">
    <div class="card">
      <div class="card-head">Balance</div>
      <div class="card-val" id="balance">$2,000.00</div>
      <div class="card-sub" id="pnlBadge">—</div>
    </div>
    <div class="card">
      <div class="card-head">BTC Price</div>
      <div class="card-val blue" id="btcPrice">—</div>
      <div class="card-sub">Binance spot</div>
    </div>
    <div class="card">
      <div class="card-head">Win Rate</div>
      <div class="card-val" id="winRate">—</div>
      <div class="card-sub" id="wlRecord">0W / 0L</div>
    </div>
    <div class="card">
      <div class="card-head">Total Bets</div>
      <div class="card-val amber" id="totalBets">0</div>
      <div class="card-sub" id="openCount">0 open positions</div>
    </div>
  </div>

  <div class="grid-3">
    <!-- Signal -->
    <div id="signalBox" class="signal-box wait">
      <div class="card-head">Signal</div>
      <div class="signal-dir muted" id="signalDir">WAITING</div>
      <div class="signal-prob" id="signalProb">Model probability: —</div>
      <ul class="reasons" id="signalReasons" style="margin-top:10px;text-align:left"></ul>
    </div>

    <!-- RSI + indicators -->
    <div class="card">
      <div class="card-head">RSI (14)</div>
      <div class="card-val" id="rsiVal">50</div>
      <div class="bar-track">
        <div class="bar-fill" id="rsiBar" style="width:50%;background:var(--blue)"></div>
      </div>
      <div class="card-sub" style="margin-top:10px">RSI &lt; 35 = oversold · RSI &gt; 65 = overbought</div>

      <div style="margin-top:14px">
        <div class="card-head">Edge Required</div>
        <div style="font-size:11px;color:var(--subtext)">Min edge: <span class="green">{MIN_EDGE_PCT}%</span> &nbsp;|&nbsp; Min prob: <span class="green">{MIN_PROB_PCT}%</span></div>
      </div>
    </div>

    <!-- BTC sparkline -->
    <div class="card">
      <div class="card-head">BTC Price (last 60 ticks)</div>
      <canvas id="spark"></canvas>
      <div class="card-sub" id="sparkStatus" style="margin-top:6px">Collecting data…</div>
    </div>
  </div>

  <div class="grid-2">
    <!-- Open positions -->
    <div class="card">
      <div class="card-head">Open Positions</div>
      <div id="openPositions" class="scroll-area" style="margin-top:4px">
        <div class="muted" style="font-size:12px;padding:8px 0">No open positions</div>
      </div>
    </div>

    <!-- Status & market -->
    <div class="card">
      <div class="card-head">Bot Status</div>
      <div id="botStatus" style="font-size:12px;margin-bottom:12px">—</div>
      <div class="card-head">Current Market</div>
      <div id="marketSlug" style="font-size:11px;color:var(--blue);word-break:break-all">—</div>
      <div id="marketEndTime" style="font-size:11px;color:var(--muted);margin-top:4px">—</div>
    </div>
  </div>

  <!-- Trade history -->
  <div class="card">
    <div class="card-head">Trade History (last 50)</div>
    <div class="scroll-area" style="margin-top:8px">
      <table>
        <thead><tr>
          <th>Time</th><th>Market</th><th>Dir</th><th>Stake</th>
          <th>Entry</th><th>Edge</th><th>Result</th><th>PnL</th>
        </tr></thead>
        <tbody id="tradeBody">
          <tr><td colspan="8" class="muted" style="text-align:center;padding:16px">No trades yet</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="refresh" id="refreshNote">Auto-refreshes every 10 seconds</div>
</div>

<script>
const MIN_EDGE_PCT = "{MIN_EDGE_PCT}";
const MIN_PROB_PCT = "{MIN_PROB_PCT}";

function fmt(n){return n===null||n===undefined?'—':Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtPct(n){return n===null||n===undefined?'—':(n*100).toFixed(1)+'%'}
function timeAgo(iso){
  if(!iso) return '—';
  const d=new Date(iso);const now=new Date();
  const s=Math.round((now-d)/1000);
  if(s<5)return 'just now';if(s<60)return s+'s ago';
  const m=Math.round(s/60);if(m<60)return m+'m ago';
  return d.toLocaleTimeString();
}

let sparkData=[];

function drawSpark(data){
  const c=document.getElementById('spark');
  if(!c)return;
  const ctx=c.getContext('2d');
  c.width=c.offsetWidth||300;c.height=60;
  if(data.length<2){ctx.clearRect(0,0,c.width,c.height);return;}
  const prices=data.map(d=>d.p);
  const mn=Math.min(...prices),mx=Math.max(...prices);
  const rng=mx-mn||1;
  const w=c.width,h=c.height;
  ctx.clearRect(0,0,w,h);
  const grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,'rgba(61,158,255,0.3)');
  grad.addColorStop(1,'rgba(61,158,255,0)');
  ctx.beginPath();
  data.forEach((d,i)=>{
    const x=i/(data.length-1)*w;
    const y=h-(d.p-mn)/rng*(h-6)-3;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  const lastY=h-(prices[prices.length-1]-mn)/rng*(h-6)-3;
  ctx.strokeStyle='#3d9eff';ctx.lineWidth=1.5;ctx.stroke();
  ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();
  ctx.fillStyle=grad;ctx.fill();
}

async function refresh(){
  try{
    const r=await fetch('/api/state');
    const d=await r.json();

    // Balance
    document.getElementById('balance').textContent='$'+fmt(d.balance);
    const pnl=d.balance-d.initial;
    const pnlEl=document.getElementById('pnlBadge');
    pnlEl.textContent=(pnl>=0?'+':'')+fmt(pnl)+' ('+(pnl/d.initial*100).toFixed(1)+'%)';
    pnlEl.className='card-sub '+(pnl>=0?'green':'red');

    // BTC price
    if(d.btc_price) document.getElementById('btcPrice').textContent='$'+fmt(d.btc_price);

    // Win rate
    const wr=d.total_bets>0?Math.round(d.wins/d.total_bets*100):0;
    const wrEl=document.getElementById('winRate');
    wrEl.textContent=d.total_bets>0?wr+'%':'—';
    wrEl.className='card-val '+(wr>=50?'green':'red');
    document.getElementById('wlRecord').textContent=d.wins+'W / '+d.losses+'L';
    document.getElementById('totalBets').textContent=d.total_bets;
    document.getElementById('openCount').textContent=d.open_positions.length+' open position'+(d.open_positions.length!==1?'s':'');

    // RSI
    const rsi=d.rsi||50;
    document.getElementById('rsiVal').textContent=rsi.toFixed(1);
    const rsiBar=document.getElementById('rsiBar');
    rsiBar.style.width=rsi+'%';
    rsiBar.style.background=rsi<35?'var(--green)':rsi>65?'var(--red)':'var(--blue)';

    // Signal
    const sigBox=document.getElementById('signalBox');
    const sigDir=document.getElementById('signalDir');
    const sigProb=document.getElementById('signalProb');
    const sigReas=document.getElementById('signalReasons');
    if(d.signal==='UP'){
      sigBox.className='signal-box up';
      sigDir.className='signal-dir green';sigDir.textContent='▲ UP';
    } else if(d.signal==='DOWN'){
      sigBox.className='signal-box down';
      sigDir.className='signal-dir red';sigDir.textContent='▼ DOWN';
    } else {
      sigBox.className='signal-box wait';
      sigDir.className='signal-dir muted';sigDir.textContent='WAITING';
    }
    sigProb.textContent='Model probability: '+(d.signal_prob*100).toFixed(1)+'%';
    sigReas.innerHTML=(d.signal_reasons||[]).slice(0,4).map(r=>'<li>'+r+'</li>').join('');

    // Market badge
    const badge=document.getElementById('marketBadge');
    if(d.market_found){
      badge.textContent='● Market Live';badge.style.color='var(--green)';badge.style.background='#0d1f0d';badge.style.borderColor='#1a3a1a';
    } else {
      badge.textContent='○ Seeking Market';badge.style.color='var(--amber)';badge.style.background='#1f1a0d';badge.style.borderColor='#3a2a1a';
    }

    // Status
    document.getElementById('botStatus').innerHTML='<span class="dot '+(d.market_found?'green':'amber')+'"></span>'+d.status;
    document.getElementById('marketSlug').textContent=d.last_market_slug||'—';
    if(d.last_market_end_ts){
      const end=new Date(d.last_market_end_ts*1000);
      const now=new Date();
      const secsLeft=Math.max(0,Math.round((end-now)/1000));
      document.getElementById('marketEndTime').textContent='Resolves in: '+secsLeft+'s ('+end.toLocaleTimeString()+')';
    }
    document.getElementById('lastUpdate').textContent=timeAgo(d.last_update);

    // Open positions
    const opEl=document.getElementById('openPositions');
    if(d.open_positions.length===0){
      opEl.innerHTML='<div class="muted" style="font-size:12px;padding:8px 0">No open positions</div>';
    } else {
      opEl.innerHTML=d.open_positions.map(p=>{
        const end=new Date(p.end_ts*1000);
        const secsLeft=Math.max(0,Math.round((end-new Date())/1000));
        return '<div class="pos-chip">'
          +'<span class="'+(p.direction==='UP'?'green':'red')+'" style="font-weight:700">'+p.direction+'</span>'
          +' &nbsp;<span class="amber">$'+fmt(p.stake)+'</span>'
          +' &nbsp;<span class="muted">@'+fmt(p.entry_price*100)+'¢</span>'
          +' &nbsp;<span style="float:right;color:var(--muted)">'+secsLeft+'s left</span>'
          +'<div style="font-size:10px;color:var(--muted);margin-top:4px">'
          +'Edge: '+(p.edge*100).toFixed(1)+'% | Prob: '+(p.prob*100).toFixed(1)+'% | BTC @ $'+fmt(p.btc_at_entry)
          +'</div></div>';
      }).join('');
    }

    // Sparkline
    sparkData=d.btc_history||[];
    drawSpark(sparkData);
    if(sparkData.length>0) document.getElementById('sparkStatus').textContent='Latest: $'+fmt(sparkData[sparkData.length-1].p);

    // Trade history
    const tbody=document.getElementById('tradeBody');
    if(d.trades.length===0){
      tbody.innerHTML='<tr><td colspan="8" class="muted" style="text-align:center;padding:16px">No trades yet</td></tr>';
    } else {
      tbody.innerHTML=d.trades.map(t=>{
        const won=t.won;
        const ts=t.closed_at?new Date(t.closed_at).toLocaleTimeString():'—';
        const shortSlug=t.slug?t.slug.replace('btc-updown-15m-',''):'—';
        return '<tr>'
          +'<td class="muted">'+ts+'</td>'
          +'<td class="muted" style="font-size:10px">…'+shortSlug+'</td>'
          +'<td class="'+(t.direction==='UP'?'green':'red')+'">'+t.direction+'</td>'
          +'<td>$'+fmt(t.stake)+'</td>'
          +'<td>'+(t.entry_price*100).toFixed(1)+'¢</td>'
          +'<td class="muted">'+(t.edge*100).toFixed(1)+'%</td>'
          +'<td class="'+(won?'green':'red')+'">'+(t.resolution||'—')+(won?' ✓':' ✗')+'</td>'
          +'<td class="'+(t.pnl>=0?'green':'red')+'">'+(t.pnl>=0?'+':'')+fmt(t.pnl)+'</td>'
          +'</tr>';
      }).join('');
    }
  } catch(e){ console.error('Refresh error',e); }
}

refresh();
setInterval(refresh, 10000);
window.addEventListener('resize',()=>drawSpark(sparkData));
</script>
</body>
</html>
""".replace("{MIN_EDGE_PCT}", str(int(MIN_EDGE*100))).replace("{MIN_PROB_PCT}", str(int(MIN_PROB*100)))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # silence default access logs

    def do_GET(self):
        if self.path == "/api/state":
            with state_lock:
                payload = {
                    "balance": round(state["balance"], 2),
                    "initial": state["initial"],
                    "btc_price": state["btc_price"],
                    "rsi": round(state["rsi"], 2),
                    "signal": state["signal"],
                    "signal_prob": state["signal_prob"],
                    "signal_reasons": state["signal_reasons"],
                    "open_positions": list(state["open_positions"]),
                    "trades": list(state["trades"]),
                    "last_market_slug": state["last_market_slug"],
                    "last_market_end_ts": state["last_market_end_ts"],
                    "status": state["status"],
                    "market_found": state["market_found"],
                    "last_update": state["last_update"],
                    "btc_history": list(state["btc_history"]),
                    "total_bets": state["total_bets"],
                    "wins": state["wins"],
                    "losses": state["losses"],
                }
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/", "/index.html"):
            body = HTML_TEMPLATE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


def run_server():
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    log.info(f"Dashboard running on http://0.0.0.0:{PORT}")
    server.serve_forever()


# ─────────────── ENTRY POINT ───────────────

if __name__ == "__main__":
    log.info("=" * 50)
    log.info("  Polymarket BTC 15m Demo Bot")
    log.info(f"  Starting capital: ${DEMO_CAPITAL:,.2f}")
    log.info(f"  Bet size: {int(BET_FRACTION*100)}% of balance")
    log.info(f"  Min edge: {int(MIN_EDGE*100)}% | Min prob: {int(MIN_PROB*100)}%")
    log.info(f"  Max open positions: {MAX_OPEN_TRADES}")
    log.info("=" * 50)

    # Start bot in background thread
    t = threading.Thread(target=bot_loop, daemon=True)
    t.start()

    # Run web server in main thread (Railway binds to PORT)
    run_server()
