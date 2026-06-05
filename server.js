'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
//  APEX MM v1.0 — BTC 15-Minute Market Maker Bot
//  ─────────────────────────────────────────────────────────────────────────────
//  STRATEGY OVERVIEW:
//    Zero fees as maker. Earns 20% of taker fees as daily PUSD rebates.
//    Two parallel strategies both running maker-only (no taker exposure on entry):
//
//  S1 — WIDE MAKER (±3¢ spread = 6¢ round-trip)
//    Bid at mid − 0.03, ask at mid + 0.03
//    Higher profit per fill, better adverse-selection buffer
//    0.7% of capital per bid. Stops posting with <45s left.
//    Stop-loss: if price falls >7¢ below filled bid → taker exit
//
//  S2 — TIGHT MAKER (±1.5¢ spread = 3¢ round-trip)
//    Bid at mid − 0.015, ask at mid + 0.015
//    Qualifies for Polymarket reward farming (within ±3¢ of mid)
//    Earns rebate income on top of spread. 0.4% of capital per bid.
//    Stop-loss: if price falls >5¢ below filled bid → taker exit
//    Stops posting with <90s left (tighter spread = more risk near close)
//
//  REBATE ENGINE:
//    Every time a taker fills one of our maker orders, Polymarket collects
//    taker fee = 0.07 × shares × p × (1-p)
//    We receive back 20% of that fee as daily PUSD credit.
//    Bot accrues estimated rebate every time an opposing taker fills us.
//
//  ADVERSE SELECTION GUARD:
//    Track price velocity. If mid moves >4¢ in one tick → freeze new quotes.
//    Emergency close: all open positions exit as takers with <12s left.
//
//  FEE MATH:
//    takerFee(shares, p) = 0.07 × shares × p × (1-p)
//    makerFee = 0
//    rebatePerShare(p) = 0.20 × 0.07 × p × (1-p)  [we earn 20% of taker fee]
//
//  COMPOUNDING:
//    Position size = floor(capital × riskFraction / price / 5) × 5
//    Rounds to nearest 5 shares (Polymarket minimum lot size).
//    Clamped between MIN_SHARES and MAX_SHARES per order.
//    As capital grows, so does position size → returns stay proportional.
//
//  MARKET DISCOVERY (15-min windows):
//    slug = `btc-updown-15m-${Math.floor(Date.now()/1000/900)*900}`
//    GET gamma-api.polymarket.com/events?slug={slug}
//    response[0].markets[0].clobTokenIds → parse JSON → [0]=UP, [1]=DOWN
//    Live price: GET clob.polymarket.com/midpoint?token_id={id}
//    Resolution: outcomePrices[0] >= 0.95 → UP won, [1] >= 0.95 → DOWN won
//
//  LIFECYCLE SAFETY (same 4 fixes as upstream):
//    Fix 1: No fill on same tick as post (postedTick < currentTick)
//    Fix 2: Separate bid/ask arrays (openBids → openAsks pipeline)
//    Fix 3: One-fill flag per lot (bid.filled = true on first fill)
//    Fix 4: Post-fill cooldown (3 ticks before reposting same price level)
// ═══════════════════════════════════════════════════════════════════════════════

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const axios     = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter   = require('events');
const path      = require('path');
const cors      = require('cors');

// ─── FEE & REBATE MATH ────────────────────────────────────────────────────────

// Taker fee paid by whoever takes our maker order
function takerFee(shares, p)      { return 0.07 * shares * p * (1 - p); }
function takerFeePerShare(p)      { return 0.07 * p * (1 - p); }

// Rebate WE earn: 20% of the taker fee (crypto category = 20%)
function rebatePerFill(shares, p) { return 0.20 * takerFee(shares, p); }

// Minimum spread needed to break even vs. adverse selection at stop
function breakEvenMove(p)         { return (2 * 0.07 * p * (1 - p)) / (1 - 0.07 * (1 - 2 * p)); }

// ─── COMPOUNDING POSITION SIZER ───────────────────────────────────────────────

function calcShares(riskFraction, price, minShares, maxShares) {
  const safeCap   = Math.max(0, state.settledCapital || state.capital);
  const dollars   = safeCap * riskFraction;
  const raw       = dollars / Math.max(price, 0.05);
  const rounded   = Math.floor(raw / 5) * 5;
  return Math.min(maxShares, Math.max(minShares, rounded));
}

// ─── DEMO SIMULATOR ───────────────────────────────────────────────────────────

