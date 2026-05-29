import time
from datetime import datetime, timezone
from py_clob_client.client import ClobClient

def get_polymarket_15m_slug(coin="btc", offset_windows=0):
    """
    Generates the exact deterministic slug for Polymarket 15m markets.
    
    offset_windows = 0 : Current active market
    offset_windows = 1 : Next upcoming market
    offset_windows = -1: Just completed market
    """
    try:
        # 1. Instantiate the client to fetch official server time (prevents local clock drift)
        client = ClobClient(host="https://clob.polymarket.com/", chain_id=137)
        server_time_sec = client.get_server_time()
    except Exception:
        # Fallback to local UTC if API is temporarily unreachable
        server_time_sec = int(time.time())
    
    # 2. Floor to the exact 15-minute start interval (900 seconds)
    current_window_start = (server_time_sec // 900) * 900
    
    # 3. Apply explicit window offset if you need to look ahead or behind
    target_timestamp = current_window_start + (offset_windows * 900)
    
    return f"{coin.lower()}-updown-15m-{target_timestamp}"

# Verification execution
if __name__ == "__main__":
    current_slug = get_polymarket_15m_slug("btc", offset_windows=0)
    next_slug = get_polymarket_15m_slug("btc", offset_windows=1)
    
    print(f"Active Live Slug: {current_slug}")
    print(f"Next Up Slug:     {next_slug}")
