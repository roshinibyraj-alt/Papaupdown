"""
Polymarket Demo Bot — "Liquidity Fade" Strategy
Market: BTC 5-min UP/DOWN binary (non-stop, confirmed live for 3+ months)
Slug:   btc-updown-5m-{unix_ts // 300 * 300}
API:    gamma-api.polymarket.com/events?slug=...  (params dict, 8 retries)
Price:  clob.polymarket.com/price?token_id=...&side=BUY
Demo:   $2000 virtual balance — NO real money
"""

import os, time, json, math, threading, requests
from datetime import datetime, timezone
from flask import Flask, jsonify, Response

# ─── CONFIG ────────────────────────────────────────────────────────────────────
STARTING_BALANCE  = float(os.getenv("DEMO_BALANCE", "2000"))
BASE_SHARES       = int(os.getenv("SHARES", "20"))
BUY_THRESHOLD     = 0.35        # buy when price <= this
TAKE_PROFIT       = 0.55        # close at TP
STOP_LOSS         = 0.15        # close at SL
SKIP_LAST_SECS    = 60          # no new trades in last 60s
TAKER_FEE         = 0.02
WINDOW_SEC        = 300
MAX_RECOVERY      = 5
GAMMA             = "https://gamma-api.polymarket.com"
CLOB              = "https://clob.polymarket.com"

# ─── STATE ─────────────────────────────────────────────────────────────────────
capital       = STARTING_BALANCE
capital_lock  = threading.Lock()
peak_capital  = STARTING_BALANCE
max_drawdown  = 0.0
total_pnl     = 0.0
rounds_played = 0
rounds_won    = 0
stats_lock    = threading.Lock()
bot_start     = datetime.now(timezone.utc).isoformat()

# Recovery
rec_carried = 0.0
rec_level   = 0
rec_lock    = threading.Lock()

# Live display
live_status  = {"phase": "Starting…", "prices": {}, "positions": [], "signals": []}
recent_rounds = []
rounds_lock   = threading.Lock()

def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)

def deduct(amount):
    global capital, max_drawdown, peak_capital
    with capital_lock:
        if capital < amount:
            return False
        capital     = round(capital - amount, 4)
        dd          = round(peak_capital - capital, 2)
        if dd > max_drawdown:
            max_drawdown = dd
        return True

def credit(amount):
    global capital, peak_capital, max_drawdown
    with capital_lock:
        capital = round(capital + amount, 4)
        if capital > peak_capital:
            peak_capital = capital
        dd = round(peak_capital - capital, 2)
        if dd > max_drawdown:
            max_drawdown = dd

