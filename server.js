'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET MARKET MAKER BOT — DEMO MODE  v2.0
//
//  PRICE ENGINE: Real Polymarket APIs, zero auth required
//  ─────────────────────────────────────────────────────────────────────────────
//  Step 1: Slug built deterministically from timestamp
//          btc-updown-15m-{floor(unixTs/900)*900}
//
//  Step 2: GET gamma-api.polymarket.com/markets?slug=...
//          → outcomes[] + clobTokenIds[]
//          → map "Up"→upTokenId, "Down"→downTokenId  (exact strings from API)
//
//  Step 3: GET clob.polymarket.com/midpoint?token_id=upTokenId   → up mid
//          GET clob.polymarket.com/midpoint?token_id=downTokenId → down mid
//          Both are REAL live order-book prices. Called every 2.5s.
//
//  Step 4: GET clob.polymarket.com/book?token_id=... for full depth display
//
//  STRATEGY:
//  ─────────────────────────────────────────────────────────────────────────────
//  S1 MAKER QUOTE  ±2¢ spread, 0.6%/bid, 6+6 slots per side (UP + DOWN)
//  S4 MAKER SCALP  ±2.5¢ spread, 0.4%/bid, 6+6 slots per side (UP + DOWN)
//  Both sides (UP and DOWN) quoted simultaneously — captures spread on any move.
//  Zero fees as maker. Rebate ~20% of taker fee on each bid fill.
//  Emergency close at T-10s. Stop-loss at 6¢ below entry.
//
//  FEE: taker = 0.07 × shares × p × (1-p) | maker = $0.00
// ═══════════════════════════════════════════════════════════════════════════════

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const axios        = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const path         = require('path');
const cors         = require('cors');

// ─── APIS ─────────────────────────────────────────────────────────────────────
const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL  = 'https://clob.polymarket.com';

// ─── FEE MATH ─────────────────────────────────────────────────────────────────
function takerFeePerShare(p) { return 0.07 * p * (1 - p); }
function takerFee(shares, p) { return shares * takerFeePerShare(p); }
function breakEvenMove(p)    { return (2*0.07*p*(1-p)) / (1 - 0.07*(1-2*p)); }

// ─── FILL SIMULATION ──────────────────────────────────────────────────────────
// Realistic CLOB fill model from your original script
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
function poissonRandom(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}
function simTakerFillPrice(mid, isBuy) {
  const ticks = poissonRandom(0.6);
  return isBuy ? mid + ticks*0.005 : mid - ticks*0.005;
}

// ─── POSITION SIZER ───────────────────────────────────────────────────────────
function calcShares(riskFraction, price, minShares, maxShares) {
  const safeCap = Math.max(0, state.settledCapital || state.capital);
  const raw     = (safeCap * riskFraction) / Math.max(price, 0.05);
  return Math.min(maxShares, Math.max(minShares, Math.floor(raw / 5) * 5));
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  DEMO_CAPITAL:    parseFloat(process.env.DEMO_CAPITAL || '2000'),
  PORT:            parseInt(process.env.PORT || '3000'),
  ASSETS:          (process.env.ASSETS || 'btc,eth,sol').split(','),
  WINDOW_SEC:      900,
  PRICE_REFRESH_MS: 2500,

  // S1: Maker Quote Engine  ±2¢
  MAKER_SPREAD:         0.04,
  MAKER_HALF:           0.02,
  MAKER_RISK:           0.006,
  MAKER_MIN_SH:         20,
  MAKER_MAX_SH:         400,
  MAKER_MAX_BIDS:       6,
  MAKER_MAX_ASKS:       6,
  MAKER_REQUOTE_DRIFT:  0.015,
  MAKER_COOLDOWN:       3,
  MAKER_STOP:           0.06,

  // S4: Maker Scalp  ±2.5¢
  SCALP_HALF:           0.025,
  SCALP_RISK:           0.004,
  SCALP_MIN_SH:         15,
  SCALP_MAX_SH:         300,
  SCALP_MAX_BIDS:       6,
  SCALP_MAX_ASKS:       6,
  SCALP_REQUOTE:        0.020,
  SCALP_STOP:           0.06,
  SCALP_COOLDOWN:       3,
  SCALP_MIN_SECS:       45,

  EMERGENCY_SECS:      10,
  WIN_THRESHOLD:       0.97,
  REBATE_RATE:         0.20,
};

