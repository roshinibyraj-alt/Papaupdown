"""
═══════════════════════════════════════════════════════════════
  Polymarket BTC 15-Minute DEMO Trading Bot
  ▸ $2,000 virtual capital  |  Paper trades only  |  No real money
  ▸ Live dashboard at your Railway URL
  ▸ Bot loop runs in background thread; Flask serves the UI
═══════════════════════════════════════════════════════════════
"""

import os, json, time, logging, threading
from datetime import datetime, timezone
from collections import deque

import requests
from flask import Flask, jsonify, render_template_string

# ── CONFIG ─────────────────────────────────────────────────────────────────────
DEMO_CAPITAL       = float(os.environ.get("DEMO_CAPITAL",        "2000"))
MAX_TRADE_USD      = float(os.environ.get("MAX_TRADE_USD",         "20"))
MAX_OPEN_POSITIONS = int  (os.environ.get("MAX_OPEN_POSITIONS",    "10"))
STOP_LOSS_PCT      = float(os.environ.get("STOP_LOSS_PCT",        "0.30"))
TAKE_PROFIT_PCT    = float(os.environ.get("TAKE_PROFIT_PCT",      "0.20"))
SPIKE_THRESHOLD    = float(os.environ.get("SPIKE_THRESHOLD",     "0.003"))
MIN_EDGE_PRICE     = float(os.environ.get("MIN_EDGE_PRICE",       "0.35"))
MAX_EDGE_PRICE     = float(os.environ.get("MAX_EDGE_PRICE",       "0.65"))
LOOP_INTERVAL      = int  (os.environ.get("LOOP_INTERVAL",        "900"))
TRADES_FILE        = os.environ.get("TRADES_FILE", "paper_trades.json")
PORT               = int  (os.environ.get("PORT", "8080"))

# ── LOGGING ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("PolyBot")

# ── SHARED STATE ───────────────────────────────────────────────────────────────
price_history: deque = deque(maxlen=10)
signal_log:    deque = deque(maxlen=20)

portfolio = {
    "cash":           DEMO_CAPITAL,
    "open_positions": [],
    "closed_trades":  [],
    "total_profit":   0.0,
    "wins":           0,
    "losses":         0,
    "skipped":        0,
}

status = {
    "btc_price":    None,
    "fear_greed":   None,
    "last_market":  "—",
    "last_cycle":   "Never",
    "next_cycle":   "—",
    "bot_running":  False,
}


# ══════════════════════════════════════════════════════════════════════════════
#  DATA FETCHERS
# ══════════════════════════════════════════════════════════════════════════════

def get_btc_price() -> float | None:
    try:
        r = requests.get("https://api.binance.com/api/v3/ticker/price",
                         params={"symbol": "BTCUSDT"}, timeout=8)
        r.raise_for_status()
        return float(r.json()["price"])
    except Exception:
        pass
    try:
        r = requests.get("https://api.coingecko.com/api/v3/simple/price",
                         params={"ids": "bitcoin", "vs_currencies": "usd"}, timeout=10)
        r.raise_for_status()
        return float(r.json()["bitcoin"]["usd"])
    except Exception as e:
        log.warning(f"BTC price fetch failed: {e}")
    return None


def get_fear_greed() -> int | None:
    try:
        r = requests.get("https://api.alternative.me/fng/?limit=1", timeout=8)
        r.raise_for_status()
        return int(r.json()["data"][0]["value"])
    except Exception as e:
        log.warning(f"Fear & Greed fetch failed: {e}")
    return None


def find_btc_15m_market() -> dict | None:
    keywords = ("btc", "bitcoin")
    try:
        r = requests.get("https://gamma-api.polymarket.com/markets",
                         params={"active": "true", "closed": "false",
                                 "limit": 100, "order": "startDate", "ascending": "false"},
                         timeout=10)
        r.raise_for_status()
        markets = r.json()
        if not isinstance(markets, list):
            markets = markets.get("markets", [])
        for m in markets:
            q = m.get("question", "").lower()
            if any(k in q for k in keywords) and "15" in q:
                return m
    except Exception as e:
        log.warning(f"Market search failed: {e}")
    return None