function poissonRandom(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function simLatencyMs(type) {
  const ranges = {
    maker_post:   [80, 250],
    maker_cancel: [100, 300],
    taker_buy:    [150, 450],
    taker_sell:   [150, 450],
  };
  const [lo, hi] = ranges[type] || [100, 400];
  return lo + Math.random() * (hi - lo);
}

function simTakerFillPrice(mid, isBuy) {
  const ticks = poissonRandom(0.5);
  return isBuy ? mid + ticks * 0.005 : mid - ticks * 0.005;
}

// Maker bid fill: price must dip to or below limitPrice
function simMakerBidFill(currentPrice, limitPrice, queuePos) {
  if (currentPrice > limitPrice) return false;
  const probs = [0, 0.42, 0.22, 0.10, 0.08, 0.06];
  return Math.random() < (probs[Math.min(queuePos, 5)] || 0.04);
}

// Maker ask fill: price must rise to or above askPrice
function simMakerAskFill(currentPrice, askPrice, queuePos) {
  if (currentPrice < askPrice) return false;
  const probs = [0, 0.42, 0.22, 0.10, 0.08, 0.06];
  return Math.random() < (probs[Math.min(queuePos, 5)] || 0.04);
}

function simPartialFill(shares, isTaker) {
  if (isTaker || shares <= 50) return shares;
  return Math.round(shares * (0.65 + Math.random() * 0.35) / 5) * 5;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  DEMO_MODE:       process.env.DEMO_MODE !== 'false',
  DEMO_CAPITAL:    parseFloat(process.env.DEMO_CAPITAL || '2000'),
  POLYMARKET_KEY:  process.env.POLYMARKET_API_KEY || '',
  GAMMA_URL:       'https://gamma-api.polymarket.com',
  CLOB_URL:        'https://clob.polymarket.com',
  PORT:            parseInt(process.env.PORT || '3000'),
  WINDOW_SEC:      900,
  PRICE_REFRESH_MS: 2500,

  // ── S1: WIDE MAKER ────────────────────────────────────────────────────────
  S1_ENABLED:          true,
  S1_HALF_SPREAD:      0.030,    // ±3¢ each side → 6¢ round-trip spread
  S1_RISK_PER_TRADE:   parseFloat(process.env.S1_RISK || '0.007'),  // 0.7% of capital
  S1_MIN_SHARES:       20,
  S1_MAX_SHARES:       500,
  S1_MAX_OPEN_BIDS:    5,
  S1_MAX_OPEN_ASKS:    5,
  S1_REQUOTE_DRIFT:    0.020,    // requote if mid drifts >2¢ from last post
  S1_STOP_DISTANCE:    0.070,    // stop-loss: 7¢ below filled bid price
  S1_COOLDOWN_TICKS:   3,
  S1_STOP_SECS:        45,       // stop posting new bids with <45s left

  // ── S2: TIGHT MAKER (reward farming zone) ─────────────────────────────────
  S2_ENABLED:          true,
  S2_HALF_SPREAD:      0.015,    // ±1.5¢ each side → 3¢ round-trip spread
  S2_RISK_PER_TRADE:   parseFloat(process.env.S2_RISK || '0.004'),  // 0.4% of capital
  S2_MIN_SHARES:       15,
  S2_MAX_SHARES:       300,
  S2_MAX_OPEN_BIDS:    4,
  S2_MAX_OPEN_ASKS:    4,
  S2_REQUOTE_DRIFT:    0.012,
  S2_STOP_DISTANCE:    0.050,    // stop-loss: 5¢ below filled bid price
  S2_COOLDOWN_TICKS:   3,
  S2_STOP_SECS:        90,       // more conservative: stop 90s early

  // ── GLOBAL GUARDS ─────────────────────────────────────────────────────────
  EMERGENCY_SECS:      12,       // emergency taker close threshold
  VELOCITY_FREEZE:     0.040,    // freeze new quotes if mid moves >4¢ in one tick
  WIN_THRESHOLD:       0.97,     // price considered a "win" if >=0.97

  // ── REBATE TRACKING ───────────────────────────────────────────────────────
  REBATE_RATE:         0.20,     // 20% of taker fees (crypto category)
};

// ─── CAPITAL MUTEX ────────────────────────────────────────────────────────────

let _capitalQueue = Promise.resolve();
function adjustCapital(delta) {
  _capitalQueue = _capitalQueue.then(() => {
    state.capital = parseFloat((state.capital + delta).toFixed(6));
    if (state.capital < 0) state.capital = 0;
    state.settledCapital = state.capital;
  });
  return _capitalQueue;
}

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  capital: 0, startCapital: 0, settledCapital: 0,
  window: null,             // single BTC window object
  lastResolution: null,
  lastResBySlug: {},
  history: [],
  prices: null,
  prevPrice: null,          // for velocity calculation
  velocityFrozen: false,    // true if price moved too fast
  logs: [],
  feesPaid: 0,
  rebateAccrued: 0,         // estimated PUSD rebates earned
  compounding: { snapshots: [] },
  sim: {
    totalSlippageCost: 0, partialFills: 0,
    avgLatencyMs: 0, latencySamples: [],
    roundTrips: 0, overfillsBlocked: 0,
  },
};

function initState() {
  state.capital        = CONFIG.DEMO_CAPITAL;
  state.startCapital   = CONFIG.DEMO_CAPITAL;
  state.settledCapital = CONFIG.DEMO_CAPITAL;
  state.window         = makeWindowState();
}

function makeWindowState() {
  return {
    windowTs: null, windowSlug: null, marketId: null,
    upTokenId: null, downTokenId: null,
    status: 'WAITING',  // WAITING | ACTIVE | CLOSED
    openedAt: null, closedAt: null,

    // ── S1 arrays (wide maker) ──────────────────────────────────────────────
    s1BidsUp: [], s1AsksUp: [],
    s1BidsDown: [], s1AsksDown: [],
    s1MidUp: null, s1MidDown: null,

    // ── S2 arrays (tight maker / reward farming) ───────────────────────────
    s2BidsUp: [], s2AsksUp: [],
    s2BidsDown: [], s2AsksDown: [],
    s2MidUp: null, s2MidDown: null,

    // Cooldown tracking: priceKey → ticksRemaining
    cooldowns: {},

    tickCount: 0,
    realizedPnl: 0, feePaid: 0, rebateEarned: 0,
    tradeCount: 0, s1Trades: 0, s2Trades: 0,
    orders: [],
  };
}

// ─── TIME & SLUG HELPERS ──────────────────────────────────────────────────────

function currentWindowTs()   { return Math.floor(Math.floor(Date.now() / 1000) / 900) * 900; }
function secondsIntoWindow() { return Math.floor(Date.now() / 1000) - currentWindowTs(); }
function secondsLeft()       { return CONFIG.WINDOW_SEC - secondsIntoWindow(); }
function makeSlug(ts)        { return `btc-updown-15m-${ts}`; }
function priceKey(p)         { return p.toFixed(4); }