// ─── CAPITAL MUTEX ────────────────────────────────────────────────────────────
let _capitalQueue = Promise.resolve();
function adjustCapital(delta) {
  _capitalQueue = _capitalQueue.then(() => {
    state.capital        = parseFloat((state.capital + delta).toFixed(6));
    if (state.capital < 0) state.capital = 0;
    state.settledCapital = state.capital;
  });
  return _capitalQueue;
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  capital: 0, startCapital: 0, settledCapital: 0,
  windows: {}, prices: {}, lastResolution: {}, lastResBySlug: {},
  history: [], logs: [],
  feesPaid: 0, rebatesEarned: 0, liqRewards: 0,
  roundTrips: 0, overfillsBlocked: 0,
  equity: [],   // [{ts, capital}]
};

function makeWindowState(asset) {
  return {
    asset, windowTs: null, windowSlug: null, marketId: null,
    status: 'WAITING',
    // S1 — separate bid/ask arrays per side
    makerBidsUp: [],   makerAsksUp:   [],
    makerBidsDown: [], makerAsksDown: [],
    // S4
    scalpBidsUp: [],   scalpAsksUp:   [],
    scalpBidsDown: [], scalpAsksDown: [],
    // Quote tracking
    makerMidUp: null, makerMidDown: null,
    scalpMidUp: null, scalpMidDown: null,
    // Cooldowns: priceKey → ticks remaining
    bidCooldowns: {},
    tickCount: 0,
    realizedPnl: 0, feePaid: 0, tradeCount: 0,
    rebates: 0,
    orders: [],
  };
}

function initState() {
  state.capital = state.startCapital = state.settledCapital = CONFIG.DEMO_CAPITAL;
  CONFIG.ASSETS.forEach(a => {
    state.windows[a]        = makeWindowState(a);
    state.prices[a]         = null;
    state.lastResolution[a] = null;
  });
  state.equity.push({ ts: Date.now(), capital: CONFIG.DEMO_CAPITAL });
}

let globalTick = 0, globalOrderSeq = 0;
const emitter = new EventEmitter();
emitter.setMaxListeners(500);

