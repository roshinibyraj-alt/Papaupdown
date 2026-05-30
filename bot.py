"""
Polymarket Demo Bot — "Liquidity Fade" Strategy
Market: BTC 5-min UP/DOWN binary markets
Logic: Buy the underpriced side (<0.35), sell at TP=0.55 or SL=0.15
Demo mode: $2000 virtual balance, NO real money
"""

import time, json, threading, logging, os, requests
from datetime import datetime, timezone
from flask import Flask, jsonify, render_template_string

# ─── CONFIG ────────────────────────────────────────────────────────────────────
DEMO_BALANCE_START = 2000.0
TRANCHE_SIZES      = [20, 30, 50]   # shares per tranche (3 tranches max)
BUY_THRESHOLD      = 0.35           # buy when price <= this
TAKE_PROFIT        = 0.55           # sell when price >= this
STOP_LOSS          = 0.15           # sell when price <= this
SKIP_LAST_SECS     = 60            # don't open new trades in last 60s of window
TAKER_FEE          = 0.02           # 2% per trade
POLL_INTERVAL      = 8             # seconds between price checks
WINDOW_SECONDS     = 300           # 5-min windows

GAMMA_BASE = "https://gamma-api.polymarket.com"
CLOB_BASE  = "https://clob.polymarket.com"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bot")

# ─── STATE ─────────────────────────────────────────────────────────────────────
state = {
    "balance":       DEMO_BALANCE_START,
    "start_balance": DEMO_BALANCE_START,
    "positions":     [],   # active open trades
    "history":       [],   # closed trades
    "log":           [],   # live event log (last 60)
    "prices":        {"UP": None, "DOWN": None},
    "window_ts":     None,
    "window_end":    None,
    "status":        "Starting…",
    "trades_today":  0,
    "wins":          0,
    "losses":        0,
    "started_at":    datetime.now(timezone.utc).isoformat(),
}
lock = threading.Lock()

def add_log(msg, level="info"):
    entry = {"t": datetime.now(timezone.utc).strftime("%H:%M:%S"), "msg": msg, "level": level}
    with lock:
        state["log"].insert(0, entry)
        state["log"] = state["log"][:80]
    log.info(msg)