// ─── TICK & COOLDOWN ──────────────────────────────────────────────────────────

let globalTick = 0;
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
let globalOrderSeq = 0;

function tickCooldowns(win) {
  for (const k of Object.keys(win.cooldowns)) {
    win.cooldowns[k]--;
    if (win.cooldowns[k] <= 0) delete win.cooldowns[k];
  }
}
function setCooldown(win, price, ticks) { win.cooldowns[priceKey(price)] = ticks; }
function isCooling(win, price)          { return (win.cooldowns[priceKey(price)] || 0) > 0; }

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(level, msg, data = null) {
  const entry = { id: uuidv4(), ts: new Date().toISOString(), level, msg, data };
  state.logs.unshift(entry);
  if (state.logs.length > 800) state.logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`, data ? JSON.stringify(data) : '');
  emitter.emit('log', entry);
}

// ─── POLYMARKET API ───────────────────────────────────────────────────────────

const tokenCache = {};

async function resolveMarketTokens(slug) {
  if (tokenCache[slug]) return tokenCache[slug];
  try {
    const res  = await axios.get(`${CONFIG.GAMMA_URL}/events`, { params: { slug }, timeout: 10000 });
    const list = Array.isArray(res.data) ? res.data : [res.data];
    const evt  = list.find(e => e && e.slug === slug);
    if (!evt) { log('warn', `Gamma: event not found: ${slug}`); return null; }

    const mkt  = Array.isArray(evt.markets) ? evt.markets[0] : null;
    if (!mkt) { log('warn', `Gamma: no markets in event: ${slug}`); return null; }

    const tokenIds = typeof mkt.clobTokenIds === 'string'
      ? JSON.parse(mkt.clobTokenIds) : (mkt.clobTokenIds || []);
    const outcomes = typeof mkt.outcomes === 'string'
      ? JSON.parse(mkt.outcomes) : (mkt.outcomes || []);

    let upTokenId = null, downTokenId = null;
    outcomes.forEach((o, i) => {
      const n = (o || '').toLowerCase();
      if (n === 'up')   upTokenId   = tokenIds[i];
      if (n === 'down') downTokenId = tokenIds[i];
    });
    // Fallback: index 0 = UP, index 1 = DOWN
    if (!upTokenId   && tokenIds[0]) upTokenId   = tokenIds[0];
    if (!downTokenId && tokenIds[1]) downTokenId = tokenIds[1];

    const result = {
      upTokenId, downTokenId,
      marketId: mkt.id || mkt.conditionId,
      closed: !!mkt.closed, resolved: !!mkt.resolved,
    };
    tokenCache[slug] = result;
    return result;
  } catch (err) {
    log('error', `resolveMarketTokens(${slug}): ${err.message}`);
    return null;
  }
}

async function fetchLivePrices() {
  const ts   = currentWindowTs();
  const slug = makeSlug(ts);
  const tokens = await resolveMarketTokens(slug);
  if (!tokens?.upTokenId) return null;
  try {
    const [upR, dnR] = await Promise.all([
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId },   timeout: 6000 }),
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 6000 }),
    ]);
    const up   = parseFloat(upR.data.mid);
    const down = parseFloat(dnR.data.mid);
    if (isNaN(up) || isNaN(down)) return null;
    return { slug, marketId: tokens.marketId, upTokenId: tokens.upTokenId,
             downTokenId: tokens.downTokenId, up, down, live: true };
  } catch (err) {
    log('error', `fetchLivePrices: ${err.message}`);
    return null;
  }
}

async function checkResolution(slug) {
  if (state.lastResBySlug[slug]) return state.lastResBySlug[slug];
  delete tokenCache[slug];
  const tokens = await resolveMarketTokens(slug);
  if (!tokens) return null;
  let result = null;
  if (tokens.closed || tokens.resolved) {
    try {
      const [upR, dnR] = await Promise.all([
        axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId },   timeout: 6000 }),
        axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 6000 }),
      ]);
      const up = parseFloat(upR.data.mid), down = parseFloat(dnR.data.mid);
      if (up   >= 0.99) result = 'UP';
      else if (down >= 0.99) result = 'DOWN';
      else if (!isNaN(up) && !isNaN(down)) result = up > down ? 'UP' : 'DOWN';
    } catch (_) {}
  }
  const p = state.prices;
  if (!result && p) {
    if (p.up   >= CONFIG.WIN_THRESHOLD) result = 'UP';
    else if (p.down >= CONFIG.WIN_THRESHOLD) result = 'DOWN';
    else if (!isNaN(p.up) && !isNaN(p.down)) result = p.up > p.down ? 'UP' : 'DOWN';
  }
  if (result) { state.lastResBySlug[slug] = result; state.lastResolution = result; }
  return result;
}

// ─── ORDER EXECUTION ──────────────────────────────────────────────────────────

async function execBuy(win, side, shares, limitPrice, type, isMaker) {
  let fillPrice = limitPrice, fillShares = shares, latencyMs = 0;

  if (CONFIG.DEMO_MODE) {
    latencyMs = simLatencyMs(isMaker ? 'maker_post' : 'taker_buy');
    await new Promise(r => setTimeout(r, Math.min(latencyMs, 40)));
    const curP = (side === 'UP' ? state.prices?.up : state.prices?.down) ?? limitPrice;
    if (!isMaker) {
      fillPrice  = simTakerFillPrice(curP, true);
      fillShares = simPartialFill(shares, true);
      state.sim.totalSlippageCost += Math.max(0, (fillPrice - limitPrice) * fillShares);
    } else {
      fillPrice  = limitPrice;
      fillShares = simPartialFill(shares, false);
      if (fillShares < shares) state.sim.partialFills++;
    }
    state.sim.latencySamples.push(latencyMs);
    if (state.sim.latencySamples.length > 200) state.sim.latencySamples.shift();
    state.sim.avgLatencyMs = Math.round(
      state.sim.latencySamples.reduce((a, b) => a + b, 0) / state.sim.latencySamples.length
    );
  } else {
    try {
      const resp = await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId,
        side: side.toLowerCase(),
        price: limitPrice,
        size: shares,
        type: isMaker ? 'limit' : 'market',
      }, {
        headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      fillPrice  = resp.data?.avgPrice  ?? limitPrice;
      fillShares = resp.data?.fillShares ?? shares;
    } catch (err) { log('error', `BUY failed: ${err.message}`); return null; }
  }

  if (fillShares <= 0) return null;

  const fee  = isMaker ? 0 : takerFee(fillShares, fillPrice);
  const cost = fillShares * fillPrice + fee;
  await adjustCapital(-cost);

  win.feePaid    += fee;
  state.feesPaid += fee;
  win.tradeCount++;
  globalOrderSeq++;

  const orderId = uuidv4();
  win.orders.push({
    id: orderId, side, type, action: 'BUY', shares: fillShares,
    limitPrice, fillPrice, fee, cost, isMaker, latencyMs,
    time: new Date().toISOString(),
  });

  log('info',
    `🟢 BUY [${type}] BTC/${side} +${fillShares}sh @ ${fillPrice.toFixed(4)}` +
    ` | ${isMaker ? 'MAKER($0)' : `fee=$${fee.toFixed(3)}`}` +
    ` | Cap=$${state.capital.toFixed(2)} | #${globalOrderSeq}`
  );
  emitter.emit('state_update', getPublicState());
  return { orderId, fillPrice, fillShares, cost };
}

