import time
import requests
import os
import threading
from flask import Flask, render_template_string

# -----------------------------------------------------------------------------
# Configuration & Global State
# -----------------------------------------------------------------------------
VIRTUAL_BALANCE = 2000.0

state = {
    "current_window_timestamp": 0,
    "market_id": "Initializing...",
    "side": "Waiting for candle...",
    "current_price": 0.0,  # Added this to track price for UI
    "base_shares": 0,
    "total_cost": 0.0,
    "average_entry": 0.0,
    "last_buy_price": 0.0,
    "moonbag_shares": 0,
    "profit_target_hit": False,
    "trailing_peak": 0.0,
    "latest_log": "Bot starting up..."
}

def log_update(message):
    print(message)
    state["latest_log"] = message

def check_previous_candle_trend():
    try:
        url = "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=15&limit=2"
        response = requests.get(url, timeout=10)
        data = response.json()
        klines = data.get("result", {}).get("list", [])
        if len(klines) >= 2:
            prev_candle = klines[1]
            return "UP" if float(prev_candle[4]) > float(prev_candle[1]) else "DOWN"
    except:
        pass
    return None

def fetch_live_polymarket_id(window_timestamp):
    slug = f"btc-updown-15m-{window_timestamp}"
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    try:
        res = requests.get(url, timeout=10).json()
        if res and "markets" in res[0] and res[0]["markets"]:
            return res[0]["markets"][0].get("id")
    except:
        pass
    return None

def get_current_token_price(market_id, side):
    try:
        url = f"https://gamma-api.polymarket.com/markets/{market_id}"
        res = requests.get(url, timeout=10).json()
        prices = res.get("outcomePrices")
        if prices and len(prices) >= 2:
            return float(prices[0]) if side == "UP" else float(prices[1])
    except:
        pass
    return None

# -----------------------------------------------------------------------------
# Background Trading Engine
# -----------------------------------------------------------------------------
def bot_loop():
    global VIRTUAL_BALANCE
    while True:
        current_time = int(time.time())
        calculated_window = (current_time // 900) * 900
        
        if calculated_window != state["current_window_timestamp"]:
            state["current_window_timestamp"] = calculated_window
            state["side"] = check_previous_candle_trend()
            state["market_id"] = fetch_live_polymarket_id(calculated_window)
            log_update(f"[NEW WINDOW] Locked: {state['market_id']} | Side: {state['side']}")

        if state["market_id"] != "Initializing...":
            price = get_current_token_price(state["market_id"], state["side"])
            if price is not None:
                state["current_price"] = price # Syncing live price to UI state
                # Trading logic omitted for brevity, logic remains identical to previous
        
        time.sleep(3)

# -----------------------------------------------------------------------------
# Web Server
# -----------------------------------------------------------------------------
app = Flask(__name__)

DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head><meta http-equiv="refresh" content="3"></head>
<body style="background:#0f172a; color:#fff; font-family:sans-serif; padding:20px;">
    <h2>BTC Bot Status</h2>
    <p>Market ID: {{ state.market_id }}</p>
    <p>Live Price: <b>{{ state.current_price }}</b></p>
    <p>Side: {{ state.side }}</p>
    <p>Log: {{ state.latest_log }}</p>
</body>
</html>
"""

@app.route('/')
def dashboard():
    return render_template_string(DASHBOARD_HTML, state=state)

if __name__ == "__main__":
    threading.Thread(target=bot_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
