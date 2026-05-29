import os
import time
import math
import requests
from threading import Thread
from flask import Flask, render_template_string

app = Flask(__name__)

# --- AUTOMATED ENGINE STATE ---
bot_state = {
    "balance": 2000.00,          # Starting Demo Capital
    "initial_capital": 2000.00,
    "current_window_end": 0,
    "time_left_seconds": 900,
    "strategy_direction": "PENDING", # Dynamically assigned by the live window's movement
    "live_btc_spot": 0.0,        
    "window_strike_price": 0.0,  # Live baseline strike price
    "current_price": 0.50,       
    "shares_held": 0,
    "total_spent": 0.0,
    "avg_entry_price": 0.0,
    "target_exit_price": 0.0,
    "bought_levels": [],         
    "logs": [],
    "trade_history": []
}

def add_log(message):
    timestamp = time.strftime("%H:%M:%S")
    bot_state["logs"].insert(0, f"[{timestamp}] {message}")
    if len(bot_state["logs"]) > 50:
        bot_state["logs"].pop()

# --- LIVE BITCOIN SPOT FETCH ---
def get_real_btc_price():
    try:
        res = requests.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", timeout=5)
        data = res.json()
        return float(data["price"])
    except Exception:
        return bot_state["live_btc_spot"] if bot_state["live_btc_spot"] > 0 else 65000.0