async function execSell(win, side, shares, limitPrice, type, costBasis, isMaker) {
  let fillPrice = limitPrice, fillShares = shares, latencyMs = 0;

  if (CONFIG.DEMO_MODE) {
    latencyMs = simLatencyMs(isMaker ? 'maker_post' : 'taker_sell');
    await new Promise(r => setTimeout(r, Math.min(latencyMs, 40)));
    const curP = (side === 'UP' ? state.prices?.up : state.prices?.down) ?? limitPrice;
    if (!isMaker) {
      fillPrice  = simTakerFillPrice(curP, false);
      fillShares = simPartialFill(shares, true);
      state.sim.totalSlippageCost += Math.max(0, (limitPrice - fillPrice) * fillShares);
    } else {
      fillPrice  = limitPrice;
      fillShares = simPartialFill(shares, false);
    }
  } else {
    try {
      const resp = await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId,
        side: side === 'UP' ? 'sell_up' : 'sell_down',
        price: limitPrice,
        size: shares,
        type: isMaker ? 'limit' : 'market',
      }, {
        headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      fillPrice  = resp.data?.avgPrice  ?? limitPrice;
      fillShares = resp.data?.fillShares ?? shares;
    } catch (err) { log('error', `SELL failed: ${err.message}`); return false; }
  }

  const fee       = isMaker ? 0 : takerFee(fillShares, fillPrice);
  const proceeds  = fillShares * fillPrice - fee;
  const scaledCost = costBasis * (fillShares / shares);
  const pnl       = proceeds - scaledCost;

  await adjustCapital(proceeds);

  win.realizedPnl  += pnl;
  win.feePaid      += fee;
  state.feesPaid   += fee;
  win.tradeCount++;
  globalOrderSeq++;

  // Rebate accounting: we estimate rebate earned when taker filled us (the maker)
  // When we NOW sell as taker (stop-loss), we pay taker fee — no rebate earned.
  // When we sell as maker (TP), the BUYER is the taker — they pay fee, we earn 20% back.
  if (isMaker) {
    const estimatedRebate = rebatePerFill(fillShares, fillPrice);
    win.rebateEarned     += estimatedRebate;
    state.rebateAccrued  += estimatedRebate;
  }

  win.orders.push({
    id: uuidv4(), side, type, action: 'SELL', shares: fillShares,
    limitPrice, fillPrice, fee, proceeds, pnl, isMaker, latencyMs,
    time: new Date().toISOString(),
  });

  const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`;
  log('info',
    `${pnl >= 0 ? '💚' : '🔻'} SELL [${type}] BTC/${side} -${fillShares}sh @ ${fillPrice.toFixed(4)}` +
    ` | ${isMaker ? 'MAKER($0)' : `fee=$${fee.toFixed(3)}`}` +
    ` | PnL:${pnlStr} | Cap=$${state.capital.toFixed(2)} | #${globalOrderSeq}`
  );
  emitter.emit('state_update', getPublicState());
  return true;
}

// ─── STRATEGY 1: WIDE MAKER ───────────────────────────────────────────────────

