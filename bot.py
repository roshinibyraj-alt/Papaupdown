"""
═══════════════════════════════════════════════════════════════
  Polymarket BTC 15-Minute DEMO Trading Bot
  ▸ $2,000 virtual capital  |  Paper trades only  |  No real money
  ▸ Signals: Price Spike + Trend + Fear & Greed sentiment
  ▸ Deploy on Railway: worker process, zero config needed
═══════════════════════════════════════════════════════════════
"""

import os, json, time, logging, statistics
from datetime import datetime, timezone
from collections import deque

import requests

# ── CONFIGURATION  (override via Railway Environment Variables) ────────────────
DEMO_CAPITAL       = float(os.environ.get("DEMO_CAPITAL",        "2000"))
MAX_TRADE_USD      = float(os.environ.get("MAX_TRADE_USD",         "20"))   # max $ per trade
MAX_OPEN_POSITIONS = int  (os.environ.get("MAX_OPEN_POSITIONS",    "10"))   # concurrent bets
STOP_LOSS_PCT      = float(os.environ.get("STOP_LOSS_PCT",        "0.30"))  # 30 % stop loss
TAKE_PROFIT_PCT    = float(os.environ.get("TAKE_PROFIT_PCT",      "0.20"))  # 20 % take profit
SPIKE_THRESHOLD    = float(os.environ.get("SPIKE_THRESHOLD",     "0.003"))  # 0.3 % price move
MIN_EDGE_PRICE     = float(os.environ.get("MIN_EDGE_PRICE",       "0.35"))  # skip if YES > this
MAX_EDGE_PRICE     = float(os.environ.get("MAX_EDGE_PRICE",       "0.65"))  # skip if YES > this
LOOP_INTERVAL      = int  (os.environ.get("LOOP_INTERVAL",        "900"))   # 900s = 15 min
TRADES_FILE        = os.environ.get("TRADES_FILE", "paper_trades.json")

# ── LOGGING ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("PolyBot")

# ── STATE ──────────────────────────────────────────────────────────────────────
price_history: deque = deque(maxlen=10)   # last 10 BTC prices for trend
portfolio = {
    "cash":           DEMO_CAPITAL,
    "open_positions": [],          # list of active bets
    "closed_trades":  [],          # resolved / expired bets
    "total_profit":   0.0,
    "wins":           0,
    "losses":         0,
    "skipped":        0,
}


# ══════════════════════════════════════════════════════════════════════════════
#  DATA FETCHERS
# ══════════════════════════════════════════════════════════════════════════════

def get_btc_price() -> float | None:
    """Fetch live BTC/USDT price from Binance public ticker (no API key needed)."""
    try:
        r = requests.get(
            "https://api.binance.com/api/v3/ticker/price",
            params={"symbol": "BTCUSDT"},
            timeout=8,
        )
        r.raise_for_status()
        return float(r.json()["price"])
    except Exception as e:
        log.warning(f"Binance price fetch failed: {e}")
    # Fallback: CoinGecko
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": "bitcoin", "vs_currencies": "usd"},
            timeout=10,
        )
        r.raise_for_status()
        return float(r.json()["bitcoin"]["usd"])
    except Exception as e:
        log.warning(f"CoinGecko fallback failed: {e}")
    return None


def get_fear_greed() -> int | None:
    """Fetch Crypto Fear & Greed Index (0=extreme fear, 100=extreme greed)."""
    try:
        r = requests.get("https://api.alternative.me/fng/?limit=1", timeout=8)
        r.raise_for_status()
        return int(r.json()["data"][0]["value"])
    except Exception as e:
        log.warning(f"Fear & Greed fetch failed: {e}")
    return None


def find_btc_15m_market() -> dict | None:
    """Find an active BTC 15-min market on Polymarket via the Gamma API."""
    keywords = ("btc", "bitcoin")
    try:
        r = requests.get(
            "https://gamma-api.polymarket.com/markets",
            params={
                "active": "true",
                "closed": "false",
                "limit": 100,
                "order": "startDate",
                "ascending": "false",
            },
            timeout=10,
        )
        r.raise_for_status()
        markets = r.json()
        if not isinstance(markets, list):
            markets = markets.get("markets", [])

        for m in markets:
            q = m.get("question", "").lower()
            if any(k in q for k in keywords) and "15" in q:
                return m
    except Exception as e:
        log.warning(f"Market search failed: {e}")
    return None


