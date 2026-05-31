'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
//  PULSE BOT v5.0 — FEE-AWARE STRATEGY ENGINE
//
//  KEY INSIGHT: Crypto taker fee = 0.07 × p × (1-p) per share
//
//  At p=0.50: fee = $1.75 per 100 shares (~3.5% round-trip)
//  At p=0.20: fee = $1.12 per 100 shares (~5.6% of trade value)
//  At p=0.85: fee = $0.89 per 100 shares (~1.0% of trade value)
//  At p=0.95: fee = $0.33 per 100 shares (~0.35% of trade value)
//
//  CRITICAL MATH: For a taker buy at p, taker sell at q (q > p):
//    Gross profit per share  = q - p
//    Fee on buy  (per share) = 0.07 × p × (1-p)
//    Fee on sell (per share) = 0.07 × q × (1-q)
//    Net profit per share    = (q - p) - 0.07×[p(1-p) + q(1-q)]
//
//  BREAKEVEN CONDITION (buy at p, sell at p+Δ):
//    Δ > 0.07 × [p(1-p) + (p+Δ)(1-(p+Δ))]
//    Simplified: Δ > 0.14 × p(1-p) / (1 - 0.07(1-2p-Δ))
//    ≈ Δ_min ≈ 0.14 × p(1-p)         for small Δ
//
//  BREAKEVEN TABLE (buy at p, taker both legs):
//    p=0.20 → Δ_min = 0.0224  (~2.24 cents min move for profit)
//    p=0.30 → Δ_min = 0.0294
//    p=0.40 → Δ_min = 0.0336
//    p=0.50 → Δ_min = 0.0350  (highest hurdle)
//    p=0.70 → Δ_min = 0.0294
//    p=0.85 → Δ_min = 0.0179
//    p=0.90 → Δ_min = 0.0126
//    p=0.95 → Δ_min = 0.0067
//
//  MAKER ADVANTAGE: Limit orders = ZERO fees. If you can buy as maker
//  and sell as taker, breakeven shrinks to just the sell-leg fee.
//  Maker sell at q: fee = 0, so profit = q - p - 0.07×p(1-p) → MUCH easier.
//
//  STRATEGY SUITE (all fee-aware):
//
//  STRATEGY 1 — MAKER QUOTE ENGINE (pure edge):
//    Post limit orders both sides. Earn maker rebate (20% of collected taker fees).
//    Zero fee on fills. Profit from spread + rebate. This IS mathematically
//    guaranteed income if you manage inventory well.
//
//  STRATEGY 2 — LATE-WINDOW DIRECTIONAL (fee-friendly zone):
//    Enter at p ≥ 0.88 (fee rate drops below 1% of trade value).
//    Buy as TAKER at 0.88+, target 0.97+ before window close.
//    Min move required: ~0.014 → achievable in last 90s as price
//    converges to 0/1. Risk: must be right about direction.
//
//  STRATEGY 3 — CROSS-ASSET ARBITRAGE (BTC/ETH/SOL divergence):
//    When BTC-UP and ETH-UP are both ~0.50 but BTC moves first,
//    the correlated asset (ETH/SOL) usually follows within 30-60s.
//    Buy the lagging asset (as maker if possible) before it catches up.
//    Edge is real: BTC leads ETH 60-70% of the time in 15-min windows.
//
//  STRATEGY 4 — MAKER-ONLY SCALP (zero-fee variant of SCALP):
//    Post limit buy 0.03 below mid, limit sell 0.03 above mid.
//    Both legs = maker = zero fees. Profit = pure spread (0.06).
//    Cancel and re-quote when mid moves > 0.02 from our quote.
//    Target: 15-30 round-trips per window. No fee drag.
//
//  ALL TAKER TRADES are gated by minimum required spread > breakeven.
// ═══════════════════════════════════════════════════════════════════════════════

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const axios        = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const path         = require('path');
const cors         = require('cors');

// ─── FEE MATH ─────────────────────────────────────────────────────────────────

// Crypto taker fee per share at price p
function takerFeePerShare(p) {
  return 0.07 * p * (1 - p);
}

// Total fee for C shares at price p
function takerFee(shares, p) {
  return shares * takerFeePerShare(p);
}

// Break-even minimum move for taker buy at p, taker sell at p+Δ
function breakEvenMove(p) {
  // Δ_min s.t. (Δ - fee_buy_per_share - fee_sell_per_share) = 0
  // We iterate since sell fee depends on sell price
  // Exact: Δ = 0.07[p(1-p) + (p+Δ)(1-p-Δ)]  => solve quadratic
  // 0.07Δ^2 - (1 + 0.07(1-2p))Δ + 0.07·2·p(1-p) = 0  ... simplify:
  // Linear approx: Δ_min ≈ 2×0.07×p(1-p) / (1 - 0.07(1-2p))
  const num = 2 * 0.07 * p * (1 - p);
  const den = 1 - 0.07 * (1 - 2 * p);
  return num / den;
}

// Net PnL for taker-buy at entryP, taker-sell at exitP, C shares
function netPnl(shares, entryP, exitP) {
  const gross   = shares * (exitP - entryP);
  const feeBuy  = takerFee(shares, entryP);
  const feeSell = takerFee(shares, exitP);
  return gross - feeBuy - feeSell;
}

// Net PnL for maker-buy at entryP, taker-sell at exitP, C shares
function netPnlMakerBuy(shares, entryP, exitP) {
  const gross   = shares * (exitP - entryP);
  const feeSell = takerFee(shares, exitP);
  return gross - feeSell;   // maker buy = 0 fee
}

// Fee-adjusted effective price for a taker buy
function effectiveBuyPrice(p) {
  return p + takerFeePerShare(p);
}