async function runS1(win, side, price, secsLeft) {
  if (!CONFIG.S1_ENABLED) return;
  if (secsLeft < CONFIG.EMERGENCY_SECS + 5) return;
  if (state.velocityFrozen) return;

  const openBids = side === 'UP' ? win.s1BidsUp   : win.s1BidsDown;
  const openAsks = side === 'UP' ? win.s1AsksUp   : win.s1AsksDown;
  const midKey   = side === 'UP' ? 's1MidUp'      : 's1MidDown';

  // ── PHASE A: check ask exits ──────────────────────────────────────────────
  for (let i = openAsks.length - 1; i >= 0; i--) {
    const ask = openAsks[i];
    ask.queuePos = Math.max(1, (ask.queuePos || 3) - 1);
    const askPrice = parseFloat((ask.entryPrice + 2 * CONFIG.S1_HALF_SPREAD).toFixed(4));

    if (simMakerAskFill(price, askPrice, ask.queuePos)) {
      const ok = await execSell(win, side, ask.filledShares, askPrice,
                                'S1_WIDE_TP', ask.cost, true);
      if (ok) {
        openAsks.splice(i, 1);
        state.sim.roundTrips++;
        setCooldown(win, ask.entryPrice, CONFIG.S1_COOLDOWN_TICKS);
        win.s1Trades++;
        log('info',
          `✅ S1 WIDE SPREAD CAPTURED BTC/${side}` +
          ` | spread=$${(2 * CONFIG.S1_HALF_SPREAD * ask.filledShares).toFixed(2)} | ZERO FEE`
        );
      }
      continue;
    }

    // Stop-loss: price 7¢ below entry, or emergency
    if (price <= ask.entryPrice - CONFIG.S1_STOP_DISTANCE || secsLeft < 20) {
      await execSell(win, side, ask.filledShares, price, 'S1_STOP', ask.cost, false);
      openAsks.splice(i, 1);
    }
  }

  // ── PHASE B: try to fill resting bids ────────────────────────────────────
  for (let i = openBids.length - 1; i >= 0; i--) {
    const bid = openBids[i];
    if (bid.filled) { state.sim.overfillsBlocked++; openBids.splice(i, 1); continue; }
    if (bid.postedTick >= win.tickCount) continue; // Fix 1: no same-tick fill

    bid.queuePos = Math.max(1, (bid.queuePos || 5) - 1);

    // Cancel stale bids that drifted too far from current price
    if (Math.abs(price - bid.limitPrice) > CONFIG.S1_HALF_SPREAD * 4) {
      openBids.splice(i, 1); continue;
    }

    if (simMakerBidFill(price, bid.limitPrice, bid.queuePos)) {
      const result = await execBuy(win, side, bid.shares, bid.limitPrice, 'S1_WIDE', true);
      if (result) {
        bid.filled = true;
        openAsks.push({
          entryPrice:   bid.limitPrice,
          filledShares: result.fillShares,
          cost:         result.cost,
          queuePos:     1 + Math.floor(Math.random() * 3),
          postedTick:   win.tickCount,
        });
        openBids.splice(i, 1);
        log('info', `📋 S1 BID FILLED → ASK POSTED BTC/${side} @ ${bid.limitPrice.toFixed(4)} | NO FEE`);
      }
    }
  }

  // ── PHASE C: post new resting bids ───────────────────────────────────────
  if (secsLeft < CONFIG.S1_STOP_SECS) return;
  const needsPost = win[midKey] === null ||
    Math.abs(price - win[midKey]) > CONFIG.S1_REQUOTE_DRIFT;
  const canPost = openBids.length < CONFIG.S1_MAX_OPEN_BIDS &&
                  openAsks.length < CONFIG.S1_MAX_OPEN_ASKS &&
                  needsPost;

  if (canPost) {
    const bidPrice = parseFloat((price - CONFIG.S1_HALF_SPREAD).toFixed(4));
    if (bidPrice > 0.01 && bidPrice < 0.97 && !isCooling(win, bidPrice)) {
      const shares  = calcShares(CONFIG.S1_RISK_PER_TRADE, bidPrice, CONFIG.S1_MIN_SHARES, CONFIG.S1_MAX_SHARES);
      const isDupe  = openBids.some(b => Math.abs(b.limitPrice - bidPrice) < 0.003);
      if (!isDupe && shares > 0) {
        openBids.push({
          id: uuidv4(), shares, filledShares: 0,
          limitPrice: bidPrice, queuePos: 1 + Math.floor(Math.random() * 5),
          filled: false, postedTick: win.tickCount, postedAt: Date.now(),
        });
        win[midKey] = price;
        log('debug', `📌 S1 BID RESTING BTC/${side} @ ${bidPrice.toFixed(4)} | ${shares}sh`);
      }
    }
  }
}

// ─── STRATEGY 2: TIGHT MAKER (REWARD FARMING ZONE) ───────────────────────────

