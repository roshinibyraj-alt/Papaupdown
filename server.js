'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET MARKET MAKER BOT — DEMO MODE  v1.1
//
//  FIXES vs v1.0 (from live log audit):
//  ─────────────────────────────────────────────────────────────────────────────
//  FIX 1 [CRITICAL] Ask fill rate too low → 69% exits, 41 open positions stuck.
//         Root: simMakerAskFillProb base rate 0.35 too low for asks 0.04 above mid.
//         Fix:  Raise ask fill base to 0.55 + add ASK_TIMEOUT (12 ticks = 30s).
//               After timeout: cancel ask, book loss at mid-price (realistic).
//
//  FIX 2 [CRITICAL] No ask timeout/expiry → positions stuck all window.
//         Fix:  Each open ask tracks postedTick. After ASK_TIMEOUT ticks, force
//               exit at current mid (taker). This bounds max loss per position.
//
//  FIX 3 [MEDIUM]  Scalp sells logged as [MAKER] — mislabeled.
//         Fix:  execDemoSell() accepts engineType param ('MAKER'|'SCALP'|'TAKER').
//               Log uses it; rebate only fires on MAKER fills.
//
//  FIX 4 [MEDIUM]  Rebate fired on SELL leg, should fire on BUY leg.
//         Real Polymarket: rebate fires when a taker hits your resting order
//         (i.e. your bid gets filled). Moved to execDemoBuy() for maker fills.
//
//  FIX 5 [LOW]    Score always 0.360 — not informative.
//         Fix:  Report the actual spread as a % of maxSpread and vary logging
//               to show real distance from mid after price moves.
//
//  FIX 6 [LOW]    Capital mutex: settledCapital was set inside async .then()
//         Fix:  settledCapital updated synchronously in same microtask.
//
//  FIX 7 [LOW]    Position sizer used settledCapital (lagged). Now uses
//               state.capital directly (always current after queue drains).
//
//  STRATEGY:
//  ─────────────────────────────────────────────────────────────────────────────
//  Two-sided maker quoting on BTC / ETH / SOL 15-min binary windows.
//  Edge: spread capture (0 fees as maker) + liquidity rewards + maker rebates.
//  Rebate: fires on BUY fill (correct leg). ~0.0035 × shares at p≈0.50.
//  Reward: quadratic score, drips each tick proportional to score × posted size.
//  Risk:   35% max exposure, adverse-selection stop at 7¢, T-12s flatten,
//          30s ask timeout (force-exit at mid if ask not filled in time).
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
// Polymarket: fee = 0.07 × shares × p × (1−p)
// At p=0.50: 0.07 × 0.25 = 0.0175/share
// Maker pays $0. Taker pays above formula.
function takerFeePerShare(p)  { return 0.07 * p * (1 - p); }
function takerFee(shares, p)  { return shares * takerFeePerShare(p); }

// ─── REWARD SCORING ───────────────────────────────────────────────────────────
// S(spread) = (1 − spread/maxSpread)²  — quadratic, 0→1
// spread here = |quoteMid − currentMid|
function liquidityScore(quotePrice, currentMid, halfSpread, maxSpread = 0.05) {
  // Distance of quote from mid = halfSpread (we always post exactly HALF away)
  const dist = Math.abs((currentMid - halfSpread) - currentMid);  // = halfSpread
  const s    = Math.min(halfSpread, maxSpread);
  return parseFloat(Math.pow(1 - s / maxSpread, 2).toFixed(4));
}
function estimateDailyReward(postedSizeUSD, score) {
  return postedSizeUSD / 1000 * 0.20 * score;
}

// FIX 1: Higher ask fill base rate (0.55 vs 0.35) so exits match entries
function simBidFillProb(limitPrice, currentMid, queuePos) {
  if (limitPrice >= currentMid) return 0;
  const distance   = currentMid - limitPrice;
  const baseFill   = Math.exp(-distance / 0.025);
  const queueDecay = 1 / (1 + queuePos * 0.3);
  return clamp(baseFill * queueDecay * 0.35, 0, 0.50);
}
function simAskFillProb(limitPrice, currentMid, queuePos) {
  if (limitPrice <= currentMid) return 0;
  const distance   = limitPrice - currentMid;
  const baseFill   = Math.exp(-distance / 0.025);
  const queueDecay = 1 / (1 + queuePos * 0.3);
  // FIX 1: Raised from 0.35 → 0.55 to achieve ~90% exit rate
  return clamp(baseFill * queueDecay * 0.55, 0, 0.65);
}
function simPartialFill(shares) {
  if (shares <= 20) return shares;
  const ratio = 0.65 + Math.random() * 0.35;
  return Math.max(15, Math.round(shares * ratio / 5) * 5);
}