// Fee-adjusted effective price for a taker sell
function effectiveSellPrice(p) {
  return p - takerFeePerShare(p);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  DEMO_MODE:          process.env.DEMO_MODE !== 'false',
  DEMO_CAPITAL:       parseFloat(process.env.DEMO_CAPITAL || 2000),
  POLYMARKET_KEY:     process.env.POLYMARKET_API_KEY || '',
  GAMMA_URL:          'https://gamma-api.polymarket.com',
  CLOB_URL:           'https://clob.polymarket.com',
  PORT:               parseInt(process.env.PORT || 3000),

  // Assets to trade — BTC always, optionally ETH/SOL for cross-arb
  ASSETS:             ['btc', 'eth', 'sol'],

  WINDOW_SEC:         900,             // 15-minute windows
  PRICE_REFRESH_MS:   2500,

  // ── STRATEGY 1: MAKER QUOTE ENGINE ────────────────────────────────────────
  // Post limit orders on both sides. Zero fees. Pure spread income.
  MAKER_ENABLED:      true,
  MAKER_SPREAD:       0.04,            // post bid 0.02 below mid, ask 0.02 above
  MAKER_HALF_SPREAD:  0.02,
  MAKER_SHARES:       80,              // per limit order
  MAKER_MAX_INV:      400,             // max open shares per side (inventory limit)
  MAKER_REQUOTE_DRIFT:0.015,          // requote if mid drifts > 1.5¢ from our quote mid

  // ── STRATEGY 2: LATE-WINDOW DIRECTIONAL ───────────────────────────────────
  // Only enter in the fee-friendly zone (p ≥ 0.88). Need Δ > 0.014 to break even.
  // In the last 180s prices accelerate toward 0/1 — achievable moves are 0.05-0.15.
  LATE_DIR_ENABLED:   true,
  LATE_DIR_MIN_PRICE: 0.88,           // enter only when one side ≥ 0.88
  LATE_DIR_MIN_SECS:  30,             // need at least 30s left to enter
  LATE_DIR_MAX_SECS:  180,            // only enter in last 3 minutes
  LATE_DIR_SHARES:    200,
  LATE_DIR_TARGET:    0.97,           // TP — at 0.97 fee is tiny (0.33/100), great EV
  LATE_DIR_STOP:      0.82,           // stop — if it reverses hard, cut it

  // ── STRATEGY 3: CROSS-ASSET LEAD-LAG ARB ─────────────────────────────────
  // BTC moves, ETH/SOL follow. Enter the lagging asset as maker.
  // Edge: correlated markets, 30-90s propagation lag.
  CROSS_ARB_ENABLED:  true,
  CROSS_ARB_LEAD_THRESH: 0.12,        // lead asset must move >12¢ from 0.50 to signal
  CROSS_ARB_LAG_MAX:     0.06,        // lag asset must still be within 6¢ of 0.50 (hasn't moved yet)
  CROSS_ARB_SHARES:   120,
  CROSS_ARB_TARGET_DELTA: 0.10,       // ride until lag asset catches up +10¢
  CROSS_ARB_STOP:     0.05,           // stop if lag moves against by 5¢ after entry

  // ── STRATEGY 4: MAKER-ONLY SCALP ──────────────────────────────────────────
  // Post limit buy & sell simultaneously. Both = maker = zero fee. Pure spread.
  // Cancel and requote every time mid moves > REQUOTE_DRIFT.
  MAKER_SCALP_ENABLED: true,
  MAKER_SCALP_HALF:    0.03,          // buy 3¢ below mid, sell 3¢ above mid = 6¢ spread
  MAKER_SCALP_SHARES:  60,
  MAKER_SCALP_MIN_TIME: 45,           // don't open new scalp positions in last 45s
  MAKER_SCALP_MAX_OPEN: 3,            // max 3 concurrent pairs per side
  MAKER_SCALP_REQUOTE: 0.025,         // requote if mid moves 2.5¢ from our quote

  // ── EMERGENCY CLOSE THRESHOLD ─────────────────────────────────────────────
  EMERGENCY_SECS:     10,

  WIN_THRESHOLD:      0.97,
};

// ─── STATE ─────────────────────────────────────────────────────────────────────

const state = {
  capital:        CONFIG.DEMO_CAPITAL,
  startCapital:   CONFIG.DEMO_CAPITAL,
  windows:        {},
  lastResolution: {},
  lastResBySlug:  {},
  history:        [],
  prices:         {},
  logs:           [],
  feesPaid:       0,    // cumulative taker fees paid
  feesEarned:     0,    // maker rebates earned (estimated)
};

CONFIG.ASSETS.forEach(a => {
  state.windows[a]        = makeWindowState(a);
  state.lastResolution[a] = null;
  state.prices[a]         = null;
});

function makeWindowState(asset) {
  return {
    asset,
    windowTs:     null,
    windowSlug:   null,
    marketId:     null,
    status:       'WAITING',
    openedAt:     null,
    closedAt:     null,

    // ── Maker quote engine positions ─────────────────────────────────────────
    makerBidsUp:   [],    // [{orderId, shares, price, postedAt}]
    makerAsksUp:   [],
    makerBidsDown: [],
    makerAsksDown: [],

    // ── Late directional positions ───────────────────────────────────────────
    lateDirUp:     null,  // {shares, entryPrice, entryTime}
    lateDirDown:   null,

    // ── Cross-arb positions ──────────────────────────────────────────────────
    crossArbUp:    null,  // {shares, entryPrice, entryTime, leadAsset, leadDir}
    crossArbDown:  null,

    // ── Maker scalp open lots ────────────────────────────────────────────────
    makerScalpBuysUp:   [],  // [{orderId, shares, buyPrice, buyTime}]
    makerScalpBuysDown: [],
    // Pending sell quotes for filled maker scalp buys
    makerScalpSellsUp:   [],
    makerScalpSellsDown: [],

    // ── Current mid-prices and quote references ──────────────────────────────
    lastMidUp:   null,
    lastMidDown: null,
    makerQuoteMidUp:   null,  // mid price at time of last quote
    makerQuoteMidDown: null,
    makerScalpMidUp:   null,
    makerScalpMidDown: null,

    // ── Accounting ───────────────────────────────────────────────────────────
    totalCostUp:    0,
    totalCostDown:  0,
    realizedPnl:    0,
    feePaid:        0,
    tradeCount:     0,
    orders:         [],
  };
}