def extract_prices_from_market(market: dict) -> dict | None:
    # Method 1: tokens array
    tokens = market.get("tokens", [])
    if tokens:
        prices = {}
        for tok in tokens:
            outcome = tok.get("outcome", "").upper()
            price   = tok.get("price")
            if price is not None and outcome in ("YES", "NO"):
                prices[outcome.lower()] = float(price)
        if "yes" in prices and "no" in prices:
            return prices

    # Method 2: outcomePrices + outcomes fields
    op_raw  = market.get("outcomePrices")
    out_raw = market.get("outcomes")
    if op_raw and out_raw:
        try:
            op       = json.loads(op_raw)  if isinstance(op_raw,  str) else op_raw
            outcomes = json.loads(out_raw) if isinstance(out_raw, str) else out_raw
            prices   = {}
            for label, price in zip(outcomes, op):
                key = label.strip().lower()
                if key in ("yes", "up", "higher", "above"):
                    prices["yes"] = float(price)
                elif key in ("no", "down", "lower", "below"):
                    prices["no"] = float(price)
            if "yes" in prices and "no" in prices:
                return prices
            if len(op) == 2 and "yes" not in prices:
                return {"yes": float(op[0]), "no": float(op[1])}
        except Exception as e:
            log.debug(f"outcomePrices parse failed: {e}")

    # Method 3: CLOB fallback
    condition_id = market.get("conditionId") or market.get("id")
    if condition_id:
        try:
            r = requests.get(f"https://clob.polymarket.com/markets/{condition_id}", timeout=8)
            r.raise_for_status()
            tokens = r.json().get("tokens", [])
            prices = {}
            for tok in tokens:
                outcome = tok.get("outcome", "").upper()
                price   = tok.get("price")
                if price is not None and outcome in ("YES", "NO"):
                    prices[outcome.lower()] = float(price)
            if "yes" in prices and "no" in prices:
                return prices
        except Exception as e:
            log.debug(f"CLOB fallback failed: {e}")

    return None


# ══════════════════════════════════════════════════════════════════════════════
#  SIGNAL ENGINE
# ══════════════════════════════════════════════════════════════════════════════

def compute_signals(current_price: float, fear_greed: int | None) -> dict:
    scores, reasons = [], []

    if len(price_history) >= 2:
        prev  = price_history[-2]
        move  = (current_price - prev) / prev
        score = min(abs(move) / SPIKE_THRESHOLD, 1.0)
        if move > SPIKE_THRESHOLD:
            scores.append(("YES", score))
            reasons.append(f"Spike UP {move*100:.2f}%")
        elif move < -SPIKE_THRESHOLD:
            scores.append(("NO", score))
            reasons.append(f"Spike DOWN {move*100:.2f}%")
        else:
            reasons.append(f"No spike ({move*100:.3f}%)")

    if len(price_history) >= 3:
        last3 = list(price_history)[-3:]
        if last3[0] < last3[1] < last3[2]:
            scores.append(("YES", 0.6))
            reasons.append("Trend UP (3-bar)")
        elif last3[0] > last3[1] > last3[2]:
            scores.append(("NO", 0.6))
            reasons.append("Trend DOWN (3-bar)")
        else:
            reasons.append("No clear trend")

    if fear_greed is not None:
        if fear_greed >= 70:
            scores.append(("YES", 0.55))
            reasons.append(f"Greed {fear_greed}/100")
        elif fear_greed <= 30:
            scores.append(("NO", 0.55))
            reasons.append(f"Fear {fear_greed}/100")
        else:
            reasons.append(f"Neutral {fear_greed}/100")

    if not scores:
        return {"direction": "SKIP", "confidence": 0.0, "reasons": reasons}

    yes_score = sum(s for d, s in scores if d == "YES")
    no_score  = sum(s for d, s in scores if d == "NO")
    total     = yes_score + no_score
    if total == 0:
        return {"direction": "SKIP", "confidence": 0.0, "reasons": reasons}

    yes_pct = yes_score / total
    if yes_pct > 0.55:
        return {"direction": "YES", "confidence": yes_pct, "reasons": reasons}
    elif yes_pct < 0.45:
        return {"direction": "NO",  "confidence": 1 - yes_pct, "reasons": reasons}
    else:
        return {"direction": "SKIP", "confidence": 0.0,
                "reasons": reasons + ["Mixed signals → skip"]}