# ─── MARKET DISCOVERY ──────────────────────────────────────────────────────────
def get_current_window_ts():
    return (int(time.time()) // WINDOW_SECONDS) * WINDOW_SECONDS

def fetch_market():
    """Try /events slug first, fall back to /markets search."""
    wts = get_current_window_ts()
    slug = f"btc-updown-5m-{wts}"
    try:
        r = requests.get(f"{GAMMA_BASE}/events?slug={slug}", timeout=10)
        if r.ok:
            data = r.json()
            if data:
                ev = data[0]
                mkts = ev.get("markets", [])
                if mkts:
                    return parse_market(mkts[0]), wts
    except Exception as e:
        log.warning(f"Event slug fetch failed: {e}")

    # Fallback: search active markets
    try:
        r = requests.get(
            f"{GAMMA_BASE}/markets",
            params={"active": "true", "tag": "crypto", "limit": 50},
            timeout=10
        )
        if r.ok:
            for m in r.json():
                q = m.get("question", "").lower()
                if "btc" in q and "5" in q and ("up" in q or "down" in q):
                    return parse_market(m), wts
    except Exception as e:
        log.warning(f"Fallback market fetch failed: {e}")

    return None, wts

def parse_market(m):
    try:
        token_ids    = json.loads(m.get("clobTokenIds", "[]"))
        outcomes     = json.loads(m.get("outcomes",     "[]"))
        outcome_prices = json.loads(m.get("outcomePrices", "[0.5,0.5]"))
    except Exception:
        token_ids      = m.get("clobTokenIds", [])
        outcomes       = m.get("outcomes",     [])
        outcome_prices = m.get("outcomePrices", [0.5, 0.5])

    # Dynamically map UP/DOWN by outcome label
    up_idx, down_idx = 0, 1
    for i, o in enumerate(outcomes):
        if isinstance(o, str) and "up" in o.lower():
            up_idx = i
        if isinstance(o, str) and "down" in o.lower():
            down_idx = i

    return {
        "condition_id": m.get("conditionId", m.get("id", "")),
        "question":     m.get("question", "BTC 5m"),
        "token_up":     token_ids[up_idx]   if len(token_ids) > up_idx   else None,
        "token_down":   token_ids[down_idx] if len(token_ids) > down_idx else None,
        "price_up":     float(outcome_prices[up_idx])   if len(outcome_prices) > up_idx   else 0.5,
        "price_down":   float(outcome_prices[down_idx]) if len(outcome_prices) > down_idx else 0.5,
    }

# ─── LIVE PRICE FETCH ──────────────────────────────────────────────────────────
def fetch_prices(market):
    prices = {"UP": market["price_up"], "DOWN": market["price_down"]}
    try:
        for side, token in [("UP", market["token_up"]), ("DOWN", market["token_down"])]:
            if not token:
                continue
            r = requests.get(f"{CLOB_BASE}/midpoint?token_id={token}", timeout=6)
            if r.ok:
                mid = r.json().get("mid")
                if mid is not None:
                    prices[side] = float(mid)
    except Exception as e:
        log.debug(f"Price fetch error: {e}")
    return prices

# ─── TRADE LOGIC ───────────────────────────────────────────────────────────────
def can_open_trade(side, price, secs_left):
    if secs_left < SKIP_LAST_SECS:
        return False, "Too close to window close"
    # Check we don't already have max tranches open on this side
    with lock:
        open_for_side = [p for p in state["positions"] if p["side"] == side and p["window_ts"] == state["window_ts"]]
    if len(open_for_side) >= len(TRANCHE_SIZES):
        return False, f"Max tranches reached for {side}"
    if price > BUY_THRESHOLD:
        return False, f"{side} price {price:.3f} above threshold {BUY_THRESHOLD}"
    with lock:
        bal = state["balance"]
    tranche_idx = len(open_for_side)
    shares = TRANCHE_SIZES[tranche_idx]
    cost = shares * price * (1 + TAKER_FEE)
    if bal < cost:
        return False, f"Insufficient balance (need ${cost:.2f}, have ${bal:.2f})"
    return True, shares

def open_trade(side, price, shares, market):
    cost = shares * price * (1 + TAKER_FEE)
    trade = {
        "id":         len(state["history"]) + len(state["positions"]) + 1,
        "side":       side,
        "shares":     shares,
        "entry":      price,
        "cost":       cost,
        "tp":         TAKE_PROFIT,
        "sl":         STOP_LOSS,
        "opened_at":  datetime.now(timezone.utc).isoformat(),
        "window_ts":  state["window_ts"],
        "question":   market["question"],
        "status":     "OPEN",
        "pnl":        0.0,
    }
    with lock:
        state["balance"] -= cost
        state["positions"].append(trade)
        state["trades_today"] += 1
    add_log(f"🟢 BUY {shares}x {side} @ {price:.3f} | cost ${cost:.2f} | bal ${state['balance']:.2f}", "buy")
    return trade

def close_trade(trade, current_price, reason):
    proceeds = trade["shares"] * current_price * (1 - TAKER_FEE)
    pnl = proceeds - trade["cost"]
    trade["exit"]       = current_price
    trade["proceeds"]   = proceeds
    trade["pnl"]        = pnl
    trade["closed_at"]  = datetime.now(timezone.utc).isoformat()
    trade["close_reason"] = reason
    trade["status"]     = "WIN" if pnl > 0 else "LOSS"
    with lock:
        state["balance"] += proceeds
        state["positions"].remove(trade)
        state["history"].insert(0, trade)
        state["history"] = state["history"][:200]
        if pnl > 0:
            state["wins"] += 1
        else:
            state["losses"] += 1
    emoji = "✅" if pnl > 0 else "❌"
    add_log(f"{emoji} CLOSE {trade['shares']}x {trade['side']} @ {current_price:.3f} | PnL ${pnl:+.2f} | {reason}", "win" if pnl > 0 else "loss")

def check_exits(prices):
    with lock:
        positions_copy = list(state["positions"])
    for trade in positions_copy:
        price = prices.get(trade["side"])
        if price is None:
            continue
        if price >= TAKE_PROFIT:
            close_trade(trade, price, "TP hit")
        elif price <= STOP_LOSS:
            close_trade(trade, price, "SL hit")

def force_close_all(prices, reason="Window end"):
    with lock:
        positions_copy = list(state["positions"])
    for trade in positions_copy:
        price = prices.get(trade["side"], trade["entry"])
        # If window settled, check settled prices (0 or 1)
        if reason == "Window end":
            # In real Polymarket, settled side goes to 1.0
            # We simulate: if price > 0.5 it likely resolved YES
            price = min(max(price, 0.0), 1.0)
        close_trade(trade, price, reason)

# ─── MAIN BOT LOOP ─────────────────────────────────────────────────────────────
def bot_loop():
    add_log("🚀 Bot started — Liquidity Fade strategy, $2000 demo", "info")
    current_market = None

    while True:
        try:
            now_ts     = int(time.time())
            window_ts  = get_current_window_ts()
            secs_left  = WINDOW_SECONDS - (now_ts - window_ts)
            window_end = window_ts + WINDOW_SECONDS

            with lock:
                state["window_ts"]  = window_ts
                state["window_end"] = window_end

            # Refresh market each new window
            if current_market is None or current_market.get("_window_ts") != window_ts:
                add_log(f"🔍 New window {datetime.fromtimestamp(window_ts, tz=timezone.utc).strftime('%H:%M')} — fetching market…")
                m, wts = fetch_market()
                if m:
                    m["_window_ts"] = wts
                    current_market = m
                    add_log(f"📋 Market: {m['question']}")
                    with lock:
                        state["status"] = f"Active: {m['question']}"
                else:
                    add_log("⚠️  No active 5m BTC market found, retrying…", "warn")
                    with lock:
                        state["status"] = "Searching for market…"
                    time.sleep(15)
                    continue

            # Force close if window just ended
            if secs_left <= 2 and state["positions"]:
                prices = fetch_prices(current_market)
                add_log(f"⏰ Window closing — force-closing {len(state['positions'])} position(s)")
                force_close_all(prices, "Window end")
                current_market = None
                time.sleep(5)
                continue

            # Fetch live prices
            prices = fetch_prices(current_market)
            with lock:
                state["prices"] = prices

            add_log(f"💹 UP={prices['UP']:.3f}  DOWN={prices['DOWN']:.3f}  ⏱ {secs_left}s left", "price")

            # Check exits first
            check_exits(prices)

            # Check for new entry opportunities
            for side in ["UP", "DOWN"]:
                price = prices.get(side)
                if price is None:
                    continue
                ok, result = can_open_trade(side, price, secs_left)
                if ok:
                    open_trade(side, price, result, current_market)

        except Exception as e:
            add_log(f"💥 Error: {e}", "error")
            log.exception("Bot loop error")

        time.sleep(POLL_INTERVAL)

# ─── FLASK DASHBOARD ───────────────────────────────────────────────────────────
app = Flask(__name__)

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="8">
<title>Polymarket Demo Bot</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;600;800&display=swap');

  :root {
    --bg:      #040a0f;
    --panel:   #081420;
    --border:  #0d2a40;
    --accent:  #00e5ff;
    --green:   #00ff88;
    --red:     #ff3355;
    --yellow:  #ffcc00;
    --muted:   #3a5a6e;
    --text:    #c8e6f0;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Exo 2', sans-serif;
    min-height: 100vh;
    background-image:
      radial-gradient(ellipse at 20% 0%, #001a2e 0%, transparent 60%),
      radial-gradient(ellipse at 80% 100%, #001428 0%, transparent 60%);
  }

  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 32px;
    border-bottom: 1px solid var(--border);
    background: rgba(0,229,255,0.03);
  }
  header h1 {
    font-size: 1.3rem; font-weight: 800; letter-spacing: 2px;
    color: var(--accent); text-transform: uppercase;
  }
  .badge {
    font-family: 'Share Tech Mono', monospace;
    font-size: 0.75rem; padding: 4px 12px;
    border: 1px solid var(--green); color: var(--green);
    border-radius: 20px; animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 16px; padding: 24px 32px 0;
  }
  .stat {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    position: relative; overflow: hidden;
  }
  .stat::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
  }
  .stat-label { font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 1.5px; }
  .stat-value { font-size: 1.7rem; font-weight: 800; margin-top: 6px; line-height: 1; }
  .stat-value.green { color: var(--green); }
  .stat-value.red   { color: var(--red); }
  .stat-value.gold  { color: var(--yellow); }
  .stat-value.cyan  { color: var(--accent); }

  .main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 32px; }
  @media(max-width:900px){ .main { grid-template-columns: 1fr; } }

  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden;
  }
  .panel-head {
    padding: 12px 18px;
    font-size: 0.72rem; letter-spacing: 2px; text-transform: uppercase;
    color: var(--accent); border-bottom: 1px solid var(--border);
    font-weight: 600;
  }

  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { padding: 8px 14px; text-align: left; color: var(--muted); font-size: 0.65rem; letter-spacing: 1px; text-transform: uppercase; }
  td { padding: 9px 14px; border-top: 1px solid #0a1e2e; font-family: 'Share Tech Mono', monospace; }
  tr:hover td { background: rgba(0,229,255,0.04); }

  .pill {
    display: inline-block; padding: 2px 10px; border-radius: 20px;
    font-size: 0.68rem; font-weight: 600; letter-spacing: 0.5px;
  }
  .pill-up   { background: rgba(0,255,136,0.12); color: var(--green); border: 1px solid rgba(0,255,136,0.3); }
  .pill-down { background: rgba(255,51,85,0.12);  color: var(--red);   border: 1px solid rgba(255,51,85,0.3); }
  .pill-win  { background: rgba(0,255,136,0.12); color: var(--green); }
  .pill-loss { background: rgba(255,51,85,0.12);  color: var(--red); }
  .pill-open { background: rgba(0,229,255,0.12); color: var(--accent); }

  .log-box { height: 300px; overflow-y: auto; padding: 10px 4px; }
  .log-entry { display: flex; gap: 10px; padding: 5px 14px; font-size: 0.75rem; font-family: 'Share Tech Mono', monospace; border-bottom: 1px solid #081420; }
  .log-t { color: var(--muted); min-width: 52px; }
  .log-buy   { color: var(--green); }
  .log-win   { color: var(--green); }
  .log-loss  { color: var(--red); }
  .log-error { color: var(--red); }
  .log-warn  { color: var(--yellow); }
  .log-price { color: #4e7a8e; }
  .log-info  { color: var(--text); }

  .prices-bar {
    display: flex; gap: 24px; padding: 14px 32px;
    border-top: 1px solid var(--border);
    font-family: 'Share Tech Mono', monospace; font-size: 0.85rem;
    background: rgba(0,0,0,0.3);
  }
  .price-item { display: flex; gap: 8px; align-items: center; }
  .price-label { color: var(--muted); font-size: 0.7rem; }
  .price-up   { color: var(--green); font-size: 1.1rem; font-weight: bold; }
  .price-down { color: var(--red);   font-size: 1.1rem; font-weight: bold; }

  .empty { color: var(--muted); padding: 20px; text-align: center; font-size: 0.8rem; }

  footer { text-align: center; padding: 20px; color: var(--muted); font-size: 0.7rem; letter-spacing: 1px; }
</style>
</head>
<body>

<header>
  <h1>⚡ Polymarket Demo Bot</h1>
  <div style="display:flex;gap:12px;align-items:center;">
    <span style="font-size:0.72rem;color:var(--muted)">{{ status }}</span>
    <span class="badge">● DEMO LIVE</span>
  </div>
</header>

<div class="grid">
  <div class="stat">
    <div class="stat-label">Balance</div>
    <div class="stat-value cyan">${{ "%.2f"|format(balance) }}</div>
  </div>
  <div class="stat">
    <div class="stat-label">P&amp;L</div>
    <div class="stat-value {% if pnl >= 0 %}green{% else %}red{% endif %}">
      ${{ "%+.2f"|format(pnl) }}
    </div>
  </div>
  <div class="stat">
    <div class="stat-label">P&amp;L %</div>
    <div class="stat-value {% if pnl >= 0 %}green{% else %}red{% endif %}">
      {{ "%+.1f"|format(pnl_pct) }}%
    </div>
  </div>
  <div class="stat">
    <div class="stat-label">Wins / Losses</div>
    <div class="stat-value gold">{{ wins }} / {{ losses }}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Win Rate</div>
    <div class="stat-value {% if winrate >= 50 %}green{% else %}red{% endif %}">
      {{ "%.0f"|format(winrate) }}%
    </div>
  </div>
  <div class="stat">
    <div class="stat-label">Open Positions</div>
    <div class="stat-value cyan">{{ open_count }}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Window</div>
    <div class="stat-value" style="font-size:1.1rem;color:var(--yellow)">{{ secs_left }}s left</div>
  </div>
</div>

<div class="prices-bar">
  <div class="price-item">
    <span class="price-label">BTC UP</span>
    <span class="price-up">{{ "%.3f"|format(price_up) }}</span>
  </div>
  <div class="price-item">
    <span class="price-label">BTC DOWN</span>
    <span class="price-down">{{ "%.3f"|format(price_down) }}</span>
  </div>
  <div class="price-item" style="margin-left:auto">
    <span class="price-label">Strategy: Liquidity Fade | Buy ≤ 0.35 | TP=0.55 | SL=0.15</span>
  </div>
</div>

<div class="main">

  <!-- Open Positions -->
  <div class="panel">
    <div class="panel-head">Open Positions ({{ open_count }})</div>
    {% if positions %}
    <table>
      <tr><th>Side</th><th>Shares</th><th>Entry</th><th>Current</th><th>Unreal PnL</th></tr>
      {% for p in positions %}
      <tr>
        <td><span class="pill pill-{{ p.side.lower() }}">{{ p.side }}</span></td>
        <td>{{ p.shares }}</td>
        <td>{{ "%.3f"|format(p.entry) }}</td>
        <td>{{ "%.3f"|format(prices.get(p.side, p.entry)) }}</td>
        <td class="{% if p.upnl >= 0 %}log-win{% else %}log-loss{% endif %}">
          ${{ "%+.2f"|format(p.upnl) }}
        </td>
      </tr>
      {% endfor %}
    </table>
    {% else %}
    <div class="empty">No open positions</div>
    {% endif %}
  </div>

  <!-- Live Log -->
  <div class="panel">
    <div class="panel-head">Live Event Log</div>
    <div class="log-box">
      {% for e in log %}
      <div class="log-entry">
        <span class="log-t">{{ e.t }}</span>
        <span class="log-{{ e.level }}">{{ e.msg }}</span>
      </div>
      {% endfor %}
    </div>
  </div>

</div>

<!-- Trade History -->
<div style="padding: 0 32px 16px;">
  <div class="panel">
    <div class="panel-head">Trade History ({{ history|length }})</div>
    {% if history %}
    <div style="max-height:280px;overflow-y:auto;">
    <table>
      <tr><th>#</th><th>Side</th><th>Shares</th><th>Entry</th><th>Exit</th><th>Reason</th><th>PnL</th></tr>
      {% for h in history %}
      <tr>
        <td>{{ h.id }}</td>
        <td><span class="pill pill-{{ h.side.lower() }}">{{ h.side }}</span></td>
        <td>{{ h.shares }}</td>
        <td>{{ "%.3f"|format(h.entry) }}</td>
        <td>{{ "%.3f"|format(h.exit) }}</td>
        <td>{{ h.close_reason }}</td>
        <td class="{% if h.pnl >= 0 %}log-win{% else %}log-loss{% endif %}">
          ${{ "%+.2f"|format(h.pnl) }}
        </td>
      </tr>
      {% endfor %}
    </table>
    </div>
    {% else %}
    <div class="empty">No closed trades yet</div>
    {% endif %}
  </div>
</div>

<footer>DEMO MODE — No real money. Polymarket Liquidity Fade Bot v1.0</footer>

</body>
</html>
"""

@app.route("/")
def dashboard():
    with lock:
        s = dict(state)

    prices = s["prices"]
    now    = int(time.time())
    wts    = s["window_ts"] or get_current_window_ts()
    wend   = s["window_end"] or (wts + WINDOW_SECONDS)
    secs_left = max(0, wend - now)

    pnl     = s["balance"] - s["start_balance"]
    pnl_pct = (pnl / s["start_balance"]) * 100
    total   = s["wins"] + s["losses"]
    winrate = (s["wins"] / total * 100) if total else 0.0

    # Compute unrealized PnL for open positions
    positions_view = []
    for p in s["positions"]:
        cur = prices.get(p["side"], p["entry"])
        upnl = p["shares"] * cur * (1 - TAKER_FEE) - p["cost"]
        pv = dict(p)
        pv["upnl"] = upnl
        positions_view.append(pv)

    return render_template_string(
        DASHBOARD_HTML,
        balance   = s["balance"],
        pnl       = pnl,
        pnl_pct   = pnl_pct,
        wins      = s["wins"],
        losses    = s["losses"],
        winrate   = winrate,
        open_count= len(s["positions"]),
        secs_left = secs_left,
        price_up  = prices.get("UP") or 0.0,
        price_down= prices.get("DOWN") or 0.0,
        positions = positions_view,
        history   = s["history"][:50],
        log       = s["log"][:40],
        prices    = prices,
        status    = s["status"],
    )

@app.route("/api/state")
def api_state():
    with lock:
        return jsonify(state)

# ─── ENTRY POINT ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    t = threading.Thread(target=bot_loop, daemon=True)
    t.start()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
