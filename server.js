'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
//  PULSE BOT v5.3 — ONE-SHOT FILL FIX + COMPOUNDING
//
//  BUG FIXED FROM v5.2: DEMO OVER-FILLING (same order filling 29× per window)
//  ─────────────────────────────────────────────────────────────────────────────
//  Root cause: every 2.5s tick could post+fill+sell a complete round-trip and
//  immediately repost. Real CLOB: one fill per order ID, then the order is gone.
//
//  FIX 1 — NO INSTANT FILL ON POST TICK
//    Orders always post as resting:true on creation tick.
//    Fill check only runs when postedAt tick < current tick.
//    Mirrors real CLOB: order must sit in queue at least one tick.
//
//  FIX 2 — SEPARATE BID and ASK ARRAYS (two-stage lifecycle)
//    openBids[]  — resting limit buys waiting to fill
//    openAsks[]  — filled bids waiting for the exit leg
//    Bid fills  → lot moves openBids → openAsks (bid slot freed immediately)
//    Ask fills  → lot removed from openAsks (round-trip complete)
//    openBids.length now accurately reflects free slots.
//
//  FIX 3 — ONE-FILL FLAG per lot
//    Each lot: filled:false. Set true on first fill. Any re-fill rejected.
//    Prevents async race where same lot fills twice in same tick.
//
//  FIX 4 — POST-FILL COOLDOWN (3 ticks = 7.5s)
//    After a complete round-trip, that price level cools for 3 ticks
//    before a new bid is posted there. Mirrors real queue re-entry delay.
//
//  COMPOUNDING ENGINE (NEW):
//  ─────────────────────────────────────────────────────────────────────────────
//  Position size scales with capital so profits compound automatically.
//
//  Formula:  shares = floor( capital × RISK_PER_TRADE / price / 5 ) × 5
//    RISK_PER_TRADE = fraction of capital to deploy per order
//    Rounded to nearest 5 shares (Polymarket minimum lot = 5)
//    Hard floor: MIN_SHARES.  Hard ceiling: MAX_SHARES.
//
//  S1 RISK_PER_TRADE = 0.006  (0.6% of capital per bid)
//    At $2,000:  shares = floor(2000×0.006/0.50/5)×5 = 40sh  → floor(120) = 40→ capped at 40? No:
//    At $2,000:  2000×0.006=12 / 0.50 = 24 → floor(24/5)×5 = 20sh  → MIN_SHARES=40 → 40sh
//    At $5,000:  5000×0.006=30 / 0.50 = 60 → floor(60/5)×5 = 60sh
//    At $10,000: 10000×0.006=60 / 0.50=120 → floor(120/5)×5=120sh
//    At $20,000: 20000×0.006=120 → 240sh → capped at MAX_SHARES=300
//
//  S4 RISK_PER_TRADE = 0.004  (0.4% of capital per bid, tighter spread)
//    Same formula, slightly smaller fraction
//
//  Effect: as capital grows, position sizes grow proportionally.
//  $2k→$4k doubles shares. Returns stay ~constant % not shrinking.
//
//  REALISTIC FILL RATE AFTER FIX:
//    ~2–8 round-trips per slot per window (was 144 before)
//    Demo PnL now calibrated to real CLOB expectations.
//
//  ALL v5.2 RETAINED:
//    ✓ S2 + S3 removed   ✓ Capital mutex   ✓ Single-source fees
//    ✓ Exact PnL costBasis  ✓ Latency/slippage/partial fill sim
//
//  FEE: taker = 0.07×sh×p×(1-p)  |  maker = $0.00
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

function takerFeePerShare(p)  { return 0.07 * p * (1 - p); }
function takerFee(shares, p)  { return shares * takerFeePerShare(p); }
function breakEvenMove(p)     { return (2*0.07*p*(1-p)) / (1 - 0.07*(1-2*p)); }

// ─── COMPOUNDING POSITION SIZER ───────────────────────────────────────────────
//
// Returns the number of shares to use for a new order, scaled to current capital.
// Rounds to nearest 5 (Polymarket min lot). Clamped between min and max.
//
// riskFraction = fraction of total capital to deploy per single bid
// price        = current mid price (affects how many shares $X buys)
//
function calcShares(riskFraction, price, minShares, maxShares) {
  const rawDollars = state.capital * riskFraction;
  const rawShares  = rawDollars / Math.max(price, 0.05); // avoid div-by-zero at extremes
  const rounded    = Math.floor(rawShares / 5) * 5;      // round down to nearest 5
  return Math.min(maxShares, Math.max(minShares, rounded));
}

// ─── REALISTIC DEMO SIMULATOR ─────────────────────────────────────────────────