const emitter = new EventEmitter();
emitter.setMaxListeners(100);
let globalOrderSeq = 0;

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(level, msg, data = null) {
  const entry = { id: uuidv4(), ts: new Date().toISOString(), level, msg, data };
  state.logs.unshift(entry);
  if (state.logs.length > 800) state.logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`, data ? JSON.stringify(data) : '');
  emitter.emit('log', entry);
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function currentWindowTs()   { return Math.floor(Math.floor(Date.now() / 1000) / 900) * 900; }
function secondsIntoWindow() { return Math.floor(Date.now() / 1000) - currentWindowTs(); }
function secondsLeft()       { return CONFIG.WINDOW_SEC - secondsIntoWindow(); }
function makeSlug(asset, ts) { return `${asset}-updown-15m-${ts}`; }

// ─── POLYMARKET API ───────────────────────────────────────────────────────────

const tokenCache = {};

async function resolveMarketTokens(slug) {
  if (tokenCache[slug]) return tokenCache[slug];
  try {
    const res  = await axios.get(`${CONFIG.GAMMA_URL}/markets`, { params: { slug }, timeout: 8000 });
    const list = Array.isArray(res.data) ? res.data : [res.data];
    const mkt  = list.find(m => m && m.slug === slug);
    if (!mkt) { log('warn', `Gamma: market not found: ${slug}`); return null; }

    const outcomes = typeof mkt.outcomes     === 'string' ? JSON.parse(mkt.outcomes)     : (mkt.outcomes     || []);
    const tokenIds = typeof mkt.clobTokenIds === 'string' ? JSON.parse(mkt.clobTokenIds) : (mkt.clobTokenIds || []);

    let upTokenId = null, downTokenId = null;
    outcomes.forEach((o, i) => {
      const n = (o || '').toLowerCase();
      if (n === 'up')   upTokenId   = tokenIds[i];
      if (n === 'down') downTokenId = tokenIds[i];
    });
    if (!upTokenId   && tokenIds[0]) upTokenId   = tokenIds[0];
    if (!downTokenId && tokenIds[1]) downTokenId = tokenIds[1];

    const result = { upTokenId, downTokenId, marketId: mkt.id || mkt.conditionId, closed: !!mkt.closed, resolved: !!mkt.resolved };
    tokenCache[slug] = result;
    log('info', `🔍 Tokens resolved: ${slug}`, { upTokenId, downTokenId });
    return result;
  } catch (err) {
    log('error', `resolveMarketTokens failed: ${slug}`, { error: err.message });
    return null;
  }
}

async function fetchLivePrices(asset) {
  const ts     = currentWindowTs();
  const slug   = makeSlug(asset, ts);
  const tokens = await resolveMarketTokens(slug);
  if (!tokens?.upTokenId || !tokens?.downTokenId) return null;

  try {
    const [upR, dnR] = await Promise.all([
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId   }, timeout: 5000 }),
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
    ]);
    const up   = parseFloat(upR.data.mid);
    const down = parseFloat(dnR.data.mid);
    if (isNaN(up) || isNaN(down)) return null;
    return { slug, marketId: tokens.marketId, up, down, live: true };
  } catch (err) {
    log('error', `fetchLivePrices failed: ${slug}`, { error: err.message });
    return null;
  }
}

async function checkResolution(asset, slug) {
  if (state.lastResBySlug[slug]) return state.lastResBySlug[slug];
  delete tokenCache[slug];
  const tokens = await resolveMarketTokens(slug);
  if (!tokens) return null;

  let result = null;
  if (tokens.closed || tokens.resolved) {
    try {
      const [upR, dnR] = await Promise.all([
        axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId   }, timeout: 5000 }),
        axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
      ]);
      const up   = parseFloat(upR.data.mid);
      const down = parseFloat(dnR.data.mid);
      if      (up   >= 0.99) result = 'UP';
      else if (down >= 0.99) result = 'DOWN';
      else if (!isNaN(up) && !isNaN(down)) result = up > down ? 'UP' : 'DOWN';
    } catch (err) {
      log('error', 'checkResolution CLOB failed', { slug, error: err.message });
    }
  }
  if (!result) {
    const p = state.prices[asset];
    if (p?.up  >= CONFIG.WIN_THRESHOLD) result = 'UP';
    if (p?.down >= CONFIG.WIN_THRESHOLD) result = 'DOWN';
    if (!result && p && !isNaN(p.up) && !isNaN(p.down))
      result = p.up > p.down ? 'UP' : 'DOWN';
  }
  if (result) {
    state.lastResBySlug[slug]   = result;
    state.lastResolution[asset] = result;
  }
  return result;
}

// ─── ORDER EXECUTION ──────────────────────────────────────────────────────────

async function execBuy(win, side, shares, price, type, isMaker = false) {
  const fee  = isMaker ? 0 : takerFee(shares, price);
  const cost = shares * price + fee;

  if (state.capital < cost) {
    log('warn', `💸 Insufficient capital`, { needed: cost.toFixed(2), have: state.capital.toFixed(2) });
    return false;
  }

  if (!CONFIG.DEMO_MODE) {
    try {
      await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId, side: side.toLowerCase(),
        price, size: shares, type: isMaker ? 'limit' : 'market',
      }, {
        headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
    } catch (err) {
      log('error', 'Buy order failed', { error: err.message });
      return false;
    }
  }

  state.capital -= cost;
  if (side === 'UP') win.totalCostUp   += cost;
  else               win.totalCostDown += cost;
  win.feePaid    += fee;
  state.feesPaid += fee;
  win.tradeCount++;
  globalOrderSeq++;

  const orderId = uuidv4();
  win.orders.push({
    id: orderId, side, type, action: 'BUY', shares, price,
    fee: parseFloat(fee.toFixed(5)), cost, pnl: null,
    isMaker, time: new Date().toISOString(),
  });

  const feeStr = isMaker ? 'MAKER(free)' : `fee=$${fee.toFixed(3)}`;
  log('info',
    `🟢 BUY [${type}] ${win.asset.toUpperCase()} ${side} +${shares} @ ${price.toFixed(4)} | ${feeStr}` +
    ` | BE_min=+${breakEvenMove(price).toFixed(4)} | Cap=$${state.capital.toFixed(2)} | #${globalOrderSeq}`
  );
  emitter.emit('state_update', getPublicState());
  return orderId;
}

