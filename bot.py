import time
import requests
import os
import threading
from flask import Flask, render_template_string

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
VIRTUAL_BALANCE = 2000.0
PROFIT_TARGET_PERCENT = 0.15
TRAILING_STOP_PERCENT = 0.05
STOP_LOSS_PERCENT = 0.20
POSITION_SIZE_PERCENT = 0.2
MAX_POSITION_USD = 500

state_lock = threading.Lock()
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

# -----------------------------------------------------------------------------
# Global State
# -----------------------------------------------------------------------------
state = {
    "current_window_timestamp": 0,
    "market_id": "Initializing...",
    "side": "Waiting for candle...",
    "current_price": 0.0,
    "up_price": 0.0,      # NEW: current UP token price
    "down_price": 0.0,    # NEW: current DOWN token price
    "base_shares": 0.0,
    "moonbag_shares": 0.0,
    "total_cost": 0.0,
    "average_entry": 0.0,
    "profit_target_hit": False,
    "trailing_peak": 0.0,
    "latest_log": "Bot starting up...",
    "virtual_balance": VIRTUAL_BALANCE,
    "unrealized_pnl": 0.0
}

def log_update(message):
    print(message)
    with state_lock:
        state["latest_log"] = message

def update_state(**kwargs):
    with state_lock:
        for key, value in kwargs.items():
            if key in state:
                state[key] = value

# -----------------------------------------------------------------------------
# API Helpers (same as before, with small improvements)
# -----------------------------------------------------------------------------
def fetch_previous_candle_trend():
    url = "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=15&limit=2"
    for attempt in range(3):
        try:
            response = requests.get(url, headers=DEFAULT_HEADERS, timeout=10)
            response.raise_for_status()
            data = response.json()
            klines = data.get("result", {}).get("list", [])
            if len(klines) >= 2:
                prev_candle = klines[1]
                close = float(prev_candle[4])
                open_price = float(prev_candle[1])
                return "UP" if close > open_price else "DOWN"
        except Exception as e:
            log_update(f"Bybit attempt {attempt+1} failed: {e}")
            time.sleep(2)
    return None

def fetch_polymarket_market_id(window_timestamp):
    slug = f"btc-updown-15m-{window_timestamp}"
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    try:
        response = requests.get(url, headers=DEFAULT_HEADERS, timeout=10)
        response.raise_for_status()
        data = response.json()
        if data and "markets" in data[0] and data[0]["markets"]:
            return data[0]["markets"][0].get("id")
    except Exception as e:
        log_update(f"Market ID fetch error: {e}")
    return None

def fetch_both_prices(market_id):
    """Return (up_price, down_price) for the given market."""
    url = f"https://gamma-api.polymarket.com/markets/{market_id}"
    try:
        response = requests.get(url, headers=DEFAULT_HEADERS, timeout=10)
        response.raise_for_status()
        data = response.json()
        prices = data.get("outcomePrices")
        if prices and len(prices) >= 2:
            return float(prices[0]), float(prices[1])
    except Exception as e:
        log_update(f"Price fetch error: {e}")
    return None, None

def fetch_token_price(market_id, side):
    """Legacy: get single side price (used for trading)."""
    up, down = fetch_both_prices(market_id)
    if side == "UP":
        return up
    else:
        return down

# -----------------------------------------------------------------------------
# Trading Actions (unchanged)
# -----------------------------------------------------------------------------
def buy_position(market_id, side, current_price):
    global VIRTUAL_BALANCE
    with state_lock:
        available_balance = VIRTUAL_BALANCE
        position_value = min(available_balance * POSITION_SIZE_PERCENT, MAX_POSITION_USD)
        shares = position_value / current_price if current_price > 0 else 0
        if shares <= 0 or position_value <= 0:
            log_update(f"Cannot buy: Insufficient balance (${available_balance:.2f})")
            return False
        cost = shares * current_price
        VIRTUAL_BALANCE -= cost
        state["base_shares"] = shares
        state["moonbag_shares"] = 0
        state["total_cost"] = cost
        state["average_entry"] = current_price
        state["profit_target_hit"] = False
        state["trailing_peak"] = 0.0
        state["virtual_balance"] = VIRTUAL_BALANCE
        log_update(f"BOUGHT {shares:.4f} shares at ${current_price:.4f} | Cost: ${cost:.2f} | Balance: ${VIRTUAL_BALANCE:.2f}")
        return True

def sell_shares(shares, current_price, sell_type="full"):
    global VIRTUAL_BALANCE
    if shares <= 0:
        return False
    sale_value = shares * current_price
    VIRTUAL_BALANCE += sale_value
    with state_lock:
        state["virtual_balance"] = VIRTUAL_BALANCE
    log_update(f"SOLD {shares:.4f} shares ({sell_type}) at ${current_price:.4f} | Value: ${sale_value:.2f} | Balance: ${VIRTUAL_BALANCE:.2f}")
    return True