// ─── LOGGING ─────────────────────────────────────────────────────────────────
function log(level, msg) {
  const entry = { id: uuidv4(), ts: Date.now(), level, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 500) state.logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`);
  emitter.emit('log', entry);
}

// ─── TIME ─────────────────────────────────────────────────────────────────────
function currentWindowTs()   { return Math.floor(Math.floor(Date.now()/1000)/900)*900; }
function secondsIntoWindow() { return Math.floor(Date.now()/1000) - currentWindowTs(); }
function secondsLeft()       { return CONFIG.WINDOW_SEC - secondsIntoWindow(); }
function makeSlug(asset, ts) { return `${asset}-updown-15m-${ts}`; }

// ─── MARKET DISCOVERY ─────────────────────────────────────────────────────────
// Exact approach from your working script:
// GET /markets?slug=btc-updown-15m-{ts}
// → outcomes[] + clobTokenIds[] → map by "Up"/"Down" label

const tokenCache = {};

async function resolveMarketTokens(slug) {
  if (tokenCache[slug]) return tokenCache[slug];
  try {
    const res  = await axios.get(`${GAMMA_URL}/markets`, { params: { slug }, timeout: 8000 });
    const list = Array.isArray(res.data) ? res.data : [res.data];
    const mkt  = list.find(m => m && m.slug === slug);
    if (!mkt) { log('warn', `Market not found yet: ${slug}`); return null; }

    const outcomes = typeof mkt.outcomes     === 'string' ? JSON.parse(mkt.outcomes)     : (mkt.outcomes     || []);
    const tokenIds = typeof mkt.clobTokenIds === 'string' ? JSON.parse(mkt.clobTokenIds) : (mkt.clobTokenIds || []);

    // Map by label: "Up" → tokenIds[i], "Down" → tokenIds[i]
    let upTokenId = null, downTokenId = null;
    outcomes.forEach((o, i) => {
      const n = (o || '').toLowerCase();
      if (n === 'up')   upTokenId   = tokenIds[i];
      if (n === 'down') downTokenId = tokenIds[i];
    });
    // Fallback: index 0 = UP, 1 = DOWN
    if (!upTokenId   && tokenIds[0]) upTokenId   = tokenIds[0];
    if (!downTokenId && tokenIds[1]) downTokenId = tokenIds[1];

    const result = { upTokenId, downTokenId, marketId: mkt.id || mkt.conditionId, closed: !!mkt.closed, resolved: !!mkt.resolved };
    tokenCache[slug] = result;
    log('info', `✅ TOKENS: ${slug} | up=${upTokenId?.slice(0,12)}... down=${downTokenId?.slice(0,12)}...`);
    return result;
  } catch (err) {
    log('error', `resolveMarketTokens(${slug}): ${err.message}`);
    return null;
  }
}

// ─── LIVE PRICE FETCH ─────────────────────────────────────────────────────────
// Uses /midpoint for the live mid price and /book for depth display

async function fetchLivePrices(asset) {
  const slug   = makeSlug(asset, currentWindowTs());
  const tokens = await resolveMarketTokens(slug);
  if (!tokens?.upTokenId) return null;

  try {
    const [upR, dnR] = await Promise.all([
      axios.get(`${CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId   }, timeout: 5000 }),
      axios.get(`${CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
    ]);
    const up   = parseFloat(upR.data.mid);
    const down = parseFloat(dnR.data.mid);
    if (isNaN(up) || isNaN(down)) return null;
    return { slug, marketId: tokens.marketId, up, down, live: true };
  } catch (err) {
    log('error', `fetchLivePrices(${asset}): ${err.message}`);
    return null;
  }
}

// Fetch full book for depth display — called separately, slower
async function fetchBookDepth(tokenId) {
  try {
    const res = await axios.get(`${CLOB_URL}/book`, { params: { token_id: tokenId }, timeout: 5000 });
    return res.data;
  } catch { return null; }
}

// ─── EXECUTION ────────────────────────────────────────────────────────────────
async function execBuy(win, side, shares, requestedPrice, type, isMaker) {
  const curP     = side === 'UP' ? state.prices[win.asset]?.up : state.prices[win.asset]?.down;
  const fillPrice  = isMaker ? requestedPrice : simTakerFillPrice(curP ?? requestedPrice, true);
  const fillShares = simPartialFill(shares, !isMaker);
  if (fillShares <= 0) return null;

  const fee  = isMaker ? 0 : takerFee(fillShares, fillPrice);
  const cost = fillShares * fillPrice + fee;
  await adjustCapital(-cost);

  // Rebate fires on BUY fill (maker resting order hit by taker)
  const rebate = isMaker ? takerFee(fillShares, fillPrice) * CONFIG.REBATE_RATE : 0;
  if (rebate > 0) {
    win.rebates += rebate;
    state.rebatesEarned += rebate;
  }

  win.feePaid += fee; state.feesPaid += fee; win.tradeCount++; globalOrderSeq++;
  win.orders.push({ id: uuidv4(), seq: globalOrderSeq, side, type, action: 'BUY',
    shares: fillShares, price: fillPrice, fee, cost, isMaker, time: Date.now() });

  log('trade', `🟢 BUY [${type}] ${win.asset.toUpperCase()} ${side} +${fillShares}sh @ ${fillPrice.toFixed(4)} | ${isMaker?'MAKER $0':(`fee=$${fee.toFixed(3)}`)} | cap=$${state.capital.toFixed(2)}`);
  emitter.emit('state_update', getPublicState());
  return { fillPrice, fillShares, cost };
}

async function execSell(win, side, shares, requestedPrice, type, costBasis, isMaker) {
  const curP      = side === 'UP' ? state.prices[win.asset]?.up : state.prices[win.asset]?.down;
  const fillPrice  = isMaker ? requestedPrice : simTakerFillPrice(curP ?? requestedPrice, false);
  const fillShares = Math.min(shares, simPartialFill(shares, !isMaker));
  if (fillShares <= 0) return false;

  const fee      = isMaker ? 0 : takerFee(fillShares, fillPrice);
  const proceeds = fillShares * fillPrice - fee;
  const scaled   = costBasis * (fillShares / shares);
  const pnl      = proceeds - scaled;
  await adjustCapital(proceeds);

  win.realizedPnl += pnl; win.feePaid += fee; state.feesPaid += fee;
  win.tradeCount++; globalOrderSeq++;
  win.orders.push({ id: uuidv4(), seq: globalOrderSeq, side, type, action: 'SELL',
    shares: fillShares, price: fillPrice, fee, proceeds, pnl, isMaker, time: Date.now() });

  log('trade', `${pnl>=0?'💚':'🔻'} SELL [${type}] ${win.asset.toUpperCase()} ${side} -${fillShares}sh @ ${fillPrice.toFixed(4)} | pnl=${pnl>=0?'+':''}$${pnl.toFixed(3)} | cap=$${state.capital.toFixed(2)}`);
  state.roundTrips++;
  emitter.emit('state_update', getPublicState());
  return true;
}

// ─── COOLDOWN HELPERS ─────────────────────────────────────────────────────────
function priceKey(p)          { return p.toFixed(4); }
function isCooling(win, p)    { return (win.bidCooldowns[priceKey(p)] || 0) > 0; }
function setCooldown(win, p, ticks) { win.bidCooldowns[priceKey(p)] = ticks; }
function tickCooldowns(win) {
  for (const k of Object.keys(win.bidCooldowns)) {
    if (--win.bidCooldowns[k] <= 0) delete win.bidCooldowns[k];
  }
}

// ─── S1: MAKER QUOTE ENGINE ──────────────────────────────────────────────────
async function runMakerQuote(win, side, price, secsLeft) {
  if (secsLeft < CONFIG.EMERGENCY_SECS + 5) return;

  const openBids  = side==='UP' ? win.makerBidsUp   : win.makerBidsDown;
  const openAsks  = side==='UP' ? win.makerAsksUp   : win.makerAsksDown;
  const midRefKey = side==='UP' ? 'makerMidUp'      : 'makerMidDown';

  win.tickCount++;
  tickCooldowns(win);

  // PHASE A: try to exit filled bids (ask leg)
  for (let i = openAsks.length - 1; i >= 0; i--) {
    const ask      = openAsks[i];
    ask.queuePos   = Math.max(1, (ask.queuePos || 3) - 1);
    const askPrice = parseFloat((ask.limitPrice + CONFIG.MAKER_SPREAD).toFixed(4));

    if (simMakerAskFillThisTick(price, askPrice, ask.queuePos)) {
      const ok = await execSell(win, side, ask.filledShares, askPrice, 'S1_TP', ask.cost, true);
      if (ok) {
        openAsks.splice(i, 1);
        setCooldown(win, ask.limitPrice, CONFIG.MAKER_COOLDOWN);
        log('info', `✅ S1 SPREAD CAPTURED ${win.asset.toUpperCase()} ${side} | $${(CONFIG.MAKER_SPREAD * ask.filledShares).toFixed(2)} | ZERO FEE`);
      }
      continue;
    }
    // Stop-loss: price 6¢ below entry or expiry
    if (price <= ask.limitPrice - CONFIG.MAKER_STOP || secsLeft < 15) {
      await execSell(win, side, ask.filledShares, price, 'S1_STOP', ask.cost, false);
      openAsks.splice(i, 1);
    }
  }

  // PHASE B: check fill on resting bids
  for (let i = openBids.length - 1; i >= 0; i--) {
    const bid = openBids[i];
    if (bid.filled) { state.overfillsBlocked++; openBids.splice(i, 1); continue; }
    if (bid.postedTick >= win.tickCount) continue;  // no same-tick fill
    bid.queuePos = Math.max(1, (bid.queuePos || 5) - 1);

    // Cancel if drifted too far
    if (Math.abs(price - bid.limitPrice) > CONFIG.MAKER_SPREAD * 3) { openBids.splice(i, 1); continue; }

    if (simMakerBidFillThisTick(price, bid.limitPrice, bid.queuePos)) {
      const result = await execBuy(win, side, bid.shares, bid.limitPrice, 'S1_BID', true);
      if (result) {
        bid.filled = true; bid.filledShares = result.fillShares; bid.cost = result.cost;
        openAsks.push({ limitPrice: bid.limitPrice, filledShares: result.fillShares,
          cost: result.cost, queuePos: 1 + Math.floor(Math.random()*3), postedTick: win.tickCount });
        openBids.splice(i, 1);
        log('info', `📋 S1 BID FILLED→ASK ${win.asset.toUpperCase()} ${side} @ ${bid.limitPrice.toFixed(4)}`);
      }
    }
  }

  // PHASE C: post new resting bid if slot available
  const needsQuote = win[midRefKey] === null || Math.abs(price - win[midRefKey]) > CONFIG.MAKER_REQUOTE_DRIFT;
  const canPost    = openBids.length < CONFIG.MAKER_MAX_BIDS && openAsks.length < CONFIG.MAKER_MAX_ASKS && needsQuote && secsLeft > 30;

  if (canPost) {
    const bidPrice = parseFloat((price - CONFIG.MAKER_HALF).toFixed(4));
    if (bidPrice > 0.01 && bidPrice < 0.99 && !isCooling(win, bidPrice)) {
      const shares  = calcShares(CONFIG.MAKER_RISK, bidPrice, CONFIG.MAKER_MIN_SH, CONFIG.MAKER_MAX_SH);
      const isDupe  = openBids.some(b => Math.abs(b.limitPrice - bidPrice) < 0.003);
      if (!isDupe && shares > 0) {
        openBids.push({ id: uuidv4(), shares, filledShares: 0, limitPrice: bidPrice,
          queuePos: 1 + Math.floor(Math.random()*5), filled: false, postedTick: win.tickCount, postedAt: Date.now() });
        win[midRefKey] = price;
        log('info', `📌 S1 BID REST ${win.asset.toUpperCase()} ${side} @ ${bidPrice.toFixed(4)} | ${shares}sh | mid=${price.toFixed(4)}`);
      }
    }
  }
}

// ─── S4: MAKER SCALP ENGINE ───────────────────────────────────────────────────
async function runMakerScalp(win, side, price, secsLeft) {
  if (secsLeft < CONFIG.SCALP_MIN_SECS) return;
  if (price < 0.10 || price > 0.90) return;

  const openBids  = side==='UP' ? win.scalpBidsUp   : win.scalpBidsDown;
  const openAsks  = side==='UP' ? win.scalpAsksUp   : win.scalpAsksDown;
  const midRefKey = side==='UP' ? 'scalpMidUp'      : 'scalpMidDown';

  // PHASE A: exit
  for (let i = openAsks.length - 1; i >= 0; i--) {
    const ask      = openAsks[i];
    ask.queuePos   = Math.max(1, (ask.queuePos || 3) - 1);
    const askPrice = parseFloat((ask.limitPrice + 2 * CONFIG.SCALP_HALF).toFixed(4));

    if (simMakerAskFillThisTick(price, askPrice, ask.queuePos)) {
      await execSell(win, side, ask.filledShares, askPrice, 'S4_TP', ask.cost, true);
      openAsks.splice(i, 1);
      setCooldown(win, ask.limitPrice, CONFIG.SCALP_COOLDOWN);
      log('info', `✂️  S4 SCALP CAPTURED ${win.asset.toUpperCase()} ${side} | ZERO FEE`);
      continue;
    }
    if (price <= ask.limitPrice - CONFIG.SCALP_STOP) {
      await execSell(win, side, ask.filledShares, price, 'S4_STOP', ask.cost, false);
      openAsks.splice(i, 1);
    }
  }

  // PHASE B: fill resting bids
  for (let i = openBids.length - 1; i >= 0; i--) {
    const bid = openBids[i];
    if (bid.filled) { openBids.splice(i, 1); continue; }
    if (bid.postedTick >= win.tickCount) continue;
    bid.queuePos = Math.max(1, (bid.queuePos || 5) - 1);
    if (Math.abs(price - bid.limitPrice) > CONFIG.SCALP_HALF * 4) { openBids.splice(i, 1); continue; }

    if (simMakerBidFillThisTick(price, bid.limitPrice, bid.queuePos)) {
      const result = await execBuy(win, side, bid.shares, bid.limitPrice, 'S4_BID', true);
      if (result) {
        bid.filled = true;
        openAsks.push({ limitPrice: bid.limitPrice, filledShares: result.fillShares,
          cost: result.cost, queuePos: 1 + Math.floor(Math.random()*3), postedTick: win.tickCount });
        openBids.splice(i, 1);
      }
    }
  }

  // PHASE C: post
  const needsNew = win[midRefKey] === null || Math.abs(price - win[midRefKey]) > CONFIG.SCALP_REQUOTE;
  const canPost  = openBids.length < CONFIG.SCALP_MAX_BIDS && openAsks.length < CONFIG.SCALP_MAX_ASKS && needsNew;

  if (canPost) {
    const bidPrice = parseFloat((price - CONFIG.SCALP_HALF).toFixed(4));
    if (bidPrice > 0.01 && !isCooling(win, bidPrice)) {
      const shares = calcShares(CONFIG.SCALP_RISK, bidPrice, CONFIG.SCALP_MIN_SH, CONFIG.SCALP_MAX_SH);
      const isDupe = openBids.some(b => Math.abs(b.limitPrice - bidPrice) < 0.003);
      if (!isDupe && shares > 0) {
        openBids.push({ id: uuidv4(), shares, filledShares: 0, limitPrice: bidPrice,
          queuePos: 1 + Math.floor(Math.random()*5), filled: false, postedTick: win.tickCount, postedAt: Date.now() });
        win[midRefKey] = price;
      }
    }
  }
}

// ─── EMERGENCY CLOSE ──────────────────────────────────────────────────────────
async function emergencyClose(win, upP, downP) {
  const closeLots = async (lots, side, px) => {
    for (const lot of lots) {
      if (!lot.filledShares || lot.filledShares <= 0) continue;
      await execSell(win, side, lot.filledShares, px, 'EMERGENCY', lot.cost ?? lot.filledShares * lot.limitPrice, false);
    }
  };
  await closeLots(win.makerAsksUp,   'UP',   upP);   win.makerAsksUp   = [];
  await closeLots(win.makerAsksDown, 'DOWN', downP); win.makerAsksDown = [];
  await closeLots(win.scalpAsksUp,   'UP',   upP);   win.scalpAsksUp   = [];
  await closeLots(win.scalpAsksDown, 'DOWN', downP); win.scalpAsksDown = [];
  win.makerBidsUp = []; win.makerBidsDown = [];
  win.scalpBidsUp = []; win.scalpBidsDown = [];
}

// ─── STRATEGY RUNNER ──────────────────────────────────────────────────────────
async function runStrategy(asset) {
  const win = state.windows[asset];
  if (!win || win.status !== 'ACTIVE') return;
  const p  = state.prices[asset];
  if (!p) return;
  const sl = secondsLeft();

  if (sl <= CONFIG.EMERGENCY_SECS) { await emergencyClose(win, p.up, p.down); return; }

  // Quote both sides simultaneously
  await runMakerQuote(win, 'UP',   p.up,   sl);
  await runMakerQuote(win, 'DOWN', p.down, sl);
  await runMakerScalp(win, 'UP',   p.up,   sl);
  await runMakerScalp(win, 'DOWN', p.down, sl);
}

// ─── WINDOW LIFECYCLE ─────────────────────────────────────────────────────────
async function startNewWindow(asset) {
  const ts     = currentWindowTs();
  const slug   = makeSlug(asset, ts);
  const tokens = await resolveMarketTokens(slug);
  const newWin = makeWindowState(asset);
  newWin.windowTs   = ts;
  newWin.windowSlug = slug;
  newWin.marketId   = tokens?.marketId ?? null;
  newWin.status     = tokens ? 'ACTIVE' : 'WAITING';
  state.windows[asset] = newWin;
  if (tokens) log('info', `🪟 WINDOW ACTIVE: ${slug} | cap=$${state.capital.toFixed(2)}`);
}

async function closeWindow(asset) {
  const win = state.windows[asset];
  if (!win?.windowSlug) return;
  const p = state.prices[asset];
  await emergencyClose(win, p?.up ?? 0.5, p?.down ?? 0.5);

  state.history.push({
    asset, slug: win.windowSlug,
    realizedPnl: win.realizedPnl, feePaid: win.feePaid,
    tradeCount: win.tradeCount, rebates: win.rebates,
    closedAt: Date.now(),
  });
  if (state.history.length > 200) state.history.shift();

  win.status = 'CLOSED';
  state.equity.push({ ts: Date.now(), capital: state.settledCapital });
  if (state.equity.length > 500) state.equity.shift();
  log('info', `🏁 CLOSED: ${win.windowSlug} | PnL=$${win.realizedPnl.toFixed(2)}`);
  emitter.emit('state_update', getPublicState());
}

// ─── PRICE REFRESH (called every 2.5s per asset) ──────────────────────────────
async function refreshPrices(asset) {
  const data = await fetchLivePrices(asset);
  if (!data) return;

  state.prices[asset] = data;
  globalTick++;

  const win = state.windows[asset];
  if (win?.status === 'ACTIVE')  await runStrategy(asset);
  if (win?.status === 'WAITING' && data.up > 0.05 && data.up < 0.95) await startNewWindow(asset);

  emitter.emit('prices', { asset, ...data });
  emitter.emit('state_update', getPublicState());
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
let priceTimers = {}, windowChecker = null;

function startMainLoop() {
  log('info', `🚀 MM Bot v2.0 | cap=$${CONFIG.DEMO_CAPITAL} | assets=${CONFIG.ASSETS.join(',')}`);
  log('info', `📡 Prices: gamma-api.polymarket.com + clob.polymarket.com/midpoint`);
  log('info', `📐 S1 ±2¢ 0.6%/bid | S4 ±2.5¢ 0.4%/bid | Both UP+DOWN sides`);

  CONFIG.ASSETS.forEach(asset => {
    clearInterval(priceTimers[asset]);
    priceTimers[asset] = setInterval(() => refreshPrices(asset), CONFIG.PRICE_REFRESH_MS);
    refreshPrices(asset);  // immediate first fetch
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
function getPublicState() {
  const displayCap = parseFloat((state.settledCapital || state.capital).toFixed(2));
  const totalPnl   = parseFloat((displayCap - state.startCapital).toFixed(2));
  const wins       = state.history.filter(h => h.realizedPnl > 0).length;
  const losses     = state.history.filter(h => h.realizedPnl < 0).length;

  const windowsOut = {};
  CONFIG.ASSETS.forEach(asset => {
    const win = state.windows[asset];
    if (!win) return;
    const p   = state.prices[asset];
    const openSharesUp   = [...(win.makerAsksUp  || []), ...(win.scalpAsksUp  || [])].reduce((s,l)=>s+(l.filledShares||0),0);
    const openSharesDown = [...(win.makerAsksDown || []), ...(win.scalpAsksDown|| [])].reduce((s,l)=>s+(l.filledShares||0),0);

    windowsOut[asset] = {
      status:        win.status,
      windowSlug:    win.windowSlug,
      windowTs:      win.windowTs,
      realizedPnl:   parseFloat((win.realizedPnl||0).toFixed(3)),
      feePaid:       parseFloat((win.feePaid||0).toFixed(4)),
      rebates:       parseFloat((win.rebates||0).toFixed(4)),
      tradeCount:    win.tradeCount,
      openBidsUp:    (win.makerBidsUp.length + win.scalpBidsUp.length),
      openBidsDown:  (win.makerBidsDown.length + win.scalpBidsDown.length),
      openAsksUp:    (win.makerAsksUp.length + win.scalpAsksUp.length),
      openAsksDown:  (win.makerAsksDown.length + win.scalpAsksDown.length),
      openSharesUp, openSharesDown,
      upPrice:       p?.up   ?? null,
      downPrice:     p?.down ?? null,
      live:          p?.live ?? false,
      recentOrders:  (win.orders||[]).slice(-20),
    };
  });

  return {
    version:     '2.0',
    mode:        'DEMO',
    capital:     displayCap,
    startCapital: state.startCapital,
    totalPnl, totalReturn: parseFloat((totalPnl / state.startCapital * 100).toFixed(3)),
    wins, losses, winRate: (wins+losses) > 0 ? ((wins/(wins+losses))*100).toFixed(1) : '0.0',
    feesPaid:    parseFloat(state.feesPaid.toFixed(4)),
    rebatesEarned: parseFloat(state.rebatesEarned.toFixed(4)),
    roundTrips:  state.roundTrips,
    secsLeft:    secondsLeft(),
    secsInto:    secondsIntoWindow(),
    currentTs:   currentWindowTs(),
    windows:     windowsOut,
    prices:      state.prices,
    equity:      state.equity.slice(-120),
    history:     state.history.slice(-50).reverse(),
    logs:        state.logs.slice(0, 80),
    tick:        globalTick,
  };
}

// ─── SERVER ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors()); app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: getPublicState() }));
  ws.on('error', e => console.error('[WS]', e.message));
});
emitter.on('state_update', d => broadcast('STATE_UPDATE', d));
emitter.on('log',          e => broadcast('LOG', e));
emitter.on('prices',       p => broadcast('PRICES', p));

app.get('/api/state',  (_, res) => res.json(getPublicState()));
app.get('/api/health', (_, res) => res.json({ ok: true, uptime: process.uptime(), tick: globalTick }));
app.get('*',           (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initState();
server.listen(CONFIG.PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  POLYMARKET MM BOT v2.0                          ║`);
  console.log(`║  http://localhost:${CONFIG.PORT}                         ║`);
  console.log(`║  Real prices: clob.polymarket.com/midpoint       ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
  startMainLoop();
});