async function runS2(win, side, price, secsLeft) {
  if (!CONFIG.S2_ENABLED) return;
  if (secsLeft < CONFIG.S2_STOP_SECS) return;
  if (state.velocityFrozen) return;
  // Only trade when price is in the "fair" zone (not near extremes)
  if (price < 0.08 || price > 0.92) return;

  const openBids = side === 'UP' ? win.s2BidsUp   : win.s2BidsDown;
  const openAsks = side === 'UP' ? win.s2AsksUp   : win.s2AsksDown;
  const midKey   = side === 'UP' ? 's2MidUp'      : 's2MidDown';

  // ── PHASE A: ask exits ───────────────────────────────────────────────────
  for (let i = openAsks.length - 1; i >= 0; i--) {
    const ask = openAsks[i];
    ask.queuePos = Math.max(1, (ask.queuePos || 3) - 1);
    const askPrice = parseFloat((ask.entryPrice + 2 * CONFIG.S2_HALF_SPREAD).toFixed(4));

    if (simMakerAskFill(price, askPrice, ask.queuePos)) {
      const ok = await execSell(win, side, ask.filledShares, askPrice,
                                'S2_TIGHT_TP', ask.cost, true);
      if (ok) {
        openAsks.splice(i, 1);
        state.sim.roundTrips++;
        setCooldown(win, ask.entryPrice, CONFIG.S2_COOLDOWN_TICKS);
        win.s2Trades++;
        log('info',
          `✂️  S2 TIGHT SPREAD CAPTURED BTC/${side}` +
          ` | spread=$${(2 * CONFIG.S2_HALF_SPREAD * ask.filledShares).toFixed(2)} | ZERO FEE + REBATE`
        );
      }
      continue;
    }

    if (price <= ask.entryPrice - CONFIG.S2_STOP_DISTANCE || secsLeft < 15) {
      await execSell(win, side, ask.filledShares, price, 'S2_STOP', ask.cost, false);
      openAsks.splice(i, 1);
    }
  }

  // ── PHASE B: fill resting bids ───────────────────────────────────────────
  for (let i = openBids.length - 1; i >= 0; i--) {
    const bid = openBids[i];
    if (bid.filled) { state.sim.overfillsBlocked++; openBids.splice(i, 1); continue; }
    if (bid.postedTick >= win.tickCount) continue;

    bid.queuePos = Math.max(1, (bid.queuePos || 5) - 1);

    if (Math.abs(price - bid.limitPrice) > CONFIG.S2_HALF_SPREAD * 5) {
      openBids.splice(i, 1); continue;
    }

    if (simMakerBidFill(price, bid.limitPrice, bid.queuePos)) {
      const result = await execBuy(win, side, bid.shares, bid.limitPrice, 'S2_TIGHT', true);
      if (result) {
        bid.filled = true;
        openAsks.push({
          entryPrice:   bid.limitPrice,
          filledShares: result.fillShares,
          cost:         result.cost,
          queuePos:     1 + Math.floor(Math.random() * 3),
          postedTick:   win.tickCount,
        });
        openBids.splice(i, 1);
      }
    }
  }

  // ── PHASE C: post new resting bids ───────────────────────────────────────
  const needsPost = win[midKey] === null ||
    Math.abs(price - win[midKey]) > CONFIG.S2_REQUOTE_DRIFT;
  const canPost = openBids.length < CONFIG.S2_MAX_OPEN_BIDS &&
                  openAsks.length < CONFIG.S2_MAX_OPEN_ASKS &&
                  needsPost;

  if (canPost) {
    const bidPrice = parseFloat((price - CONFIG.S2_HALF_SPREAD).toFixed(4));
    if (bidPrice > 0.02 && bidPrice < 0.96 && !isCooling(win, bidPrice)) {
      const shares  = calcShares(CONFIG.S2_RISK_PER_TRADE, bidPrice, CONFIG.S2_MIN_SHARES, CONFIG.S2_MAX_SHARES);
      const isDupe  = openBids.some(b => Math.abs(b.limitPrice - bidPrice) < 0.002);
      if (!isDupe && shares > 0) {
        openBids.push({
          id: uuidv4(), shares, filledShares: 0,
          limitPrice: bidPrice, queuePos: 1 + Math.floor(Math.random() * 5),
          filled: false, postedTick: win.tickCount, postedAt: Date.now(),
        });
        win[midKey] = price;
        log('debug', `📌 S2 BID RESTING BTC/${side} @ ${bidPrice.toFixed(4)} | ${shares}sh | 🏆REWARD ZONE`);
      }
    }
  }
}

// ─── EMERGENCY CLOSE ─────────────────────────────────────────────────────────

async function emergencyClose(win, upP, downP) {
  const close = async (lots, side, px) => {
    for (const lot of lots) {
      if (!lot.filledShares || lot.filledShares <= 0) continue;
      await execSell(win, side, lot.filledShares, px,
        'EMERGENCY_CLOSE', lot.cost ?? lot.filledShares * lot.entryPrice, false);
    }
  };
  await close(win.s1AsksUp,   'UP',   upP);   win.s1AsksUp   = [];
  await close(win.s1AsksDown, 'DOWN', downP); win.s1AsksDown = [];
  await close(win.s2AsksUp,   'UP',   upP);   win.s2AsksUp   = [];
  await close(win.s2AsksDown, 'DOWN', downP); win.s2AsksDown = [];
  // Clear resting bids (unfilled = just cancel, no cost)
  win.s1BidsUp = []; win.s1BidsDown = [];
  win.s2BidsUp = []; win.s2BidsDown = [];
}

// ─── MASTER RUNNER ────────────────────────────────────────────────────────────

async function runStrategy(win, priceData) {
  if (!win || win.status !== 'ACTIVE') return;
  const sl = secondsLeft();

  win.tickCount++;
  tickCooldowns(win);

  if (sl <= CONFIG.EMERGENCY_SECS) {
    await emergencyClose(win, priceData.up, priceData.down);
    return;
  }

  // Velocity check: freeze new quotes if price moved too fast
  if (state.prevPrice) {
    const velocityUp   = Math.abs(priceData.up   - state.prevPrice.up);
    const velocityDown = Math.abs(priceData.down  - state.prevPrice.down);
    const maxVelocity  = Math.max(velocityUp, velocityDown);
    if (maxVelocity >= CONFIG.VELOCITY_FREEZE) {
      if (!state.velocityFrozen) {
        log('warn', `⚡ VELOCITY FREEZE: ${maxVelocity.toFixed(4)} move detected — pausing new quotes`);
        state.velocityFrozen = true;
      }
    } else {
      if (state.velocityFrozen) {
        log('info', '✅ Velocity normalized — resuming quotes');
        state.velocityFrozen = false;
      }
    }
  }
  state.prevPrice = { up: priceData.up, down: priceData.down };

  // Run both strategies on both sides
  await runS1(win, 'UP',   priceData.up,   sl);
  await runS1(win, 'DOWN', priceData.down, sl);
  await runS2(win, 'UP',   priceData.up,   sl);
  await runS2(win, 'DOWN', priceData.down, sl);
}