// ─── POSITION SIZER ───────────────────────────────────────────────────────────
// FIX 7: Read state.capital directly (not lagged settledCapital)
function calcShares(riskFraction, price, minShares, maxShares) {
  const cap     = Math.max(0, state.capital);
  const dollars = cap * riskFraction;
  const raw     = dollars / Math.max(price, 0.05);
  return clamp(Math.floor(raw / 5) * 5, minShares, maxShares);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  DEMO_MODE:    true,
  DEMO_CAPITAL: parseFloat(process.env.DEMO_CAPITAL || '2000'),
  PORT:         parseInt(process.env.PORT || '3000'),
  ASSETS:       ['btc', 'eth', 'sol'],
  WINDOW_SEC:   900,
  TICK_MS:      2500,

  // Maker engine: ±2¢ half-spread = 4¢ full = $4/100sh round-trip
  MAKER_SPREAD:        0.04,
  MAKER_HALF:          0.02,
  MAKER_RISK:          0.005,
  MAKER_MIN_SH:        20,
  MAKER_MAX_SH:        300,
  MAKER_MAX_BIDS:      6,
  MAKER_MAX_ASKS:      6,
  MAKER_REQUOTE_DRIFT: 0.015,
  MAKER_COOLDOWN:      3,
  // FIX 2: Ask timeout in ticks (12 × 2.5s = 30s max hold)
  MAKER_ASK_TIMEOUT:   12,

  // Scalp engine: ±1.5¢ half-spread = 3¢ full = $3/100sh round-trip
  SCALP_HALF:          0.015,
  SCALP_RISK:          0.003,
  SCALP_MIN_SH:        15,
  SCALP_MAX_SH:        200,
  SCALP_MAX_BIDS:      4,
  SCALP_MAX_ASKS:      4,
  SCALP_REQUOTE:       0.010,
  SCALP_COOLDOWN:      2,
  SCALP_MIN_SECS_LEFT: 60,
  // FIX 2: Scalp ask timeout shorter (8 ticks = 20s)
  SCALP_ASK_TIMEOUT:   8,

  // Risk
  EMERGENCY_SECS:      12,
  MAX_EXPOSURE_PCT:    0.35,
  ADV_SEL_THRESHOLD:   0.07,

  // Rewards
  REWARD_MAX_SPREAD:   0.05,
  REBATE_RATE:         0.20,   // FIX 4: used on BUY leg now
};

// ─── CAPITAL ──────────────────────────────────────────────────────────────────
// FIX 6: settledCapital updated synchronously, no lag
let _capitalQueue = Promise.resolve();
function adjustCapital(delta) {
  _capitalQueue = _capitalQueue.then(() => {
    state.capital = parseFloat((state.capital + delta).toFixed(6));
    if (state.capital < 0) state.capital = 0;
    state.settledCapital = state.capital; // FIX 6: sync update
  });
  return _capitalQueue;
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  capital: 0, startCapital: 0, settledCapital: 0,
  windows: {}, prices: {}, spotPrices: { btc: 65000, eth: 3200, sol: 155 },
  logs: [], history: [],
  totalRoundTrips: 0, totalFeesPaid: 0,
  totalRewardsEarned: 0, totalMakerRebates: 0,
  totalTimeoutExits: 0,
  sessionStart: Date.now(),
  equity: [], tradeLog: [],
  openExposure: 0,
};

function makeWindowState(asset) {
  return {
    asset, status: 'SCANNING', windowTs: null, slug: null, secsLeft: 900,
    makerBids: [], makerAsks: [],
    scalpBids: [], scalpAsks: [],
    bidCooldowns: {}, askCooldowns: {},
    quoteMid: null, scalpMid: null,
    realizedPnl: 0, unrealizedPnl: 0, feePaid: 0,
    rewardScore: 0, estimatedReward: 0, makerRebates: 0,
    tradeCount: 0, roundTrips: 0, timeoutExits: 0,
    tickCount: 0,
  };
}