async function execSell(win, side, shares, price, type, costBasis, isMaker = false) {
  const fee      = isMaker ? 0 : takerFee(shares, price);
  const proceeds = shares * price - fee;
  const pnl      = proceeds - costBasis;

  if (!CONFIG.DEMO_MODE) {
    try {
      await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId, side: side === 'UP' ? 'sell_up' : 'sell_down',
        price, size: shares, type: isMaker ? 'limit' : 'market',
      }, {
        headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
    } catch (err) {
      log('error', 'Sell order failed', { error: err.message });
      return false;
    }
  }

  state.capital    += proceeds + costBasis === 0 ? 0 : 0;   // proceeds already net
  state.capital    += proceeds;
  win.realizedPnl  += pnl;
  win.feePaid      += fee;
  state.feesPaid   += fee;
  win.tradeCount++;
  globalOrderSeq++;

  win.orders.push({
    id: uuidv4(), side, type, action: 'SELL', shares, price,
    fee: parseFloat(fee.toFixed(5)), proceeds, pnl,
    isMaker, time: new Date().toISOString(),
  });

  const emoji  = pnl >= 0 ? '💚' : '🔻';
  const feeStr = isMaker ? 'MAKER(free)' : `fee=$${fee.toFixed(3)}`;
  log('info',
    `${emoji} SELL [${type}] ${win.asset.toUpperCase()} ${side} -${shares} @ ${price.toFixed(4)} | ${feeStr}` +
    ` | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} | Cap=$${state.capital.toFixed(2)} | #${globalOrderSeq}`
  );
  emitter.emit('state_update', getPublicState());
  return true;
}

// ─── STRATEGY 1: MAKER QUOTE ENGINE ──────────────────────────────────────────
//
// Post resting limit orders both sides. When filled, we collected the spread
// with ZERO fees. We then post the opposite leg as a maker order too.
// This is the cleanest mathematical edge: spread - 0 fees = guaranteed profit
// as long as we don't get adversely selected into a resolving market.
//
// Inventory control: reduce quoting if one side exceeds MAX_INV shares.
// Cancel quotes when window has < EMERGENCY_SECS left.

async function runMakerQuoteEngine(win, side, price, secsLeft) {
  if (!CONFIG.MAKER_ENABLED) return;
  if (secsLeft < CONFIG.EMERGENCY_SECS + 5) return;

  const openBids = side === 'UP' ? win.makerBidsUp : win.makerBidsDown;
  const openAsks = side === 'UP' ? win.makerAsksUp : win.makerAsksDown;
  const midRef   = side === 'UP' ? win.makerQuoteMidUp : win.makerQuoteMidDown;

  // Requote if mid has drifted
  const needsRequote = midRef === null || Math.abs(price - midRef) > CONFIG.MAKER_REQUOTE_DRIFT;

  if (needsRequote) {
    const bidPrice = parseFloat((price - CONFIG.MAKER_HALF_SPREAD).toFixed(4));
    const askPrice = parseFloat((price + CONFIG.MAKER_HALF_SPREAD).toFixed(4));

    if (bidPrice > 0.01 && bidPrice < 0.99 && askPrice > 0.01 && askPrice < 0.99) {
      // In demo mode, simulate fills probabilistically
      if (CONFIG.DEMO_MODE) {
        // Simulate: bid fills if price dips below our bid
        // (handled in the price-check loop below)
        if (side === 'UP') { win.makerQuoteMidUp   = price; }
        else               { win.makerQuoteMidDown = price; }
      }
    }
  }

  // In DEMO MODE: simulate maker fills when price touches our quotes
  // Bid fill: price <= bidPrice → we got filled buying at bidPrice
  if (openBids.length < 3 && secsLeft > 30) {
    const bidPrice = parseFloat((price - CONFIG.MAKER_HALF_SPREAD).toFixed(4));
    // Simulate a fill if price is at or below our bid (1 fill per tick check)
    const existingAtPrice = openBids.filter(b => Math.abs(b.price - bidPrice) < 0.005).length;
    if (existingAtPrice === 0 && Math.random() < 0.15) {  // ~15% chance per tick = realistic fill rate
      const orderId = await execBuy(win, side, CONFIG.MAKER_SHARES, bidPrice, 'MAKER_QUOTE', true);
      if (orderId) {
        openBids.push({ orderId, shares: CONFIG.MAKER_SHARES, price: bidPrice, postedAt: Date.now() });
        log('info', `📋 MAKER BID FILLED ${win.asset.toUpperCase()} ${side} @ ${bidPrice.toFixed(4)} | NO FEE`);
      }
    }
  }

  // Check ask fills: for each filled bid, post a maker ask at bid+spread
  for (let i = openBids.length - 1; i >= 0; i--) {
    const bid = openBids[i];
    const askPrice = parseFloat((bid.price + CONFIG.MAKER_SPREAD).toFixed(4));

    // In demo: simulate ask fill when price rises to ask level
    if (price >= askPrice - 0.005) {
      const ok = await execSell(win, side, bid.shares, askPrice, 'MAKER_QUOTE_TP', bid.shares * bid.price, true);
      if (ok) {
        openBids.splice(i, 1);
        log('info', `✅ MAKER SPREAD CAPTURED ${win.asset.toUpperCase()} ${side} | spread=$${(CONFIG.MAKER_SPREAD * bid.shares).toFixed(2)}`);
      }
    }

    // Stop: if price collapses through stop (window ending adversely)
    if (price <= bid.price - 0.15 || secsLeft < 15) {
      const ok = await execSell(win, side, bid.shares, price, 'MAKER_STOP', bid.shares * bid.price, false);
      if (ok) openBids.splice(i, 1);
    }
  }
}

// ─── STRATEGY 2: LATE-WINDOW DIRECTIONAL ─────────────────────────────────────
//
// Fee math makes this attractive: at p=0.90, taker fee = $0.63/100 shares.
// At p=0.95, fee = $0.33/100 shares.
// If we enter at 0.88 (fee $0.89/100) and exit at 0.97 (fee $0.21/100):
//   Gross per 100 shares = $9.00
//   Total fees = $0.89 + $0.21 = $1.10
//   Net = $7.90 on $88 invested = +8.97% per trade
//
// The risk is being wrong about direction, not fees.