# ─── MARKET DISCOVERY (copied from working script) ─────────────────────────────
def get_window_ts():
    return (int(time.time()) // WINDOW_SEC) * WINDOW_SEC

def get_tokens(window_ts):
    """Exact same pattern as the working BTC/ETH signal bot."""
    slug = f"btc-updown-5m-{window_ts}"
    for attempt in range(8):
        try:
            r = requests.get(
                f"{GAMMA}/events",
                params={"slug": slug},   # <-- params dict, NOT url string
                timeout=10
            )
            r.raise_for_status()
            data = r.json()
            if not data:
                log(f"Token lookup attempt {attempt+1}/8: empty response")
                time.sleep(3)
                continue
            markets = data[0].get("markets", [])
            if not markets:
                log(f"Token lookup attempt {attempt+1}/8: no markets in event")
                time.sleep(3)
                continue
            ids = json.loads(markets[0]["clobTokenIds"])
            log(f"✅ Market found: {slug} | UP={ids[0][:12]}… DOWN={ids[1][:12]}…")
            return ids[0], ids[1], slug
        except Exception as e:
            log(f"Token lookup attempt {attempt+1}/8 error: {e}")
            time.sleep(3)
    log(f"❌ Could not find market after 8 attempts: {slug}")
    return None, None, slug

def safe_price(token_id):
    """Use /price?side=BUY — same as working script."""
    try:
        r = requests.get(
            f"{CLOB}/price",
            params={"token_id": token_id, "side": "BUY"},
            timeout=5
        )
        return float(r.json()["price"])
    except:
        return None

def get_resolution(slug):
    try:
        r = requests.get(f"{GAMMA}/events", params={"slug": slug}, timeout=10)
        data = r.json()
        if not data: return None
        markets = data[0].get("markets", [])
        if not markets: return None
        p = json.loads(markets[0]["outcomePrices"])
        if float(p[0]) >= 0.95: return "UP"
        if float(p[1]) >= 0.95: return "DOWN"
        return None
    except:
        return None

# ─── RECOVERY ──────────────────────────────────────────────────────────────────
def get_recovery_shares(entry_price):
    with rec_lock:
        if rec_carried <= 0:
            return BASE_SHARES, False
        net_per_sh = round(TAKE_PROFIT * (1 - TAKER_FEE) - entry_price, 6)
        if net_per_sh <= 0.01:
            return BASE_SHARES, True
        needed = math.ceil((rec_carried + 1.0) / net_per_sh)
        return max(needed, BASE_SHARES), True

def record_recovery_result(round_pnl):
    global rec_carried, rec_level
    with rec_lock:
        if round_pnl >= 0:
            log(f"RECOVERY WIN — carried ${rec_carried:.2f} cleared")
            rec_carried = 0.0
            rec_level   = 0
        else:
            rec_carried = round(rec_carried + abs(round_pnl), 2)
            rec_level  += 1
            if rec_level > MAX_RECOVERY:
                log(f"Recovery exhausted after {MAX_RECOVERY} levels — resetting")
                rec_carried = 0.0
                rec_level   = 0
            else:
                log(f"Recovery L{rec_level}/{MAX_RECOVERY} — carried=${rec_carried:.2f}")

# ─── WINDOW RUNNER ─────────────────────────────────────────────────────────────
class Window:
    def __init__(self, token_up, token_dn, slug, window_ts):
        self.token_up  = token_up
        self.token_dn  = token_dn
        self.slug      = slug
        self.window_ts = window_ts
        self.win_start = float(window_ts)

        with rec_lock:
            self.is_recovery  = rec_level > 0
            self.rec_level    = rec_level
            self.carried_snap = rec_carried

        self.up_entered = False; self.dn_entered = False
        self.up_shares  = 0;     self.dn_shares  = 0
        self.up_cost    = 0.0;   self.dn_cost    = 0.0
        self.up_tp      = False; self.dn_tp      = False
        self.up_pnl     = 0.0;   self.dn_pnl     = 0.0
        self.round_pnl  = 0.0
        self.settled    = False
        self.signals    = []
        self.phase      = "WATCHING"

    def elapsed(self):
        return time.time() - self.win_start

    def secs_left(self):
        return max(0, WINDOW_SEC - self.elapsed())

    def check_entries(self, price_up, price_dn):
        secs = self.secs_left()
        if secs < SKIP_LAST_SECS:
            return

        # Check UP side
        if not self.up_entered and price_up is not None and price_up <= BUY_THRESHOLD:
            sh = BASE_SHARES
            rec_tag = ""
            if self.is_recovery and not self.up_entered and not self.dn_entered:
                sh, _ = get_recovery_shares(price_up)
                rec_tag = f" [REC-L{self.rec_level}]"
            cost = round(price_up * sh, 4)
            if deduct(cost):
                self.up_entered = True
                self.up_shares  = sh
                self.up_cost    = cost
                msg = f"BUY{rec_tag} UP {sh}sh @ {price_up:.4f} cost=${cost:.2f}"
                log(msg)
                self.signals.append(msg)

        # Check DOWN side
        if not self.dn_entered and price_dn is not None and price_dn <= BUY_THRESHOLD:
            sh = BASE_SHARES
            rec_tag = ""
            if self.is_recovery and not self.up_entered and not self.dn_entered:
                sh, _ = get_recovery_shares(price_dn)
                rec_tag = f" [REC-L{self.rec_level}]"
            cost = round(price_dn * sh, 4)
            if deduct(cost):
                self.dn_entered = True
                self.dn_shares  = sh
                self.dn_cost    = cost
                msg = f"BUY{rec_tag} DOWN {sh}sh @ {price_dn:.4f} cost=${cost:.2f}"
                log(msg)
                self.signals.append(msg)

    def check_tp(self, price_up, price_dn):
        if self.up_entered and not self.up_tp and price_up is not None and price_up >= TAKE_PROFIT:
            proceeds = round(self.up_shares * price_up * (1 - TAKER_FEE), 4)
            pnl      = round(proceeds - self.up_cost, 2)
            credit(proceeds)
            self.up_tp  = True
            self.up_pnl = pnl
            self.round_pnl = round(self.round_pnl + pnl, 2)
            log(f"TP UP {self.up_shares}sh @ {price_up:.4f} pnl=${pnl:+.2f}")

        if self.dn_entered and not self.dn_tp and price_dn is not None and price_dn >= TAKE_PROFIT:
            proceeds = round(self.dn_shares * price_dn * (1 - TAKER_FEE), 4)
            pnl      = round(proceeds - self.dn_cost, 2)
            credit(proceeds)
            self.dn_tp  = True
            self.dn_pnl = pnl
            self.round_pnl = round(self.round_pnl + pnl, 2)
            log(f"TP DOWN {self.dn_shares}sh @ {price_dn:.4f} pnl=${pnl:+.2f}")

    def check_sl(self, price_up, price_dn):
        if self.up_entered and not self.up_tp and price_up is not None and price_up <= STOP_LOSS:
            pnl = round(-self.up_cost, 2)
            self.up_tp  = True  # mark closed
            self.up_pnl = pnl
            self.round_pnl = round(self.round_pnl + pnl, 2)
            log(f"SL UP {self.up_shares}sh @ {price_up:.4f} pnl=${pnl:+.2f}")

        if self.dn_entered and not self.dn_tp and price_dn is not None and price_dn <= STOP_LOSS:
            pnl = round(-self.dn_cost, 2)
            self.dn_tp  = True
            self.dn_pnl = pnl
            self.round_pnl = round(self.round_pnl + pnl, 2)
            log(f"SL DOWN {self.dn_shares}sh @ {price_dn:.4f} pnl=${pnl:+.2f}")

    def settle(self, price_up, price_dn):
        if self.settled:
            return
        self.settled = True
        # Determine winner: price > 0.55 or API resolution
        winner = None
        if price_up is not None and price_up > 0.55:   winner = "UP"
        elif price_dn is not None and price_dn > 0.55: winner = "DOWN"
        if winner is None:
            winner = get_resolution(self.slug)

        if self.up_entered and not self.up_tp:
            if winner == "UP":
                proceeds = round(self.up_shares * 1.0 * (1 - TAKER_FEE), 4)
                pnl = round(proceeds - self.up_cost, 2)
                credit(proceeds)
            else:
                pnl = round(-self.up_cost, 2)
            self.up_pnl    = pnl
            self.round_pnl = round(self.round_pnl + pnl, 2)
            log(f"SETTLE UP {'WIN' if winner=='UP' else 'LOSS'} pnl=${pnl:+.2f}")

        if self.dn_entered and not self.dn_tp:
            if winner == "DOWN":
                proceeds = round(self.dn_shares * 1.0 * (1 - TAKER_FEE), 4)
                pnl = round(proceeds - self.dn_cost, 2)
                credit(proceeds)
            else:
                pnl = round(-self.dn_cost, 2)
            self.dn_pnl    = pnl
            self.round_pnl = round(self.round_pnl + pnl, 2)
            log(f"SETTLE DOWN {'WIN' if winner=='DOWN' else 'LOSS'} pnl=${pnl:+.2f}")

        if self.up_entered or self.dn_entered:
            self._record_round(winner)

    def _record_round(self, winner):
        global total_pnl, rounds_played, rounds_won
        won = self.round_pnl >= 0
        with stats_lock:
            total_pnl     = round(total_pnl + self.round_pnl, 2)
            rounds_played += 1
            if won: rounds_won += 1
        with rounds_lock:
            recent_rounds.append({
                "time":       datetime.now(timezone.utc).strftime("%H:%M:%S"),
                "is_rec":     self.is_recovery,
                "rec_level":  self.rec_level,
                "carried_in": round(self.carried_snap, 2),
                "up_entered": self.up_entered,
                "dn_entered": self.dn_entered,
                "up_shares":  self.up_shares,
                "dn_shares":  self.dn_shares,
                "up_pnl":     round(self.up_pnl, 2),
                "dn_pnl":     round(self.dn_pnl, 2),
                "pnl":        self.round_pnl,
                "winner":     winner or "--",
                "capital":    capital,
            })
            if len(recent_rounds) > 100:
                recent_rounds.pop(0)
        record_recovery_result(self.round_pnl)
        log(f"ROUND END pnl=${self.round_pnl:+.2f} cap=${capital:.2f}")

    def update_live(self, pu, pd):
        unreal = 0.0
        if self.up_entered and not self.up_tp and pu:
            unreal += self.up_shares * pu - self.up_cost
        if self.dn_entered and not self.dn_tp and pd:
            unreal += self.dn_shares * pd - self.dn_cost

        parts = []
        if self.up_entered:
            parts.append(f"UP {self.up_shares}sh" + (" TP✓" if self.up_tp else f" @{pu:.4f}" if pu else ""))
        if self.dn_entered:
            parts.append(f"DN {self.dn_shares}sh" + (" TP✓" if self.dn_tp else f" @{pd:.4f}" if pd else ""))
        phase = "HOLDING " + " | ".join(parts) if parts else "WATCHING (need price ≤ 0.35)"

        with rec_lock:
            cl = rec_carried; rl = rec_level

        live_status.update({
            "phase":       phase,
            "elapsed":     round(self.elapsed(), 1),
            "secs_left":   round(self.secs_left(), 1),
            "price_up":    pu,
            "price_dn":    pd,
            "up_entered":  self.up_entered,
            "dn_entered":  self.dn_entered,
            "up_shares":   self.up_shares,
            "dn_shares":   self.dn_shares,
            "up_cost":     round(self.up_cost, 2),
            "dn_cost":     round(self.dn_cost, 2),
            "up_entry_px": round(self.up_cost / self.up_shares, 4) if self.up_shares else 0,
            "dn_entry_px": round(self.dn_cost / self.dn_shares, 4) if self.dn_shares else 0,
            "up_tp":       self.up_tp,
            "dn_tp":       self.dn_tp,
            "up_pnl":      round(self.up_pnl, 2),
            "dn_pnl":      round(self.dn_pnl, 2),
            "round_pnl":   round(self.round_pnl, 2),
            "unrealised":  round(unreal, 2),
            "is_recovery": self.is_recovery,
            "rec_level":   rl,
            "carried":     round(cl, 2),
            "signals":     self.signals[-8:],
            "capital":     capital,
            "settled":     self.settled,
        })

    def run(self):
        with rec_lock:
            cl = rec_carried; rl = rec_level
        log(f"=== Window {datetime.fromtimestamp(self.window_ts, timezone.utc).strftime('%H:%M UTC')} | "
            f"{'RECOVERY L'+str(rl)+' carried=$'+str(round(cl,2)) if rl > 0 else 'BASE'} ===")

        while True:
            elapsed = self.elapsed()
            pu = safe_price(self.token_up)
            pd = safe_price(self.token_dn)

            if elapsed < WINDOW_SEC - 1:
                self.check_entries(pu, pd)
                self.check_tp(pu, pd)
                self.check_sl(pu, pd)

            if elapsed >= WINDOW_SEC - 1:
                self.phase = "SETTLING"
                self.settle(pu, pd)
                self.update_live(pu, pd)
                break

            self.update_live(pu, pd)
            time.sleep(0.5)

# ─── MAIN LOOP ─────────────────────────────────────────────────────────────────
def main_loop():
    log("=" * 50)
    log(f"  Polymarket Liquidity Fade Bot — DEMO")
    log(f"  Capital: ${STARTING_BALANCE:.2f} | Base shares: {BASE_SHARES}")
    log(f"  Buy ≤ {BUY_THRESHOLD} | TP={TAKE_PROFIT} | SL={STOP_LOSS}")
    log(f"  Recovery: up to {MAX_RECOVERY} levels")
    log("=" * 50)

    while True:
        ts      = get_window_ts()
        elapsed = time.time() - ts

        # If mid-window (>5s elapsed), wait for next window
        if elapsed > 5:
            wait = WINDOW_SEC - elapsed
            log(f"Mid-window ({elapsed:.0f}s elapsed) — waiting {wait:.0f}s for next window")
            live_status.update({
                "phase":      f"Waiting {int(wait)}s for next window",
                "elapsed":    round(elapsed, 1),
                "secs_left":  round(wait, 1),
                "price_up":   None, "price_dn":   None,
                "up_entered": False,"dn_entered":  False,
                "signals":    [],   "capital":     capital,
            })
            time.sleep(max(1, wait))
            continue

        log("Discovering BTC 5m market…")
        token_up, token_dn, slug = get_tokens(ts)
        if not token_up or not token_dn:
            log("Market not found — waiting for next window")
            time.sleep(max(1, WINDOW_SEC - (time.time() - ts)))
            continue

        Window(token_up, token_dn, slug, ts).run()

# ─── FLASK DASHBOARD ───────────────────────────────────────────────────────────
DASHBOARD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Polymarket Fade Bot</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;600&family=Unbounded:wght@700;900&display=swap" rel="stylesheet">
<style>
:root{--bg:#040910;--panel:#080f1a;--card:#0c1520;--line:#142030;
  --g:#00ff88;--r:#ff3355;--b:#00d4ff;--y:#ffcc00;
  --t:#c8e8f8;--mid:#3a6080}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--t);font-family:'IBM Plex Mono',monospace;font-size:12px;min-height:100vh}
.hdr{background:var(--panel);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.logo{font-family:'Unbounded',sans-serif;font-size:13px;font-weight:900;color:#fff;letter-spacing:1px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--g);box-shadow:0 0 8px var(--g);display:inline-block;margin-right:8px;animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.2}}
.badge{font-size:9px;letter-spacing:2px;padding:3px 10px;border:1px solid var(--y);color:var(--y);border-radius:2px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--line)}
.kpi{background:var(--panel);padding:14px 18px;border-top:2px solid var(--line)}
.kpi.g{border-top-color:var(--g)}.kpi.r{border-top-color:var(--r)}.kpi.b{border-top-color:var(--b)}.kpi.y{border-top-color:var(--y)}
.kl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mid);margin-bottom:4px}
.kv{font-family:'Unbounded',sans-serif;font-size:18px;font-weight:700}
.ks{font-size:9px;color:var(--mid);margin-top:2px}
.wrap{display:grid;grid-template-columns:1fr 240px;gap:1px;background:var(--line)}
.main{background:var(--panel);padding:18px}
.side{background:var(--panel);padding:16px;border-left:1px solid var(--line)}
.sec{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--mid);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.prog{margin-bottom:14px}
.prog-row{display:flex;justify-content:space-between;font-size:10px;margin-bottom:4px}
.bar{height:3px;background:var(--line);border-radius:2px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--b),var(--g));transition:width .3s}
.px-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.px-box{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:12px 14px;position:relative}
.px-box.active{border-color:#00ff8840;background:#00ff8806}
.px-lbl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mid);margin-bottom:6px}
.px-val{font-family:'Unbounded',sans-serif;font-size:26px;font-weight:700}
.px-val.up{color:var(--g)}.px-val.dn{color:var(--b)}
.px-sub{font-size:9px;margin-top:4px}
.tb{font-size:9px;padding:2px 8px;border-radius:2px;position:absolute;top:8px;right:8px}
.tb-ok{background:#00ff8818;color:var(--g);border:1px solid #00ff8830}
.tb-hold{background:#00d4ff18;color:var(--b);border:1px solid #00d4ff30}
.tb-tp{background:#ffcc0018;color:var(--y);border:1px solid #ffcc0030}
.tb-sl{background:#ff335518;color:var(--r);border:1px solid #ff335530}
.sig-log{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:10px 12px;max-height:90px;overflow-y:auto;margin-bottom:14px}
.sig-item{font-size:10px;color:var(--t);padding:2px 0;border-bottom:1px solid #14203015;line-height:1.4}
.sig-item:last-child{border:none}
table{width:100%;border-collapse:collapse;font-size:11px}
th{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mid);font-weight:400;padding:4px 8px;border-bottom:1px solid var(--line);text-align:left}
td{padding:6px 8px;border-bottom:1px solid #08101808}
.w td:first-child{border-left:2px solid var(--g)}.l td:first-child{border-left:2px solid var(--r)}.rc td:first-child{border-left:2px solid #ff8800}
.cfg-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line);font-size:11px}
.cfg-row:last-child{border:none}.ck{color:var(--mid)}.cv{color:var(--t)}
.rec-box{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:12px;margin-bottom:12px}
.rec-row{display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px}
.rec-row:last-child{margin:0}.rk{color:var(--mid)}.rv{font-weight:500}
.rec-lvls{display:flex;gap:4px;margin-top:8px}
.rl{width:24px;height:24px;border-radius:50%;border:1px solid var(--line);background:var(--card);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:var(--mid)}
.rl.done{background:#ff335518;color:var(--r);border-color:#ff335540}
.rl.cur{background:#ff880025;color:#ff8800;border-color:#ff880060}
.footer{background:var(--panel);border-top:1px solid var(--line);padding:8px 24px;display:flex;justify-content:space-between;font-size:10px;color:var(--mid)}
@media(max-width:800px){.kpis{grid-template-columns:repeat(3,1fr)}.wrap{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="hdr">
  <div class="logo"><span class="dot"></span>POLYMARKET FADE BOT</div>
  <div style="display:flex;gap:10px;align-items:center">
    <span id="hphase" style="font-size:10px;color:var(--mid)">--</span>
    <span class="badge">DEMO $2000</span>
  </div>
</div>

<div class="kpis">
  <div class="kpi" id="k-cap"><div class="kl">Balance</div><div class="kv" id="kv-cap">$--</div><div class="ks" id="ks-cap">--</div></div>
  <div class="kpi" id="k-pnl"><div class="kl">Session P&L</div><div class="kv" id="kv-pnl">--</div><div class="ks" id="ks-pnl">--</div></div>
  <div class="kpi b"><div class="kl">Win Rate</div><div class="kv" id="kv-wr">--%</div><div class="ks" id="ks-wr">0 rounds</div></div>
  <div class="kpi" id="k-rec"><div class="kl">Recovery</div><div class="kv" id="kv-rec">BASE</div><div class="ks" id="ks-rec">--</div></div>
  <div class="kpi y"><div class="kl">Max Drawdown</div><div class="kv" id="kv-dd">$0.00</div><div class="ks">from peak</div></div>
  <div class="kpi b"><div class="kl">Window</div><div class="kv" id="kv-win">--s</div><div class="ks" id="ks-win">remaining</div></div>
</div>

<div class="wrap">
<div class="main">
  <div class="sec">Live Prices — Buy when ≤ 0.35 | TP 0.55 | SL 0.15</div>
  <div class="prog">
    <div class="prog-row"><span id="prog-phase">--</span><span style="color:var(--mid)" id="prog-time">0:00 / 5:00</span></div>
    <div class="bar"><div class="fill" id="prog-fill" style="width:0%"></div></div>
  </div>
  <div class="px-grid">
    <div class="px-box" id="box-up">
      <div class="px-lbl">BTC UP</div>
      <div class="px-val up" id="px-up">--</div>
      <div class="px-sub" id="sub-up" style="color:var(--mid)">watching…</div>
      <span class="tb" id="tb-up" style="display:none"></span>
    </div>
    <div class="px-box" id="box-dn">
      <div class="px-lbl">BTC DOWN</div>
      <div class="px-val dn" id="px-dn">--</div>
      <div class="px-sub" id="sub-dn" style="color:var(--mid)">watching…</div>
      <span class="tb" id="tb-dn" style="display:none"></span>
    </div>
  </div>

  <div class="sec">Signal Log</div>
  <div class="sig-log" id="sig-log"><div class="sig-item" style="color:var(--mid)">No signals yet…</div></div>

  <div class="sec">Round History</div>
  <table><thead><tr>
    <th>Time</th><th>Type</th><th>UP sh</th><th>UP P&L</th>
    <th>DN sh</th><th>DN P&L</th><th>Total P&L</th><th>Capital</th>
  </tr></thead><tbody id="tbl"></tbody></table>
</div>

<div class="side">
  <div class="sec">Session</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border-radius:4px;overflow:hidden;margin-bottom:12px">
    <div style="background:var(--card);padding:10px 12px"><div style="font-size:9px;color:var(--mid);margin-bottom:3px">WINS</div><div style="font-family:'Unbounded',sans-serif;font-size:18px;color:var(--g)" id="s-w">0</div></div>
    <div style="background:var(--card);padding:10px 12px"><div style="font-size:9px;color:var(--mid);margin-bottom:3px">LOSSES</div><div style="font-family:'Unbounded',sans-serif;font-size:18px;color:var(--r)" id="s-l">0</div></div>
    <div style="background:var(--card);padding:10px 12px"><div style="font-size:9px;color:var(--mid);margin-bottom:3px">ROUNDS</div><div style="font-family:'Unbounded',sans-serif;font-size:18px" id="s-r">0</div></div>
    <div style="background:var(--card);padding:10px 12px"><div style="font-size:9px;color:var(--mid);margin-bottom:3px">P&L</div><div style="font-family:'Unbounded',sans-serif;font-size:16px" id="s-p">$0</div></div>
  </div>

  <div class="sec">Recovery</div>
  <div class="rec-box">
    <div class="rec-row"><span class="rk">Level</span><span class="rv" id="rc-lv">BASE</span></div>
    <div class="rec-row"><span class="rk">Carried</span><span class="rv" id="rc-ca" style="color:var(--r)">$0.00</span></div>
    <div class="rec-row"><span class="rk">Max</span><span class="rv">5 levels → reset</span></div>
    <div class="rec-lvls" id="rc-dots"></div>
  </div>

  <div class="sec">Config</div>
  <div style="background:var(--card);border:1px solid var(--line);border-radius:4px;padding:10px 12px">
    <div class="cfg-row"><span class="ck">Market</span><span class="cv" style="color:var(--y)">BTC 5m UP/DOWN</span></div>
    <div class="cfg-row"><span class="ck">Buy trigger</span><span class="cv" style="color:var(--g)">≤ 0.35</span></div>
    <div class="cfg-row"><span class="ck">Take profit</span><span class="cv" style="color:var(--y)">@ 0.55</span></div>
    <div class="cfg-row"><span class="ck">Stop loss</span><span class="cv" style="color:var(--r)">@ 0.15</span></div>
    <div class="cfg-row"><span class="ck">Base shares</span><span class="cv" id="cfg-sh">20</span></div>
    <div class="cfg-row"><span class="ck">Fee</span><span class="cv">2% taker</span></div>
    <div class="cfg-row"><span class="ck">Recovery</span><span class="cv">up to 5 levels</span></div>
  </div>
</div>
</div>

<div class="footer">
  <span>DEMO — No real money | Liquidity Fade v3.0</span>
  <span id="upd">--</span>
</div>

<script>
const $ = id => document.getElementById(id);
const f2 = (n,plus=false) => n==null?'--':(plus&&n>=0?'+':'')+n.toFixed(2);
const f4 = n => n==null?'--':n.toFixed(4);
const pc = n => n>=0?'var(--g)':'var(--r)';

async function refresh(){
  try{
    const d = await fetch('/stats').then(r=>r.json());
    const w = d.live||{};

    // KPIs
    const cap=d.capital||0, start=d.starting_balance||0, pnl=d.total_pnl||0;
    $('kv-cap').textContent='$'+cap.toFixed(2);
    $('ks-cap').textContent=(pnl>=0?'+':'')+pnl.toFixed(2)+' total pnl';
    $('k-cap').className='kpi '+(pnl>=0?'g':'r');
    $('kv-pnl').textContent=(pnl>=0?'+$':'-$')+Math.abs(pnl).toFixed(2);
    $('kv-pnl').style.color=pnl>=0?'var(--g)':'var(--r)';
    $('k-pnl').className='kpi '+(pnl>=0?'g':'r');
    const rp=d.rounds_played||0,rw=d.rounds_won||0;
    $('ks-pnl').textContent=rw+' wins / '+rp+' rounds';
    $('kv-wr').textContent=rp>0?((rw/rp)*100).toFixed(0)+'%':'--%';
    $('ks-wr').textContent=rp+' rounds played';
    $('kv-dd').textContent='-$'+(d.max_drawdown||0).toFixed(2);

    // Window
    const sl=w.secs_left||0,mm=Math.floor(sl/60),ss=(sl%60|0).toString().padStart(2,'0');
    $('kv-win').textContent=mm+':'+ss;
    $('ks-win').textContent='remaining';

    // Recovery
    const rl=d.rec_level||0,cl=d.rec_carried||0;
    if(rl>0){
      $('kv-rec').textContent='L'+rl+'/5';$('kv-rec').style.color='#ff8800';
      $('ks-rec').textContent='$'+cl.toFixed(2)+' carried';$('k-rec').className='kpi y';
    } else {
      $('kv-rec').textContent='BASE';$('kv-rec').style.color='var(--g)';
      $('ks-rec').textContent='no loss carried';$('k-rec').className='kpi g';
    }

    // Progress
    const el=w.elapsed||0,em=Math.floor(el/60),es=(el%60|0).toString().padStart(2,'0');
    const rm=Math.max(0,300-el),rmm=Math.floor(rm/60),rms=(rm%60|0).toString().padStart(2,'0');
    $('hphase').textContent=w.phase||'--';
    $('prog-phase').textContent=(w.phase||'--');
    $('prog-time').textContent=em+':'+es+' / 5:00';
    $('prog-fill').style.width=Math.min((el/300)*100,100)+'%';

    // Prices
    const pu=w.price_up, pd=w.price_dn;
    $('px-up').textContent=pu!=null?pu.toFixed(4):'--';
    $('px-dn').textContent=pd!=null?pd.toFixed(4):'--';

    function renderBox(side, entered, tp, pnl, px, shares, cost, entryPx){
      const box=$('box-'+side), sub=$('sub-'+side), tb=$('tb-'+side);
      if(!entered){
        box.className='px-box';
        sub.textContent=px!=null&&px<=0.35?'⚡ SIGNAL — entering…':'watching (need ≤ 0.35)';
        sub.style.color=px!=null&&px<=0.35?'var(--y)':'var(--mid)';
        tb.style.display='none';
      } else if(tp){
        box.className='px-box active';
        sub.textContent='closed | pnl: '+(pnl>=0?'+':'')+pnl.toFixed(2);
        sub.style.color=pnl>=0?'var(--g)':'var(--r)';
        tb.textContent='CLOSED'; tb.className='tb tb-tp'; tb.style.display='block';
      } else {
        box.className='px-box active';
        const unreal=px?shares*px-cost:0;
        sub.textContent=shares+'sh | entry '+entryPx.toFixed(4)+' | '+(unreal>=0?'+':'')+unreal.toFixed(2);
        sub.style.color=unreal>=0?'var(--g)':'var(--r)';
        tb.textContent='HOLDING'; tb.className='tb tb-hold'; tb.style.display='block';
      }
    }
    renderBox('up',w.up_entered,w.up_tp,w.up_pnl||0,pu,w.up_shares||0,w.up_cost||0,w.up_entry_px||0);
    renderBox('dn',w.dn_entered,w.dn_tp,w.dn_pnl||0,pd,w.dn_shares||0,w.dn_cost||0,w.dn_entry_px||0);

    // Signals
    const sigs=w.signals||[];
    $('sig-log').innerHTML=sigs.length?[...sigs].reverse().map(s=>`<div class="sig-item">${s}</div>`).join(''):'<div class="sig-item" style="color:var(--mid)">No signals this window</div>';

    // Sidebar
    $('s-w').textContent=rw;$('s-l').textContent=rp-rw;$('s-r').textContent=rp;
    $('s-p').textContent=(pnl>=0?'+$':'-$')+Math.abs(pnl).toFixed(2);
    $('s-p').style.color=pc(pnl);
    $('rc-lv').textContent=rl>0?'Level '+rl+' / 5':'BASE';
    $('rc-lv').style.color=rl>0?'#ff8800':'var(--g)';
    $('rc-ca').textContent='$'+cl.toFixed(2);
    $('rc-ca').style.color=cl>0?'var(--r)':'var(--g)';
    let dots='';
    for(let i=1;i<=5;i++) dots+=`<div class="rl${i<rl?' done':i===rl?' cur':''}">${i}</div>`;
    $('rc-dots').innerHTML=dots;
    $('cfg-sh').textContent=(d.base_shares||20)+' shares';

    // Table
    const rr=(d.recent_rounds||[]).slice().reverse().slice(0,15);
    $('tbl').innerHTML=rr.map(r=>{
      const cls=r.is_rec?'rc':r.pnl>=0?'w':'l';
      const f=(n,e)=>e?(n>=0?'<span style="color:var(--g)">+$'+n.toFixed(2)+'</span>':'<span style="color:var(--r)">-$'+Math.abs(n).toFixed(2)+'</span>'):'--';
      return `<tr class="${cls}">
        <td>${r.time}</td>
        <td style="color:${r.is_rec?'#ff8800':'var(--mid)'}">${r.is_rec?'REC-L'+r.rec_level:'BASE'}</td>
        <td>${r.up_entered?r.up_shares+'sh':'--'}</td>
        <td>${f(r.up_pnl,r.up_entered)}</td>
        <td>${r.dn_entered?r.dn_shares+'sh':'--'}</td>
        <td>${f(r.dn_pnl,r.dn_entered)}</td>
        <td style="color:${pc(r.pnl)}">${r.pnl>=0?'+$':'-$'}${Math.abs(r.pnl).toFixed(2)}</td>
        <td>$${r.capital.toFixed(2)}</td>
      </tr>`;
    }).join('');

    $('upd').textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){$('upd').textContent='reconnecting…';}
}
refresh(); setInterval(refresh, 500);
</script>
</body>
</html>"""

def get_stats():
    with rounds_lock:
        rr = list(recent_rounds)
    with rec_lock:
        cl = rec_carried; rl = rec_level
    return {
        "starting_balance": STARTING_BALANCE,
        "capital":          capital,
        "total_pnl":        total_pnl,
        "rounds_played":    rounds_played,
        "rounds_won":       rounds_won,
        "peak_capital":     peak_capital,
        "max_drawdown":     max_drawdown,
        "base_shares":      BASE_SHARES,
        "rec_carried":      round(cl, 2),
        "rec_level":        rl,
        "bot_start":        bot_start,
        "recent_rounds":    rr,
        "live":             dict(live_status),
    }

app = Flask(__name__)

@app.route("/")
def index():
    return Response(DASHBOARD, mimetype="text/html")

@app.route("/stats")
def stats():
    return jsonify(get_stats())

if __name__ == "__main__":
    import logging
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    threading.Thread(target=main_loop, daemon=True).start()
    port = int(os.environ.get("PORT", 8080))
    log(f"Dashboard on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