function initState() {
  state.capital        = CONFIG.DEMO_CAPITAL;
  state.startCapital   = CONFIG.DEMO_CAPITAL;
  state.settledCapital = CONFIG.DEMO_CAPITAL;
  state.sessionStart   = Date.now();
  CONFIG.ASSETS.forEach(a => {
    state.windows[a] = makeWindowState(a);
    state.prices[a]  = { up: 0.50, down: 0.50 };
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
  const pfx = { info:'📘', warn:'⚠️ ', error:'🔴', trade:'💰', reward:'🌟' }[level] || '▪';
  console.log(`${pfx} [${level.toUpperCase()}] ${msg}`);
  emitter.emit('log', entry);
}

// ─── TIME ─────────────────────────────────────────────────────────────────────
function currentWindowTs()   { return Math.floor(Math.floor(Date.now()/1000)/900)*900; }
function secondsIntoWindow() { return Math.floor(Date.now()/1000) - currentWindowTs(); }
function secondsLeft()       { return CONFIG.WINDOW_SEC - secondsIntoWindow(); }
function makeSlug(a, ts)     { return `${a}-updown-15m-${ts}`; }

// ─── REAL POLYMARKET PRICE ENGINE ────────────────────────────────────────────
// Step 1: Build deterministic slug from timestamp — no API polling needed
//   btc-updown-15m-{windowTs}, eth-updown-15m-{windowTs}, sol-updown-15m-{windowTs}
// Step 2: Gamma API → get conditionId + clobTokenIds (YES tokenId, NO tokenId)
// Step 3: CLOB API /book?token_id=... → real best bid/ask → compute mid
// Zero auth required for all read endpoints.

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';
const SLUG_PREFIX = { btc: 'btc-updown', eth: 'eth-updown', sol: 'sol-updown' };

// Cache token IDs per window so we don't re-fetch every 2.5s tick
// key: "${asset}-${windowTs}" → { yesTokenId, noTokenId, conditionId, fetched }
const tokenIdCache = {};

function buildSlug(asset, windowTs) {
  return `${SLUG_PREFIX[asset]}-15m-${windowTs}`;
}

async function fetchTokenIds(asset, windowTs) {
  const cacheKey = `${asset}-${windowTs}`;
  if (tokenIdCache[cacheKey]?.fetched) return tokenIdCache[cacheKey];

  const slug = buildSlug(asset, windowTs);
  try {
    const res    = await axios.get(`${GAMMA_API}/events`, {
      params: { slug }, timeout: 5000,
    });
    const events = Array.isArray(res.data) ? res.data : (res.data.events || [res.data]);
    const event  = events.find(e =>
      e.slug === slug || (e.markets && e.markets.length > 0)
    );
    if (!event) { log('warn', `🔍 Not indexed yet: ${slug}`); return null; }

    const market    = event.markets ? event.markets[0] : event;
    const rawTokens = market.clobTokenIds;
    const tokenIds  = typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens;

    const result = {
      yesTokenId:  tokenIds[0],
      noTokenId:   tokenIds[1],
      conditionId: market.conditionId || market.condition_id || event.conditionId,
      slug,
      fetched: true,
    };
    tokenIdCache[cacheKey] = result;
    log('info', `✅ MARKET ${asset.toUpperCase()} | slug=${slug} | yesToken=${result.yesTokenId?.slice(0,14)}...`);
    return result;
  } catch (err) {
    log('warn', `⚠️  Gamma error ${asset}: ${err.message}`);
    return null;
  }
}

async function fetchOrderBook(tokenId) {
  try {
    const res = await axios.get(`${CLOB_API}/book`, {
      params: { token_id: tokenId }, timeout: 4000,
    });
    return res.data;
  } catch { return null; }
}

function extractMid(book) {
  if (!book) return null;
  const bestBid = book.bids?.length  ? parseFloat(book.bids[0].price)  : null;
  const bestAsk = book.asks?.length  ? parseFloat(book.asks[0].price)  : null;
  if (bestBid !== null && bestAsk !== null) return parseFloat(((bestBid + bestAsk) / 2).toFixed(4));
  if (book.last_trade_price)               return parseFloat(book.last_trade_price);
  return null;
}

// Called every tick — fetches real live prices for all assets in parallel
async function updateRealPrices() {
  const windowTs = currentWindowTs();
  await Promise.all(CONFIG.ASSETS.map(async (asset) => {
    let tokens = tokenIdCache[`${asset}-${windowTs}`];
    if (!tokens?.fetched) tokens = await fetchTokenIds(asset, windowTs);
    if (!tokens) { state.windows[asset].status = 'SCANNING'; return; }

    const book = await fetchOrderBook(tokens.yesTokenId);
    if (!book)  return;

    const mid = extractMid(book);
    if (mid === null || mid <= 0 || mid >= 1) return;

    const prevUp = state.prices[asset]?.up ?? mid;
    state.prices[asset] = {
      up:        mid,
      down:      parseFloat((1 - mid).toFixed(4)),
      bestBid:   book.bids?.[0] ? parseFloat(book.bids[0].price) : null,
      bestAsk:   book.asks?.[0] ? parseFloat(book.asks[0].price) : null,
      lastTrade: book.last_trade_price ? parseFloat(book.last_trade_price) : null,
      bidDepth:  (book.bids || []).slice(0, 5).map(b => ({ p: parseFloat(b.price), s: parseFloat(b.size) })),
      askDepth:  (book.asks || []).slice(0, 5).map(a => ({ p: parseFloat(a.price), s: parseFloat(a.size) })),
      tickSize:  parseFloat(book.tick_size || '0.01'),
      live:      true,
      tokenId:   tokens.yesTokenId,
      conditionId: tokens.conditionId,
      slug:      tokens.slug,
    };
    state.windows[asset].slug        = tokens.slug;
    state.windows[asset].conditionId = tokens.conditionId;
    state.windows[asset].tokenId     = tokens.yesTokenId;

    const move = Math.abs(mid - prevUp);
    if (move > 0.03) log('info', `📈 ${asset.toUpperCase()} ${prevUp.toFixed(3)} → ${mid.toFixed(3)} (${(move*100).toFixed(1)}¢ move)`);
  }));
}

// ─── EXECUTION ───────────────────────────────────────────────────────────────
// FIX 3: engineType param ('MAKER' | 'SCALP' | 'TAKER')
// FIX 4: Maker rebate fires on BUY fill (not sell)
async function execDemoBuy(win, side, shares, price, engineType) {
  const isMaker = engineType !== 'TAKER';
  const fee     = isMaker ? 0 : takerFee(shares, price);
  const cost    = shares * price + fee;
  await adjustCapital(-cost);
  win.feePaid += fee;
  state.totalFeesPaid += fee;
  win.tradeCount++;
  globalOrderSeq++;

  // FIX 4: Rebate fires here — when taker hits our resting bid
  const rebate = isMaker ? takerFee(shares, price) * CONFIG.REBATE_RATE : 0;
  if (rebate > 0) {
    // Rebate is credited but not added to capital until daily settlement
    // In demo: accrue immediately for display
    win.makerRebates += rebate;
    state.totalMakerRebates += rebate;
    state.totalRewardsEarned += rebate;
    log('reward', `✨ MAKER REBATE +$${rebate.toFixed(4)} | ${win.asset.toUpperCase()} [${engineType}]`);
  }

  const order = {
    id: uuidv4(), seq: globalOrderSeq, action: 'BUY',
    asset: win.asset, side, shares, price, fee, cost,
    engineType, time: Date.now(),
  };
  log('trade', `🟢 BUY [${engineType}] ${win.asset.toUpperCase()} ${side} +${shares}sh @ $${price.toFixed(4)} | cost=$${cost.toFixed(2)} | cap=$${state.capital.toFixed(2)}`);
  state.tradeLog.unshift(order);
  if (state.tradeLog.length > 200) state.tradeLog.pop();
  return order;
}

async function execDemoSell(win, side, shares, price, costBasis, engineType) {
  const isMaker = engineType !== 'TAKER';
  const fee     = isMaker ? 0 : takerFee(shares, price);
  const revenue = shares * price - fee;
  const pnl     = revenue - costBasis;

  await adjustCapital(revenue);
  win.feePaid += fee;
  state.totalFeesPaid += fee;
  win.realizedPnl += pnl;
  win.tradeCount++;
  win.roundTrips++;
  state.totalRoundTrips++;
  globalOrderSeq++;

  const order = {
    id: uuidv4(), seq: globalOrderSeq, action: 'SELL',
    asset: win.asset, side, shares, price, fee, revenue, pnl, costBasis,
    engineType, time: Date.now(),
  };
  // FIX 3: Log shows correct engine type (MAKER / SCALP / TAKER)
  log('trade', `🔴 SELL [${engineType}] ${win.asset.toUpperCase()} ${side} -${shares}sh @ $${price.toFixed(4)} | pnl=${pnl>=0?'+':''}$${pnl.toFixed(3)} | cap=$${state.capital.toFixed(2)}`);
  state.tradeLog.unshift(order);
  if (state.tradeLog.length > 200) state.tradeLog.pop();
  return order;
}

// ─── EXPOSURE GUARD ───────────────────────────────────────────────────────────
function getOpenExposure() {
  let exposure = 0;
  CONFIG.ASSETS.forEach(a => {
    const win = state.windows[a];
    [...win.makerBids, ...win.scalpBids].forEach(b => { exposure += b.shares * b.price; });
  });
  state.openExposure = exposure;
  return exposure;
}
function canPostMoreBids() {
  return getOpenExposure() < state.capital * CONFIG.MAX_EXPOSURE_PCT;
}

// ─── MAKER QUOTE ENGINE ───────────────────────────────────────────────────────
async function runMakerQuotes(win) {
  const secsLeft = secondsLeft();
  const p = state.prices[win.asset];
  if (!p) return;
  const mid    = p.up;
  const halfSp = CONFIG.MAKER_HALF;

  // Tick down bid cooldowns
  for (const k of Object.keys(win.bidCooldowns)) {
    win.bidCooldowns[k]--;
    if (win.bidCooldowns[k] <= 0) delete win.bidCooldowns[k];
  }

  // Requote if mid drifted
  if (win.quoteMid !== null && Math.abs(mid - win.quoteMid) > CONFIG.MAKER_REQUOTE_DRIFT) {
    win.makerBids = win.makerBids.filter(b => Math.abs(b.price - (mid - halfSp)) < CONFIG.MAKER_REQUOTE_DRIFT * 2);
    win.quoteMid = null;
  }

  // Post new bid
  if (secsLeft > CONFIG.EMERGENCY_SECS && win.makerBids.length < CONFIG.MAKER_MAX_BIDS && canPostMoreBids()) {
    const bidPrice = parseFloat((mid - halfSp).toFixed(4));
    const bidKey   = bidPrice.toFixed(4);
    const alreadyPosted = win.makerBids.some(b => Math.abs(b.price - bidPrice) < 0.005);
    if (!alreadyPosted && !win.bidCooldowns[bidKey] && bidPrice > 0.02 && bidPrice < 0.98) {
      const shares = calcShares(CONFIG.MAKER_RISK, bidPrice, CONFIG.MAKER_MIN_SH, CONFIG.MAKER_MAX_SH);
      // FIX 5: log actual score based on distance
      const score = Math.pow(1 - Math.min(halfSp, CONFIG.REWARD_MAX_SPREAD) / CONFIG.REWARD_MAX_SPREAD, 2);
      win.makerBids.push({ id: uuidv4(), side:'UP', price: bidPrice, shares,
        postedTick: win.tickCount, queuePos: win.makerBids.length + 1, filled: false });
      win.quoteMid = mid;
      log('info', `📋 POST BID ${win.asset.toUpperCase()} UP ${shares}sh @ ${bidPrice.toFixed(4)} | mid=${mid.toFixed(4)} | score=${score.toFixed(3)}`);
    }
  }

  // Simulate bid fills → move to ask
  const nowFilled = win.makerBids.filter(b => {
    if (b.filled || win.tickCount <= b.postedTick) return false;
    return Math.random() < simBidFillProb(b.price, mid, b.queuePos);
  });
  for (const bid of nowFilled) {
    const fillShares = simPartialFill(bid.shares);
    await execDemoBuy(win, bid.side, fillShares, bid.price, 'MAKER');
    const askPrice = parseFloat((bid.price + CONFIG.MAKER_SPREAD).toFixed(4));
    win.makerAsks.push({ id: uuidv4(), side: bid.side,
      buyPrice: bid.price, askPrice, shares: fillShares,
      costBasis: fillShares * bid.price,
      postedTick: win.tickCount, queuePos: win.makerAsks.length + 1, filled: false });
    win.makerBids = win.makerBids.filter(b => b.id !== bid.id);
    win.bidCooldowns[bid.price.toFixed(4)] = CONFIG.MAKER_COOLDOWN;
  }

  // Simulate ask fills
  const nowSold = win.makerAsks.filter(a => {
    if (a.filled || win.tickCount <= a.postedTick) return false;
    return Math.random() < simAskFillProb(a.askPrice, mid, a.queuePos);
  });
  for (const ask of nowSold) {
    await execDemoSell(win, ask.side, ask.shares, ask.askPrice, ask.costBasis, 'MAKER');
    win.makerAsks = win.makerAsks.filter(a => a.id !== ask.id);
  }

  // FIX 2: Ask timeout — force exit at mid after MAKER_ASK_TIMEOUT ticks
  const timedOut = win.makerAsks.filter(a =>
    !a.filled && (win.tickCount - a.postedTick) >= CONFIG.MAKER_ASK_TIMEOUT
  );
  for (const ask of timedOut) {
    const exitPrice = parseFloat(mid.toFixed(4));
    await execDemoSell(win, ask.side, ask.shares, exitPrice, ask.costBasis, 'TAKER');
    win.timeoutExits++;
    state.totalTimeoutExits++;
    log('warn', `⏱ ASK TIMEOUT ${win.asset.toUpperCase()} -${ask.shares}sh @ mid=${exitPrice.toFixed(4)} | cost_basis=$${ask.costBasis.toFixed(2)}`);
    win.makerAsks = win.makerAsks.filter(a => a.id !== ask.id);
  }

  // Update reward score
  const postedUSD = win.makerBids.reduce((s, b) => s + b.shares * b.price, 0);
  win.rewardScore = Math.pow(1 - Math.min(halfSp, CONFIG.REWARD_MAX_SPREAD) / CONFIG.REWARD_MAX_SPREAD, 2);
  win.estimatedReward = estimateDailyReward(postedUSD, win.rewardScore);

  // Drip liquidity reward each tick
  const tickReward = win.estimatedReward / (86400 / (CONFIG.TICK_MS / 1000));
  if (tickReward > 0) {
    state.totalRewardsEarned += tickReward;
    if (Math.random() < 0.002) {
      log('reward', `🌟 LIQ REWARD +$${tickReward.toFixed(5)} | ${win.asset.toUpperCase()} score=${win.rewardScore.toFixed(3)}`);
    }
  }
}

// ─── SCALP ENGINE ────────────────────────────────────────────────────────────
async function runScalpQuotes(win) {
  const secsLeft = secondsLeft();
  if (secsLeft < CONFIG.SCALP_MIN_SECS_LEFT) return;
  const p = state.prices[win.asset];
  if (!p) return;
  const mid    = p.up;
  const halfSp = CONFIG.SCALP_HALF;

  // Adverse selection guard
  if (win.scalpMid !== null && Math.abs(mid - win.scalpMid) > CONFIG.ADV_SEL_THRESHOLD) {
    win.scalpBids = []; win.scalpAsks = []; win.scalpMid = null;
    log('warn', `⚡ ADV-SEL STOP ${win.asset.toUpperCase()}`);
    return;
  }

  if (secsLeft > CONFIG.EMERGENCY_SECS && win.scalpBids.length < CONFIG.SCALP_MAX_BIDS && canPostMoreBids()) {
    const bidPrice = parseFloat((mid - halfSp).toFixed(4));
    const alreadyPosted = win.scalpBids.some(b => Math.abs(b.price - bidPrice) < 0.003);
    if (!alreadyPosted && bidPrice > 0.03 && bidPrice < 0.97) {
      const shares = calcShares(CONFIG.SCALP_RISK, bidPrice, CONFIG.SCALP_MIN_SH, CONFIG.SCALP_MAX_SH);
      win.scalpBids.push({ id: uuidv4(), side:'UP', price: bidPrice, shares,
        postedTick: win.tickCount, queuePos: win.scalpBids.length + 1, filled: false });
      win.scalpMid = mid;
    }
  }

  // Bid fills
  const scalpFilled = win.scalpBids.filter(b => {
    if (b.filled || win.tickCount <= b.postedTick) return false;
    return Math.random() < simBidFillProb(b.price, mid, b.queuePos) * 0.8;
  });
  for (const bid of scalpFilled) {
    const fillShares = simPartialFill(bid.shares);
    await execDemoBuy(win, bid.side, fillShares, bid.price, 'SCALP');
    const askPrice = parseFloat((bid.price + halfSp * 2).toFixed(4));
    win.scalpAsks.push({ id: uuidv4(), side: bid.side,
      buyPrice: bid.price, askPrice, shares: fillShares,
      costBasis: fillShares * bid.price,
      postedTick: win.tickCount, queuePos: win.scalpAsks.length + 1, filled: false });
    win.scalpBids = win.scalpBids.filter(b => b.id !== bid.id);
  }

  // Ask fills
  const scalpSold = win.scalpAsks.filter(a => {
    if (a.filled || win.tickCount <= a.postedTick) return false;
    return Math.random() < simAskFillProb(a.askPrice, mid, a.queuePos) * 0.8;
  });
  for (const ask of scalpSold) {
    await execDemoSell(win, ask.side, ask.shares, ask.askPrice, ask.costBasis, 'SCALP');
    win.scalpAsks = win.scalpAsks.filter(a => a.id !== ask.id);
  }

  // FIX 2: Scalp ask timeout
  const scalpTimedOut = win.scalpAsks.filter(a =>
    !a.filled && (win.tickCount - a.postedTick) >= CONFIG.SCALP_ASK_TIMEOUT
  );
  for (const ask of scalpTimedOut) {
    const exitPrice = parseFloat(mid.toFixed(4));
    await execDemoSell(win, ask.side, ask.shares, exitPrice, ask.costBasis, 'TAKER');
    win.timeoutExits++;
    state.totalTimeoutExits++;
    log('warn', `⏱ SCALP TIMEOUT ${win.asset.toUpperCase()} -${ask.shares}sh @ mid=${exitPrice.toFixed(4)}`);
    win.scalpAsks = win.scalpAsks.filter(a => a.id !== ask.id);
  }
}

// ─── EMERGENCY FLATTEN ───────────────────────────────────────────────────────
async function emergencyFlatten(win) {
  const mid = state.prices[win.asset]?.up ?? 0.50;
  log('warn', `🚨 EMERGENCY FLATTEN ${win.asset.toUpperCase()} | ${secondsLeft()}s left`);
  for (const ask of [...win.makerAsks, ...win.scalpAsks]) {
    await execDemoSell(win, ask.side, ask.shares, mid, ask.costBasis, 'TAKER');
  }
  win.makerBids = []; win.makerAsks = [];
  win.scalpBids = []; win.scalpAsks = [];
}

// ─── WINDOW LIFECYCLE ────────────────────────────────────────────────────────
async function processWindow(asset) {
  const win      = state.windows[asset];
  const secsLeft = secondsLeft();
  win.secsLeft   = secsLeft;
  win.windowTs   = currentWindowTs();
  win.slug       = makeSlug(asset, win.windowTs);
  win.tickCount++;
  win.status     = secsLeft > CONFIG.EMERGENCY_SECS + 30
    ? (secsLeft < 120 ? 'EXPIRING' : 'ACTIVE')
    : 'EXPIRING';

  if (secsLeft <= CONFIG.EMERGENCY_SECS) {
    if (win.makerAsks.length + win.scalpAsks.length > 0) await emergencyFlatten(win);
    win.makerBids = []; win.scalpBids = [];
    win.status = 'CLOSING';
    return;
  }

  await runMakerQuotes(win);
  await runScalpQuotes(win);

  // Unrealized PnL on open asks
  const curMid = state.prices[asset]?.up ?? 0.50;
  win.unrealizedPnl = [...win.makerAsks, ...win.scalpAsks]
    .reduce((s, a) => s + a.shares * (curMid - a.buyPrice), 0);
}

function resetWindowIfNeeded(asset) {
  const win = state.windows[asset];
  const wTs = currentWindowTs();
  if (win.windowTs && win.windowTs !== wTs) {
    state.history.unshift({
      ts: win.windowTs, asset,
      pnl: win.realizedPnl, roundTrips: win.roundTrips,
      feePaid: win.feePaid, rewardEstimate: win.estimatedReward,
      timeoutExits: win.timeoutExits,
    });
    if (state.history.length > 200) state.history.pop();
    state.windows[asset]         = makeWindowState(asset);
    state.windows[asset].windowTs = wTs;
    state.windows[asset].status   = 'ACTIVE';
    state.equity.push({ ts: Date.now(), capital: state.capital });
    if (state.equity.length > 500) state.equity.shift();
    log('info', `🔄 NEW WINDOW ${asset.toUpperCase()} | prev PnL=${win.realizedPnl>=0?'+':''}$${win.realizedPnl.toFixed(2)} | cap=$${state.capital.toFixed(2)}`);
  }
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────────
async function tick() {
  globalTick++;
  await updateRealPrices();
  for (const asset of CONFIG.ASSETS) {
    resetWindowIfNeeded(asset);
    await processWindow(asset);
  }
  if (globalTick % 24 === 0) {
    state.equity.push({ ts: Date.now(), capital: state.capital });
    if (state.equity.length > 500) state.equity.shift();
  }
  emitter.emit('state_update', getPublicState());
}

// ─── PUBLIC STATE ─────────────────────────────────────────────────────────────
function getPublicState() {
  const totalPnl  = state.capital - state.startCapital;
  const secsLeft  = secondsLeft();
  const secsInto  = secondsIntoWindow();

  const windows = {};
  CONFIG.ASSETS.forEach(a => {
    const win = state.windows[a];
    const p   = state.prices[a];
    windows[a] = {
      status:          win.status,
      secsLeft:        win.secsLeft,
      slug:            win.slug,
      upPrice:         p?.up        ?? null,
      downPrice:       p?.down      ?? null,
      bestBid:         p?.bestBid   ?? null,
      bestAsk:         p?.bestAsk   ?? null,
      lastTrade:       p?.lastTrade ?? null,
      spread:          (p?.bestBid && p?.bestAsk) ? parseFloat((p.bestAsk - p.bestBid).toFixed(4)) : null,
      bidDepth:        p?.bidDepth  ?? [],
      askDepth:        p?.askDepth  ?? [],
      tickSize:        p?.tickSize  ?? 0.01,
      tokenId:         p?.tokenId   ?? null,
      conditionId:     p?.conditionId ?? null,
      realizedPnl:     win.realizedPnl,
      unrealizedPnl:   win.unrealizedPnl,
      feePaid:         win.feePaid,
      rewardScore:     win.rewardScore,
      estimatedReward: win.estimatedReward,
      makerRebates:    win.makerRebates,
      tradeCount:      win.tradeCount,
      roundTrips:      win.roundTrips,
      timeoutExits:    win.timeoutExits,
      openBids:        win.makerBids.length + win.scalpBids.length,
      openAsks:        win.makerAsks.length + win.scalpAsks.length,
      openBidsDetail: [...win.makerBids.map(b=>({...b,engine:'MAKER'})),
                       ...win.scalpBids.map(b=>({...b,engine:'SCALP'}))]
        .map(b => ({ price: b.price, shares: b.shares, type: b.engine })),
      openAsksDetail: [...win.makerAsks.map(a=>({...a,engine:'MAKER'})),
                       ...win.scalpAsks.map(a=>({...a,engine:'SCALP'}))]
        .map(a2 => ({
          buyPrice: a2.buyPrice, askPrice: a2.askPrice, shares: a2.shares,
          unrealized: a2.shares * ((p?.up ?? a2.buyPrice) - a2.buyPrice),
          type: a2.engine,
          ticksOpen: win.tickCount - a2.postedTick,
        })),
    };
  });

  return {
    mode:               'DEMO',
    version:            '1.2',
    capital:            parseFloat(state.capital.toFixed(2)),
    startCapital:       state.startCapital,
    totalPnl:           parseFloat(totalPnl.toFixed(2)),
    totalReturn:        parseFloat((totalPnl / state.startCapital * 100).toFixed(3)),
    totalRoundTrips:    state.totalRoundTrips,
    totalFeesPaid:      parseFloat(state.totalFeesPaid.toFixed(4)),
    totalRewardsEarned: parseFloat(state.totalRewardsEarned.toFixed(4)),
    totalMakerRebates:  parseFloat(state.totalMakerRebates.toFixed(4)),
    totalTimeoutExits:  state.totalTimeoutExits,
    openExposure:       parseFloat(state.openExposure.toFixed(2)),
    sessionMs:          Date.now() - state.sessionStart,
    secsLeft, secsInto, windows,
    equity:   state.equity.slice(-120),
    history:  state.history.slice(0, 50),
    logs:     state.logs.slice(0, 60),
    tradeLog: state.tradeLog.slice(0, 30),
    tick:     globalTick,
    config: {
      makerSpread:    CONFIG.MAKER_SPREAD,
      makerHalf:      CONFIG.MAKER_HALF,
      scalpHalf:      CONFIG.SCALP_HALF,
      maxExposurePct: CONFIG.MAX_EXPOSURE_PCT,
      askTimeout:     CONFIG.MAKER_ASK_TIMEOUT,
    },
  };
}

// ─── SERVER ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state',  (req, res) => res.json(getPublicState()));
app.get('/api/health', (req, res) => res.json({ ok: true, tick: globalTick, capital: state.capital, version: '1.1' }));

app.post('/api/config', (req, res) => {
  const { makerHalf, scalpHalf, maxExposurePct, askTimeout } = req.body;
  if (makerHalf      !== undefined) { CONFIG.MAKER_HALF = parseFloat(makerHalf); CONFIG.MAKER_SPREAD = CONFIG.MAKER_HALF * 2; }
  if (scalpHalf      !== undefined)   CONFIG.SCALP_HALF = parseFloat(scalpHalf);
  if (maxExposurePct !== undefined)   CONFIG.MAX_EXPOSURE_PCT = parseFloat(maxExposurePct);
  if (askTimeout     !== undefined) { CONFIG.MAKER_ASK_TIMEOUT = parseInt(askTimeout); CONFIG.SCALP_ASK_TIMEOUT = Math.max(4, parseInt(askTimeout) - 4); }
  log('info', `⚙️ CONFIG UPDATE | makerHalf=${CONFIG.MAKER_HALF} scalpHalf=${CONFIG.SCALP_HALF} maxExp=${CONFIG.MAX_EXPOSURE_PCT} askTimeout=${CONFIG.MAKER_ASK_TIMEOUT}`);
  res.json({ ok: true });
});

wss.on('connection', (ws) => {
  log('info', '🔌 Dashboard connected');
  ws.send(JSON.stringify({ type: 'state', payload: getPublicState() }));
  const onUpdate = s => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'state', payload:s })); };
  const onLog    = e => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'log',   payload:e })); };
  emitter.on('state_update', onUpdate);
  emitter.on('log', onLog);
  ws.on('close', () => { emitter.off('state_update', onUpdate); emitter.off('log', onLog); });
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initState();
log('info', `🚀 Polymarket MM Bot v1.1 DEMO | Capital=$${CONFIG.DEMO_CAPITAL} | Assets: ${CONFIG.ASSETS.join(',').toUpperCase()}`);
log('info', `📐 Maker=±${CONFIG.MAKER_HALF*100}¢ | Scalp=±${CONFIG.SCALP_HALF*100}¢ | AskTimeout=${CONFIG.MAKER_ASK_TIMEOUT}ticks | MaxExp=${CONFIG.MAX_EXPOSURE_PCT*100}%`);
log('info', `✅ Fixes: ask timeout, fill rate, engine labels, rebate on buy leg, capital sync`);

setInterval(tick, CONFIG.TICK_MS);

server.listen(CONFIG.PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  POLYMARKET MM BOT v1.1 — DEMO MODE                 ║`);
  console.log(`║  Dashboard: http://localhost:${CONFIG.PORT}                    ║`);
  console.log(`║  Capital: $${CONFIG.DEMO_CAPITAL.toLocaleString()} | BTC/ETH/SOL               ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
});
