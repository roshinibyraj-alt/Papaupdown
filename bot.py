import time
import requests
import json

# -----------------------------------------------------------------------------
# Configuration & Global Demo State
# -----------------------------------------------------------------------------
VIRTUAL_BALANCE = 2000.0

# Active market tracking states
state = {
    "current_window_timestamp": 0,
    "market_id": None,
    "side": None,             # "UP" or "DOWN"
    
    # Standard Ladder Tracking
    "base_shares": 0,         # Current shares active in the downward ladder
    "total_cost": 0.0,        # Total cash spent on the current base_shares
    "average_entry": 0.0,     # Dynamic calculated entry price
    "last_buy_price": 0.0,    # Price of the absolute last ladder step buy
    
    # Moonbag Tracking (The 0.98 rule)
    "moonbag_shares": 0,      # Independent shares held until 0.98 or expiry
    
    # Trailing Re-Entry Tracking
    "profit_target_hit": False, # Triggers once price hits average_entry + 0.10
    "trailing_peak": 0.0       # Tracks highest price touched after profit target
}

def check_binance_candle():
    """Checks the color of the last fully completed 15-minute BTC candle."""
    try:
        url = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=2"
        response = requests.get(url, timeout=10).json()
        prev_candle = response[0]  # Index 0 is the fully closed 15m candle
        open_price = float(prev_candle[1])
        close_price = float(prev_candle[4])
        return "UP" if close_price > open_price else "DOWN"
    except Exception as e:
        print(f"[SYSTEM ERROR] Failed to fetch Binance candle: {e}")
        return None

def fetch_live_polymarket_id(window_timestamp, side):
    """Calculates the target slug and retrieves market metadata from Gamma API."""
    slug = f"btc-updown-15m-{window_timestamp}"
    url = f"https://gamma-api.polymarket.com/events?slug={slug}"
    
    # 10 retries over 20 seconds to account for the opening API index lag
    for _ in range(10):
        try:
            res = requests.get(url, timeout=10).json()
            if res and "markets" in res[0] and res[0]["markets"]:
                market = res[0]["markets"][0]
                return market.get("id")
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
    """Pings the oracle resolution state to verify if the position won or lost."""
    try:
        url = f"https://gamma-api.polymarket.com/markets/{market_id}"
        res = requests.get(url, timeout=10).json()
        
        # Check if market has fully settled
        if res.get("closed") is True or res.get("resolved") is True:
            prices = res.get("outcomePrices")
            if prices:
                final_price = float(prices[0]) if side == "UP" else float(prices[1])
                if final_price >= 0.99:
                    return "WIN"
                elif final_price <= 0.01:
                    return "LOSS"
    except Exception as e:
        print(f"[RESOLUTION ERROR] Couldn't check market resolution: {e}")
    return "PENDING"

