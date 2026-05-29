import time
import requests
import os
import threading
from flask import Flask, render_template_string

# -----------------------------------------------------------------------------
# Configuration & Global Demo State
# -----------------------------------------------------------------------------
VIRTUAL_BALANCE = 2000.0

state = {
    "current_window_timestamp": 0,
    "market_id": "Initializing...",
    "side": "Waiting for candle...",
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
    """Updates the console and the dashboard log simultaneously."""
    print(message)
    state["latest_log"] = message

def check_binance_candle():
    """Checks the Binance.US 15-minute BTC candle to bypass geo-blocks."""
    try:
        url = "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=2"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        if isinstance(data, list) and len(data) >= 2:
            prev_candle = data[0]
            open_price = float(prev_candle[1])
            close_price = float(prev_candle[4])
            return "UP" if close_price > open_price else "DOWN"
    except Exception as e:
        log_update(f"[SYSTEM ERROR] Binance.US fetch failed: {e}")
    return None

def fetch_live_polymarket_id(window_timestamp):
    """Calculates target slug and retrieves market metadata."""
    slug = f"btc-updown-15m-{window_timestamp}"
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    
    for _ in range(10):
        try:
            res = requests.get(url, timeout=10).json()
            if res and "markets" in res[0] and res[0]["markets"]:
                return res[0]["markets"][0].get("id")
        except Exception:
            pass
        time.sleep(2)
    return None

def get_current_token_price(market_id, side):
    """Fetches real-time outcome prices for the active contract."""
    try:
        url = f"https://gamma-api.polymarket.com/markets/{market_id}"
        res = requests.get(url, timeout=10).json()
        prices = res.get("outcomePrices")
        if prices and len(prices) >= 2:
            return float(prices[0]) if side == "UP" else float(prices[1])
    except Exception:
        pass
    return None

def check_market_resolution(market_id, side):
    """Pings the oracle resolution state."""
    try:
        url = f"https://gamma-api.polymarket.com/markets/{market_id}"
        res = requests.get(url, timeout=10).json()
        if res.get("closed") is True or res.get("resolved") is True:
            prices = res.get("outcomePrices")
            if prices:
                final_price = float(prices[0]) if side == "UP" else float(prices[1])
                if final_price >= 0.99: return "WIN"
                elif final_price <= 0.01: return "LOSS"
    except Exception:
        pass
    return "PENDING"

# -----------------------------------------------------------------------------
# Background Trading Engine
# -----------------------------------------------------------------------------
def bot_loop():
    global VIRTUAL_BALANCE
    old_market_id = None
    old_side = None
    old_held_shares = 0

    while True:
        current_time = int(time.time())
        calculated_window = (current_time // 900) * 900
        
        # 1. WINDOW BOUNDARY HANDOVER LOGIC
        if calculated_window != state["current_window_timestamp"]:
            log_update(f"[WINDOW TRANSITION] New 15-Minute Block: {calculated_window}")
            
            old_held_shares = state["base_shares"] + state["moonbag_shares"]
            old_market_id = state["market_id"] if state["market_id"] != "Initializing..." else None
            old_side = state["side"]
            
            state["current_window_timestamp"] = calculated_window
            state["base_shares"] = 0
            state["total_cost"] = 0.0
            state["average_entry"] = 0.0
            state["last_buy_price"] = 0.0
            state["moonbag_shares"] = 0
            state["profit_target_hit"] = False
            state["trailing_peak"] = 0.0
            
            side = check_binance_candle()
            if not side:
                log_update("[SYSTEM ALERT] Candle unreadable. Retrying next cycle.")
                state["current_window_timestamp"] = 0
                time.sleep(5)
                continue
                
            state["side"] = side
            log_update(f"[STRATEGY] Activating {side} Token ladder.")
            
            market_id = fetch_live_polymarket_id(calculated_window)
            if not market_id:
                log_update("[API ERROR] Could not map live Polymarket ID.")
                state["current_window_timestamp"] = 0
                time.sleep(5)
                continue
                
            state["market_id"] = market_id
            log_update(f"[LIVE TRACKING] Market: {market_id}")

        # 2. HISTORICAL AUTO-RESOLUTION ENGINE
        if old_market_id and old_held_shares > 0:
            status = check_market_resolution(old_market_id, old_side)
            if status == "WIN":
                VIRTUAL_BALANCE += (old_held_shares * 1.00)
                log_update(f"🏆 [RESOLUTION WIN] Paid ${old_held_shares * 1.00:.2f}. Balance: ${VIRTUAL_BALANCE:,.2f}")
                old_market_id = None
                old_held_shares = 0
            elif status == "LOSS":
                log_update(f"💀 [RESOLUTION LOSS] Market resolved 0. Balance: ${VIRTUAL_BALANCE:,.2f}")
                old_market_id = None
                old_held_shares = 0

        # 3. LIVE WINDOW TRADING STRATEGY
        if state["market_id"] and state["market_id"] != "Initializing...":
            price = get_current_token_price(state["market_id"], state["side"])
            
            if price is not None:
                # Moonbag Liquidation Rule (0.98 check runs independent of range guard)
                if state["moonbag_shares"] > 0 and price >= 0.98:
                    revenue = state["moonbag_shares"] * price
                    VIRTUAL_BALANCE += revenue
                    log_update(f"🎯 [MOONBAG TARGET] Hit 0.98! Sold for ${revenue:.2f}")
                    state["moonbag_shares"] = 0

                # Normal Range Guard
                if 0.05 <= price <= 0.90:
                    # Base Entry Setup
                    if state["base_shares"] == 0 and not state["profit_target_hit"]:
                        cost = 100 * price
                        VIRTUAL_BALANCE -= cost
                        state["base_shares"] = 100
                        state["total_cost"] = cost
                        state["average_entry"] = price
                        state["last_buy_price"] = price
                        log_update(f"📥 [BASE ENTRY] Bought 100 at ${price:.2f}.")

                    # Ladder Loop
                    elif state["base_shares"] > 0 and not state["profit_target_hit"]:
                        if price <= (state["last_buy_price"] - 0.05):
                            cost = 100 * price
                            VIRTUAL_BALANCE -= cost
                            state["base_shares"] += 100
                            state["total_cost"] += cost
                            state["average_entry"] = state["total_cost"] / state["base_shares"]
                            state["last_buy_price"] = price
                            log_update(f"🪜 [LADDER BUY] Price dropped. Bought 100 at ${price:.2f}.")

                        elif price >= (state["average_entry"] + 0.10):
                            sell_shares = state["base_shares"] - 100
                            if sell_shares > 0:
                                VIRTUAL_BALANCE += (sell_shares * price)
                                log_update(f"💸 [TAKE PROFIT] Sold {sell_shares}. Moved 100 to Moonbag.")
                            else:
                                log_update(f"💸 [TAKE PROFIT] Moved base 100 to Moonbag.")
                            
                            state["moonbag_shares"] += 100
                            state["base_shares"] = 0
                            state["profit_target_hit"] = True
                            state["trailing_peak"] = price

                    # Trailing Re-Entry Engine
                    elif state["profit_target_hit"]:
                        if price > state["trailing_peak"]:
                            state["trailing_peak"] = price

                        if price <= (state["trailing_peak"] - 0.05):
                            cost = 100 * price
                            VIRTUAL_BALANCE -= cost
                            state["base_shares"] = 100
                            state["total_cost"] = cost
                            state["average_entry"] = price
                            state["last_buy_price"] = price
                            state["profit_target_hit"] = False 
                            state["trailing_peak"] = 0.0
                            log_update(f"🔄 [RE-ENTRY] Dropped 0.05 from peak. Bought 100 at ${price:.2f}.")

        time.sleep(3)

# -----------------------------------------------------------------------------
# Web Server & Dashboard (Single File Structure)
# -----------------------------------------------------------------------------
app = Flask(__name__)

DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Bot Dashboard</title>
    <meta http-equiv="refresh" content="5">
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
        h2 { border-bottom: 2px solid #334155; padding-bottom: 10px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: #1e293b; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .card h3 { margin-top: 0; color: #38bdf8; }
        .highlight { font-size: 1.5em; font-weight: bold; color: #22c55e; }
        .log-box { margin-top: 20px; background: #000; padding: 15px; border-radius: 8px; font-family: monospace; color: #a3e635; }
    </style>
</head>
<body>
    <h2>BTC 15M Binary Options Automated Bot</h2>
    
    <div class="grid">
        <div class="card">
            <h3>🏦 Global Wallet</h3>
            <p>Virtual Balance: <span class="highlight">${{ "%.2f"|format(balance) }}</span></p>
        </div>
        
        <div class="card">
            <h3>📡 Active Market</h3>
            <p><strong>Target Block:</strong> {{ state.current_window_timestamp }}</p>
            <p><strong>Market ID:</strong> {{ state.market_id }}</p>
            <p><strong>Direction Trigger:</strong> {{ state.side }}</p>
        </div>
        
        <div class="card">
            <h3>🪜 Standard Ladder</h3>
            <p><strong>Active Shares:</strong> {{ state.base_shares }}</p>
            <p><strong>Avg Entry:</strong> ${{ "%.2f"|format(state.average_entry) }}</p>
            <p><strong>Last Buy Tier:</strong> ${{ "%.2f"|format(state.last_buy_price) }}</p>
        </div>

        <div class="card">
            <h3>🌕 Moonbag & Trailing</h3>
            <p><strong>Locked Moonbag (0.98):</strong> {{ state.moonbag_shares }} shares</p>
            <p><strong>Re-entry Peak Tracker:</strong> ${{ "%.2f"|format(state.trailing_peak) }}</p>
        </div>
    </div>

    <div class="log-box">
        > {{ state.latest_log }}
    </div>
</body>
</html>
"""

@app.route('/')
def dashboard():
    """Serves the live HTML dashboard."""
    return render_template_string(DASHBOARD_HTML, balance=VIRTUAL_BALANCE, state=state)

if __name__ == "__main__":
    # Spin up the background trading loop as a daemon thread
    trading_thread = threading.Thread(target=bot_loop, daemon=True)
    trading_thread.start()
    
    # Run the web server on the port assigned by Railway
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