def close_all_positions(current_price):
    with state_lock:
        base = state["base_shares"]
        moonbag = state["moonbag_shares"]
        total_shares = base + moonbag
        if total_shares > 0:
            sell_shares(total_shares, current_price, "full_liquidation")
            state["base_shares"] = 0
            state["moonbag_shares"] = 0
            state["total_cost"] = 0
            state["average_entry"] = 0
            state["profit_target_hit"] = False
            state["trailing_peak"] = 0.0
            log_update(f"Position fully liquidated at ${current_price:.4f}")
            return True
    return False

def manage_existing_position(current_price):
    with state_lock:
        base_shares = state["base_shares"]
        moonbag_shares = state["moonbag_shares"]
        avg_entry = state["average_entry"]
        profit_target_hit = state["profit_target_hit"]
        trailing_peak = state["trailing_peak"]
        if base_shares == 0 and moonbag_shares == 0:
            return
        total_shares = base_shares + moonbag_shares
        total_value = total_shares * current_price
        total_cost = state["total_cost"]
        unrealized_pnl = total_value - total_cost
        update_state(unrealized_pnl=unrealized_pnl)
        if not profit_target_hit and total_cost > 0:
            loss_pct = (current_price - avg_entry) / avg_entry if avg_entry > 0 else 0
            if loss_pct <= -STOP_LOSS_PERCENT:
                log_update(f"STOP LOSS triggered! Loss: {loss_pct*100:.2f}%")
                close_all_positions(current_price)
                return
        if not profit_target_hit and base_shares > 0 and avg_entry > 0:
            gain_pct = (current_price - avg_entry) / avg_entry
            if gain_pct >= PROFIT_TARGET_PERCENT:
                sell_shares(base_shares, current_price, "profit_target")
                state["base_shares"] = 0
                state["profit_target_hit"] = True
                state["trailing_peak"] = current_price
                log_update(f"PROFIT TARGET HIT! Gain: {gain_pct*100:.2f}% | Moonbag: {moonbag_shares:.4f}")
                return
        if profit_target_hit and moonbag_shares > 0:
            if current_price > trailing_peak:
                state["trailing_peak"] = current_price
                trailing_peak = current_price
            drawdown = (trailing_peak - current_price) / trailing_peak if trailing_peak > 0 else 0
            if drawdown >= TRAILING_STOP_PERCENT:
                log_update(f"TRAILING STOP triggered! Drawdown: {drawdown*100:.2f}%")
                sell_shares(moonbag_shares, current_price, "trailing_stop")
                state["moonbag_shares"] = 0
                state["profit_target_hit"] = False
                state["trailing_peak"] = 0.0