# -----------------------------------------------------------------------------
# Core Execution Engine
# -----------------------------------------------------------------------------
def main():
    global VIRTUAL_BALANCE
    print(f"====================================================")
    print(f"       BTC 15M BINARY OPTIONS AUTOMATED BOT         ")
    print(f"       INITIAL DEMO CAPITAL: ${VIRTUAL_BALANCE:,.2f}       ")
    print(f"====================================================")
    
    # Variables to hold previous window information for post-settlement tracking
    old_market_id = None
    old_side = None
    old_held_shares = 0

    while True:
        current_time = int(time.time())
        # Snap current time down to the exact 900-second block boundary
        calculated_window = (current_time // 900) * 900
        
        # ---------------------------------------------------------------------
        # WINDOW BOUNDARY HANDOVER LOGIC
        # ---------------------------------------------------------------------
        if calculated_window != state["current_window_timestamp"]:
            print(f"\n----------------------------------------------------")
            print(f"[WINDOW TRANSITION] New 15-Minute Block Detected: {calculated_window}")
            print(f"----------------------------------------------------")
            
            # Pack up any outstanding shares left on the table for natural settlement checks
            old_held_shares = state["base_shares"] + state["moonbag_shares"]
            old_market_id = state["market_id"]
            old_side = state["side"]
            
            if old_held_shares > 0 and old_market_id:
                print(f"[EXPIRED POSITION] Leftover: {old_held_shares} shares in old market ({old_market_id}). Moving to auto-resolution tracking...")

            # Clean and reset state dictionary completely for the fresh window
            state["current_window_timestamp"] = calculated_window
            state["base_shares"] = 0
            state["total_cost"] = 0.0
            state["average_entry"] = 0.0
            state["last_buy_price"] = 0.0
            state["moonbag_shares"] = 0
            state["profit_target_hit"] = False
            state["trailing_peak"] = 0.0
            
            # Determine direction from previous candle
            side = check_binance_candle()
            if not side:
                print("[SYSTEM ALERT] Candle trend unreadable. Forcing retry next cycle.")
                state["current_window_timestamp"] = 0
                time.sleep(5)
                continue
                
            state["side"] = side
            print(f"[TREND ANALYSIS] Previous Binance Candle Close: {'GREEN 🟢' if side == 'UP' else 'RED 🔴'}")
            print(f"[STRATEGY] Activating {side} Token dynamic ladder system.")
            
            # Fetch live contract ID
            market_id = fetch_live_polymarket_id(calculated_window, side)
            if not market_id:
                print("[API ERROR] Could not map live Polymarket ID. Retrying structural mapping...")
                state["current_window_timestamp"] = 0
                time.sleep(5)
                continue
                
            state["market_id"] = market_id
            print(f"[LIVE TRACKING STARTED] Market ID: {market_id}")

        # ---------------------------------------------------------------------
        # HISTORICAL AUTO-RESOLUTION ENGINE (P&L LOGGER)
        # ---------------------------------------------------------------------
        if old_market_id and old_held_shares > 0:
            status = check_market_resolution(old_market_id, old_side)
            if status == "WIN":
                payout = old_held_shares * 1.00
                VIRTUAL_BALANCE += payout
                print(f"\n🏆 [RESOLUTION RESULT] Market {old_market_id} Resolved as a WIN!")
                print(f"💰 Payout: ${payout:.2f} | Current Balance: ${VIRTUAL_BALANCE:,.2f}")
                old_market_id = None
                old_held_shares = 0
            elif status == "LOSS":
                print(f"\n💀 [RESOLUTION RESULT] Market {old_market_id} Resolved as a LOSS.")
                print(f"📉 Payout: $0.00 | Current Balance: ${VIRTUAL_BALANCE:,.2f}")
                old_market_id = None
                old_held_shares = 0

        # ---------------------------------------------------------------------
        # LIVE WINDOW TRADING STRATEGY
        # ---------------------------------------------------------------------
        if state["market_id"]:
            price = get_current_token_price(state["market_id"], state["side"])
            
            if price is not None:
                # 1. Price Range Hard Guard
                if not (0.05 <= price <= 0.90):
                    # Moonbag remains monitored regardless of range guards
                    if state["moonbag_shares"] > 0 and price >= 0.98:
                        VIRTUAL_BALANCE += (state["moonbag_shares"] * price)
                        print(f"🎯 [MOONBAG TARGET] Price touched {price}. Liquidating 100 Moonbag shares for ${state['moonbag_shares'] * price:.2f}")
                        state["moonbag_shares"] = 0
                        print(f"[DEMO WALLET] Balance: ${VIRTUAL_BALANCE:,.2f}")
                    time.sleep(3)
                    continue

                # 2. Base Entry Setup
                if state["base_shares"] == 0 and not state["profit_target_hit"]:
                    cost = 100 * price
                    VIRTUAL_BALANCE -= cost
                    state["base_shares"] = 100
                    state["total_cost"] = cost
                    state["average_entry"] = price
                    state["last_buy_price"] = price
                    print(f"📥 [BASE ENTRY] Bought 100 shares at ${price:.2f}. Balance: ${VIRTUAL_BALANCE:,.2f}")

                # 3. Standard Downward Ladder Loop
                elif state["base_shares"] > 0 and not state["profit_target_hit"]:
                    # Check if price dropped 0.05 from last executed buy tier
                    if price <= (state["last_buy_price"] - 0.05):
                        cost = 100 * price
                        VIRTUAL_BALANCE -= cost
                        state["base_shares"] += 100
                        state["total_cost"] += cost
                        state["average_entry"] = state["total_cost"] / state["base_shares"]
                        state["last_buy_price"] = price
                        print(f"🪜 [LADDER BUY] Price dropped. Bought 100 shares at ${price:.2f}.")
                        print(f"📊 Total Base Position: {state['base_shares']} shares | Avg Entry: ${state['average_entry']:.2f}")

                    # Check if price increased 0.10 from current average entry price
                    elif price >= (state["average_entry"] + 0.10):
                        sell_shares = state["base_shares"] - 100
                        # Scenario A: We have accumulated over 100 shares. Sell all excess.
                        if sell_shares > 0:
                            revenue = sell_shares * price
                            VIRTUAL_BALANCE += revenue
                            state["moonbag_shares"] += 100
                            print(f"💸 [TAKE PROFIT] Target hit at ${price:.2f}. Liquidating {sell_shares} ladder shares for ${revenue:.2f}.")
                        # Scenario B: We hit target on base entry of exactly 100 shares. Move whole batch to Moonbag.
                        else:
                            state["moonbag_shares"] += 100
                            print(f"💸 [TAKE PROFIT] Target hit at ${price:.2f} with base entry. Transferring 100 shares to Moonbag container.")
                        
                        state["base_shares"] = 0
                        state["total_cost"] = 0.0
                        state["average_entry"] = 0.0
                        state["profit_target_hit"] = True
                        state["trailing_peak"] = price
                        print(f"🔒 [MOONBAG STATUS] 100 shares locked until $0.98. Current Wallet: ${VIRTUAL_BALANCE:,.2f}")

                # 4. Trailing Re-Entry Engine & Independent Moonbag Take Profit Check
                elif state["profit_target_hit"]:
                    # Keep track of structural upward movement peak
                    if price > state["trailing_peak"]:
                        state["trailing_peak"] = price

                    # Re-Entry Condition: Price pulls back 0.05 from its post-take-profit peak
                    if price <= (state["trailing_peak"] - 0.05):
                        print(f"🔄 [TRAILING RE-ENTRY] Price dropped 0.05 from peak (${state['trailing_peak']:.2f}) to ${price:.2f}.")
                        cost = 100 * price
                        VIRTUAL_BALANCE -= cost
                        state["base_shares"] = 100
                        state["total_cost"] = cost
                        state["average_entry"] = price
                        state["last_buy_price"] = price
                        state["profit_target_hit"] = False  # Reactivates standard ladder rules for new batch
                        state["trailing_peak"] = 0.0
                        print(f"📥 [LADDER RESET] New 100 share ladder cycle activated. Balance: ${VIRTUAL_BALANCE:,.2f}")

                    # Separate runtime track to kill the moonbag early if it hits 0.98
                    if state["moonbag_shares"] > 0 and price >= 0.98:
                        revenue = state["moonbag_shares"] * price
                        VIRTUAL_BALANCE += revenue
                        print(f"🎯 [MOONBAG MOONSHOT] Moonbag hit max target at ${price:.2f}! Selling 100 shares for ${revenue:.2f}")
                        state["moonbag_shares"] = 0
                        print(f"[DEMO WALLET] Balance: ${VIRTUAL_BALANCE:,.2f}")

        # Throttle to keep logs clean and respect network endpoints
        time.sleep(3)

if __name__ == "__main__":
    main()