def get_clob_prices(condition_id: str) -> dict | None:
    """
    Get YES/NO mid-prices from Polymarket CLOB.
    Returns {"yes": float, "no": float} or None.
    """
    try:
        r = requests.get(
            f"https://clob.polymarket.com/markets/{condition_id}",
            timeout=8,
        )
        r.raise_for_status()
        data = r.json()
        tokens = data.get("tokens", [])
        prices = {}
        for tok in tokens:
            outcome = tok.get("outcome", "").upper()
            price   = float(tok.get("price", 0))
            if outcome in ("YES", "NO"):
                prices[outcome.lower()] = price
        if "yes" in prices and "no" in prices:
            return prices
    except Exception as e:
        log.warning(f"CLOB price fetch failed ({condition_id}): {e}")
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  SIGNAL ENGINE
# ══════════════════════════════════════════════════════════════════════════════

def compute_signals(current_price: float, fear_greed: int | None) -> dict:
    """
    Returns a signal dict:
      direction  : "YES" | "NO" | "SKIP"
      confidence : 0.0 – 1.0
      reasons    : list[str]
    """
    scores  = []
    reasons = []

    # ── Signal 1: Price Spike ──────────────────────────────────────────────
    if len(price_history) >= 2:
        prev  = price_history[-2]
        move  = (current_price - prev) / prev
        spike_score = min(abs(move) / SPIKE_THRESHOLD, 1.0)  # 0-1 normalised
        if move > SPIKE_THRESHOLD:
            scores.append(("YES", spike_score))
            reasons.append(f"Spike UP {move*100:.2f}% (score {spike_score:.2f})")
        elif move < -SPIKE_THRESHOLD:
            scores.append(("NO", spike_score))
            reasons.append(f"Spike DOWN {move*100:.2f}% → NO (score {spike_score:.2f})")
        else:
            reasons.append(f"No spike ({move*100:.3f}%)")

    # ── Signal 2: Short-term Trend (last 3 prices) ─────────────────────────
    if len(price_history) >= 3:
        last3 = list(price_history)[-3:]
        if last3[0] < last3[1] < last3[2]:
            scores.append(("YES", 0.6))
            reasons.append("Trend UP (3-bar)")
        elif last3[0] > last3[1] > last3[2]:
            scores.append(("NO", 0.6))
            reasons.append("Trend DOWN (3-bar)")
        else:
            reasons.append("No clear trend")

    # ── Signal 3: Fear & Greed sentiment ──────────────────────────────────
    if fear_greed is not None:
        if fear_greed >= 70:
            scores.append(("YES", 0.55))
            reasons.append(f"Greed {fear_greed}/100 → bullish")
        elif fear_greed <= 30:
            scores.append(("NO", 0.55))
            reasons.append(f"Fear {fear_greed}/100 → bearish")
        else:
            reasons.append(f"Neutral sentiment {fear_greed}/100")

    if not scores:
        return {"direction": "SKIP", "confidence": 0.0, "reasons": reasons}

    yes_score = sum(s for d, s in scores if d == "YES")
    no_score  = sum(s for d, s in scores if d == "NO")
    total     = yes_score + no_score

    if total == 0:
        return {"direction": "SKIP", "confidence": 0.0, "reasons": reasons}

    yes_pct = yes_score / total
    if yes_pct > 0.55:
        return {"direction": "YES", "confidence": yes_pct, "reasons": reasons}
    elif yes_pct < 0.45:
        return {"direction": "NO",  "confidence": 1 - yes_pct, "reasons": reasons}
    else:
        return {"direction": "SKIP", "confidence": 0.0, "reasons": reasons + ["Mixed signals → skip"]}


# ══════════════════════════════════════════════════════════════════════════════
#  PAPER TRADE EXECUTION
# ══════════════════════════════════════════════════════════════════════════════