# ══════════════════════════════════════════════════════════════════════════════
#  PAPER TRADE EXECUTION
# ══════════════════════════════════════════════════════════════════════════════

def execute_demo_trade(signal, market, clob_prices, btc_price):
    direction  = signal["direction"]
    confidence = signal["confidence"]
    yes_price  = clob_prices["yes"]

    if not (MIN_EDGE_PRICE <= yes_price <= MAX_EDGE_PRICE):
        log.info(f"  ↳ Skipping — YES price {yes_price:.3f} outside edge range")
        portfolio["skipped"] += 1
        return

    side       = direction
    side_price = clob_prices[side.lower()]
    trade_usd  = min(MAX_TRADE_USD * confidence, portfolio["cash"], MAX_TRADE_USD)
    if trade_usd < 1.0:
        log.info("  ↳ Skipping — insufficient cash")
        portfolio["skipped"] += 1
        return

    shares = round(trade_usd / side_price, 4)
    portfolio["cash"] -= trade_usd

    position = {
        "id":           f"trade_{int(time.time())}",
        "market_id":    market.get("conditionId", market.get("id", "unknown")),
        "question":     market.get("question", "BTC 15m")[:80],
        "side":         side,
        "shares":       shares,
        "entry_price":  side_price,
        "cost_usd":     trade_usd,
        "btc_at_entry": btc_price,
        "stop_loss":    side_price * (1 - STOP_LOSS_PCT),
        "take_profit":  side_price * (1 + TAKE_PROFIT_PCT),
        "confidence":   round(confidence, 3),
        "opened_at":    datetime.now(timezone.utc).isoformat(),
        "status":       "open",
    }
    portfolio["open_positions"].append(position)
    log.info(f"  📥 DEMO TRADE  {side}  ${trade_usd:.2f}  →  "
             f"{shares:.2f} shares @ {side_price:.3f}  confidence {confidence:.0%}")


def resolve_positions(current_btc, clob_prices):
    if not clob_prices:
        return
    still_open = []
    for pos in portfolio["open_positions"]:
        mark_price = clob_prices.get(pos["side"].lower(), pos["entry_price"])
        pnl        = (mark_price - pos["entry_price"]) * pos["shares"]

        if mark_price <= pos["stop_loss"]:
            outcome = "STOP LOSS"
        elif mark_price >= pos["take_profit"]:
            outcome = "TAKE PROFIT"
        else:
            still_open.append(pos)
            continue

        proceeds = mark_price * pos["shares"]
        portfolio["cash"] += proceeds
        portfolio["total_profit"] += pnl
        pos.update({"status": "closed",
                    "closed_at": datetime.now(timezone.utc).isoformat(),
                    "exit_price": mark_price,
                    "pnl_usd": round(pnl, 4)})
        portfolio["closed_trades"].append(pos)
        if pnl >= 0:
            portfolio["wins"]   += 1
            emoji = "✅"
        else:
            portfolio["losses"] += 1
            emoji = "❌"
        log.info(f"  {emoji} CLOSED [{outcome}]  pnl ${pnl:+.2f}  cash ${portfolio['cash']:.2f}")

    portfolio["open_positions"] = still_open