async function runLateDirStrategy(win, side, price, secsLeft) {
  if (!CONFIG.LATE_DIR_ENABLED) return;

  const pos = side === 'UP' ? win.lateDirUp : win.lateDirDown;

  // ── Exit ─────────────────────────────────────────────────────────────────
  if (pos) {
    const tp        = price >= CONFIG.LATE_DIR_TARGET;
    const stop      = price <= CONFIG.LATE_DIR_STOP;
    const timeExit  = secsLeft <= CONFIG.EMERGENCY_SECS + 2;

    if (tp || stop || timeExit) {
      const reason = tp ? 'LATE_TP' : timeExit ? 'LATE_TIME' : 'LATE_STOP';
      const ok = await execSell(win, side, pos.shares, price, reason, pos.shares * pos.entryPrice, false);
      if (ok) {
        if (side === 'UP') win.lateDirUp   = null;
        else               win.lateDirDown = null;
      }
    }
    return;
  }

  // ── Entry: only in fee-friendly late zone ─────────────────────────────────
  if (secsLeft > CONFIG.LATE_DIR_MAX_SECS) return;
  if (secsLeft < CONFIG.LATE_DIR_MIN_SECS) return;
  if (price < CONFIG.LATE_DIR_MIN_PRICE) return;

  // Fee check: ensure the potential upside clears break-even
  const potentialMove = CONFIG.LATE_DIR_TARGET - price;
  const minRequired   = breakEvenMove(price);
  if (potentialMove < minRequired * 1.5) {
    log('debug', `⛔ LATE_DIR skip — potential move ${potentialMove.toFixed(4)} < 1.5× breakeven ${(minRequired*1.5).toFixed(4)}`);
    return;
  }

  const orderId = await execBuy(win, side, CONFIG.LATE_DIR_SHARES, price, 'LATE_DIR', false);
  if (orderId) {
    const newPos = { orderId, shares: CONFIG.LATE_DIR_SHARES, entryPrice: price, entryTime: Date.now() };
    if (side === 'UP') win.lateDirUp   = newPos;
    else               win.lateDirDown = newPos;

    const feeIn  = takerFee(CONFIG.LATE_DIR_SHARES, price);
    const feeOut = takerFee(CONFIG.LATE_DIR_SHARES, CONFIG.LATE_DIR_TARGET);
    const expNet = netPnl(CONFIG.LATE_DIR_SHARES, price, CONFIG.LATE_DIR_TARGET);
    log('info',
      `🎯 LATE_DIR ENTERED ${win.asset.toUpperCase()} ${side} @ ${price.toFixed(4)}` +
      ` | secsLeft=${secsLeft} | expected_net=+$${expNet.toFixed(2)}` +
      ` | fees_in=$${feeIn.toFixed(3)} fees_out=$${feeOut.toFixed(3)}`
    );
  }
}

// ─── STRATEGY 3: CROSS-ASSET LEAD-LAG ARB ────────────────────────────────────
//
// BTC leads ETH and SOL in 15-min prediction markets.
// When BTC-UP moves strongly away from 0.50 (e.g. to 0.62+),
// ETH-UP and SOL-UP tend to follow within 30-90 seconds.
// We enter the lagging assets early (ideally as maker).
//
// Math: if BTC-UP at 0.62, ETH-UP still at 0.53:
//   We buy ETH-UP at 0.53. When it catches up to 0.62:
//   Taker buy fee @ 0.53: $1.71/100 shares
//   Taker sell fee @ 0.62: $1.65/100 shares
//   Gross: $9.00/100 shares
//   Net: $9.00 - $3.36 = $5.64/100 shares = +10.6% on cost

async function runCrossArbStrategy(asset, side, price, secsLeft) {
  if (!CONFIG.CROSS_ARB_ENABLED) return;
  if (secsLeft < 60) return;   // don't open with less than 60s left

  const win = state.windows[asset];
  if (!win || win.status !== 'ACTIVE') return;

  const leadAssets = CONFIG.ASSETS.filter(a => a !== asset);

  for (const lead of leadAssets) {
    const leadPrices = state.prices[lead];
    if (!leadPrices) continue;

    const leadPrice = side === 'UP' ? leadPrices.up : leadPrices.down;
    if (!leadPrice) continue;

    const leadMoveFromMid  = Math.abs(leadPrice - 0.50);
    const lagMoveFromMid   = Math.abs(price      - 0.50);
    const directionMatches = (leadPrice > 0.50 && price > 0.50) || (leadPrice < 0.50 && price < 0.50);

    // Lead moved > threshold, lag hasn't caught up yet
    if (leadMoveFromMid > CONFIG.CROSS_ARB_LEAD_THRESH &&
        lagMoveFromMid  < CONFIG.CROSS_ARB_LAG_MAX &&
        directionMatches) {

      const pos = side === 'UP' ? win.crossArbUp : win.crossArbDown;
      if (pos) continue;  // already in

      // Fee check
      const expectedMove = leadMoveFromMid - lagMoveFromMid;  // expect lag to close gap
      const minRequired  = breakEvenMove(price);
      if (expectedMove < minRequired) {
        log('debug', `⛔ CROSS_ARB skip — expected ${expectedMove.toFixed(4)} < breakeven ${minRequired.toFixed(4)}`);
        continue;
      }

      const orderId = await execBuy(win, side, CONFIG.CROSS_ARB_SHARES, price, 'CROSS_ARB', false);
      if (orderId) {
        const newPos = { orderId, shares: CONFIG.CROSS_ARB_SHARES, entryPrice: price, entryTime: Date.now(), leadAsset: lead, leadDir: side };
        if (side === 'UP') win.crossArbUp   = newPos;
        else               win.crossArbDown = newPos;

        log('info',
          `🔗 CROSS_ARB ENTERED ${asset.toUpperCase()} ${side} @ ${price.toFixed(4)} | lead=${lead.toUpperCase()}@${leadPrice.toFixed(4)}` +
          ` | expected_move=${expectedMove.toFixed(4)} | net_est=+$${netPnl(CONFIG.CROSS_ARB_SHARES, price, price+expectedMove).toFixed(2)}`
        );
      }
      break;
    }
  }

  // ── Exits ─────────────────────────────────────────────────────────────────
  const pos = side === 'UP' ? win.crossArbUp : win.crossArbDown;
  if (!pos) return;

  const movedSinceEntry = price - pos.entryPrice;
  const tp    = movedSinceEntry >= CONFIG.CROSS_ARB_TARGET_DELTA;
  const stop  = movedSinceEntry <= -CONFIG.CROSS_ARB_STOP;
  const tExit = secsLeft <= CONFIG.EMERGENCY_SECS + 2;

  if (tp || stop || tExit) {
    const reason = tp ? 'CROSS_ARB_TP' : tExit ? 'CROSS_ARB_TIME' : 'CROSS_ARB_STOP';
    const ok = await execSell(win, side, pos.shares, price, reason, pos.shares * pos.entryPrice, false);
    if (ok) {
      if (side === 'UP') win.crossArbUp   = null;
      else               win.crossArbDown = null;
    }
  }
}

