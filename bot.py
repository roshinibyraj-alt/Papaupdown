import time
import requests
import os
import threading
from flask import Flask, render_template_string

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
VIRTUAL_BALANCE = 2000.0
PROFIT_TARGET_PERCENT = 0.15      # 15% profit target
TRAILING_STOP_PERCENT = 0.05      # 5% trailing stop from peak
STOP_LOSS_PERCENT = 0.20          # 20% stop loss
POSITION_SIZE_PERCENT = 0.2       # Use 20% of available balance per trade
MAX_POSITION_USD = 500            # Max $500 per trade

# Global lock for thread safety
state_lock = threading.Lock()

# -----------------------------------------------------------------------------
# Global State
# -----------------------------------------------------------------------------
state = {
    "current_window_timestamp": 0,
    "market_id": "Initializing...",
    "side": "Waiting for candle...",
    "current_price": 0.0,
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
# Polymarket & Bybit API Helpers
# -----------------------------------------------------------------------------
def fetch_previous_candle_trend():
    """Get direction of previous 15-min BTC candle from Bybit"""
    try:
        url = "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=15&limit=2"
        response = requests.get(url, timeout=10)
        data = response.json()
        klines = data.get("result", {}).get("list", [])
        if len(klines) >= 2:
            prev_candle = klines[1]  # second last candle
            close = float(prev_candle[4])
            open_price = float(prev_candle[1])
            return "UP" if close > open_price else "DOWN"
    except Exception as e:
        log_update(f"Error fetching candle trend: {e}")
    return None

def fetch_polymarket_market_id(window_timestamp):
    """Get Polymarket market ID for BTC 15-min up/down event"""
    slug = f"btc-updown-15m-{window_timestamp}"
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    try:
        response = requests.get(url, timeout=10)
        data = response.json()
        if data and "markets" in data[0] and data[0]["markets"]:
            return data[0]["markets"][0].get("id")
    except Exception as e:
        log_update(f"Error fetching market ID: {e}")
    return None

def fetch_token_price(market_id, side):
    """Get current price for UP or DOWN outcome token"""
    try:
        url = f"https://gamma-api.polymarket.com/markets/{market_id}"
        response = requests.get(url, timeout=10)
        data = response.json()
        prices = data.get("outcomePrices")
        if prices and len(prices) >= 2:
            # Index 0 = Up/Yes, Index 1 = Down/No
            return float(prices[0]) if side == "UP" else float(prices[1])
    except Exception as e:
        log_update(f"Error fetching token price: {e}")
    return None

# -----------------------------------------------------------------------------
# Trading Actions (Virtual)
# -----------------------------------------------------------------------------
def buy_position(market_id, side, current_price):
    """Buy initial position at the start of a new window"""
    global VIRTUAL_BALANCE
    
    # Calculate position size
    with state_lock:
        available_balance = VIRTUAL_BALANCE
        position_value = min(available_balance * POSITION_SIZE_PERCENT, MAX_POSITION_USD)
        shares = position_value / current_price
        
        if shares <= 0 or position_value <= 0:
            log_update(f"Cannot buy: Insufficient balance (${available_balance:.2f})")
            return False
        
        # Execute buy
        cost = shares * current_price
        VIRTUAL_BALANCE -= cost
        
        # Update state
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
    """Sell shares and update virtual balance"""
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
    """Liquidate entire position (base + moonbag)"""
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

# -----------------------------------------------------------------------------
# Position Management
# -----------------------------------------------------------------------------
def manage_existing_position(current_price):
    """Check profit target, trailing stop, and stop loss conditions"""
    with state_lock:
        base_shares = state["base_shares"]
        moonbag_shares = state["moonbag_shares"]
        avg_entry = state["average_entry"]
        profit_target_hit = state["profit_target_hit"]
        trailing_peak = state["trailing_peak"]
        
        if base_shares == 0 and moonbag_shares == 0:
            return
        
        # Calculate unrealized PnL
        total_shares = base_shares + moonbag_shares
        total_value = total_shares * current_price
        total_cost = state["total_cost"]
        unrealized_pnl = total_value - total_cost
        unrealized_pnl_pct = (unrealized_pnl / total_cost) * 100 if total_cost > 0 else 0
        
        update_state(unrealized_pnl=unrealized_pnl)
        
        # Stop Loss Check (apply to entire position)
        if not profit_target_hit and total_cost > 0:
            loss_pct = (current_price - avg_entry) / avg_entry
            if loss_pct <= -STOP_LOSS_PERCENT:
                log_update(f"STOP LOSS triggered! Loss: {loss_pct*100:.2f}%")
                close_all_positions(current_price)
                return
        
        # Profit Target Check (sell base shares, keep moonbag)
        if not profit_target_hit and base_shares > 0 and avg_entry > 0:
            gain_pct = (current_price - avg_entry) / avg_entry
            if gain_pct >= PROFIT_TARGET_PERCENT:
                # Sell all base shares
                sell_value = base_shares * current_price
                sell_shares(base_shares, current_price, "profit_target")
                state["base_shares"] = 0
                state["profit_target_hit"] = True
                state["trailing_peak"] = current_price
                log_update(f"PROFIT TARGET HIT! Gain: {gain_pct*100:.2f}% | Moonbag shares kept: {moonbag_shares:.4f}")
                return
        
        # Trailing Stop for Moonbag (after profit target hit)
        if profit_target_hit and moonbag_shares > 0:
            # Update trailing peak
            if current_price > trailing_peak:
                state["trailing_peak"] = current_price
                trailing_peak = current_price
            
            # Check trailing stop condition
            drawdown = (trailing_peak - current_price) / trailing_peak
            if drawdown >= TRAILING_STOP_PERCENT:
                log_update(f"TRAILING STOP triggered! Drawdown: {drawdown*100:.2f}% from peak ${trailing_peak:.4f}")
                sell_shares(moonbag_shares, current_price, "trailing_stop")
                state["moonbag_shares"] = 0
                state["profit_target_hit"] = False
                state["trailing_peak"] = 0.0

# -----------------------------------------------------------------------------
# Background Trading Engine
# -----------------------------------------------------------------------------
def bot_loop():
    global VIRTUAL_BALANCE
    
    while True:
        try:
            current_time = int(time.time())
            current_window = (current_time // 900) * 900  # 15-minute window
            
            # Check for window change
            with state_lock:
                last_window = state["current_window_timestamp"]
            
            if current_window != last_window:
                log_update(f"NEW WINDOW: {current_window}")
                
                # Get current price before liquidation
                market_id = state["market_id"]
                side = state["side"]
                if market_id and market_id != "Initializing..." and side:
                    price = fetch_token_price(market_id, side)
                    if price:
                        # Liquidate any existing position
                        close_all_positions(price)
                
                # Fetch new trend and market
                trend = fetch_previous_candle_trend()
                new_market_id = fetch_polymarket_market_id(current_window)
                
                if trend and new_market_id:
                    update_state(
                        current_window_timestamp=current_window,
                        market_id=new_market_id,
                        side=trend,
                        profit_target_hit=False
                    )
                    log_update(f"Market: {new_market_id} | Side: {trend}")
                    
                    # Buy new position
                    token_price = fetch_token_price(new_market_id, trend)
                    if token_price:
                        update_state(current_price=token_price)
                        buy_position(new_market_id, trend, token_price)
                    else:
                        log_update("Cannot get token price for new position")
                else:
                    log_update(f"Cannot initialize new window - trend: {trend}, market_id: {new_market_id}")
            
            # Manage existing position (if any)
            with state_lock:
                current_market = state["market_id"]
                current_side = state["side"]
                has_position = (state["base_shares"] > 0 or state["moonbag_shares"] > 0)
            
            if current_market and current_market != "Initializing..." and current_side and has_position:
                price = fetch_token_price(current_market, current_side)
                if price:
                    update_state(current_price=price)
                    manage_existing_position(price)
            
            time.sleep(3)
            
        except Exception as e:
            log_update(f"Bot loop error: {e}")
            time.sleep(5)

# -----------------------------------------------------------------------------
# Web Dashboard
# -----------------------------------------------------------------------------
app = Flask(__name__)

DASHBOARD_HTML = """
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="3">
    <style>
        body { background: #0f172a; color: #e2e8f0; font-family: 'Segoe UI', sans-serif; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        h1, h2 { color: #38bdf8; margin-top: 0; }
        .metric { display: inline-block; margin-right: 30px; margin-bottom: 15px; }
        .metric-label { font-size: 12px; color: #94a3b8; }
        .metric-value { font-size: 24px; font-weight: bold; color: #f1f5f9; }
        .positive { color: #4ade80; }
        .negative { color: #f87171; }
        .log-box { background: #0f172a; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 13px; max-height: 300px; overflow-y: auto; }
        hr { border-color: #334155; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Polymarket BTC 15-Min Bot</h1>
        
        <div class="card">
            <h2>📊 Market Status</h2>
            <div class="metric"><div class="metric-label">Market ID</div><div class="metric-value">{{ state.market_id[:20] }}...</div></div>
            <div class="metric"><div class="metric-label">Current Side</div><div class="metric-value">{{ state.side }}</div></div>
            <div class="metric"><div class="metric-label">Token Price</div><div class="metric-value">${{ "%.4f"|format(state.current_price) }}</div></div>
            <div class="metric"><div class="metric-label">Virtual Balance</div><div class="metric-value">${{ "%.2f"|format(state.virtual_balance) }}</div></div>
        </div>
        
        <div class="card">
            <h2>💰 Position</h2>
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
            <h2>⚙️ Strategy Settings</h2>
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

# -----------------------------------------------------------------------------
# Main Entry Point
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    # Start bot in background thread
    bot_thread = threading.Thread(target=bot_loop, daemon=True)
    bot_thread.start()
    
    # Start web server
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, threaded=True)
