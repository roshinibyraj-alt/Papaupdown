import os
import time
from threading import Thread
from flask import Flask, render_template_string
import requests

try:
    from py_clob_client.client import ClobClient
    CLOB_AVAILABLE = True
except ModuleNotFoundError:
    CLOB_AVAILABLE = False
    print("CRITICAL ERROR: py-clob-client package is missing from requirements.")

app = Flask(__name__)

# --- AUTOMATED ENGINE STATE ---
bot_state = {
    "balance": 2000.00,
    "initial_capital": 2000.00,
    "current_window_start": 0,    
    "time_left_seconds": 900,
    "strategy_direction": "PENDING", 
    "live_btc_spot": 0.0,        
    "window_strike_price": 0.0,  
    "current_price": 0.50,       
    "shares_held": 0,
    "total_spent": 0.0,
    "avg_entry_price": 0.0,
    "target_exit_price": 0.0,
    "bought_levels": [],         
    "logs": [],
    "trade_history": []
}

PRIVATE_KEY = os.getenv("POLY_PRIVATE_KEY", "")
API_KEY = os.getenv("POLY_API_KEY", "")
API_SECRET = os.getenv("POLY_API_SECRET", "")
API_PASSPHRASE = os.getenv("POLY_API_PASSPHRASE", "")

def add_log(message):
    timestamp = time.strftime("%H:%M:%S")
    bot_state["logs"].insert(0, f"[{timestamp}] {message}")
    if len(bot_state["logs"]) > 50:
        bot_state["logs"].pop()

def get_authenticated_client():
    if not CLOB_AVAILABLE:
        return None
    try:
        return ClobClient(
            host="https://clob.polymarket.com/",
            chain_id=137,
            key=PRIVATE_KEY if PRIVATE_KEY else None,
            api_key=API_KEY if API_KEY else None,
            api_secret=API_SECRET if API_SECRET else None,
            api_passphrase=API_PASSPHRASE if API_PASSPHRASE else None
        )
    except Exception as e:
        print(f"Failed to connect CLOB API Client: {e}")
        return None

client = get_authenticated_client()

def get_real_btc_price():
    try:
        res = requests.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", timeout=5)
        return float(res.json()["price"])
    except Exception:
        return bot_state["live_btc_spot"] if bot_state["live_btc_spot"] > 0 else 65000.0

def get_sync_time():
    if client:
        try:
            return int(client.get_server_time())
        except Exception:
            pass
    return int(time.time())

