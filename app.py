import os
import sys
import time
from datetime import datetime, timezone

# Safe dependency importing to prevent container crash loops
try:
    from py_clob_client.client import ClobClient
    CLOB_CLIENT_AVAILABLE = True
except ModuleNotFoundError:
    print("[WARNING] 'py_clob_client' is missing from the environment. Falling back to local UTC clock sync.")
    CLOB_CLIENT_AVAILABLE = False

def get_server_time_safely():
    """
    Attempts to fetch official Polymarket server time.
    Falls back gracefully to local machine UTC timestamp if unavailable.
    """
    if CLOB_CLIENT_AVAILABLE:
        try:
            # Instantiate client pointing to the Polygon Mainnet CLOB API
            client = ClobClient(host="https://clob.polymarket.com/", chain_id=137)
            return int(client.get_server_time())
        except Exception as e:
            print(f"[WARNING] Failed to fetch server time from Polymarket API ({e}). Using local clock.")
    
    # Fallback to pure local UTC system time
    return int(time.time())

def get_polymarket_15m_slug(coin="btc", offset_windows=0):
    """
    Generates the exact deterministic slug identifier for Polymarket 15m intervals.
    
    Parameters:
      coin (str): Asset ticker (e.g., 'btc', 'eth')
      offset_windows (int): 0 for current active pool, 1 for the next upcoming pool, -1 for previous.
    """
    # 1. Fetch synchronized timestamp
    server_time_sec = get_server_time_safely()
    
    # 2. Drop down to the exact 15-minute interval start (900 seconds floor)
    current_window_start = (server_time_sec // 900) * 900
    
    # 3. Adjust for look-ahead/look-behind windows
    target_timestamp = current_window_start + (offset_windows * 900)
    
    # 4. Format clean string
    slug = f"{coin.lower()}-updown-15m-{target_timestamp}"
    return slug, target_timestamp

def main():
    print("[INFO] Starting Polymarket 15m Slug Synchronization Daemon...")
    
    # Test generation
    try:
        active_slug, active_ts = get_polymarket_15m_slug("btc", offset_windows=0)
        next_slug, next_ts = get_polymarket_15m_slug("btc", offset_windows=1)
        
        print(f"[SUCCESS] Environment Sync Verified.")
        print(f" -> Active Market Slug: {active_slug} (Starts: {datetime.fromtimestamp(active_ts, timezone.utc)})")
        print(f" -> Next Market Slug:   {next_slug} (Starts: {datetime.fromtimestamp(next_ts, timezone.utc)})")
        
    except Exception as e:
        print(f"[CRITICAL] Operational execution failure: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