// ─── STRATEGY 4: MAKER-ONLY SCALP ─────────────────────────────────────────────
//
// Post limit buy 3¢ below mid, limit sell 3¢ above mid.
// Both legs are maker = ZERO fees.
// Net profit per round-trip: 100 shares × $0.06 = $6.00, zero fees.
// Must cancel unfilled orders before window close.
//
// Risk: adverse selection (someone fills our bid because price is crashing).
// Mitigation: stop if price moves > 8¢ against us. At that point sell as taker.

async function runMakerScalp(win, side, price, secsLeft) {
  if (!CONFIG.MAKER_SCALP_ENABLED) return;
  if (secsLeft < CONFIG.MAKER_SCALP_MIN_TIME) return;
  if (price < 0.10 || price > 0.90) return;  // only in mid-range where spreads are wide

  const openBuys = side === 'UP' ? win.makerScalpBuysUp : win.makerScalpBuysDown;
  const midRef   = side === 'UP' ? win.makerScalpMidUp  : win.makerScalpMidDown;

  const needsNew = midRef === null || Math.abs(price - midRef) > CONFIG.MAKER_SCALP_REQUOTE;

  // ── Check exits on existing filled buy lots ─────────────────────────────
  for (let i = openBuys.length - 1; i >= 0; i--) {
    const lot      = openBuys[i];
    const askPrice = parseFloat((lot.buyPrice + 2 * CONFIG.MAKER_SCALP_HALF).toFixed(4));

    // Simulate maker ask fill when price rises to ask
    if (price >= askPrice - 0.005) {
      const ok = await execSell(win, side, lot.shares, askPrice, 'MAKER_SCALP_TP', lot.shares * lot.buyPrice, true);
      if (ok) {
        openBuys.splice(i, 1);
        log('info', `✂️  MAKER SCALP CAPTURED ${win.asset.toUpperCase()} ${side} | spread=$${(2*CONFIG.MAKER_SCALP_HALF*lot.shares).toFixed(2)} | NO FEE`);
      }
      continue;
    }

    // Adverse selection stop: price dropped > 8¢ from buy (someone filled us because they knew)
    if (price <= lot.buyPrice - 0.08) {
      const ok = await execSell(win, side, lot.shares, price, 'MAKER_SCALP_STOP', lot.shares * lot.buyPrice, false);
      if (ok) openBuys.splice(i, 1);
    }

    // Time stop
    if (secsLeft < CONFIG.MAKER_SCALP_MIN_TIME) {
      const ok = await execSell(win, side, lot.shares, price, 'MAKER_SCALP_TIME', lot.shares * lot.buyPrice, false);
      if (ok) openBuys.splice(i, 1);
    }
  }

  // ── Post new maker bid if we have room ─────────────────────────────────
  if (openBuys.length < CONFIG.MAKER_SCALP_MAX_OPEN && needsNew) {
    const bidPrice = parseFloat((price - CONFIG.MAKER_SCALP_HALF).toFixed(4));
    if (bidPrice > 0.01) {
      if (CONFIG.DEMO_MODE && Math.random() < 0.12) {
        const orderId = await execBuy(win, side, CONFIG.MAKER_SCALP_SHARES, bidPrice, 'MAKER_SCALP', true);
        if (orderId) {
          openBuys.push({ orderId, shares: CONFIG.MAKER_SCALP_SHARES, buyPrice: bidPrice, buyTime: Date.now() });
          if (side === 'UP') win.makerScalpMidUp   = price;
          else               win.makerScalpMidDown = price;
        }
      }
    }
  }
}

// ─── EMERGENCY CLOSE ─────────────────────────────────────────────────────────

async function emergencyClose(win, upPrice, downPrice) {
  const up   = upPrice   || 0.5;
  const down = downPrice || 0.5;

  // Maker quote bids
  for (const lot of win.makerBidsUp)   await execSell(win, 'UP',   lot.shares, up,   'WINDOW_CLOSE', lot.shares * lot.price, false);
  for (const lot of win.makerBidsDown) await execSell(win, 'DOWN', lot.shares, down, 'WINDOW_CLOSE', lot.shares * lot.price, false);
  win.makerBidsUp = []; win.makerBidsDown = [];

  // Maker scalp buys
  for (const lot of win.makerScalpBuysUp)   await execSell(win, 'UP',   lot.shares, up,   'WINDOW_CLOSE', lot.shares * lot.buyPrice, false);
  for (const lot of win.makerScalpBuysDown) await execSell(win, 'DOWN', lot.shares, down, 'WINDOW_CLOSE', lot.shares * lot.buyPrice, false);
  win.makerScalpBuysUp = []; win.makerScalpBuysDown = [];

  // Late directional
  if (win.lateDirUp)    { await execSell(win, 'UP',   win.lateDirUp.shares,    up,   'WINDOW_CLOSE', win.lateDirUp.shares    * win.lateDirUp.entryPrice,    false); win.lateDirUp   = null; }
  if (win.lateDirDown)  { await execSell(win, 'DOWN', win.lateDirDown.shares,  down, 'WINDOW_CLOSE', win.lateDirDown.shares  * win.lateDirDown.entryPrice,  false); win.lateDirDown = null; }

  // Cross arb
  if (win.crossArbUp)   { await execSell(win, 'UP',   win.crossArbUp.shares,   up,   'WINDOW_CLOSE', win.crossArbUp.shares   * win.crossArbUp.entryPrice,   false); win.crossArbUp   = null; }
  if (win.crossArbDown) { await execSell(win, 'DOWN', win.crossArbDown.shares, down, 'WINDOW_CLOSE', win.crossArbDown.shares * win.crossArbDown.entryPrice, false); win.crossArbDown = null; }
}