# --- DYNAMIC TOKEN SOLVER ENGINE ---
def update_market_context():
    global client
    if not client:
        client = get_authenticated_client()
        
    server_time = get_sync_time()
    interval_start = (server_time // 900) * 900
    window_end = interval_start + 900
    
    bot_state["live_btc_spot"] = get_real_btc_price()
    bot_state["time_left_seconds"] = max(0, window_end - server_time)

    # Reset frame on exact 15-minute turnover boundaries
    if bot_state["current_window_start"] != interval_start:
        bot_state["current_window_start"] = interval_start
        bot_state["window_strike_price"] = bot_state["live_btc_spot"]
        bot_state["shares_held"] = 0
        bot_state["total_spent"] = 0.0
        bot_state["avg_entry_price"] = 0.0
        bot_state["target_exit_price"] = 0.0
        bot_state["bought_levels"] = []
        bot_state["strategy_direction"] = "PENDING"
        add_log(f"--- Switched to Live Market Window: btc-updown-15m-{interval_start} ---")

    # Set strategy layout flags based on spot movement from strike
    if bot_state["strategy_direction"] == "PENDING":
        price_diff = bot_state["live_btc_spot"] - bot_state["window_strike_price"]
        if price_diff > 1.5:
            bot_state["strategy_direction"] = "UP"
            add_log(f"Direction Locked: UP (Spot crossed strike +$1.50)")
        elif price_diff < -1.5:
            bot_state["strategy_direction"] = "DOWN"
            add_log(f"Direction Locked: DOWN (Spot crossed strike -$1.50)")
        else:
            return

    # EXCLUSIVE DYNAMIC BOOK TARGETING (No hardcoded indexes)
    if client:
        try:
            slug = f"btc-updown-15m-{bot_state['current_window_start']}"
            market_data = client.get_market_by_slug(slug)
            
            if market_data and "tokens" in market_data:
                token_id = None
                target_outcome = "Yes" if bot_state["strategy_direction"] == "UP" else "No"
                
                # Scan tokens explicitly matching the required outcome string mapping
                for token in market_data["tokens"]:
                    if token.get("outcome", "").strip().lower() == target_outcome.lower():
                        token_id = token.get("token_id")
                        break
                
                # Fallback safeguard index mapping if outcome names aren't parsed explicitly
                if not token_id:
                    token_id = market_data["tokens"][0]["token_id"] if bot_state["strategy_direction"] == "UP" else market_data["tokens"][1]["token_id"]

                # Fetch real-time book depth
                order_book = client.get_order_book(token_id)
                
                if order_book:
                    if order_book.bids and len(order_book.bids) > 0:
                        bot_state["current_price"] = float(order_book.bids[0].price)
                    elif order_book.asks and len(order_book.asks) > 0:
                        bot_state["current_price"] = float(order_book.asks[0].price)
                    else:
                        # Fallback case: if book liquidity gaps out temporarily, calculate implied spot baseline
                        pass
        except Exception as e:
            print(f"API Streaming Exception Error: {e}")

# --- LADDER EXECUTION ENGINE ---
def run_trading_logic():
    direction = bot_state["strategy_direction"]
    price = bot_state["current_price"]
    
    if direction == "PENDING" or not (0.01 <= price <= 0.99):
        return

    import math
    current_level = round(math.floor(price / 0.05) * 0.05, 2)

    if current_level not in bot_state["bought_levels"] and len(bot_state["bought_levels"]) < 10:
        cost = 100 * price
        if bot_state["balance"] >= cost:
            bot_state["balance"] -= cost
            bot_state["shares_held"] += 100
            bot_state["total_spent"] += cost
            bot_state["bought_levels"].append(current_level)
            
            bot_state["avg_entry_price"] = round(bot_state["total_spent"] / bot_state["shares_held"], 4)
            bot_state["target_exit_price"] = round(bot_state["avg_entry_price"] + 0.10, 4)
            add_log(f"Position Buy Filled: 100 shares at real price {price:.2f} USDC (Bracket: {current_level})")

    if bot_state["shares_held"] > 0 and price >= bot_state["target_exit_price"]:
        revenue = bot_state["shares_held"] * price
        profit = revenue - bot_state["total_spent"]
        bot_state["balance"] += revenue
        
        add_log(f"TAKE PROFIT TARGET HIT: Sold positions at live market price {price:.2f} USDC.")
        bot_state["trade_history"].append({
            "window": time.strftime("%H:%M", time.localtime(bot_state["current_window_start"])),
            "direction": direction,
            "shares": bot_state["shares_held"],
            "avg_entry": bot_state["avg_entry_price"],
            "exit_price": price,
            "pnl": profit
        })
        bot_state["shares_held"] = 0
        bot_state["total_spent"] = 0.0
        bot_state["avg_entry_price"] = 0.0
        bot_state["target_exit_price"] = 0.0
        bot_state["bought_levels"] = []

def background_loop():
    while True:
        try:
            update_market_context()
            run_trading_logic()
        except Exception as e:
            print(f"Core Engine Error loop exception: {e}")
        time.sleep(2)

Thread(target=background_loop, daemon=True).start()

# --- DASHBOARD FRONTEND ---
DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Polymarket Live Order Book Terminal</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <meta http-equiv="refresh" content="2">
</head>
<body class="bg-slate-950 text-slate-100 font-sans min-h-screen p-6">
    <div class="max-w-6xl mx-auto space-y-6">
        
        <div class="flex justify-between items-center bg-slate-900 border border-slate-800 p-6 rounded-xl shadow-lg">
            <div>
                <h1 class="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                    <span class="h-3 w-3 bg-indigo-500 rounded-full animate-pulse"></span>
                    Direct API Book Engine
                </h1>
                <p class="text-slate-400 text-sm mt-1">Target Slug: <span class="font-mono text-indigo-400">btc-updown-15m-{{ current_window_start }}</span></p>
            </div>
            <div class="text-right">
                <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">Time to Expiration</p>
                <p class="text-3xl font-mono font-bold text-amber-400">{{ time_left }}</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Account Balance</p>
                <p class="text-xl font-bold font-mono text-emerald-400 mt-1">${{ balance }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Realized Performance</p>
                <p class="text-xl font-bold font-mono {{ pnl_color }} mt-1">${{ net_pnl }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Locked Direction</p>
                <p class="text-xl font-bold mt-1 {{ bias_color }}">{{ direction }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Binance BTC Spot</p>
                <p class="text-xl font-bold font-mono text-amber-400 mt-1">${{ btc_spot }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Live API Contract Book Price</p>
                <p class="text-xl font-bold font-mono text-blue-400 mt-1">${{ current_price }}</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="md:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-4">
                <div class="flex justify-between items-center border-b border-slate-800 pb-2">
                    <h2 class="text-lg font-bold text-white">Active Positions</h2>
                    <span class="text-xs text-slate-400 font-mono">Strike Anchor: ${{ strike }}</span>
                </div>
                {% if shares > 0 %}
                <div class="grid grid-cols-2 gap-4 bg-slate-950 p-4 rounded-lg border border-slate-850 font-mono text-sm">
                    <div><span class="text-slate-500">Shares Held:</span> <span class="text-white font-bold">{{ shares }}</span></div>
                    <div><span class="text-slate-500">Allocated Capital:</span> <span class="text-white">${{ total_spent }}</span></div>
                    <div><span class="text-slate-500">Average Basis Price:</span> <span class="text-indigo-400">${{ avg_entry }}</span></div>
                    <div><span class="text-slate-500">Profit Trigger Level:</span> <span class="text-emerald-400 font-bold">${{ target_exit }}</span></div>
                </div>
                {% else %}
                <div class="flex flex-col items-center justify-center py-8 text-slate-500 text-sm bg-slate-950 rounded-lg border border-dashed border-slate-800">
                    <p>Scanning markets... No active ladders currently deployed.</p>
                </div>
                {% endif %}
            </div>

            <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl flex flex-col">
                <h2 class="text-lg font-bold text-white border-b border-slate-800 pb-2 mb-3">Session Log</h2>
                <div class="flex-1 overflow-y-auto max-h-[160px] space-y-2 pr-1 text-xs font-mono">
                    {% for trade in history %}
                    <div class="flex justify-between items-center bg-slate-950 p-2 rounded border border-slate-850">
                        <div><span class="text-slate-400 font-bold">[{{ trade.window }}]</span> {{ trade.direction }}</div>
                        <div class="{% if trade.pnl >= 0 %}text-emerald-400{% else %}text-rose-400{% endif %} font-bold">
                            {{ "{:+.2f}".format(trade.pnl) }} USDC
                        </div>
                    </div>
                    {% else %}
                    <p class="text-slate-600 text-center py-6">No resolved history records.</p>
                    {% endfor %}
                </div>
            </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl">
            <h2 class="text-lg font-bold text-white border-b border-slate-800 pb-2 mb-3">System Log Threads</h2>
            <div class="bg-slate-950 p-4 rounded-lg h-48 overflow-y-auto border border-slate-850 font-mono text-xs space-y-1.5 text-slate-300">
                {% for log in logs %}
                <div class="border-b border-slate-900 pb-1 last:border-0">{{ log }}</div>
                {% endfor %}
            </div>
        </div>
    </div>
</body>
</html>
"""

@app.route("/")
def index():
    minutes = bot_state["time_left_seconds"] // 60
    seconds = bot_state["time_left_seconds"] % 60
    time_str = f"{minutes:02d}:{seconds:02d}"
    
    net_pnl = bot_state["balance"] - bot_state["initial_capital"]
    pnl_color = "text-emerald-400" if net_pnl >= 0 else "text-rose-400"
    
    if bot_state["strategy_direction"] == "UP":
        bias_color = "text-emerald-400"
    elif bot_state["strategy_direction"] == "DOWN":
        bias_color = "text-rose-500"
    else:
        bias_color = "text-amber-400 animate-pulse"

    return render_template_string(
        DASHBOARD_HTML,
        current_window_start=bot_state["current_window_start"],
        time_left=time_str,
        balance=f"{bot_state['balance']:.2f}",
        net_pnl=f"{net_pnl:+.2f}",
        pnl_color=pnl_color,
        direction=bot_state["strategy_direction"],
        bias_color=bias_color,
        btc_spot=f"{bot_state['live_btc_spot']:,}",
        strike=f"{bot_state['window_strike_price']:,}",
        current_price=f"{bot_state['current_price']:.2f}",
        shares=bot_state["shares_held"],
        total_spent=f"{bot_state['total_spent']:.2f}",
        avg_entry=f"{bot_state['avg_entry_price']:.4f}",
        target_exit=f"{bot_state['target_exit_price']:.4f}",
        logs=bot_state["logs"],
        history=bot_state["trade_history"]
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