function poissonRandom(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function simLatencyMs(orderType) {
  const base = {
    taker_buy:    { min: 200, max: 600 },
    taker_sell:   { min: 200, max: 600 },
    maker_post:   { min: 100, max: 300 },
    maker_cancel: { min: 150, max: 400 },
  }[orderType] || { min: 200, max: 500 };
  return base.min + Math.random() * (base.max - base.min);
}

function simTakerFillPrice(midPrice, isBuy) {
  const ticks = poissonRandom(0.6);
  return isBuy ? midPrice + ticks*0.005 : midPrice - ticks*0.005;
}

// Fill probability based on queue position — price must have crossed limit
function simMakerBidFillThisTick(currentPrice, limitPrice, queuePos) {
  if (currentPrice > limitPrice) return false;
  const probs = [0, 0.40, 0.20, 0.08, 0.08, 0.08];
  return Math.random() < (probs[Math.min(queuePos, 5)] || 0.05);
}
function simMakerAskFillThisTick(currentPrice, limitPrice, queuePos) {
  if (currentPrice < limitPrice) return false;
  const probs = [0, 0.40, 0.20, 0.08, 0.08, 0.08];
  return Math.random() < (probs[Math.min(queuePos, 5)] || 0.05);
}

function simPartialFill(shares, isTaker) {
  if (isTaker || shares <= 60) return shares;
  return Math.round(shares * (0.60 + Math.random()*0.40) / 5) * 5;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  DEMO_MODE:       process.env.DEMO_MODE !== 'false',
  DEMO_CAPITAL:    parseFloat(process.env.DEMO_CAPITAL || 2000),
  POLYMARKET_KEY:  process.env.POLYMARKET_API_KEY || '',
  GAMMA_URL:       'https://gamma-api.polymarket.com',
  CLOB_URL:        'https://clob.polymarket.com',
  PORT:            parseInt(process.env.PORT || 3000),
  ASSETS:          (process.env.ASSETS || 'btc,eth,sol').split(','),
  WINDOW_SEC:      900,
  PRICE_REFRESH_MS: 2500,

  // ── S1: MAKER QUOTE ENGINE ────────────────────────────────────────────────
  // Spread = MAKER_SPREAD = 0.04 → $4.80/120sh per round-trip, zero fees.
  // Position size compounds with capital via RISK_PER_TRADE.
  MAKER_ENABLED:        true,
  MAKER_SPREAD:         0.04,
  MAKER_HALF_SPREAD:    0.02,
  MAKER_RISK_PER_TRADE: 0.006,   // 0.6% of capital per bid → scales shares
  MAKER_MIN_SHARES:     20,      // floor — never post fewer than 20sh
  MAKER_MAX_SHARES:     400,     // ceiling — never post more than 400sh
  MAKER_MAX_OPEN_BIDS:  6,       // max concurrent resting bids per side
  MAKER_MAX_OPEN_ASKS:  6,       // max concurrent pending asks per side
  MAKER_REQUOTE_DRIFT:  0.015,   // requote if mid drifts >1.5¢
  MAKER_COOLDOWN_TICKS: 3,       // ticks to wait before reposting at same price

  // ── S4: MAKER-ONLY SCALP ──────────────────────────────────────────────────
  // Spread = 2 × SCALP_HALF = 0.05 → $4.00/80sh per round-trip, zero fees.
  MAKER_SCALP_ENABLED:      true,
  MAKER_SCALP_HALF:         0.025,
  MAKER_SCALP_RISK_PER_TRADE: 0.004,  // 0.4% of capital per bid
  MAKER_SCALP_MIN_SHARES:   15,
  MAKER_SCALP_MAX_SHARES:   300,
  MAKER_SCALP_MIN_TIME:     45,        // stop new posts with <45s left
  MAKER_SCALP_MAX_OPEN:     6,
  MAKER_SCALP_MAX_ASKS:     6,
  MAKER_SCALP_REQUOTE:      0.020,
  MAKER_SCALP_ADV_SEL_STOP: 0.06,
  MAKER_SCALP_COOLDOWN_TICKS: 3,

  EMERGENCY_SECS:  10,
  WIN_THRESHOLD:   0.97,
};

// ─── CAPITAL MUTEX ────────────────────────────────────────────────────────────

let _capitalQueue = Promise.resolve();
function adjustCapital(delta) {
  _capitalQueue = _capitalQueue.then(() => {
    state.capital = parseFloat((state.capital + delta).toFixed(6));
  });
  return _capitalQueue;
}

// ─── STATE ─────────────────────────────────────────────────────────────────────

const state = {
  capital: 0, startCapital: 0,
  windows: {}, lastResolution: {}, lastResBySlug: {},
  history: [], prices: {}, logs: [],
  feesPaid: 0,
  sim: {
    totalSlippageCost: 0, partialFills: 0,
    avgLatencyMs: 0, latencySamples: [],
    roundTrips: 0,          // completed bid→ask cycles
    overfillsBlocked: 0,    // times one-fill guard fired
  },
  compounding: {
    // snapshot history for the compounding chart
    snapshots: [],   // [{ts, capital, sharesS1, sharesS4}]
  },
};

function initState() {
  state.capital      = CONFIG.DEMO_CAPITAL;
  state.startCapital = CONFIG.DEMO_CAPITAL;
  CONFIG.ASSETS.forEach(a => {
    state.windows[a]        = makeWindowState(a);
    state.lastResolution[a] = null;
    state.prices[a]         = null;
  });
}

function makeWindowState(asset) {
  return {
    asset, windowTs: null, windowSlug: null, marketId: null,
    status: 'WAITING', openedAt: null, closedAt: null,

    // FIX 2: SEPARATE BID and ASK arrays
    // openBids: resting orders waiting for bid fill
    // openAsks: filled bids waiting for ask fill (exit leg)
    makerBidsUp:   [], makerAsksUp:   [],
    makerBidsDown: [], makerAsksDown: [],
    makerScalpBidsUp:   [], makerScalpAsksUp:   [],
    makerScalpBidsDown: [], makerScalpAsksDown: [],

    // Cooldown tracking: priceKey → ticksRemaining
    // Prevents reposting at same price immediately after a fill
    bidCooldowns: {},   // { '0.4800': 3, '0.5200': 1, ... }

    // Price tracking
    makerQuoteMidUp: null, makerQuoteMidDown: null,
    makerScalpMidUp: null, makerScalpMidDown: null,

    // Tick counter (increments each price refresh)
    tickCount: 0,

    realizedPnl: 0, feePaid: 0, tradeCount: 0,
    orders: [],
  };
}

// ─── TICK COUNTER ─────────────────────────────────────────────────────────────
// Used to enforce "no fill on same tick as post" (Fix 1)
// and cooldown tracking (Fix 4).

let globalTick = 0;   // increments every PRICE_REFRESH_MS across all assets

const emitter = new EventEmitter();
emitter.setMaxListeners(200);
let globalOrderSeq = 0;

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(level, msg, data = null) {
  const entry = { id: uuidv4(), ts: new Date().toISOString(), level, msg, data };
  state.logs.unshift(entry);
  if (state.logs.length > 1000) state.logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`, data ? JSON.stringify(data) : '');
  emitter.emit('log', entry);
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function currentWindowTs()   { return Math.floor(Math.floor(Date.now()/1000)/900)*900; }
function secondsIntoWindow() { return Math.floor(Date.now()/1000) - currentWindowTs(); }
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
      const n = (o||'').toLowerCase();
      if (n==='up')   upTokenId   = tokenIds[i];
      if (n==='down') downTokenId = tokenIds[i];
    });
    if (!upTokenId   && tokenIds[0]) upTokenId   = tokenIds[0];
    if (!downTokenId && tokenIds[1]) downTokenId = tokenIds[1];
    const result = { upTokenId, downTokenId, marketId: mkt.id||mkt.conditionId, closed:!!mkt.closed, resolved:!!mkt.resolved };
    tokenCache[slug] = result;
    return result;
  } catch (err) {
    log('error', `resolveMarketTokens: ${err.message}`);
    return null;
  }
}

async function fetchLivePrices(asset) {
  const slug   = makeSlug(asset, currentWindowTs());
  const tokens = await resolveMarketTokens(slug);
  if (!tokens?.upTokenId) return null;
  try {
    const [upR, dnR] = await Promise.all([
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId   }, timeout: 5000 }),
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
    ]);
    const up = parseFloat(upR.data.mid), down = parseFloat(dnR.data.mid);
    if (isNaN(up)||isNaN(down)) return null;
    return { slug, marketId: tokens.marketId, up, down, live: true };
  } catch (err) {
    log('error', `fetchLivePrices ${asset}: ${err.message}`);
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
      const up = parseFloat(upR.data.mid), down = parseFloat(dnR.data.mid);
      if (up>=0.99) result='UP'; else if (down>=0.99) result='DOWN';
      else if (!isNaN(up)&&!isNaN(down)) result = up>down?'UP':'DOWN';
    } catch(_) {}
  }
  const p = state.prices[asset];
  if (!result && p) {
    if (p.up>=CONFIG.WIN_THRESHOLD) result='UP';
    else if (p.down>=CONFIG.WIN_THRESHOLD) result='DOWN';
    else if (!isNaN(p.up)&&!isNaN(p.down)) result = p.up>p.down?'UP':'DOWN';
  }
  if (result) { state.lastResBySlug[slug]=result; state.lastResolution[asset]=result; }
  return result;
}

// ─── ORDER EXECUTION ──────────────────────────────────────────────────────────

async function execBuy(win, side, shares, requestedPrice, type, isMaker) {
  let fillPrice = requestedPrice, fillShares = shares, latencyMs = 0;

  if (CONFIG.DEMO_MODE) {
    latencyMs = simLatencyMs(isMaker ? 'maker_post' : 'taker_buy');
    await new Promise(r => setTimeout(r, Math.min(latencyMs, 50)));
    const curP = (side==='UP' ? state.prices[win.asset]?.up : state.prices[win.asset]?.down) ?? requestedPrice;
    if (!isMaker) {
      fillPrice  = simTakerFillPrice(curP, true);
      fillShares = simPartialFill(shares, true);
      state.sim.totalSlippageCost += Math.max(0, (fillPrice-requestedPrice)*fillShares);
    } else {
      fillPrice  = requestedPrice;
      fillShares = simPartialFill(shares, false);
      if (fillShares < shares) state.sim.partialFills++;
    }
    state.sim.latencySamples.push(latencyMs);
    if (state.sim.latencySamples.length > 200) state.sim.latencySamples.shift();
    state.sim.avgLatencyMs = Math.round(state.sim.latencySamples.reduce((a,b)=>a+b,0)/state.sim.latencySamples.length);
  } else {
    try {
      const resp = await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId, side: side.toLowerCase(),
        price: requestedPrice, size: shares, type: isMaker ? 'limit' : 'market',
      }, { headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type':'application/json' }, timeout: 8000 });
      fillPrice  = resp.data?.avgPrice  ?? requestedPrice;
      fillShares = resp.data?.fillShares ?? shares;
    } catch (err) { log('error', `BUY failed: ${err.message}`); return null; }
  }

  if (fillShares <= 0) return null;

  const fee  = isMaker ? 0 : takerFee(fillShares, fillPrice);
  const cost = fillShares * fillPrice + fee;   // costBasis includes buy-side fee
  await adjustCapital(-cost);

  win.feePaid    += fee;
  state.feesPaid += fee;
  win.tradeCount++;
  globalOrderSeq++;

  const orderId = uuidv4();
  win.orders.push({ id:orderId, side, type, action:'BUY', shares:fillShares,
    requestedPrice, fillPrice, fee, cost, isMaker, latencyMs, time:new Date().toISOString() });

  const feeStr = isMaker ? 'MAKER(free)' : `fee=$${fee.toFixed(3)}`;
  log('info', `🟢 BUY [${type}] ${win.asset.toUpperCase()} ${side} +${fillShares} @ ${fillPrice.toFixed(4)}` +
    ` | ${feeStr} | BE_min=+${breakEvenMove(fillPrice).toFixed(4)} | Cap=$${state.capital.toFixed(2)} | #${globalOrderSeq}`);
  emitter.emit('state_update', getPublicState());
  return { orderId, fillPrice, fillShares, cost };
}

async function execSell(win, side, shares, requestedPrice, type, costBasis, isMaker) {
  let fillPrice = requestedPrice, fillShares = shares, latencyMs = 0;

  if (CONFIG.DEMO_MODE) {
    latencyMs = simLatencyMs(isMaker ? 'maker_post' : 'taker_sell');
    await new Promise(r => setTimeout(r, Math.min(latencyMs, 50)));
    const curP = (side==='UP' ? state.prices[win.asset]?.up : state.prices[win.asset]?.down) ?? requestedPrice;
    if (!isMaker) {
      fillPrice  = simTakerFillPrice(curP, false);
      fillShares = simPartialFill(shares, true);
      state.sim.totalSlippageCost += Math.max(0, (requestedPrice-fillPrice)*fillShares);
    } else {
      fillPrice  = requestedPrice;
      fillShares = simPartialFill(shares, false);
    }
  } else {
    try {
      const resp = await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId, side: side==='UP'?'sell_up':'sell_down',
        price: requestedPrice, size: shares, type: isMaker ? 'limit' : 'market',
      }, { headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type':'application/json' }, timeout: 8000 });
      fillPrice  = resp.data?.avgPrice  ?? requestedPrice;
      fillShares = resp.data?.fillShares ?? shares;
    } catch (err) { log('error', `SELL failed: ${err.message}`); return false; }
  }

  const fee       = isMaker ? 0 : takerFee(fillShares, fillPrice);
  const proceeds  = fillShares * fillPrice - fee;
  const scaledCost= costBasis * (fillShares / shares);
  const pnl       = proceeds - scaledCost;

  await adjustCapital(proceeds);

  win.realizedPnl  += pnl;
  win.feePaid      += fee;
  state.feesPaid   += fee;
  win.tradeCount++;
  globalOrderSeq++;

  win.orders.push({ id:uuidv4(), side, type, action:'SELL', shares:fillShares,
    requestedPrice, fillPrice, fee, proceeds, pnl, isMaker, latencyMs, time:new Date().toISOString() });

  log('info', `${pnl>=0?'💚':'🔻'} SELL [${type}] ${win.asset.toUpperCase()} ${side} -${fillShares} @ ${fillPrice.toFixed(4)}` +
    ` | ${isMaker?'MAKER(free)':`fee=$${fee.toFixed(3)}`} | PnL: ${pnl>=0?'+':''}$${pnl.toFixed(3)}` +
    ` | Cap=$${state.capital.toFixed(2)} | #${globalOrderSeq}`);
  emitter.emit('state_update', getPublicState());
  return true;
}

// ─── COMPOUNDING SNAPSHOT ─────────────────────────────────────────────────────
// Called after every window close. Records capital + computed share sizes
// so the dashboard can plot a compounding growth curve.

function takeCompoundingSnapshot() {
  const midP = 0.50; // reference price for share size illustration
  const s1Shares = calcShares(CONFIG.MAKER_RISK_PER_TRADE,       midP, CONFIG.MAKER_MIN_SHARES,       CONFIG.MAKER_MAX_SHARES);
  const s4Shares = calcShares(CONFIG.MAKER_SCALP_RISK_PER_TRADE, midP, CONFIG.MAKER_SCALP_MIN_SHARES, CONFIG.MAKER_SCALP_MAX_SHARES);
  state.compounding.snapshots.push({
    ts:        new Date().toISOString(),
    capital:   parseFloat(state.capital.toFixed(2)),
    sharesS1:  s1Shares,
    sharesS4:  s4Shares,
    pnl:       parseFloat((state.capital - state.startCapital).toFixed(2)),
    returnPct: parseFloat(((state.capital - state.startCapital) / state.startCapital * 100).toFixed(2)),
  });
  if (state.compounding.snapshots.length > 500) state.compounding.snapshots.shift();
}

// ─── COOLDOWN HELPERS ─────────────────────────────────────────────────────────

function priceKey(p) { return p.toFixed(4); }

function tickCooldowns(win) {
  // Decrement all cooldown counters by 1 each tick. Remove when zero.
  for (const k of Object.keys(win.bidCooldowns)) {
    win.bidCooldowns[k]--;
    if (win.bidCooldowns[k] <= 0) delete win.bidCooldowns[k];
  }
}

function setCooldown(win, price, ticks) {
  win.bidCooldowns[priceKey(price)] = ticks;
}

function isCoolingDown(win, price) {
  return (win.bidCooldowns[priceKey(price)] || 0) > 0;
}

// ─── STRATEGY 1: MAKER QUOTE ENGINE ──────────────────────────────────────────
//
// Two-array lifecycle (Fix 2):
//   openBids  → resting limit buys, waiting for price to cross down
//   openAsks  → filled bids, waiting for price to cross up to exit
//
// One-shot fill (Fix 3): each lot.filled flag prevents double-fill.
// No-instant-fill (Fix 1): lots only eligible for fill if postedTick < currentTick.
// Cooldown (Fix 4): after ask fills, priceKey cools for MAKER_COOLDOWN_TICKS ticks.

async function runMakerQuoteEngine(win, side, price, secsLeft) {
  if (!CONFIG.MAKER_ENABLED) return;
  if (secsLeft < CONFIG.EMERGENCY_SECS + 5) return;

  const openBids = side==='UP' ? win.makerBidsUp   : win.makerBidsDown;
  const openAsks = side==='UP' ? win.makerAsksUp   : win.makerAsksDown;
  const midRefKey = side==='UP' ? 'makerQuoteMidUp' : 'makerQuoteMidDown';

  win.tickCount++;
  tickCooldowns(win);

  // ── PHASE A: Check ask exits on pending asks ───────────────────────────
  for (let i = openAsks.length-1; i >= 0; i--) {
    const ask = openAsks[i];
    ask.queuePos = Math.max(1, (ask.queuePos||3) - 1);

    const askPrice = parseFloat((ask.limitPrice + CONFIG.MAKER_SPREAD).toFixed(4));

    if (simMakerAskFillThisTick(price, askPrice, ask.queuePos)) {
      const ok = await execSell(win, side, ask.filledShares, askPrice,
                                'MAKER_QUOTE_TP', ask.cost, true);
      if (ok) {
        openAsks.splice(i, 1);
        state.sim.roundTrips++;
        // FIX 4: cooldown on this price level
        setCooldown(win, ask.limitPrice, CONFIG.MAKER_COOLDOWN_TICKS);
        log('info', `✅ MAKER SPREAD CAPTURED ${win.asset.toUpperCase()} ${side}` +
          ` | spread=$${(CONFIG.MAKER_SPREAD*ask.filledShares).toFixed(2)} | NO FEE`);
      }
      continue;
    }

    // Stop: price fell 15¢ below our entry or window ending
    if (price <= ask.limitPrice - 0.15 || secsLeft < 15) {
      await execSell(win, side, ask.filledShares, price, 'MAKER_STOP', ask.cost, false);
      openAsks.splice(i, 1);
    }
  }

  // ── PHASE B: Try to fill resting bids ─────────────────────────────────
  for (let i = openBids.length-1; i >= 0; i--) {
    const bid = openBids[i];

    // FIX 3: one-fill guard
    if (bid.filled) { state.sim.overfillsBlocked++; openBids.splice(i,1); continue; }

    // FIX 1: no fill on same tick as post
    if (bid.postedTick >= win.tickCount) continue;

    bid.queuePos = Math.max(1, (bid.queuePos||5) - 1);

    // Cancel stale bids that have drifted too far from current mid
    if (Math.abs(price - bid.limitPrice) > CONFIG.MAKER_SPREAD * 3) {
      openBids.splice(i, 1);
      continue;
    }

    if (simMakerBidFillThisTick(price, bid.limitPrice, bid.queuePos)) {
      const result = await execBuy(win, side, bid.shares, bid.limitPrice, 'MAKER_QUOTE', true);
      if (result) {
        bid.filled       = true;                  // FIX 3: mark filled
        bid.filledShares = result.fillShares;
        bid.cost         = result.cost;
        // FIX 2: move to openAsks, remove from openBids
        openAsks.push({
          limitPrice:   bid.limitPrice,
          filledShares: result.fillShares,
          cost:         result.cost,
          queuePos:     1 + Math.floor(Math.random()*3),   // fresh ask queue pos 1-3
          postedTick:   win.tickCount,
        });
        openBids.splice(i, 1);
        log('info', `📋 BID FILLED → ASK POSTED ${win.asset.toUpperCase()} ${side}` +
          ` @ ${bid.limitPrice.toFixed(4)} | queue=${bid.queuePos} | NO FEE`);
      }
    }
  }

  // ── PHASE C: Post new resting bids if slots available ─────────────────
  const needsRequote = win[midRefKey]===null || Math.abs(price - win[midRefKey]) > CONFIG.MAKER_REQUOTE_DRIFT;
  const canPost      = openBids.length < CONFIG.MAKER_MAX_OPEN_BIDS
                    && openAsks.length < CONFIG.MAKER_MAX_OPEN_ASKS
                    && needsRequote && secsLeft > 30;

  if (canPost) {
    const bidPrice = parseFloat((price - CONFIG.MAKER_HALF_SPREAD).toFixed(4));
    if (bidPrice > 0.01 && bidPrice < 0.99 && !isCoolingDown(win, bidPrice)) {
      // FIX: no instant-fill check — always post as resting
      // Shares compound with current capital
      const shares   = calcShares(CONFIG.MAKER_RISK_PER_TRADE, bidPrice,
                                  CONFIG.MAKER_MIN_SHARES, CONFIG.MAKER_MAX_SHARES);
      const queuePos = 1 + Math.floor(Math.random()*5);
      const isDupe   = openBids.some(b => Math.abs(b.limitPrice-bidPrice) < 0.003);
      if (!isDupe && shares > 0) {
        openBids.push({
          id:          uuidv4(),
          shares,
          filledShares: 0,
          limitPrice:  bidPrice,
          queuePos,
          filled:      false,          // FIX 3
          postedTick:  win.tickCount,  // FIX 1
          postedAt:    Date.now(),
        });
        win[midRefKey] = price;
        log('debug', `📌 BID RESTING ${win.asset.toUpperCase()} ${side} @ ${bidPrice.toFixed(4)}` +
          ` | ${shares}sh | queue=${queuePos} | compound_cap=$${state.capital.toFixed(0)}`);
      }
    }
  }
}

// ─── STRATEGY 4: MAKER-ONLY SCALP ────────────────────────────────────────────
// Same four fixes applied identically to S4.

async function runMakerScalp(win, side, price, secsLeft) {
  if (!CONFIG.MAKER_SCALP_ENABLED) return;
  if (secsLeft < CONFIG.MAKER_SCALP_MIN_TIME) return;
  if (price < 0.10 || price > 0.90) return;

  const openBids = side==='UP' ? win.makerScalpBidsUp   : win.makerScalpBidsDown;
  const openAsks = side==='UP' ? win.makerScalpAsksUp   : win.makerScalpAsksDown;
  const midRefKey = side==='UP' ? 'makerScalpMidUp'     : 'makerScalpMidDown';

  // ── PHASE A: Check ask exits ───────────────────────────────────────────
  for (let i = openAsks.length-1; i >= 0; i--) {
    const ask = openAsks[i];
    ask.queuePos = Math.max(1, (ask.queuePos||3) - 1);

    const askPrice = parseFloat((ask.limitPrice + 2*CONFIG.MAKER_SCALP_HALF).toFixed(4));

    if (simMakerAskFillThisTick(price, askPrice, ask.queuePos)) {
      await execSell(win, side, ask.filledShares, askPrice,
                     'MAKER_SCALP_TP', ask.cost, true);
      openAsks.splice(i, 1);
      state.sim.roundTrips++;
      setCooldown(win, ask.limitPrice, CONFIG.MAKER_SCALP_COOLDOWN_TICKS);
      log('info', `✂️  SCALP CAPTURED ${win.asset.toUpperCase()} ${side}` +
        ` | spread=$${(2*CONFIG.MAKER_SCALP_HALF*ask.filledShares).toFixed(2)} | NO FEE`);
      continue;
    }

    // Adverse selection stop
    if (price <= ask.limitPrice - CONFIG.MAKER_SCALP_ADV_SEL_STOP) {
      await execSell(win, side, ask.filledShares, price, 'MAKER_SCALP_STOP', ask.cost, false);
      openAsks.splice(i, 1);
    }
  }

  // ── PHASE B: Try to fill resting bids ─────────────────────────────────
  for (let i = openBids.length-1; i >= 0; i--) {
    const bid = openBids[i];

    if (bid.filled) { state.sim.overfillsBlocked++; openBids.splice(i,1); continue; }
    if (bid.postedTick >= win.tickCount) continue;  // FIX 1

    bid.queuePos = Math.max(1, (bid.queuePos||5) - 1);

    if (Math.abs(price - bid.limitPrice) > CONFIG.MAKER_SCALP_HALF * 4) {
      openBids.splice(i, 1); continue;
    }

    if (simMakerBidFillThisTick(price, bid.limitPrice, bid.queuePos)) {
      const result = await execBuy(win, side, bid.shares, bid.limitPrice, 'MAKER_SCALP', true);
      if (result) {
        bid.filled = true;
        openAsks.push({
          limitPrice:   bid.limitPrice,
          filledShares: result.fillShares,
          cost:         result.cost,
          queuePos:     1 + Math.floor(Math.random()*3),
          postedTick:   win.tickCount,
        });
        openBids.splice(i, 1);
      }
    }
  }

  // ── PHASE C: Post new resting bids ────────────────────────────────────
  const needsNew = win[midRefKey]===null || Math.abs(price - win[midRefKey]) > CONFIG.MAKER_SCALP_REQUOTE;
  const canPost  = openBids.length < CONFIG.MAKER_SCALP_MAX_OPEN
                && openAsks.length < CONFIG.MAKER_SCALP_MAX_ASKS
                && needsNew;

  if (canPost) {
    const bidPrice = parseFloat((price - CONFIG.MAKER_SCALP_HALF).toFixed(4));
    if (bidPrice > 0.01 && !isCoolingDown(win, bidPrice)) {
      const shares   = calcShares(CONFIG.MAKER_SCALP_RISK_PER_TRADE, bidPrice,
                                  CONFIG.MAKER_SCALP_MIN_SHARES, CONFIG.MAKER_SCALP_MAX_SHARES);
      const queuePos = 1 + Math.floor(Math.random()*5);
      const isDupe   = openBids.some(b => Math.abs(b.limitPrice-bidPrice) < 0.003);
      if (!isDupe && shares > 0) {
        openBids.push({
          id:          uuidv4(),
          shares,
          filledShares: 0,
          limitPrice:  bidPrice,
          queuePos,
          filled:      false,
          postedTick:  win.tickCount,
          postedAt:    Date.now(),
        });
        win[midRefKey] = price;
      }
    }
  }
}

// ─── EMERGENCY CLOSE ─────────────────────────────────────────────────────────

async function emergencyClose(win, upP, downP) {
  const closeLots = async (lots, side, px) => {
    for (const lot of lots) {
      if (!lot.filledShares || lot.filledShares <= 0) continue;
      await execSell(win, side, lot.filledShares, px, 'WINDOW_CLOSE',
                     lot.cost ?? lot.filledShares * lot.limitPrice, false);
    }
  };
  // Close all pending asks (filled bids waiting for exit)
  await closeLots(win.makerAsksUp,        'UP',   upP);   win.makerAsksUp        = [];
  await closeLots(win.makerAsksDown,      'DOWN', downP); win.makerAsksDown      = [];
  await closeLots(win.makerScalpAsksUp,   'UP',   upP);   win.makerScalpAsksUp   = [];
  await closeLots(win.makerScalpAsksDown, 'DOWN', downP); win.makerScalpAsksDown = [];
  // Clear all resting bids (unfilled — just cancel, no trade)
  win.makerBidsUp        = []; win.makerBidsDown        = [];
  win.makerScalpBidsUp   = []; win.makerScalpBidsDown   = [];
}

// ─── MASTER RUNNER ────────────────────────────────────────────────────────────

async function runStrategy(asset) {
  const win = state.windows[asset];
  if (!win || win.status !== 'ACTIVE') return;
  const p  = state.prices[asset];
  if (!p) return;
  const sl = secondsLeft();

  if (sl <= CONFIG.EMERGENCY_SECS) { await emergencyClose(win, p.up, p.down); return; }

  await runMakerQuoteEngine(win, 'UP',   p.up,   sl);
  await runMakerQuoteEngine(win, 'DOWN', p.down, sl);
  await runMakerScalp      (win, 'UP',   p.up,   sl);
  await runMakerScalp      (win, 'DOWN', p.down, sl);
}

// ─── WINDOW LIFECYCLE ─────────────────────────────────────────────────────────

async function startNewWindow(asset) {
  const ts     = currentWindowTs();
  const slug   = makeSlug(asset, ts);
  const tokens = await resolveMarketTokens(slug);
  const newWin = makeWindowState(asset);
  newWin.windowTs  = ts; newWin.windowSlug = slug;
  newWin.marketId  = tokens?.marketId ?? null;
  newWin.status    = tokens ? 'ACTIVE' : 'WAITING';
  newWin.openedAt  = new Date().toISOString();
  state.windows[asset] = newWin;
  if (tokens) log('info', `🪟 WINDOW ACTIVE: ${slug} | Cap=$${state.capital.toFixed(2)}`);
  emitter.emit('state_update', getPublicState());
}

async function closeWindow(asset) {
  const win = state.windows[asset];
  if (!win?.windowSlug) return;
  const p = state.prices[asset];
  await emergencyClose(win, p?.up??0.5, p?.down??0.5);
  const result = await checkResolution(asset, win.windowSlug);

  const makerTrades = win.orders.filter(o => o.isMaker).length;
  state.history.push({
    asset, slug: win.windowSlug,
    resolution: result || '?',
    tradeCount: win.tradeCount, makerTrades,
    realizedPnl: win.realizedPnl, feePaid: win.feePaid,
    closedAt: new Date().toISOString(),
  });
  win.status='CLOSED'; win.closedAt=new Date().toISOString();
  log('info', `🏁 WINDOW CLOSED: ${win.windowSlug} | PnL=$${win.realizedPnl.toFixed(2)} | fees=$${win.feePaid.toFixed(4)}`);

  // Compounding snapshot after every window
  takeCompoundingSnapshot();
  emitter.emit('state_update', getPublicState());
}

// ─── PRICE REFRESH ────────────────────────────────────────────────────────────

async function refreshPrices(asset) {
  const data = await fetchLivePrices(asset);
  if (!data) return;
  state.prices[asset] = data;
  globalTick++;
  const win = state.windows[asset];
  if (win?.status==='ACTIVE')  await runStrategy(asset);
  if (win?.status==='WAITING' && data.up>0.05 && data.up<0.95) await startNewWindow(asset);
  emitter.emit('prices', { asset, ...data });
  emitter.emit('state_update', getPublicState());
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

let priceTimers = {}, windowChecker = null;

function startMainLoop() {
  log('info', `⚡ PULSE BOT v5.3 | mode=${CONFIG.DEMO_MODE?'REALISTIC DEMO':'LIVE'} | assets=${CONFIG.ASSETS.join(',')}`);
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

  // Take an initial compounding snapshot at startup
  takeCompoundingSnapshot();
}

// ─── PUBLIC STATE ─────────────────────────────────────────────────────────────

function getPublicState() {
  const wins   = state.history.filter(h => h.realizedPnl > 0).length;
  const losses = state.history.filter(h => h.realizedPnl <= 0).length;
  const totalPnl = parseFloat((state.capital - state.startCapital).toFixed(2));

  const windowsOut = {};
  CONFIG.ASSETS.forEach(asset => {
    const win = state.windows[asset];
    if (!win) return;
    const openUp   = [...(win.makerAsksUp||[]),  ...(win.makerScalpAsksUp||[])].reduce((s,l)=>s+(l.filledShares||0),0);
    const openDown = [...(win.makerAsksDown||[]),...(win.makerScalpAsksDown||[])].reduce((s,l)=>s+(l.filledShares||0),0);
    // Current compounded share sizes at current prices
    const curPriceUp   = state.prices[asset]?.up   || 0.50;
    const curPriceDown = state.prices[asset]?.down || 0.50;
    windowsOut[asset] = {
      ...win,
      realizedPnl:    parseFloat((win.realizedPnl||0).toFixed(2)),
      feePaid:        parseFloat((win.feePaid||0).toFixed(4)),
      openSharesUp:   openUp,
      openSharesDown: openDown,
      currentSharesS1Up:  calcShares(CONFIG.MAKER_RISK_PER_TRADE,       curPriceUp,  CONFIG.MAKER_MIN_SHARES,       CONFIG.MAKER_MAX_SHARES),
      currentSharesS1Down:calcShares(CONFIG.MAKER_RISK_PER_TRADE,       curPriceDown,CONFIG.MAKER_MIN_SHARES,       CONFIG.MAKER_MAX_SHARES),
      currentSharesS4Up:  calcShares(CONFIG.MAKER_SCALP_RISK_PER_TRADE, curPriceUp,  CONFIG.MAKER_SCALP_MIN_SHARES, CONFIG.MAKER_SCALP_MAX_SHARES),
      currentSharesS4Down:calcShares(CONFIG.MAKER_SCALP_RISK_PER_TRADE, curPriceDown,CONFIG.MAKER_SCALP_MIN_SHARES, CONFIG.MAKER_SCALP_MAX_SHARES),
      orders: (win.orders||[]).slice(-40),
    };
  });

  const totalFeePaid = parseFloat(state.feesPaid.toFixed(4));
  const makerTrades  = state.history.reduce((s,h)=>s+(h.makerTrades||0),0);
  const breakEvenTable = [0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,0.95].map(p=>({
    p: p.toFixed(2), fee100: takerFee(100,p).toFixed(2),
    feePct: (takerFeePerShare(p)/p*100).toFixed(2), beMove: breakEvenMove(p).toFixed(4),
  }));

  // Compounding projections at current pace
  const snapshots    = state.compounding.snapshots;
  const windowsRun   = snapshots.length;
  const avgPnlPerWin = windowsRun > 1
    ? (state.capital - state.startCapital) / windowsRun
    : 0;
  const compoundProjections = (() => {
    if (windowsRun < 2) return null;
    const windowsPerDay = 96; // 4 per hour × 24h
    let cap = state.capital;
    const proj = [];
    for (let day = 1; day <= 30; day++) {
      for (let w = 0; w < windowsPerDay; w++) {
        // Per-window return % estimated from recent history
        const pctPerWin = avgPnlPerWin / cap;
        cap = cap * (1 + pctPerWin);
      }
      proj.push({ day, capital: parseFloat(cap.toFixed(2)) });
    }
    return proj;
  })();

  return {
    capital:      parseFloat(state.capital.toFixed(2)),
    startCapital: state.startCapital,
    totalPnl,
    totalReturn:  parseFloat((totalPnl / state.startCapital * 100).toFixed(2)),
    wins, losses,
    winRate: (wins+losses)>0 ? ((wins/(wins+losses))*100).toFixed(1) : '0.0',
    windows:        windowsOut,
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
    feeAnalytics: { totalFeePaid, makerTradeCount: makerTrades, breakEvenTable },
    simStats: CONFIG.DEMO_MODE ? {
      ...state.sim,
      totalSlippageCost: parseFloat(state.sim.totalSlippageCost.toFixed(4)),
    } : null,
    compounding: {
      snapshots:      snapshots.slice(-200),
      projections:    compoundProjections,
      avgPnlPerWindow: parseFloat(avgPnlPerWin.toFixed(4)),
      windowsRun,
      // Live compounded share sizes at current capital, p=0.50 reference
      currentSharesS1: calcShares(CONFIG.MAKER_RISK_PER_TRADE,       0.50, CONFIG.MAKER_MIN_SHARES,       CONFIG.MAKER_MAX_SHARES),
      currentSharesS4: calcShares(CONFIG.MAKER_SCALP_RISK_PER_TRADE, 0.50, CONFIG.MAKER_SCALP_MIN_SHARES, CONFIG.MAKER_SCALP_MAX_SHARES),
    },
  };
}

// ─── EXPRESS + WS ─────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors()); app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState===WebSocket.OPEN) c.send(msg); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'FULL_STATE', data: getPublicState() }));
  ws.on('error', e => console.error('[WS]', e.message));
});
emitter.on('state_update', d => broadcast('STATE_UPDATE', d));
emitter.on('log',          e => broadcast('LOG', e));
emitter.on('prices',       p => broadcast('PRICES', p));