def execute_demo_trade(
    signal:     dict,
    market:     dict,
    clob_prices: dict,
    btc_price:  float,
) -> None:
    """Place a simulated (paper) trade and update portfolio state."""

    direction  = signal["direction"]
    confidence = signal["confidence"]
    yes_price  = clob_prices["yes"]
    no_price   = clob_prices["no"]

    # Choose which side to buy
    if direction == "YES":
        side, side_price = "YES", yes_price
    else:
        side, side_price = "NO", no_price

    # Value filter: only trade when the market offers real uncertainty
    if not (MIN_EDGE_PRICE <= yes_price <= MAX_EDGE_PRICE):
        log.info(f"  ↳ Skipping — YES price {yes_price:.3f} outside edge range [{MIN_EDGE_PRICE},{MAX_EDGE_PRICE}]")
        portfolio["skipped"] += 1
        return

    # Risk sizing: scale trade by confidence, cap at MAX_TRADE_USD
    trade_usd = min(MAX_TRADE_USD * confidence, portfolio["cash"], MAX_TRADE_USD)
    if trade_usd < 1.0:
        log.info("  ↳ Skipping — insufficient cash or trade size too small")
        portfolio["skipped"] += 1
        return

    shares = round(trade_usd / side_price, 4)
    portfolio["cash"] -= trade_usd

    position = {
        "id":           f"trade_{int(time.time())}",
        "market_id":    market.get("conditionId", market.get("id", "unknown")),
        "question":     market.get("question", "BTC 15m")[:80],
        "side":         side,
        "shares":       shares,
        "entry_price":  side_price,
        "cost_usd":     trade_usd,
        "btc_at_entry": btc_price,
        "stop_loss":    side_price * (1 - STOP_LOSS_PCT),
        "take_profit":  side_price * (1 + TAKE_PROFIT_PCT),
        "confidence":   round(confidence, 3),
        "opened_at":    datetime.now(timezone.utc).isoformat(),
        "status":       "open",
    }
    portfolio["open_positions"].append(position)

    log.info(
        f"  📥 DEMO TRADE  {side}  ${trade_usd:.2f}  →  {shares:.2f} shares @ {side_price:.3f}"
        f"  |  confidence {confidence:.0%}  |  cash remaining ${portfolio['cash']:.2f}"
    )


def resolve_positions(current_btc: float, clob_prices: dict | None) -> None:
    """
    Check open positions for stop-loss / take-profit / expiry triggers.
    In demo mode we use the updated market price as the mark price.
    """
    if not clob_prices:
        return

    still_open = []
    for pos in portfolio["open_positions"]:
        side        = pos["side"]
        mark_price  = clob_prices.get(side.lower(), pos["entry_price"])
        pnl         = (mark_price - pos["entry_price"]) * pos["shares"]
        pnl_pct     = (mark_price - pos["entry_price"]) / pos["entry_price"]

        if mark_price <= pos["stop_loss"]:
            outcome = "STOP LOSS"
        elif mark_price >= pos["take_profit"]:
            outcome = "TAKE PROFIT"
        else:
            still_open.append(pos)
            continue

        # Close the position
        proceeds = mark_price * pos["shares"]
        portfolio["cash"] += proceeds
        portfolio["total_profit"] += pnl
        pos["status"]     = "closed"
        pos["closed_at"]  = datetime.now(timezone.utc).isoformat()
        pos["exit_price"] = mark_price
        pos["pnl_usd"]    = round(pnl, 4)
        portfolio["closed_trades"].append(pos)

        if pnl >= 0:
            portfolio["wins"] += 1
            emoji = "✅"
        else:
            portfolio["losses"] += 1
            emoji = "❌"

        log.info(
            f"  {emoji} CLOSED [{outcome}]  {side}  pnl ${pnl:+.2f}  "
            f"({pnl_pct:+.1%})  |  cash ${portfolio['cash']:.2f}"
        )

    portfolio["open_positions"] = still_open


# ══════════════════════════════════════════════════════════════════════════════
#  PERSISTENCE
# ══════════════════════════════════════════════════════════════════════════════

def save_state() -> None:
    try:
        with open(TRADES_FILE, "w") as f:
            json.dump(portfolio, f, indent=2)
    except Exception as e:
        log.warning(f"Failed to save state: {e}")


def load_state() -> None:
    global portfolio
    if os.path.exists(TRADES_FILE):
        try:
            with open(TRADES_FILE) as f:
                saved = json.load(f)
            portfolio.update(saved)
            log.info(f"Loaded saved state — cash ${portfolio['cash']:.2f}  |  "
                     f"trades {len(portfolio['closed_trades'])} closed, "
                     f"{len(portfolio['open_positions'])} open")
        except Exception as e:
            log.warning(f"Could not load saved state: {e}")