# --- CORE MARKET MECHANICS & DIRECTION ENGINE ---
def update_market_context():
    now = int(time.time())
    interval_start = (now // 900) * 900
    window_end = interval_start + 900
    
    # Get freshest live market price
    bot_state["live_btc_spot"] = get_real_btc_price()

    # DETECT WINDOW TURNOVER
    if bot_state["current_window_end"] != window_end:
        # Settle any outstanding positions from the expired window before wiping state
        if bot_state["current_window_end"] > 0 and bot_state["shares_held"] > 0:
            win = False
            if bot_state["strategy_direction"] == "UP" and bot_state["live_btc_spot"] > bot_state["window_strike_price"]:
                win = True
            elif bot_state["strategy_direction"] == "DOWN" and bot_state["live_btc_spot"] < bot_state["window_strike_price"]:
                win = True
                
            payout_per_share = 1.00 if win else 0.00
            revenue = bot_state["shares_held"] * payout_per_share
            profit_loss = revenue - bot_state["total_spent"]
            bot_state["balance"] += revenue
            
            outcome_text = f"WON ($1.00 payout)" if win else f"LOST ($0.00 payout)"
            add_log(f"Expired Window Settled: {outcome_text}. Final Spot: ${bot_state['live_btc_spot']:,} | PnL: {profit_loss:+.2f} USDC")
            
            bot_state["trade_history"].append({
                "window": time.strftime("%H:%M", time.localtime(bot_state["current_window_end"])),
                "direction": bot_state["strategy_direction"],
                "shares": bot_state["shares_held"],
                "avg_entry": bot_state["avg_entry_price"],
                "exit_price": payout_per_share,
                "pnl": profit_loss
            })

        # Initialize parameters strictly for the brand-new live window
        bot_state["current_window_end"] = window_end
        bot_state["window_strike_price"] = bot_state["live_btc_spot"]
        bot_state["shares_held"] = 0
        bot_state["total_spent"] = 0.0
        bot_state["avg_entry_price"] = 0.0
        bot_state["target_exit_price"] = 0.0
        bot_state["bought_levels"] = []
        bot_state["strategy_direction"] = "PENDING"
        
        add_log(f"--- New Live 15m Window Opened ---")
        add_log(f"Live Strike locked at: ${bot_state['window_strike_price']:,} USD. Monitoring active trend...")

    bot_state["time_left_seconds"] = max(0, window_end - now)

    # DYNAMIC LIVE-WINDOW DIRECTION LOCK
    if bot_state["strategy_direction"] == "PENDING":
        price_diff = bot_state["live_btc_spot"] - bot_state["window_strike_price"]
        
        # Confirm immediate trend breakout on the live window ($2 threshold)
        if price_diff > 2.0:
            bot_state["strategy_direction"] = "UP"
            add_log(f"Live Window Breakout: UP. Activating live UP contract ladder.")
        elif price_diff < -2.0:
            bot_state["strategy_direction"] = "DOWN"
            add_log(f"Live Window Breakout: DOWN. Activating live DOWN contract ladder.")
        else:
            bot_state["current_price"] = 0.50
            return

    # REALISTIC LIVE CONTRACT PRICING
    # Tracks contract values strictly based on current live window performance
    if bot_state["strategy_direction"] == "UP":
        price_distance = bot_state["live_btc_spot"] - bot_state["window_strike_price"]
        calculated_price = 0.50 + (price_distance * 0.002)
    else:
        # For DOWN strategy, contract gains value as live spot drops below strike
        price_distance = bot_state["window_strike_price"] - bot_state["live_btc_spot"]
        calculated_price = 0.50 + (price_distance * 0.002)
        
    bot_state["current_price"] = round(calculated_price, 2)
    
    # Keep bounded within realistic order book bounds
    if bot_state["current_price"] > 0.95: bot_state["current_price"] = 0.95
    if bot_state["current_price"] < 0.02: bot_state["current_price"] = 0.02

# --- CORE LADDER EXECUTION ENGINE ---
def run_trading_logic():
    direction = bot_state["strategy_direction"]
    price = bot_state["current_price"]
    
    if direction == "PENDING" or not (0.05 <= price <= 0.90):
        return

    current_level = round(math.floor(price / 0.05) * 0.05, 2)

    # Accumulate on pullbacks relative to the live target direction
    if current_level not in bot_state["bought_levels"] and len(bot_state["bought_levels"]) < 10:
        cost = 100 * price
        if bot_state["balance"] >= cost:
            bot_state["balance"] -= cost
            bot_state["shares_held"] += 100
            bot_state["total_spent"] += cost
            bot_state["bought_levels"].append(current_level)
            
            bot_state["avg_entry_price"] = round(bot_state["total_spent"] / bot_state["shares_held"], 4)
            bot_state["target_exit_price"] = round(bot_state["avg_entry_price"] + 0.10, 4)
            add_log(f"Live Ladder Filled: 100 shares at {price:.2f} USDC (Bracket: {current_level:.2f})")

    # Take Profit execution
    if bot_state["shares_held"] > 0 and price >= bot_state["target_exit_price"]:
        revenue = bot_state["shares_held"] * price
        profit = revenue - bot_state["total_spent"]
        bot_state["balance"] += revenue
        
        add_log(f"TAKE PROFIT HIT! Sold all {bot_state['shares_held']} shares at {price:.2f} USDC. Net Profit: {profit:.2f} USDC")
        bot_state["trade_history"].append({
            "window": time.strftime("%H:%M", time.localtime(bot_state["current_window_end"])),
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
            print(f"Engine Error: {e}")
        time.sleep(2)

Thread(target=background_loop, daemon=True).start()

# --- WEB DASHBOARD FRONTEND ---
DASHBOARD_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Polymarket 15m BTC Live Trading Console</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <meta http-equiv="refresh" content="3">
</head>
<body class="bg-slate-950 text-slate-100 font-sans min-h-screen p-6">
    <div class="max-w-6xl mx-auto space-y-6">
        
        <div class="flex justify-between items-center bg-slate-900 border border-slate-800 p-6 rounded-xl shadow-lg">
            <div>
                <h1 class="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                    <span class="h-3 w-3 bg-emerald-500 rounded-full animate-pulse"></span>
                    Polymarket BTC 15m Live Window Console
                </h1>
                <p class="text-slate-400 text-sm mt-1">Active Contract Reference: <span class="font-mono text-indigo-400">btc-15m-{{ current_window_end }}</span></p>
            </div>
            <div class="text-right">
                <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">Live Window Expiry In</p>
                <p class="text-3xl font-mono font-bold text-amber-400">{{ time_left }}</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Available Capital</p>
                <p class="text-xl font-bold font-mono text-emerald-400 mt-1">${{ balance }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Total Net Profit</p>
                <p class="text-xl font-bold font-mono {{ pnl_color }} mt-1">${{ net_pnl }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Live Window Direction</p>
                <p class="text-xl font-bold mt-1 {{ bias_color }}">{{ direction }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Live BTC Spot</p>
                <p class="text-xl font-bold font-mono text-amber-400 mt-1">${{ btc_spot }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                <p class="text-xs font-semibold uppercase text-slate-500">Active Token Price</p>
                <p class="text-xl font-bold font-mono text-blue-400 mt-1">${{ current_price }}</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="md:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-4">
                <div class="flex justify-between items-center border-b border-slate-800 pb-2">
                    <h2 class="text-lg font-bold text-white">Active Position Status</h2>
                    <span class="text-xs text-slate-400 font-mono">Live Window Strike: ${{ strike }}</span>
                </div>
                {% if shares > 0 %}
                <div class="grid grid-cols-2 gap-4 bg-slate-950 p-4 rounded-lg border border-slate-850 font-mono text-sm">
                    <div><span class="text-slate-500">Shares Accumulated:</span> <span class="text-white font-bold">{{ shares }}</span></div>
                    <div><span class="text-slate-500">Total Invested:</span> <span class="text-white">${{ total_spent }}</span></div>
                    <div><span class="text-slate-500">Average Entry Cost:</span> <span class="text-indigo-400">${{ avg_entry }}</span></div>
                    <div><span class="text-slate-500">Take-Profit Target:</span> <span class="text-emerald-400 font-bold">${{ target_exit }}</span></div>
                </div>
                <div class="space-y-1">
                    <p class="text-xs font-semibold text-slate-500">Brackets Triggered in Live Window:</p>
                    <div class="flex gap-2 flex-wrap pt-1">
                        {% for lvl in levels %}
                        <span class="bg-indigo-950/50 text-indigo-300 border border-indigo-800/60 px-2.5 py-0.5 rounded text-xs font-mono">{{ lvl }} USDC</span>
                        {% endfor %}
                    </div>
                </div>
                {% else %}
                <div class="flex flex-col items-center justify-center py-8 text-slate-500 text-sm bg-slate-950 rounded-lg border border-dashed border-slate-800">
                    <p>No active positions open.</p>
                    <p class="text-xs text-slate-600 mt-1">Waiting for live window breakout to initiate tracking ladders.</p>
                </div>
                {% endif %}
            </div>

            <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl flex flex-col">
                <h2 class="text-lg font-bold text-white border-b border-slate-800 pb-2 mb-3">Session Performance</h2>
                <div class="flex-1 overflow-y-auto max-h-[160px] space-y-2 pr-1 text-xs font-mono">
                    {% for trade in history %}
                    <div class="flex justify-between items-center bg-slate-950 p-2 rounded border border-slate-850">
                        <div>
                            <span class="text-slate-400 font-bold">Ref: {{ trade.window }}</span> 
                            <span class="text-slate-500">Side:</span> {{ trade.direction }}
                        </div>
                        <div class="{% if trade.pnl >= 0 %}text-emerald-400{% else %}text-rose-400{% endif %} font-bold">
                            {{ "{:+.2f}".format(trade.pnl) }} USDC
                        </div>
                    </div>
                    {% else %}
                    <p class="text-slate-600 text-center py-6">No closed positions yet this session.</p>
                    {% endfor %}
                </div>
            </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl">
            <h2 class="text-lg font-bold text-white border-b border-slate-800 pb-2 mb-3">Live Execution Console Log</h2>
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
        current_window_end=bot_state["current_window_end"],
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
        levels=bot_state["bought_levels"],
        logs=bot_state["logs"],
        history=bot_state["trade_history"]
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