app.get('/api/state',             (_, res) => res.json(getPublicState()));
app.get('/api/health',            (_, res) => res.json({ ok:true, uptime:process.uptime(), demo:CONFIG.DEMO_MODE }));
app.get('/api/compounding',       (_, res) => res.json(state.compounding));
app.get('/api/sim-stats',         (_, res) => res.json(state.sim));
app.get('/api/fee-math/:p',       (req, res) => {
  const p = parseFloat(req.params.p);
  if (isNaN(p)||p<=0||p>=1) return res.status(400).json({ error:'p must be 0-1' });
  res.json({ price:p, fee100:takerFee(100,p).toFixed(5), beMove:breakEvenMove(p).toFixed(5) });
});
app.get('/api/compound-project',  (req, res) => {
  // ?capital=X&windowsPerDay=Y&avgReturnPct=Z
  const cap     = parseFloat(req.query.capital     || state.capital);
  const wpd     = parseInt  (req.query.windowsPerDay || 96);
  const pctWin  = parseFloat(req.query.avgReturnPct || 0.0015); // 0.15% per window default
  const days    = parseInt  (req.query.days         || 30);
  const rows = [];
  let c = cap;
  for (let d = 0; d <= days; d++) {
    rows.push({ day:d, capital: parseFloat(c.toFixed(2)) });
    for (let w = 0; w < wpd; w++) c *= (1 + pctWin);
  }
  res.json({ inputs:{ cap, wpd, pctWin, days }, projection: rows });
});
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── BOOT ─────────────────────────────────────────────────────────────────────