# ══════════════════════════════════════════════════════════════════════════════
#  STATS DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════

def print_stats(btc_price: float | None) -> None:
    total_trades = portfolio["wins"] + portfolio["losses"]
    win_rate     = (portfolio["wins"] / total_trades * 100) if total_trades else 0
    open_val     = sum(p["cost_usd"] for p in portfolio["open_positions"])
    equity       = portfolio["cash"] + open_val
    pnl_total    = equity - DEMO_CAPITAL

    log.info("─" * 60)
    log.info(f"  📊 PORTFOLIO SNAPSHOT")
    log.info(f"     BTC Price       : ${btc_price:,.2f}" if btc_price else "     BTC Price       : N/A")
    log.info(f"     Cash            : ${portfolio['cash']:,.2f}")
    log.info(f"     Open Positions  : {len(portfolio['open_positions'])}  (${open_val:.2f} at risk)")
    log.info(f"     Total Equity    : ${equity:,.2f}  ({pnl_total:+.2f} vs start)")
    log.info(f"     Win / Loss      : {portfolio['wins']} W  /  {portfolio['losses']} L  "
             f"({win_rate:.0f}% win rate)")
    log.info(f"     Skipped         : {portfolio['skipped']}")
    log.info("─" * 60)


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN LOOP
# ══════════════════════════════════════════════════════════════════════════════

def run_cycle() -> None:
    """Execute one full trading cycle."""
    log.info("═" * 60)
    log.info(f"  🔄 CYCLE START  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    log.info("═" * 60)

    # 1. Fetch data
    btc_price  = get_btc_price()
    fear_greed = get_fear_greed()

    if btc_price is None:
        log.error("Cannot fetch BTC price — skipping cycle")
        return

    price_history.append(btc_price)
    log.info(f"  BTC: ${btc_price:,.2f}  |  Fear/Greed: {fear_greed}/100")

    # 2. Find market
    market = find_btc_15m_market()
    if not market:
        log.warning("  No active BTC 15-min market found — skipping")
    else:
        log.info(f"  Market: {market.get('question', '')[:70]}")

        condition_id = market.get("conditionId") or market.get("id")
        clob_prices  = get_clob_prices(condition_id) if condition_id else None

        if clob_prices:
            log.info(f"  Prices  YES={clob_prices['yes']:.3f}  NO={clob_prices['no']:.3f}")
        else:
            log.warning("  Could not fetch CLOB prices — skipping trade")
            clob_prices = None

        # 3. Resolve any open positions with latest prices
        resolve_positions(btc_price, clob_prices)

        # 4. Generate signal
        signal = compute_signals(btc_price, fear_greed)
        log.info(f"  Signal: {signal['direction']}  confidence={signal['confidence']:.0%}")
        for r in signal["reasons"]:
            log.info(f"    • {r}")

        # 5. Execute if conditions met
        if (
            signal["direction"] != "SKIP"
            and clob_prices is not None
            and len(portfolio["open_positions"]) < MAX_OPEN_POSITIONS
        ):
            execute_demo_trade(signal, market, clob_prices, btc_price)
        elif signal["direction"] == "SKIP":
            log.info("  → Signal says SKIP — no trade this cycle")
        elif len(portfolio["open_positions"]) >= MAX_OPEN_POSITIONS:
            log.info(f"  → Max positions ({MAX_OPEN_POSITIONS}) reached — no new trade")

    # 6. Print stats & save
    print_stats(btc_price)
    save_state()


def main():
    log.info("╔══════════════════════════════════════════════════════╗")
    log.info("║  Polymarket BTC 15-Minute DEMO Bot  —  Paper Trading ║")
    log.info(f"║  Starting capital: ${DEMO_CAPITAL:,.0f}  |  Max per trade: ${MAX_TRADE_USD:.0f}    ║")
    log.info("╚══════════════════════════════════════════════════════╝")
    load_state()

    while True:
        try:
            run_cycle()
        except KeyboardInterrupt:
            log.info("Bot stopped by user.")
            break
        except Exception as e:
            log.error(f"Unexpected error in cycle: {e}", exc_info=True)

        log.info(f"  💤 Sleeping {LOOP_INTERVAL}s until next cycle…")
        time.sleep(LOOP_INTERVAL)


if __name__ == "__main__":
    main()