// ─── COMPOUNDING SNAPSHOT ────────────────────────────────────────────────────

function takeCompoundingSnapshot() {
  const cap = parseFloat((state.settledCapital || state.capital).toFixed(2));
  state.compounding.snapshots.push({
    ts: new Date().toISOString(),
    capital:   cap,
    rebate:    parseFloat(state.rebateAccrued.toFixed(4)),
    pnl:       parseFloat((cap - state.startCapital).toFixed(2)),
    returnPct: parseFloat(((cap - state.startCapital) / state.startCapital * 100).toFixed(2)),
    s1Shares:  calcShares(CONFIG.S1_RISK_PER_TRADE, 0.50, CONFIG.S1_MIN_SHARES, CONFIG.S1_MAX_SHARES),
    s2Shares:  calcShares(CONFIG.S2_RISK_PER_TRADE, 0.50, CONFIG.S2_MIN_SHARES, CONFIG.S2_MAX_SHARES),
  });
  if (state.compounding.snapshots.length > 500) state.compounding.snapshots.shift();
}

// ─── WINDOW LIFECYCLE ─────────────────────────────────────────────────────────

async function startNewWindow() {
  const ts     = currentWindowTs();
  const slug   = makeSlug(ts);
  const tokens = await resolveMarketTokens(slug);
  const newWin = makeWindowState();
  newWin.windowTs  = ts;
  newWin.windowSlug = slug;
  newWin.marketId  = tokens?.marketId ?? null;
  newWin.upTokenId   = tokens?.upTokenId ?? null;
  newWin.downTokenId = tokens?.downTokenId ?? null;
  newWin.status    = tokens ? 'ACTIVE' : 'WAITING';
  newWin.openedAt  = new Date().toISOString();
  state.window = newWin;
  state.prevPrice = null;
  state.velocityFrozen = false;
  if (tokens) {
    log('info', `🪟 NEW WINDOW ACTIVE: ${slug} | Cap=$${state.capital.toFixed(2)}`);
  } else {
    log('warn', `⏳ Waiting for market: ${slug}`);
  }
  emitter.emit('state_update', getPublicState());
}

async function closeWindow() {
  const win = state.window;
  if (!win?.windowSlug) return;
  const p = state.prices;
  await emergencyClose(win, p?.up ?? 0.5, p?.down ?? 0.5);
  const result = await checkResolution(win.windowSlug);

  state.history.push({
    slug:        win.windowSlug,
    resolution:  result || '?',
    tradeCount:  win.tradeCount,
    s1Trades:    win.s1Trades,
    s2Trades:    win.s2Trades,
    realizedPnl: win.realizedPnl,
    rebateEarned: win.rebateEarned,
    feePaid:     win.feePaid,
    closedAt:    new Date().toISOString(),
  });

  win.status   = 'CLOSED';
  win.closedAt = new Date().toISOString();
  log('info',
    `🏁 WINDOW CLOSED: ${win.windowSlug}` +
    ` | PnL=$${win.realizedPnl.toFixed(2)}` +
    ` | Rebate≈$${win.rebateEarned.toFixed(4)}` +
    ` | fees=$${win.feePaid.toFixed(4)}`
  );
  takeCompoundingSnapshot();
  emitter.emit('state_update', getPublicState());
}

// ─── PRICE REFRESH ────────────────────────────────────────────────────────────

async function refreshPrices() {
  const data = await fetchLivePrices();
  if (!data) return;

  state.prices = data;
  globalTick++;

  const win = state.window;
  if (!win) return;

  if (win.status === 'ACTIVE') {
    await runStrategy(win, data);
  } else if (win.status === 'WAITING' && data.up > 0.05 && data.up < 0.95) {
    // Market is now live — update window state
    win.status    = 'ACTIVE';
    win.marketId  = data.marketId;
    win.upTokenId   = data.upTokenId;
    win.downTokenId = data.downTokenId;
    log('info', `✅ Market now active: ${win.windowSlug}`);
  }

  emitter.emit('prices', { up: data.up, down: data.down, slug: data.slug });
  emitter.emit('state_update', getPublicState());
}

// ─── PUBLIC STATE ─────────────────────────────────────────────────────────────