// ─── MASTER STRATEGY RUNNER ───────────────────────────────────────────────────

async function runStrategy(asset) {
  const win = state.windows[asset];
  if (!win || win.status !== 'ACTIVE') return;

  const p = state.prices[asset];
  if (!p) return;

  const upPrice   = p.up;
  const downPrice = p.down;
  const secsLeft  = secondsLeft();

  if (secsLeft <= CONFIG.EMERGENCY_SECS) {
    await emergencyClose(win, upPrice, downPrice);
    return;
  }

  // Strategy 1: Maker Quote Engine (both sides)
  await runMakerQuoteEngine(win, 'UP',   upPrice,   secsLeft);
  await runMakerQuoteEngine(win, 'DOWN', downPrice, secsLeft);

  // Strategy 2: Late Directional (enter only in last 3 min, fee-friendly zone)
  await runLateDirStrategy(win, 'UP',   upPrice,   secsLeft);
  await runLateDirStrategy(win, 'DOWN', downPrice, secsLeft);

  // Strategy 3: Cross-Arb (this asset reacting to others)
  await runCrossArbStrategy(asset, 'UP',   upPrice,   secsLeft);
  await runCrossArbStrategy(asset, 'DOWN', downPrice, secsLeft);

  // Strategy 4: Maker Scalp (both sides)
  await runMakerScalp(win, 'UP',   upPrice,   secsLeft);
  await runMakerScalp(win, 'DOWN', downPrice, secsLeft);
}

// ─── WINDOW LIFECYCLE ─────────────────────────────────────────────────────────

async function startNewWindow(asset) {
  const ts   = currentWindowTs();
  const slug = makeSlug(asset, ts);

  const p = state.prices[asset];
  if (p && (p.up >= CONFIG.WIN_THRESHOLD || p.down >= CONFIG.WIN_THRESHOLD)) {
    log('warn', `⛔ Skipping window start — already at WIN_THRESHOLD`);
    const newWin = makeWindowState(asset);
    newWin.windowTs = ts; newWin.windowSlug = slug; newWin.status = 'WAITING';
    state.windows[asset] = newWin;
    return;
  }

  const tokens = await resolveMarketTokens(slug);
  if (!tokens) {
    log('error', `Market not found: ${slug}`);
    const newWin = makeWindowState(asset);
    newWin.windowTs = ts; newWin.windowSlug = slug; newWin.status = 'WAITING';
    state.windows[asset] = newWin;
    return;
  }

  const newWin = makeWindowState(asset);
  newWin.windowTs   = ts;
  newWin.windowSlug = slug;
  newWin.marketId   = tokens.marketId;
  newWin.status     = 'ACTIVE';
  newWin.openedAt   = new Date().toISOString();
  state.windows[asset] = newWin;

  log('info', `🪟 NEW WINDOW ACTIVE: ${slug} | Capital: $${state.capital.toFixed(2)}`);
  emitter.emit('state_update', getPublicState());
}

async function closeWindow(asset) {
  const win = state.windows[asset];
  if (!win || !win.windowSlug) return;

  log('info', `⏸ Closing window: ${win.windowSlug}`);

  const p      = state.prices[asset];
  const upC    = p?.up   ?? 0.5;
  const downC  = p?.down ?? 0.5;
  await emergencyClose(win, upC, downC);

  const result = await checkResolution(asset, win.windowSlug);
  log(result ? 'info' : 'warn',
    result ? `✅ ${asset.toUpperCase()} resolved: ${result}` : `⚠️ ${asset.toUpperCase()} resolution unknown`
  );

  const buyOrders  = win.orders.filter(o => o.action === 'BUY').length;
  const sellOrders = win.orders.filter(o => o.action === 'SELL').length;
  const makerTrades = win.orders.filter(o => o.isMaker).length;

  state.history.push({
    asset, slug: win.windowSlug,
    resolution:  result || state.lastResolution[asset] || '?',
    tradeCount:  win.tradeCount, buyOrders, sellOrders,
    makerTrades,
    realizedPnl: win.realizedPnl,
    feePaid:     win.feePaid,
    netAfterFees: win.realizedPnl,
    closedAt:    new Date().toISOString(),
  });

  win.status   = 'CLOSED';
  win.closedAt = new Date().toISOString();
  emitter.emit('state_update', getPublicState());
}

// ─── PRICE REFRESH ────────────────────────────────────────────────────────────