# -----------------------------------------------------------------------------
# Background Bot Loop (updated to refresh both prices)
# -----------------------------------------------------------------------------
def bot_loop():
    global VIRTUAL_BALANCE
    while True:
        try:
            current_time = int(time.time())
            current_window = (current_time // 900) * 900
            with state_lock:
                last_window = state["current_window_timestamp"]
            if current_window != last_window:
                log_update(f"NEW WINDOW: {current_window}")
                with state_lock:
                    old_market = state["market_id"]
                    old_side = state["side"]
                if old_market and old_market != "Initializing..." and old_side:
                    price = fetch_token_price(old_market, old_side)
                    if price:
                        close_all_positions(price)
                trend = fetch_previous_candle_trend()
                new_market_id = fetch_polymarket_market_id(current_window)
                update_state(current_window_timestamp=current_window)
                if trend and new_market_id:
                    update_state(market_id=new_market_id, side=trend, profit_target_hit=False)
                    log_update(f"Market: {new_market_id} | Side: {trend}")
                    token_price = fetch_token_price(new_market_id, trend)
                    if token_price and token_price > 0:
                        update_state(current_price=token_price)
                        buy_position(new_market_id, trend, token_price)
                    else:
                        log_update(f"Cannot get token price for {new_market_id} / {trend}")
                else:
                    log_update(f"Init failed - trend: {trend}, market_id: {new_market_id}")
            # --- Refresh both UP/DOWN prices for the current market ---
            with state_lock:
                current_market = state["market_id"]
            if current_market and current_market != "Initializing...":
                up_price, down_price = fetch_both_prices(current_market)
                if up_price is not None and down_price is not None:
                    update_state(up_price=up_price, down_price=down_price)
                    # Also update the side price for trading logic
                    with state_lock:
                        side = state["side"]
                        if side == "UP":
                            update_state(current_price=up_price)
                        else:
                            update_state(current_price=down_price)
            # Manage existing position using the updated current_price
            with state_lock:
                current_market = state["market_id"]
                current_side = state["side"]
                has_position = (state["base_shares"] > 0 or state["moonbag_shares"] > 0)
                price_to_use = state["current_price"]
            if current_market and current_market != "Initializing..." and current_side and has_position and price_to_use > 0:
                manage_existing_position(price_to_use)
            time.sleep(3)
        except Exception as e:
            log_update(f"Bot loop error: {e}")
            time.sleep(5)

# -----------------------------------------------------------------------------
# Web Dashboard (now shows UP and DOWN prices)
# -----------------------------------------------------------------------------
app = Flask(__name__)

DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="3">
    <style>
        body { background: #0f172a; color: #e2e8f0; font-family: 'Segoe UI', sans-serif; padding: 20px; }
        .container { max-width: 900px; margin: 0 auto; }
        .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        h1, h2 { color: #38bdf8; margin-top: 0; }
        .metric { display: inline-block; margin-right: 30px; margin-bottom: 15px; }
        .metric-label { font-size: 12px; color: #94a3b8; }
        .metric-value { font-size: 24px; font-weight: bold; color: #f1f5f9; }
        .positive { color: #4ade80; }
        .negative { color: #f87171; }
        .log-box { background: #0f172a; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 13px; max-height: 300px; overflow-y: auto; }
        .price-up { color: #4ade80; }
        .price-down { color: #f87171; }
        hr { border-color: #334155; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Polymarket BTC 15-Min Bot</h1>
        <div class="card">
            <h2>📊 Live Prices</h2>
            <div class="metric">
                <div class="metric-label">UP Token Price</div>
                <div class="metric-value price-up">${{ "%.4f"|format(state.up_price) }}</div>
            </div>
            <div class="metric">
                <div class="metric-label">DOWN Token Price</div>
                <div class="metric-value price-down">${{ "%.4f"|format(state.down_price) }}</div>
            </div>
            <div class="metric">
                <div class="metric-label">Our Side</div>
                <div class="metric-value">{{ state.side }}</div>
            </div>
            <div class="metric">
                <div class="metric-label">Our Token Price</div>
                <div class="metric-value">${{ "%.4f"|format(state.current_price) }}</div>
            </div>
        </div>
        <div class="card">
            <h2>💰 Account & Position</h2>
            <div class="metric"><div class="metric-label">Virtual Balance</div><div class="metric-value">${{ "%.2f"|format(state.virtual_balance) }}</div></div>
            <div class="metric"><div class="metric-label">Base Shares</div><div class="metric-value">{{ "%.4f"|format(state.base_shares) }}</div></div>
            <div class="metric"><div class="metric-label">Moonbag Shares</div><div class="metric-value">{{ "%.4f"|format(state.moonbag_shares) }}</div></div>
            <div class="metric"><div class="metric-label">Avg Entry</div><div class="metric-value">${{ "%.4f"|format(state.average_entry) }}</div></div>
            <div class="metric"><div class="metric-label">Unrealized PnL</div><div class="metric-value {% if state.unrealized_pnl >= 0 %}positive{% else %}negative{% endif %}">${{ "%.2f"|format(state.unrealized_pnl) }}</div></div>
            <div class="metric"><div class="metric-label">Profit Target Hit</div><div class="metric-value">{{ state.profit_target_hit }}</div></div>
            {% if state.trailing_peak > 0 %}
            <div class="metric"><div class="metric-label">Trailing Peak</div><div class="metric-value">${{ "%.4f"|format(state.trailing_peak) }}</div></div>
            {% endif %}
        </div>
        <div class="card">
            <h2>📝 Live Log</h2>
            <div class="log-box">{{ state.latest_log }}</div>
        </div>
        <div class="card">
            <h2>⚙️ Strategy</h2>
            <div class="metric"><div class="metric-label">Profit Target</div><div class="metric-value">{{ (PROFIT_TARGET_PERCENT*100)|int }}%</div></div>
            <div class="metric"><div class="metric-label">Trailing Stop</div><div class="metric-value">{{ (TRAILING_STOP_PERCENT*100)|int }}%</div></div>
            <div class="metric"><div class="metric-label">Stop Loss</div><div class="metric-value">{{ (STOP_LOSS_PERCENT*100)|int }}%</div></div>
            <div class="metric"><div class="metric-label">Position Size</div><div class="metric-value">{{ (POSITION_SIZE_PERCENT*100)|int }}% of balance (max ${{ MAX_POSITION_USD }})</div></div>
        </div>
    </div>
</body>
</html>
"""

@app.route('/')
def dashboard():
    return render_template_string(
        DASHBOARD_HTML,
        state=state,
        PROFIT_TARGET_PERCENT=PROFIT_TARGET_PERCENT,
        TRAILING_STOP_PERCENT=TRAILING_STOP_PERCENT,
        STOP_LOSS_PERCENT=STOP_LOSS_PERCENT,
        POSITION_SIZE_PERCENT=POSITION_SIZE_PERCENT,
        MAX_POSITION_USD=MAX_POSITION_USD
    )

if __name__ == "__main__":
    threading.Thread(target=bot_loop, daemon=True).start()
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, threaded=True)