# ══════════════════════════════════════════════════════════════════════════════
#  PERSISTENCE
# ══════════════════════════════════════════════════════════════════════════════

def save_state():
    try:
        with open(TRADES_FILE, "w") as f:
            json.dump(portfolio, f, indent=2)
    except Exception as e:
        log.warning(f"Failed to save state: {e}")


def load_state():
    if os.path.exists(TRADES_FILE):
        try:
            with open(TRADES_FILE) as f:
                saved = json.load(f)
            portfolio.update(saved)
            log.info(f"Loaded saved state — cash ${portfolio['cash']:.2f}")
        except Exception as e:
            log.warning(f"Could not load saved state: {e}")


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN BOT LOOP
# ══════════════════════════════════════════════════════════════════════════════

def run_cycle():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    log.info("═" * 60)
    log.info(f"  🔄 CYCLE START  {now}")
    log.info("═" * 60)

    btc_price  = get_btc_price()
    fear_greed = get_fear_greed()

    if btc_price is None:
        log.error("Cannot fetch BTC price — skipping cycle")
        return

    price_history.append(btc_price)
    status["btc_price"]  = btc_price
    status["fear_greed"] = fear_greed
    status["last_cycle"] = now

    log.info(f"  BTC: ${btc_price:,.2f}  |  Fear/Greed: {fear_greed}/100")

    market      = find_btc_15m_market()
    clob_prices = None
    signal      = {"direction": "SKIP", "confidence": 0.0, "reasons": ["No market found"]}

    if market:
        status["last_market"] = market.get("question", "—")[:70]
        log.info(f"  Market: {status['last_market']}")

        clob_prices = extract_prices_from_market(market)
        if clob_prices:
            log.info(f"  Prices  YES={clob_prices['yes']:.3f}  NO={clob_prices['no']:.3f}")
        else:
            log.warning("  Could not extract prices — skipping trade")

        resolve_positions(btc_price, clob_prices)

        signal = compute_signals(btc_price, fear_greed)
        log.info(f"  Signal: {signal['direction']}  confidence={signal['confidence']:.0%}")
        for r in signal["reasons"]:
            log.info(f"    • {r}")

        if (signal["direction"] != "SKIP"
                and clob_prices is not None
                and len(portfolio["open_positions"]) < MAX_OPEN_POSITIONS):
            execute_demo_trade(signal, market, clob_prices, btc_price)
        elif signal["direction"] == "SKIP":
            log.info("  → SKIP — no trade this cycle")
        elif len(portfolio["open_positions"]) >= MAX_OPEN_POSITIONS:
            log.info(f"  → Max positions ({MAX_OPEN_POSITIONS}) reached")

    open_val = sum(p["cost_usd"] for p in portfolio["open_positions"])
    equity   = portfolio["cash"] + open_val
    signal_log.appendleft({
        "time":       now,
        "btc":        f"${btc_price:,.2f}",
        "fg":         fear_greed,
        "direction":  signal["direction"],
        "confidence": f"{signal['confidence']:.0%}",
        "reasons":    " · ".join(signal["reasons"]),
        "equity":     f"${equity:,.2f}",
        "prices":     f"YES {clob_prices['yes']:.3f} / NO {clob_prices['no']:.3f}" if clob_prices else "—",
    })

    save_state()


def bot_thread():
    status["bot_running"] = True
    load_state()
    while True:
        try:
            run_cycle()
        except Exception as e:
            log.error(f"Cycle error: {e}", exc_info=True)
        status["next_cycle"] = f"~{LOOP_INTERVAL // 60} min"
        log.info(f"  💤 Sleeping {LOOP_INTERVAL}s…")
        time.sleep(LOOP_INTERVAL)


# ══════════════════════════════════════════════════════════════════════════════
#  FLASK DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════

app = Flask(__name__)

DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polymarket BTC Bot — Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:       #0a0c10;
    --panel:    #111520;
    --border:   #1e2535;
    --green:    #00ff9d;
    --red:      #ff4d6d;
    --amber:    #ffb830;
    --blue:     #4da6ff;
    --muted:    #4a5568;
    --text:     #c9d1e0;
    --heading:  #eef2ff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh;
    padding: 24px;
  }
  body::before {
    content: '';
    position: fixed; inset: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.08) 2px, rgba(0,0,0,.08) 4px);
    pointer-events: none; z-index: 999;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 28px; padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .logo { display: flex; align-items: center; gap: 12px; }
  .logo-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 12px var(--green);
    animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .logo h1 { font-family: 'Space Mono', monospace; font-size: 15px; color: var(--heading); letter-spacing: .08em; }
  .logo span { font-size: 11px; color: var(--muted); }
  .demo-badge {
    background: rgba(255,184,48,.12); color: var(--amber);
    border: 1px solid rgba(255,184,48,.3);
    padding: 4px 12px; border-radius: 20px;
    font-size: 11px; font-family: 'Space Mono', monospace; letter-spacing:.1em;
  }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px 18px;
  }
  .stat-card .label { font-size: 10px; text-transform: uppercase; letter-spacing:.12em; color: var(--muted); margin-bottom: 6px; }
  .stat-card .value { font-family: 'Space Mono', monospace; font-size: 22px; color: var(--heading); }
  .stat-card .value.green { color: var(--green); }
  .stat-card .value.red   { color: var(--red); }
  .stat-card .value.amber { color: var(--amber); }
  .stat-card .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media(max-width:780px){ .grid-2 { grid-template-columns: 1fr; } }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden;
  }
  .panel-header {
    padding: 12px 18px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .panel-header h2 { font-size: 11px; font-family: 'Space Mono', monospace; letter-spacing:.1em; text-transform: uppercase; color: var(--heading); }
  .panel-header .count { font-size: 10px; background: var(--border); padding: 2px 8px; border-radius: 20px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { padding: 8px 14px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing:.1em; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 400; }
  td { padding: 10px 14px; border-bottom: 1px solid rgba(30,37,53,.6); color: var(--text); font-family: 'Space Mono', monospace; font-size: 11px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }
  .empty { padding: 24px; text-align: center; color: var(--muted); font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-family: 'Space Mono', monospace; font-weight: 700; letter-spacing:.05em; }
  .badge-yes  { background: rgba(0,255,157,.12);  color: var(--green); border: 1px solid rgba(0,255,157,.25); }
  .badge-no   { background: rgba(255,77,109,.12); color: var(--red);   border: 1px solid rgba(255,77,109,.25); }
  .badge-skip { background: rgba(74,85,104,.2);   color: var(--muted); border: 1px solid var(--border); }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .market-name { font-family: 'DM Sans', sans-serif; font-size: 11px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .time-cell { color: var(--muted); font-size: 10px; }
  .refresh-bar { text-align: center; padding: 14px; font-size: 10px; color: var(--muted); font-family: 'Space Mono', monospace; letter-spacing:.08em; }
  #countdown { color: var(--amber); }
  .signal-log { max-height: 420px; overflow-y: auto; }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-dot"></div>
    <div>
      <h1>POLYMARKET BTC BOT</h1>
      <span>15-Minute Paper Trading Dashboard</span>
    </div>
  </div>
  <div class="demo-badge">⬡ DEMO MODE</div>
</header>

<div class="stats-row">
  <div class="stat-card"><div class="label">BTC Price</div><div class="value amber" id="btc-price">—</div></div>
  <div class="stat-card"><div class="label">Fear &amp; Greed</div><div class="value" id="fear-greed">—</div><div class="sub" id="fg-label">—</div></div>
  <div class="stat-card"><div class="label">Total Equity</div><div class="value" id="equity">—</div><div class="sub" id="pnl">—</div></div>
  <div class="stat-card"><div class="label">Cash</div><div class="value" id="cash">—</div></div>
  <div class="stat-card"><div class="label">Win Rate</div><div class="value green" id="win-rate">—</div><div class="sub" id="wl">—</div></div>
  <div class="stat-card"><div class="label">Open Positions</div><div class="value blue" id="open-count">—</div></div>
</div>

<div class="grid-2">
  <div class="panel">
    <div class="panel-header"><h2>Open Positions</h2><span class="count" id="open-badge">0</span></div>
    <div id="open-positions-body"><div class="empty">No open positions</div></div>
  </div>
  <div class="panel">
    <div class="panel-header"><h2>Closed Trades</h2><span class="count" id="closed-badge">0</span></div>
    <div id="closed-trades-body"><div class="empty">No closed trades yet</div></div>
  </div>
</div>

<div class="panel">
  <div class="panel-header"><h2>Signal Log</h2></div>
  <div class="signal-log">
    <div id="signal-log-body"><div class="empty">Waiting for first cycle…</div></div>
  </div>
</div>

<div class="refresh-bar">
  Auto-refresh in <span id="countdown">30</span>s &nbsp;·&nbsp; Last update: <span id="last-update">—</span>
</div>

<script>
let countdown = 30;

function fg_label(v) {
  if (v === null) return '—';
  if (v <= 20) return 'Extreme Fear';
  if (v <= 40) return 'Fear';
  if (v <= 60) return 'Neutral';
  if (v <= 80) return 'Greed';
  return 'Extreme Greed';
}
function fg_color(v) {
  if (v === null) return '';
  if (v <= 30) return 'red';
  if (v >= 70) return 'green';
  return 'amber';
}
function pnl_class(v) { return v >= 0 ? 'pos' : 'neg'; }
function dir_badge(d) {
  const cls = d === 'YES' ? 'yes' : d === 'NO' ? 'no' : 'skip';
  return `<span class="badge badge-${cls}">${d}</span>`;
}
function fmt_time(iso) {
  if (!iso || iso === 'Never') return '—';
  const d = new Date(iso.replace(' UTC','Z').replace(' ','T'));
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

async function fetchData() {
  try {
    const res = await fetch('/api/status');
    const d   = await res.json();

    document.getElementById('btc-price').textContent = d.btc_price ? '$' + d.btc_price.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
    const fg = d.fear_greed;
    const fgEl = document.getElementById('fear-greed');
    fgEl.textContent = fg !== null ? fg + '/100' : '—';
    fgEl.className = 'value ' + fg_color(fg);
    document.getElementById('fg-label').textContent = fg_label(fg);
    document.getElementById('equity').textContent = '$' + d.equity.toLocaleString('en-US', {minimumFractionDigits:2});
    const pnl = d.equity - 2000;
    const pnlEl = document.getElementById('pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' vs start';
    pnlEl.className = 'sub ' + pnl_class(pnl);
    document.getElementById('cash').textContent = '$' + d.cash.toLocaleString('en-US', {minimumFractionDigits:2});
    const total = d.wins + d.losses;
    document.getElementById('win-rate').textContent = total ? Math.round(d.wins/total*100) + '%' : '—';
    document.getElementById('wl').textContent = d.wins + 'W / ' + d.losses + 'L  (' + d.skipped + ' skipped)';
    document.getElementById('open-count').textContent = d.open_positions.length;
    document.getElementById('open-badge').textContent = d.open_positions.length;
    document.getElementById('closed-badge').textContent = d.closed_trades.length;

    const opDiv = document.getElementById('open-positions-body');
    if (d.open_positions.length === 0) {
      opDiv.innerHTML = '<div class="empty">No open positions</div>';
    } else {
      let h = '<table><thead><tr><th>Side</th><th>Shares</th><th>Entry</th><th>Cost</th><th>Conf</th></tr></thead><tbody>';
      d.open_positions.forEach(p => {
        h += `<tr><td>${dir_badge(p.side)}<div class="market-name">${p.question}</div></td><td>${p.shares}</td><td>${p.entry_price.toFixed(3)}</td><td>$${p.cost_usd.toFixed(2)}</td><td>${(p.confidence*100).toFixed(0)}%</td></tr>`;
      });
      h += '</tbody></table>';
      opDiv.innerHTML = h;
    }

    const ctDiv = document.getElementById('closed-trades-body');
    const recent = d.closed_trades.slice(-10).reverse();
    if (recent.length === 0) {
      ctDiv.innerHTML = '<div class="empty">No closed trades yet</div>';
    } else {
      let h = '<table><thead><tr><th>Side</th><th>P&amp;L</th><th>Exit</th><th>Time</th></tr></thead><tbody>';
      recent.forEach(p => {
        const pnl = p.pnl_usd || 0;
        const sign = pnl >= 0 ? '+' : '';
        h += `<tr><td>${dir_badge(p.side)}</td><td class="${pnl_class(pnl)}">${sign}$${pnl.toFixed(2)}</td><td>${p.exit_price ? p.exit_price.toFixed(3) : '—'}</td><td class="time-cell">${fmt_time(p.closed_at)}</td></tr>`;
      });
      h += '</tbody></table>';
      ctDiv.innerHTML = h;
    }

    const slDiv = document.getElementById('signal-log-body');
    if (d.signal_log.length === 0) {
      slDiv.innerHTML = '<div class="empty">Waiting for first cycle…</div>';
    } else {
      let h = '<table><thead><tr><th>Time</th><th>BTC</th><th>F&amp;G</th><th>Signal</th><th>Conf</th><th>Prices</th><th>Equity</th><th>Reasons</th></tr></thead><tbody>';
      d.signal_log.forEach(s => {
        h += `<tr><td class="time-cell">${fmt_time(s.time)}</td><td>${s.btc}</td><td>${s.fg !== null ? s.fg : '—'}</td><td>${dir_badge(s.direction)}</td><td>${s.confidence}</td><td>${s.prices}</td><td>${s.equity}</td><td style="color:var(--muted);font-family:'DM Sans',sans-serif;font-size:11px">${s.reasons}</td></tr>`;
      });
      h += '</tbody></table>';
      slDiv.innerHTML = h;
    }

    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
  } catch(e) { console.error('Fetch failed', e); }
}

function tick() {
  countdown--;
  document.getElementById('countdown').textContent = countdown;
  if (countdown <= 0) { countdown = 30; fetchData(); }
}

fetchData();
setInterval(tick, 1000);
</script>
</body>
</html>
"""


@app.route("/")
def dashboard():
    return render_template_string(DASHBOARD_HTML)


@app.route("/api/status")
def api_status():
    open_val = sum(p["cost_usd"] for p in portfolio["open_positions"])
    equity   = portfolio["cash"] + open_val
    return jsonify({
        "btc_price":      status["btc_price"],
        "fear_greed":     status["fear_greed"],
        "last_market":    status["last_market"],
        "last_cycle":     status["last_cycle"],
        "next_cycle":     status["next_cycle"],
        "cash":           portfolio["cash"],
        "equity":         equity,
        "wins":           portfolio["wins"],
        "losses":         portfolio["losses"],
        "skipped":        portfolio["skipped"],
        "open_positions": portfolio["open_positions"],
        "closed_trades":  portfolio["closed_trades"],
        "signal_log":     list(signal_log),
    })


# ══════════════════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    log.info("╔══════════════════════════════════════════════════════╗")
    log.info("║  Polymarket BTC 15-Min DEMO Bot  — Dashboard Edition ║")
    log.info(f"║  Capital: ${DEMO_CAPITAL:,.0f}  |  Max/trade: ${MAX_TRADE_USD:.0f}  |  Port: {PORT}    ║")
    log.info("╚══════════════════════════════════════════════════════╝")

    t = threading.Thread(target=bot_thread, daemon=True)
    t.start()

    app.run(host="0.0.0.0", port=PORT, debug=False)