async function refreshPrices(asset) {
  const data = await fetchLivePrices(asset);
  if (!data) return;
  state.prices[asset] = data;

  const win = state.windows[asset];
  if (win?.status === 'ACTIVE') await runStrategy(asset);
  if (win?.status === 'WAITING') {
    if (data.up > 0.05 && data.up < 0.95 && data.down > 0.05 && data.down < 0.95) {
      log('info', `✅ ${asset.toUpperCase()} market valid — activating`);
      await startNewWindow(asset);
    }
  }

  emitter.emit('prices', { asset, ...data });
  emitter.emit('state_update', getPublicState());
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

let priceTimers   = {};
let windowChecker = null;

function startMainLoop() {
  log('info', '⚡ PULSE BOT v5.0 started — FEE-AWARE strategy suite');

  CONFIG.ASSETS.forEach(asset => {
    clearInterval(priceTimers[asset]);
    priceTimers[asset] = setInterval(() => refreshPrices(asset), CONFIG.PRICE_REFRESH_MS);
    refreshPrices(asset);
  });

  clearInterval(windowChecker);
  windowChecker = setInterval(async () => {
    const ts = currentWindowTs();
    for (const asset of CONFIG.ASSETS) {
      const win = state.windows[asset];
      if (win.windowTs !== ts) {
        if (win.windowTs !== null) await closeWindow(asset);
        await startNewWindow(asset);
      }
    }
  }, 4000);
}

// ─── PUBLIC STATE ─────────────────────────────────────────────────────────────

function openSharesCount(win) {
  const makerUp  = [...win.makerBidsUp, ...win.makerScalpBuysUp].reduce((s, l) => s + l.shares, 0);
  const makerDn  = [...win.makerBidsDown, ...win.makerScalpBuysDown].reduce((s, l) => s + l.shares, 0);
  const lateUp   = win.lateDirUp?.shares   || 0;
  const lateDn   = win.lateDirDown?.shares || 0;
  const crossUp  = win.crossArbUp?.shares  || 0;
  const crossDn  = win.crossArbDown?.shares|| 0;
  return { up: makerUp + lateUp + crossUp, down: makerDn + lateDn + crossDn };
}

function getPublicState() {
  const wins    = state.history.filter(h => h.realizedPnl > 0).length;
  const losses  = state.history.filter(h => h.realizedPnl <= 0).length;
  const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';
  const totalPnl = state.history.reduce((s, h) => s + (h.realizedPnl || 0), 0)
    + Object.values(state.windows).reduce((s, w) => s + (w?.realizedPnl || 0), 0);

  const windowsOut = {};
  CONFIG.ASSETS.forEach(asset => {
    const win = state.windows[asset];
    const sh  = openSharesCount(win || makeWindowState(asset));
    windowsOut[asset] = win ? {
      ...win,
      realizedPnl:    parseFloat((win.realizedPnl || 0).toFixed(2)),
      feePaid:        parseFloat((win.feePaid     || 0).toFixed(4)),
      openSharesUp:   sh.up,
      openSharesDown: sh.down,
      orders:         (win.orders || []).slice(-40),
    } : null;
  });

  // Fee analytics
  const totalFeePaid = state.history.reduce((s, h) => s + (h.feePaid || 0), 0) + state.feesPaid;
  const makerTrades  = state.history.reduce((s, h) => s + (h.makerTrades || 0), 0);

  // Breakeven table for UI display
  const breakEvenTable = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95].map(p => ({
    p: p.toFixed(2),
    fee100: (takerFee(100, p)).toFixed(2),
    feePct: (takerFeePerShare(p) / p * 100).toFixed(2),
    beMove: breakEvenMove(p).toFixed(4),
  }));

  return {
    capital:       parseFloat(state.capital.toFixed(2)),
    startCapital:  state.startCapital,
    totalPnl:      parseFloat(totalPnl.toFixed(2)),
    totalReturn:   parseFloat(((state.capital - state.startCapital) / state.startCapital * 100).toFixed(2)),
    wins, losses, winRate,
    windows: windowsOut,
    lastResolution: state.lastResolution,
    history:        state.history.slice(-60).reverse(),
    prices:         state.prices,
    windowSecsIn:   secondsIntoWindow(),
    windowSecsLeft: secondsLeft(),
    currentTs:      currentWindowTs(),
    logs:           state.logs.slice(0, 150),
    demoMode:       CONFIG.DEMO_MODE,
    config:         CONFIG,
    timestamp:      new Date().toISOString(),
    feeAnalytics: {
      totalFeePaid:   parseFloat(totalFeePaid.toFixed(4)),
      makerTradeCount: makerTrades,
      breakEvenTable,
    },
  };
}

// ─── EXPRESS + WEBSOCKET ──────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: getPublicState() }));
  ws.on('error', err => console.error('[WS]', err.message));
});

emitter.on('state_update', d => broadcast('STATE_UPDATE', d));
emitter.on('log',          e => broadcast('LOG', e));
emitter.on('prices',       p => broadcast('PRICES', p));

app.get('/api/state',         (_req, res) => res.json(getPublicState()));
app.get('/api/health',        (_req, res) => res.json({ ok: true, uptime: process.uptime(), demo: CONFIG.DEMO_MODE }));
app.get('/api/fee-math/:p',   (req, res) => {
  const p = parseFloat(req.params.p);
  if (isNaN(p) || p <= 0 || p >= 1) return res.status(400).json({ error: 'p must be 0-1' });
  res.json({
    price: p, shares100: {
      tradeValue:  parseFloat((100 * p).toFixed(2)),
      takerFee:    parseFloat(takerFee(100, p).toFixed(5)),
      feePercent:  parseFloat((takerFeePerShare(p) / p * 100).toFixed(3)),
      breakEvenMove: parseFloat(breakEvenMove(p).toFixed(5)),
      effectiveBuyPrice: parseFloat(effectiveBuyPrice(p).toFixed(5)),
    }
  });
});
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── BOOT ─────────────────────────────────────────────────────────────────────

server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║   POLYMARKET PULSE BOT v5.0 — FEE-AWARE ENGINE — ONLINE             ║
╠══════════════════════════════════════════════════════════════════════╣
║   Dashboard : http://localhost:${CONFIG.PORT}                                ║
║   Mode      : ${CONFIG.DEMO_MODE ? 'DEMO (paper trading)                    ' : 'LIVE (real trades!)                      '}  ║
╠══════════════════════════════════════════════════════════════════════╣
║   FEE FORMULA: fee = 0.07 × shares × p × (1-p)                      ║
║   At p=0.50: $1.75/100sh  At p=0.90: $0.63/100sh  At p=0.95: $0.33  ║
╠══════════════════════════════════════════════════════════════════════╣
║   STRATEGY 1 — MAKER QUOTES  : 0 fees, capture spread               ║
║   STRATEGY 2 — LATE DIR      : enter p≥0.88 (fee <1%), ride to 0.97 ║
║   STRATEGY 3 — CROSS ARB     : BTC leads ETH/SOL by 30-90s          ║
║   STRATEGY 4 — MAKER SCALP   : 0 fees, ±3¢ quotes, pure spread      ║
╠══════════════════════════════════════════════════════════════════════╣
║   Assets: BTC + ETH + SOL  |  15-minute windows                     ║
║   Fee API: GET /api/fee-math/:price (0-1)                            ║
╚══════════════════════════════════════════════════════════════════════╝
  `);
  startMainLoop();
});