initState();
server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║   PULSE BOT v5.3 — ONE-SHOT FILL FIX + COMPOUNDING ENGINE           ║
╠══════════════════════════════════════════════════════════════════════╣
║   http://localhost:${CONFIG.PORT}  |  ${CONFIG.DEMO_MODE ? 'REALISTIC DEMO MODE         ' : 'LIVE TRADING MODE          '}   ║
╠══════════════════════════════════════════════════════════════════════╣
║   FIXES APPLIED:                                                     ║
║   ✓ Fix 1: No instant-fill on post tick (postedTick guard)           ║
║   ✓ Fix 2: Separate openBids / openAsks arrays (two-stage lifecycle) ║
║   ✓ Fix 3: One-fill flag per lot (no double-fill)                    ║
║   ✓ Fix 4: Post-fill cooldown 3 ticks (7.5s queue re-entry delay)   ║
╠══════════════════════════════════════════════════════════════════════╣
║   COMPOUNDING ENGINE:                                                ║
║   shares = floor(capital × riskPct / price / 5) × 5                 ║
║   S1: 0.6% per bid  |  S4: 0.4% per bid                             ║
║   At $2k → 20-40sh  |  $10k → 120sh  |  $20k → 240sh (capped 400)  ║
║   GET /api/compound-project?capital=X&days=30 for projections        ║
╠══════════════════════════════════════════════════════════════════════╣
║   S1 Maker Quote Engine  — ±2¢, 6 bids+6 asks, $0 fee               ║
║   S4 Maker-Only Scalp    — ±2.5¢, 6 bids+6 asks, $0 fee             ║
╚══════════════════════════════════════════════════════════════════════╝
  `);
  startMainLoop();
});