function getPublicState() {
  const cap      = parseFloat((state.settledCapital || state.capital).toFixed(2));
  const totalPnl = parseFloat((cap - state.startCapital).toFixed(2));
  const wins     = state.history.filter(h => h.realizedPnl > 0).length;
  const losses   = state.history.filter(h => h.realizedPnl < 0).length;

  const win = state.window;
  let windowOut = null;
  if (win) {
    const s1OpenBids = (win.s1BidsUp.length + win.s1BidsDown.length);
    const s2OpenBids = (win.s2BidsUp.length + win.s2BidsDown.length);
    const s1OpenAsks = [...win.s1AsksUp, ...win.s1AsksDown].reduce((s, l) => s + (l.filledShares || 0), 0);
    const s2OpenAsks = [...win.s2AsksUp, ...win.s2AsksDown].reduce((s, l) => s + (l.filledShares || 0), 0);
    windowOut = {
      ...win,
      realizedPnl: parseFloat((win.realizedPnl || 0).toFixed(2)),
      rebateEarned: parseFloat((win.rebateEarned || 0).toFixed(4)),
      feePaid: parseFloat((win.feePaid || 0).toFixed(4)),
      s1OpenBids, s1OpenAsks,
      s2OpenBids, s2OpenAsks,
      orders: (win.orders || []).slice(-50),
      // Hide internal arrays (too much data)
      s1BidsUp: undefined, s1BidsDown: undefined,
      s1AsksUp: undefined, s1AsksDown: undefined,
      s2BidsUp: undefined, s2BidsDown: undefined,
      s2AsksUp: undefined, s2AsksDown: undefined,
    };
  }

  // 30-day compound projection
  const snaps = state.compounding.snapshots;
  const avgPnlPerWin = snaps.length > 1
    ? (cap - state.startCapital) / snaps.length : 0;
  const projections = (() => {
    if (snaps.length < 2) return null;
    const windowsPerDay = 96;
    let c = cap;
    const proj = [];
    for (let day = 1; day <= 30; day++) {
      for (let w = 0; w < windowsPerDay; w++) {
        c = c * (1 + avgPnlPerWin / Math.max(c, 1));
      }
      proj.push({ day, capital: parseFloat(c.toFixed(2)) });
    }
    return proj;
  })();

  // Break-even table for display
  const beTable = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90].map(p => ({
    p: p.toFixed(2),
    takerFee100: takerFee(100, p).toFixed(2),
    rebate100: rebatePerFill(100, p).toFixed(3),
    breakEven: breakEvenMove(p).toFixed(4),
  }));

  return {
    capital: cap,
    startCapital: state.startCapital,
    totalPnl,
    totalReturn: parseFloat((totalPnl / state.startCapital * 100).toFixed(2)),
    rebateAccrued: parseFloat(state.rebateAccrued.toFixed(4)),
    wins, losses,
    winRate: (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0',
    window: windowOut,
    lastResolution: state.lastResolution,
    history: state.history.slice(-80).reverse(),
    prices: state.prices,
    windowSecsIn:   secondsIntoWindow(),
    windowSecsLeft: secondsLeft(),
    currentTs:      currentWindowTs(),
    logs: state.logs.slice(0, 120),
    demoMode: CONFIG.DEMO_MODE,
    velocityFrozen: state.velocityFrozen,
    config: {
      S1_HALF_SPREAD: CONFIG.S1_HALF_SPREAD,
      S2_HALF_SPREAD: CONFIG.S2_HALF_SPREAD,
      S1_RISK_PER_TRADE: CONFIG.S1_RISK_PER_TRADE,
      S2_RISK_PER_TRADE: CONFIG.S2_RISK_PER_TRADE,
      REBATE_RATE: CONFIG.REBATE_RATE,
    },
    compounding: {
      snapshots:      snaps.slice(-200),
      projections,
      avgPnlPerWindow: parseFloat(avgPnlPerWin.toFixed(4)),
      windowsRun:     snaps.length,
      currentS1Shares: calcShares(CONFIG.S1_RISK_PER_TRADE, 0.50, CONFIG.S1_MIN_SHARES, CONFIG.S1_MAX_SHARES),
      currentS2Shares: calcShares(CONFIG.S2_RISK_PER_TRADE, 0.50, CONFIG.S2_MIN_SHARES, CONFIG.S2_MAX_SHARES),
    },
    sim: CONFIG.DEMO_MODE ? {
      ...state.sim,
      totalSlippageCost: parseFloat(state.sim.totalSlippageCost.toFixed(4)),
    } : null,
    feeAnalytics: { beTable, totalFeePaid: parseFloat(state.feesPaid.toFixed(4)) },
    timestamp: new Date().toISOString(),
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
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: getPublicState() }));
  ws.on('error', e => console.error('[WS]', e.message));
});

emitter.on('state_update', d => broadcast('STATE_UPDATE', d));
emitter.on('log',          e => broadcast('LOG', e));
emitter.on('prices',       p => broadcast('PRICES', p));

app.get('/api/state',   (_, res) => res.json(getPublicState()));
app.get('/api/health',  (_, res) => res.json({ ok: true, uptime: process.uptime(), demo: CONFIG.DEMO_MODE }));
app.get('*',            (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

let priceTimer = null, windowChecker = null;

function startMainLoop() {
  log('info', `⚡ APEX MM v1.0 | mode=${CONFIG.DEMO_MODE ? 'DEMO' : 'LIVE'}`);
  clearInterval(priceTimer);
  priceTimer = setInterval(() => refreshPrices(), CONFIG.PRICE_REFRESH_MS);
  refreshPrices();

  clearInterval(windowChecker);
  windowChecker = setInterval(async () => {
    const ts  = currentWindowTs();
    const win = state.window;
    if (!win || win.windowTs !== ts) {
      if (win?.windowTs !== null && win?.windowTs !== undefined) {
        await closeWindow();
      }
      await startNewWindow();
      takeCompoundingSnapshot();
    }
  }, 4000);

  takeCompoundingSnapshot();
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

initState();
server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║   APEX MM v1.0 — BTC 15-Minute Market Maker Bot                         ║
╠══════════════════════════════════════════════════════════════════════════╣
║   Dashboard → http://localhost:${CONFIG.PORT}                                   ║
║   Mode: ${CONFIG.DEMO_MODE ? 'DEMO ($' + CONFIG.DEMO_CAPITAL.toFixed(0) + ' simulated)                        ' : 'LIVE TRADING 🔴                              '}   ║
╠══════════════════════════════════════════════════════════════════════════╣
║   S1 WIDE MAKER  ±3¢ spread  0.7%/bid  6¢ round-trip  $0 fee           ║
║   S2 TIGHT MAKER ±1.5¢ spread 0.4%/bid  3¢ round-trip  $0 fee + rebate ║
║   REBATE: 20% of taker fees redistributed daily in PUSD                 ║
╠══════════════════════════════════════════════════════════════════════════╣
║   BTC 15-min windows  |  96 windows/day  |  Compounding capital         ║
╚══════════════════════════════════════════════════════════════════════════╝
  `);
  startMainLoop();
});
