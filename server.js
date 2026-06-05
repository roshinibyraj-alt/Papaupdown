'use strict';
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET MARKET MAKER BOT — DEMO MODE
//  BTC/ETH/SOL 15-Minute Binary Windows
//
//  STRATEGY:
//  ─────────────────────────────────────────────────────────────────────────────
//  • Two-sided maker quoting: post bid+ask around fair value mid
//  • Capture the spread (4¢ wide = 2¢ each side) with ZERO taker fees
//  • Earn Liquidity Rewards: resting orders near mid score quadratically
//  • Earn Maker Rebates: share of taker fees on every fill
//
//  EDGE SOURCES:
//  1. Spread capture   — buy@0.48 sell@0.52 = $4/100sh round trip
//  2. Liquidity rewards — daily USDC for resting near mid (score ∝ proximity²)
//  3. Maker rebates    — % of taker fee pool proportional to filled volume
//  4. Skew management  — lean quotes toward fair value to avoid adverse selection
//
//  POSITION SIZING:
//  • 0.5% of capital per bid (compounds as capital grows)
//  • Max 6 concurrent bids per side per market
//  • Hard ceiling: 300 shares per order
//  • Requote if mid drifts >2¢ (adverse selection defense)
//  • Emergency flatten with <10s left in window
//
//  REWARD SIMULATION:
//  • Liquidity rewards estimated: $0.15–$0.50/day per $1k of posted size
//  • Maker rebates: ~20% of taker fee on filled volume
//  • Fee formula: 0.07 × shares × p × (1−p)   (Polymarket standard)
//
//  DEMO CAPITAL: $2,000
// ═══════════════════════════════════════════════════════════════════════════════

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const axios      = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const path       = require('path');
const cors       = require('cors');

// ─── FEE MATH ─────────────────────────────────────────────────────────────────
// Polymarket: fee = 0.07 * shares * p * (1 - p)
// Symmetric around 50¢. At p=0.50: fee = 0.0175/share
// Maker pays: $0.00. Taker pays above formula.

function takerFeePerShare(p)  { return 0.07 * p * (1 - p); }
function takerFee(shares, p)  { return shares * takerFeePerShare(p); }
function breakEvenSpread(p)   { return 2 * takerFeePerShare(p); }

// ─── REWARD ESTIMATOR ─────────────────────────────────────────────────────────
// Liquidity Rewards: quadratic scoring based on spread from mid
// S(spread) = 1 - (spread / maxSpread)²
// Closer to mid → exponentially higher score
// Daily reward = (your_Qepoch / total_Qepoch) * daily_pool
//
// Conservative estimate: $1–$3/day per $1,000 capital in active quoting
// This is a realistic floor for well-placed BTC 15m markets

function estimateLiquidityRewardScore(quoteMid, currentMid, maxSpread = 0.05) {
  const s = Math.abs(quoteMid - currentMid);
  if (s >= maxSpread) return 0;
  return Math.pow(1 - s / maxSpread, 2);  // quadratic
}

function estimateDailyReward(postedSizeUSD, score) {
  // ~$0.20/day per $1k posted at score=1.0 (conservative, real varies)
  const base = postedSizeUSD / 1000 * 0.20;
  return base * score;
}

// ─── POISSON / SIMULATION HELPERS ─────────────────────────────────────────────

function poissonRandom(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function gaussianRandom(mean = 0, std = 1) {
  // Box-Muller
  const u1 = Math.random(), u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Simulate BTC 15m price as mean-reverting random walk near 0.50
// Real market: driven by BTC spot moves vs strike. We simulate both directions.
function simPriceTick(prev, windowSecsLeft) {
  // Volatility increases near expiry (pin risk)
  const volScale = windowSecsLeft < 60 ? 2.5 : windowSecsLeft < 180 ? 1.5 : 1.0;
  const drift    = 0.003 * gaussianRandom(0, 1) * volScale;
  const meanRev  = 0.04 * (0.50 - prev);  // pull toward 50¢
  const next     = clamp(prev + drift + meanRev, 0.02, 0.98);
  return parseFloat(next.toFixed(4));
}

// Simulate BTC spot price for display
function simBtcSpot(prevSpot) {
  const pct = gaussianRandom(0, 0.0008);  // ~0.08% per 2.5s tick
  return parseFloat((prevSpot * (1 + pct)).toFixed(0));
}

// Fill probability for a resting maker bid: needs market to trade through price
function simMakerFillProb(limitPrice, currentMid, queuePos) {
  if (limitPrice > currentMid) return 0;  // bid above mid = immediate fill (taker)
  const distance = currentMid - limitPrice;
  // Realistic: 15-30% chance of fill per tick if within 2¢ of mid
  const baseFill = Math.exp(-distance / 0.025);  // decay with distance
  const queuePenalty = 1 / (1 + queuePos * 0.3);
  return clamp(baseFill * queuePenalty * 0.35, 0, 0.50);
}

function simMakerAskFillProb(limitPrice, currentMid, queuePos) {
  if (limitPrice < currentMid) return 0;
  const distance = limitPrice - currentMid;
  const baseFill = Math.exp(-distance / 0.025);
  const queuePenalty = 1 / (1 + queuePos * 0.3);
  return clamp(baseFill * queuePenalty * 0.35, 0, 0.50);
}

// Partial fill simulation for large orders
function simPartialFill(shares) {
  if (shares <= 50) return shares;
  const ratio = 0.65 + Math.random() * 0.35;
  return Math.max(20, Math.round(shares * ratio / 5) * 5);
}

// ─── POSITION SIZER ───────────────────────────────────────────────────────────
// Compounds as capital grows. Floor and ceiling enforced.

function calcShares(riskFraction, price, minShares, maxShares) {
  const cap     = Math.max(0, state.settledCapital || state.capital);
  const dollars = cap * riskFraction;
  const raw     = dollars / Math.max(price, 0.05);
  const rounded = Math.floor(raw / 5) * 5;
  return clamp(rounded, minShares, maxShares);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  DEMO_MODE:         true,
  DEMO_CAPITAL:      parseFloat(process.env.DEMO_CAPITAL || '2000'),
  PORT:              parseInt(process.env.PORT || '3000'),
  ASSETS:            ['btc', 'eth', 'sol'],
  WINDOW_SEC:        900,          // 15 minutes
  TICK_MS:           2500,         // price refresh interval

  // ── MAKER QUOTE ENGINE ────────────────────────────────────────────────────
  // Post bid at (mid - half) and ask at (mid + half)
  // Full spread = 2 × HALF_SPREAD = 4¢
  // Per 100sh round trip: 100 × 0.04 = $4.00 gross, $0 fees = $4.00 net
  MAKER_SPREAD:          0.04,
  MAKER_HALF:            0.02,
  MAKER_RISK:            0.005,    // 0.5% capital per bid → scales with equity
  MAKER_MIN_SH:          20,
  MAKER_MAX_SH:          300,
  MAKER_MAX_BIDS:        6,        // max concurrent bids per side
  MAKER_MAX_ASKS:        6,        // max concurrent asks (filled bids awaiting exit)
  MAKER_REQUOTE_DRIFT:   0.015,    // requote if mid moves >1.5¢
  MAKER_COOLDOWN:        3,        // ticks before reposting at same level

  // ── SCALP ENGINE (tighter, faster) ────────────────────────────────────────
  // Tighter spread = better liquidity reward score (closer to mid)
  // At 50¢: score S = (1 - 0.5/5)² = 0.81 vs wide spread S = 0.36
  SCALP_HALF:            0.015,    // 1.5¢ half-spread
  SCALP_RISK:            0.003,    // 0.3% capital per bid (smaller, tighter)
  SCALP_MIN_SH:          15,
  SCALP_MAX_SH:          200,
  SCALP_MAX_BIDS:        4,
  SCALP_MAX_ASKS:        4,
  SCALP_REQUOTE:         0.010,
  SCALP_COOLDOWN:        2,
  SCALP_MIN_SECS_LEFT:   60,       // stop scalp postings within 60s of expiry

  // ── RISK MANAGEMENT ──────────────────────────────────────────────────────
  EMERGENCY_SECS:        12,       // flatten all positions with <12s left
  WIN_THRESHOLD:         0.97,     // price ≥ 0.97 = treat as resolved
  MAX_EXPOSURE_PCT:      0.35,     // max 35% of capital in open positions
  ADV_SEL_THRESHOLD:     0.07,     // if mid moves >7¢ against us: pause quoting

  // ── REWARD PARAMS (for simulation/display) ───────────────────────────────
  REWARD_MAX_SPREAD:     0.05,     // max spread to qualify for liq rewards
  REWARD_DAILY_POOL_EST: 50,       // estimated daily pool for BTC 15m ($)
  REBATE_RATE:           0.20,     // 20% of taker fee returned to makers
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
  windows: {}, prices: {}, spotPrices: { btc: 65000, eth: 3200, sol: 155 },
  logs: [], history: [],
  totalRoundTrips: 0,
  totalFeesPaid: 0,
  totalRewardsEarned: 0,
  totalMakerRebates: 0,
  dailyRewardAccrual: 0,
  sessionStart: Date.now(),
  equity: [],           // [{ts, capital}] for chart
  rewardLog: [],        // [{ts, amount, type}]
  tradeLog: [],         // recent fills
  openExposure: 0,      // current $ tied in open bids
};

function makeWindowState(asset) {
  return {
    asset,
    status: 'SCANNING',   // SCANNING | ACTIVE | EXPIRING | CLOSED
    windowTs: null,
    slug: null,
    secsLeft: 900,

    // Separate arrays: openBids (resting, waiting fill), openAsks (filled, waiting exit)
    makerBids: [],     // { id, side, price, shares, postedTick, queuePos, filled }
    makerAsks: [],     // { id, side, buyPrice, askPrice, shares, postedTick, filled }
    scalpBids: [],
    scalpAsks: [],

    bidCooldowns: {},  // price → ticksRemaining
    askCooldowns: {},

    quoteMid: null,    // last mid we quoted around
    scalpMid: null,

    realizedPnl: 0,
    unrealizedPnl: 0,
    feePaid: 0,
    rewardScore: 0,    // current liquidity reward score
    estimatedReward: 0,
    makerRebates: 0,
    tradeCount: 0,
    roundTrips: 0,

    tickCount: 0,
    lastResolution: null,
    resolutionTs: null,
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
  // Seed equity chart
  state.equity.push({ ts: Date.now(), capital: CONFIG.DEMO_CAPITAL });
}

// ─── GLOBAL TICK ─────────────────────────────────────────────────────────────

let globalTick = 0;
let globalOrderSeq = 0;
const emitter = new EventEmitter();
emitter.setMaxListeners(500);

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(level, msg, data = null) {
  const entry = { id: uuidv4(), ts: Date.now(), level, msg, data };
  state.logs.unshift(entry);
  if (state.logs.length > 500) state.logs.pop();
  const prefix = { info: '📘', warn: '⚠️', error: '🔴', trade: '💰', reward: '🌟' }[level] || '▪';
  console.log(`${prefix} [${level.toUpperCase()}] ${msg}`, data ? JSON.stringify(data) : '');
  emitter.emit('log', entry);
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function currentWindowTs()   { return Math.floor(Math.floor(Date.now() / 1000) / 900) * 900; }
function secondsIntoWindow() { return Math.floor(Date.now() / 1000) - currentWindowTs(); }
function secondsLeft()       { return CONFIG.WINDOW_SEC - secondsIntoWindow(); }
function makeSlug(asset, ts) { return `${asset}-updown-15m-${ts}`; }

// ─── REAL PRICE ENGINE ────────────────────────────────────────────────────────
// Fetches live UP/DOWN token prices from Polymarket public APIs (no auth needed).
//
// Flow per asset:
//   1. Compute deterministic slug  →  btc-updown-15m-{windowTs}
//   2. GET gamma-api.polymarket.com/markets?slug=...  →  extract clobTokenIds[0/1]
//   3. GET clob.polymarket.com/midpoint?token_id=...  →  live mid price
//   4. Cache token IDs per window so step 2 only runs once per 15m period
//   5. On any failure: fall back to simPriceTick so the bot never stalls

// token ID cache:  asset → { windowTs, upTokenId, downTokenId }
const _tokenCache = {};

async function fetchTokenIds(asset, windowTs) {
  const cached = _tokenCache[asset];
  if (cached && cached.windowTs === windowTs) {
    return { upTokenId: cached.upTokenId, downTokenId: cached.downTokenId };
  }

  const slug = makeSlug(asset, windowTs);
  const url  = `https://gamma-api.polymarket.com/markets?slug=${slug}`;

  const res  = await axios.get(url, { timeout: 4000 });
  const markets = res.data;

  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error(`No market found for slug: ${slug}`);
  }

  const market = markets[0];
  const ids    = market.clobTokenIds || market.clob_token_ids;
  if (!ids || ids.length < 2) throw new Error(`Missing clobTokenIds for ${slug}`);

  // Index 0 = UP (Yes), index 1 = DOWN (No) — consistent with Polymarket ordering
  const upTokenId   = ids[0];
  const downTokenId = ids[1];

  _tokenCache[asset] = { windowTs, upTokenId, downTokenId };
  log('info', `🔗 TOKEN IDs cached ${asset.toUpperCase()} | UP=${upTokenId.slice(0,12)}… DOWN=${downTokenId.slice(0,12)}…`);

  return { upTokenId, downTokenId };
}

async function fetchMidPrice(tokenId) {
  const url = `https://clob.polymarket.com/midpoint?token_id=${tokenId}`;
  const res = await axios.get(url, { timeout: 3000 });
  const mid = parseFloat(res.data?.mid ?? res.data?.midpoint ?? res.data?.price);
  if (isNaN(mid)) throw new Error(`Bad midpoint response for token ${tokenId.slice(0,12)}`);
  return clamp(mid, 0.01, 0.99);
}

// Spot prices: CoinGecko simple price endpoint — completely free, no API key
// Batched in a single call. Runs on a slower cadence (every 6 ticks ≈ 15s).
const COINGECKO_IDS = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana' };
let _spotFetchTick  = 0;

async function fetchSpotPrices() {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await axios.get(url, { timeout: 5000 });
  const d   = res.data;
  if (d?.bitcoin?.usd)  state.spotPrices.btc = d.bitcoin.usd;
  if (d?.ethereum?.usd) state.spotPrices.eth = d.ethereum.usd;
  if (d?.solana?.usd)   state.spotPrices.sol = d.solana.usd;
}

async function updateRealPrices() {
  const wTs = currentWindowTs();

  // Fetch all three assets concurrently — any failure throws and halts the tick
  await Promise.all(CONFIG.ASSETS.map(async (asset) => {
    const { upTokenId, downTokenId } = await fetchTokenIds(asset, wTs);

    const [upMid, downMid] = await Promise.all([
      fetchMidPrice(upTokenId),
      fetchMidPrice(downTokenId),
    ]);

    state.prices[asset] = { up: upMid, down: downMid, live: true };
  }));

  // Fetch spot prices on a slower cadence (every 6 ticks ≈ 15s) to respect CoinGecko rate limits
  _spotFetchTick++;
  if (_spotFetchTick % 6 === 1) {
    fetchSpotPrices().catch(err =>
      log('warn', `⚠️ Spot price fetch failed | ${err.message}`)
    );
  }
}

// ─── ORDER SIMULATION ────────────────────────────────────────────────────────

async function execDemoBuy(win, side, shares, price, isMaker) {
  const fee  = isMaker ? 0 : takerFee(shares, price);
  const cost = shares * price + fee;
  await adjustCapital(-cost);
  win.feePaid    += fee;
  state.totalFeesPaid += fee;
  win.tradeCount++;
  globalOrderSeq++;

  const order = {
    id: uuidv4(), seq: globalOrderSeq, side, action: 'BUY',
    shares, price, fee, cost, isMaker,
    time: Date.now(), asset: win.asset,
  };
  win.tradeCount++;

  const typeStr = isMaker ? 'MAKER' : 'TAKER';
  log('trade', `🟢 BUY [${typeStr}] ${win.asset.toUpperCase()} ${side} +${shares}sh @ $${price.toFixed(4)} | cost=$${cost.toFixed(2)} | cap=$${state.capital.toFixed(2)}`);

  state.tradeLog.unshift(order);
  if (state.tradeLog.length > 200) state.tradeLog.pop();

  return order;
}

async function execDemoSell(win, side, shares, price, costBasis, isMaker) {
  const fee     = isMaker ? 0 : takerFee(shares, price);
  const revenue = shares * price - fee;
  const pnl     = revenue - costBasis;

  await adjustCapital(revenue);
  win.feePaid    += fee;
  state.totalFeesPaid += fee;
  win.realizedPnl += pnl;
  win.tradeCount++;
  win.roundTrips++;
  state.totalRoundTrips++;
  globalOrderSeq++;

  // Simulate maker rebate on this fill
  const rebate = isMaker ? takerFee(shares, price) * CONFIG.REBATE_RATE : 0;
  if (rebate > 0) {
    win.makerRebates  += rebate;
    state.totalMakerRebates += rebate;
    state.totalRewardsEarned += rebate;
    log('reward', `✨ MAKER REBATE +$${rebate.toFixed(4)} | ${win.asset.toUpperCase()}`);
  }

  const order = {
    id: uuidv4(), seq: globalOrderSeq, side, action: 'SELL',
    shares, price, fee, revenue, pnl, costBasis, isMaker,
    time: Date.now(), asset: win.asset,
  };

  log('trade', `🔴 SELL [${isMaker?'MAKER':'TAKER'}] ${win.asset.toUpperCase()} ${side} -${shares}sh @ $${price.toFixed(4)} | pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} | cap=$${state.capital.toFixed(2)}`);

  state.tradeLog.unshift(order);
  if (state.tradeLog.length > 200) state.tradeLog.pop();

  return order;
}

// ─── MAKER QUOTE ENGINE ───────────────────────────────────────────────────────

function getOpenExposure() {
  let exposure = 0;
  CONFIG.ASSETS.forEach(a => {
    const win = state.windows[a];
    [...win.makerBids, ...win.scalpBids].forEach(b => {
      exposure += b.shares * b.price;
    });
  });
  state.openExposure = exposure;
  return exposure;
}

function canPostMoreBids() {
  const exposure = getOpenExposure();
  return exposure < state.settledCapital * CONFIG.MAX_EXPOSURE_PCT;
}

async function runMakerQuotes(win) {
  if (!CONFIG.DEMO_MODE) return;
  const secsLeft = secondsLeft();
  const p = state.prices[win.asset];
  if (!p) return;

  const mid    = p.up;  // binary: quote around YES (Up) probability
  const halfSp = CONFIG.MAKER_HALF;

  // ── Tick down cooldowns
  Object.keys(win.bidCooldowns).forEach(k => {
    win.bidCooldowns[k]--;
    if (win.bidCooldowns[k] <= 0) delete win.bidCooldowns[k];
  });

  // ── Requote check: cancel stale bids if mid has drifted
  if (win.quoteMid !== null && Math.abs(mid - win.quoteMid) > CONFIG.MAKER_REQUOTE_DRIFT) {
    win.makerBids = win.makerBids.filter(b => {
      const drift = Math.abs(b.price - (mid - halfSp));
      return drift < CONFIG.MAKER_REQUOTE_DRIFT * 2;
    });
    win.quoteMid = null;
  }

  // ── Post new bids (YES side)
  if (secsLeft > CONFIG.EMERGENCY_SECS && win.makerBids.length < CONFIG.MAKER_MAX_BIDS && canPostMoreBids()) {
    const bidPrice = parseFloat((mid - halfSp).toFixed(4));
    const bidKey   = bidPrice.toFixed(4);
    const alreadyPosted = win.makerBids.some(b => Math.abs(b.price - bidPrice) < 0.005);

    if (!alreadyPosted && !win.bidCooldowns[bidKey] && bidPrice > 0.02 && bidPrice < 0.98) {
      const shares = calcShares(CONFIG.MAKER_RISK, bidPrice, CONFIG.MAKER_MIN_SH, CONFIG.MAKER_MAX_SH);
      win.makerBids.push({
        id: uuidv4(), side: 'UP', price: bidPrice, shares,
        postedTick: win.tickCount, queuePos: win.makerBids.length + 1,
        filled: false,
      });
      win.quoteMid = mid;
      log('info', `📋 POST BID ${win.asset.toUpperCase()} UP ${shares}sh @ ${bidPrice.toFixed(4)} | mid=${mid.toFixed(4)} | score=${estimateLiquidityRewardScore(bidPrice, mid).toFixed(3)}`);
    }
  }

  // ── Simulate bid fills
  const nowFilled = [];
  win.makerBids.forEach(bid => {
    if (bid.filled) return;
    if (win.tickCount <= bid.postedTick) return;   // no same-tick fill
    const fillProb = simMakerFillProb(bid.price, mid, bid.queuePos);
    if (Math.random() < fillProb) {
      bid.filled = true;
      nowFilled.push(bid);
    }
  });

  for (const bid of nowFilled) {
    const fillShares = simPartialFill(bid.shares);
    await execDemoBuy(win, bid.side, fillShares, bid.price, true);

    // Move to asks array
    const askPrice = parseFloat((bid.price + CONFIG.MAKER_SPREAD).toFixed(4));
    win.makerAsks.push({
      id: uuidv4(), side: bid.side,
      buyPrice: bid.price, askPrice,
      shares: fillShares, costBasis: fillShares * bid.price,
      postedTick: win.tickCount, queuePos: win.makerAsks.length + 1,
      filled: false,
    });

    // Remove from bids, set cooldown
    win.makerBids = win.makerBids.filter(b => b.id !== bid.id);
    win.bidCooldowns[bid.price.toFixed(4)] = CONFIG.MAKER_COOLDOWN;
  }

  // ── Simulate ask fills (exit leg)
  const nowSold = [];
  win.makerAsks.forEach(ask => {
    if (ask.filled) return;
    if (win.tickCount <= ask.postedTick) return;
    const fillProb = simMakerAskFillProb(ask.askPrice, mid, ask.queuePos);
    if (Math.random() < fillProb) {
      ask.filled = true;
      nowSold.push(ask);
    }
  });

  for (const ask of nowSold) {
    await execDemoSell(win, ask.side, ask.shares, ask.askPrice, ask.costBasis, true);
    win.makerAsks = win.makerAsks.filter(a => a.id !== ask.id);
    win.askCooldowns = win.askCooldowns || {};
    win.askCooldowns[ask.askPrice.toFixed(4)] = CONFIG.MAKER_COOLDOWN;
  }

  // ── Update reward score (based on current quotes)
  const bestBidDist  = win.makerBids.length > 0 ? Math.min(...win.makerBids.map(b => Math.abs(b.price - mid))) : CONFIG.REWARD_MAX_SPREAD;
  win.rewardScore = estimateLiquidityRewardScore(mid - bestBidDist, mid, CONFIG.REWARD_MAX_SPREAD);

  const postedUSD = win.makerBids.reduce((s, b) => s + b.shares * b.price, 0);
  win.estimatedReward = estimateDailyReward(postedUSD, win.rewardScore);

  // Accumulate simulated liquidity reward (tiny drip each tick)
  const tickReward = win.estimatedReward / (86400 / (CONFIG.TICK_MS / 1000));
  state.totalRewardsEarned += tickReward;
  state.dailyRewardAccrual += tickReward;
  if (tickReward > 0 && Math.random() < 0.002) {
    log('reward', `🌟 LIQ REWARD drip +$${tickReward.toFixed(5)} | ${win.asset.toUpperCase()} score=${win.rewardScore.toFixed(3)}`);
  }
}

// ─── SCALP ENGINE ─────────────────────────────────────────────────────────────
// Tighter spread = higher reward score. Lower fill rate but more consistent reward.

async function runScalpQuotes(win) {
  const secsLeft = secondsLeft();
  if (secsLeft < CONFIG.SCALP_MIN_SECS_LEFT) return;

  const p = state.prices[win.asset];
  if (!p) return;
  const mid    = p.up;
  const halfSp = CONFIG.SCALP_HALF;

  // Tick cooldowns
  Object.keys(win.bidCooldowns).forEach(k => {
    // handled in maker engine
  });

  // Adverse selection guard: if mid moved sharply, pause scalp
  if (win.scalpMid !== null && Math.abs(mid - win.scalpMid) > CONFIG.ADV_SEL_THRESHOLD) {
    win.scalpBids = [];
    win.scalpAsks = [];
    win.scalpMid = null;
    log('warn', `⚡ ADV-SEL STOP ${win.asset.toUpperCase()} | mid moved ${Math.abs(mid-(win.scalpMid||mid)).toFixed(3)}`);
    return;
  }

  if (secsLeft > CONFIG.EMERGENCY_SECS && win.scalpBids.length < CONFIG.SCALP_MAX_BIDS && canPostMoreBids()) {
    const bidPrice = parseFloat((mid - halfSp).toFixed(4));
    const alreadyPosted = win.scalpBids.some(b => Math.abs(b.price - bidPrice) < 0.003);

    if (!alreadyPosted && bidPrice > 0.03 && bidPrice < 0.97) {
      const shares = calcShares(CONFIG.SCALP_RISK, bidPrice, CONFIG.SCALP_MIN_SH, CONFIG.SCALP_MAX_SH);
      win.scalpBids.push({
        id: uuidv4(), side: 'UP', price: bidPrice, shares,
        postedTick: win.tickCount, queuePos: win.scalpBids.length + 1,
        filled: false,
      });
      win.scalpMid = mid;
    }
  }

  // Fill & move to asks
  const scalpFilled = [];
  win.scalpBids.forEach(bid => {
    if (bid.filled || win.tickCount <= bid.postedTick) return;
    const fillProb = simMakerFillProb(bid.price, mid, bid.queuePos) * 0.8;
    if (Math.random() < fillProb) { bid.filled = true; scalpFilled.push(bid); }
  });

  for (const bid of scalpFilled) {
    const fillShares = simPartialFill(bid.shares);
    await execDemoBuy(win, bid.side, fillShares, bid.price, true);
    const askPrice = parseFloat((bid.price + CONFIG.SCALP_HALF * 2).toFixed(4));
    win.scalpAsks.push({
      id: uuidv4(), side: bid.side, buyPrice: bid.price, askPrice,
      shares: fillShares, costBasis: fillShares * bid.price,
      postedTick: win.tickCount, queuePos: win.scalpAsks.length + 1, filled: false,
    });
    win.scalpBids = win.scalpBids.filter(b => b.id !== bid.id);
  }

  // Exit asks
  const scalpSold = [];
  win.scalpAsks.forEach(ask => {
    if (ask.filled || win.tickCount <= ask.postedTick) return;
    const fillProb = simMakerAskFillProb(ask.askPrice, mid, ask.queuePos) * 0.8;
    if (Math.random() < fillProb) { ask.filled = true; scalpSold.push(ask); }
  });

  for (const ask of scalpSold) {
    await execDemoSell(win, ask.side, ask.shares, ask.askPrice, ask.costBasis, true);
    win.scalpAsks = win.scalpAsks.filter(a => a.id !== ask.id);
  }

  // Scalp reward contribution (tighter = better score)
  const scalpPostedUSD = win.scalpBids.reduce((s, b) => s + b.shares * b.price, 0);
  const scalpScore = halfSp < 0.02 ? estimateLiquidityRewardScore(mid - halfSp, mid, CONFIG.REWARD_MAX_SPREAD) : 0;
  win.estimatedReward += estimateDailyReward(scalpPostedUSD, scalpScore);
}

// ─── EMERGENCY FLATTEN ────────────────────────────────────────────────────────
// Near expiry: close all open asks at market (taker fee applies)

async function emergencyFlatten(win) {
  const p = state.prices[win.asset];
  if (!p) return;

  log('warn', `🚨 EMERGENCY FLATTEN ${win.asset.toUpperCase()} | ${secondsLeft()}s left`);

  for (const ask of [...win.makerAsks, ...win.scalpAsks]) {
    const curMid = p.up;
    // Sell at mid (taker, unfavorable)
    await execDemoSell(win, ask.side, ask.shares, curMid, ask.costBasis, false);
  }

  // Clear all
  win.makerBids  = []; win.makerAsks  = [];
  win.scalpBids  = []; win.scalpAsks  = [];
}

// ─── WINDOW LIFECYCLE ─────────────────────────────────────────────────────────

async function processWindow(asset) {
  const win     = state.windows[asset];
  const secsLeft = secondsLeft();
  const wTs     = currentWindowTs();
  const slug    = makeSlug(asset, wTs);

  // Update window metadata
  win.secsLeft = secsLeft;
  win.windowTs = wTs;
  win.slug     = slug;
  win.tickCount++;

  // Update window status
  if (secsLeft > CONFIG.EMERGENCY_SECS + 30) {
    win.status = secsLeft < 120 ? 'EXPIRING' : 'ACTIVE';
  } else {
    win.status = 'EXPIRING';
  }

  // Emergency flatten near expiry
  if (secsLeft <= CONFIG.EMERGENCY_SECS) {
    if (win.makerAsks.length > 0 || win.scalpAsks.length > 0) {
      await emergencyFlatten(win);
    }
    // Cancel open bids (not filled, refund cost = 0 since only fills deduct)
    win.makerBids = [];
    win.scalpBids = [];
    win.status = 'CLOSING';
    return;
  }

  // Run quote engines
  await runMakerQuotes(win);
  await runScalpQuotes(win);

  // Compute unrealized PnL on open asks
  const curMid = state.prices[asset]?.up ?? 0.50;
  win.unrealizedPnl = [...win.makerAsks, ...win.scalpAsks].reduce((s, a) => {
    return s + a.shares * (curMid - a.buyPrice);
  }, 0);
}

// ─── WINDOW RESET (new 15m period) ───────────────────────────────────────────

function resetWindowIfNeeded(asset) {
  const win = state.windows[asset];
  const wTs = currentWindowTs();
  if (win.windowTs && win.windowTs !== wTs) {
    const pnl  = win.realizedPnl;
    const prev = { ...win, orders: undefined };
    state.history.unshift({ ts: win.windowTs, asset, pnl, roundTrips: win.roundTrips, feePaid: win.feePaid, rewardEstimate: win.estimatedReward });
    if (state.history.length > 200) state.history.pop();

    // Reset window state
    state.windows[asset] = makeWindowState(asset);
    state.windows[asset].windowTs = wTs;
    state.windows[asset].status   = 'ACTIVE';

    // Snap equity
    state.equity.push({ ts: Date.now(), capital: state.settledCapital });
    if (state.equity.length > 500) state.equity.shift();

    log('info', `🔄 NEW WINDOW ${asset.toUpperCase()} | prev PnL=${pnl>=0?'+':''}$${pnl.toFixed(2)} | cap=$${state.capital.toFixed(2)}`);
  }
}

// ─── MAIN TICK ────────────────────────────────────────────────────────────────

async function tick() {
  globalTick++;
  await updateRealPrices();

  for (const asset of CONFIG.ASSETS) {
    resetWindowIfNeeded(asset);
    await processWindow(asset);
  }

  // Snapshot equity every 24 ticks (~60s)
  if (globalTick % 24 === 0) {
    state.equity.push({ ts: Date.now(), capital: state.settledCapital });
    if (state.equity.length > 500) state.equity.shift();
  }

  emitter.emit('state_update', getPublicState());
}

// ─── PUBLIC STATE BUILDER ─────────────────────────────────────────────────────

function getPublicState() {
  const totalPnl   = state.capital - state.startCapital;
  const totalRet   = totalPnl / state.startCapital * 100;
  const secsLeft   = secondsLeft();
  const secsInto   = secondsIntoWindow();
  const sessionMs  = Date.now() - state.sessionStart;

  const windows = {};
  CONFIG.ASSETS.forEach(a => {
    const win = state.windows[a];
    const p   = state.prices[a];
    windows[a] = {
      status:         win.status,
      secsLeft:       win.secsLeft,
      slug:           win.slug,
      upPrice:        p?.up   ?? null,
      downPrice:      p?.down ?? null,
      spotPrice:      state.spotPrices[a],
      realizedPnl:    win.realizedPnl,
      unrealizedPnl:  win.unrealizedPnl,
      feePaid:        win.feePaid,
      rewardScore:    win.rewardScore,
      estimatedReward: win.estimatedReward,
      makerRebates:   win.makerRebates,
      tradeCount:     win.tradeCount,
      roundTrips:     win.roundTrips,
      openBids:       win.makerBids.length + win.scalpBids.length,
      openAsks:       win.makerAsks.length + win.scalpAsks.length,
      openBidsDetail: [...win.makerBids, ...win.scalpBids].map(b => ({
        price: b.price, shares: b.shares, type: win.makerBids.includes(b) ? 'maker' : 'scalp',
      })),
      openAsksDetail: [...win.makerAsks, ...win.scalpAsks].map(a2 => ({
        buyPrice: a2.buyPrice, askPrice: a2.askPrice, shares: a2.shares,
        unrealized: a2.shares * ((p?.up ?? a2.buyPrice) - a2.buyPrice),
        type: win.makerAsks.includes(a2) ? 'maker' : 'scalp',
      })),
    };
  });

  return {
    mode:          'DEMO',
    capital:       parseFloat(state.settledCapital.toFixed(2)),
    startCapital:  state.startCapital,
    totalPnl:      parseFloat(totalPnl.toFixed(2)),
    totalReturn:   parseFloat(totalRet.toFixed(3)),
    totalRoundTrips: state.totalRoundTrips,
    totalFeesPaid:   parseFloat(state.totalFeesPaid.toFixed(4)),
    totalRewardsEarned: parseFloat(state.totalRewardsEarned.toFixed(4)),
    totalMakerRebates: parseFloat(state.totalMakerRebates.toFixed(4)),
    dailyRewardAccrual: parseFloat(state.dailyRewardAccrual.toFixed(4)),
    openExposure:    parseFloat(state.openExposure.toFixed(2)),
    sessionMs,
    secsLeft,
    secsInto,
    windows,
    equity:    state.equity.slice(-120),
    history:   state.history.slice(0, 50),
    logs:      state.logs.slice(0, 60),
    tradeLog:  state.tradeLog.slice(0, 30),
    tick:      globalTick,
    config: {
      makerSpread:    CONFIG.MAKER_SPREAD,
      makerHalf:      CONFIG.MAKER_HALF,
      scalpHalf:      CONFIG.SCALP_HALF,
      maxExposurePct: CONFIG.MAX_EXPOSURE_PCT,
      rewardMaxSpread: CONFIG.REWARD_MAX_SPREAD,
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

app.get('/api/state', (req, res) => res.json(getPublicState()));
app.get('/api/health', (req, res) => res.json({ ok: true, tick: globalTick, capital: state.settledCapital }));

// Config update endpoint (for dashboard controls)
app.post('/api/config', (req, res) => {
  const { makerHalf, scalpHalf, maxExposurePct } = req.body;
  if (makerHalf     !== undefined) { CONFIG.MAKER_HALF = parseFloat(makerHalf);  CONFIG.MAKER_SPREAD = CONFIG.MAKER_HALF * 2; }
  if (scalpHalf     !== undefined)   CONFIG.SCALP_HALF = parseFloat(scalpHalf);
  if (maxExposurePct !== undefined)  CONFIG.MAX_EXPOSURE_PCT = parseFloat(maxExposurePct);
  log('info', `⚙️ CONFIG UPDATE | makerHalf=${CONFIG.MAKER_HALF} scalpHalf=${CONFIG.SCALP_HALF} maxExp=${CONFIG.MAX_EXPOSURE_PCT}`);
  res.json({ ok: true });
});

wss.on('connection', (ws) => {
  log('info', '🔌 Dashboard connected');
  ws.send(JSON.stringify({ type: 'state', payload: getPublicState() }));

  const onUpdate = (s) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', payload: s }));
    }
  };
  const onLog = (entry) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log', payload: entry }));
    }
  };

  emitter.on('state_update', onUpdate);
  emitter.on('log', onLog);

  ws.on('close', () => {
    emitter.off('state_update', onUpdate);
    emitter.off('log', onLog);
  });
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────

initState();
log('info', `🚀 Polymarket MM Bot DEMO | Capital=$${CONFIG.DEMO_CAPITAL} | Assets: ${CONFIG.ASSETS.join(',').toUpperCase()}`);
log('info', `📐 Strategy: Maker=${CONFIG.MAKER_SPREAD*100}¢ spread | Scalp=${CONFIG.SCALP_HALF*2*100}¢ spread | MaxExp=${CONFIG.MAX_EXPOSURE_PCT*100}%`);
log('info', `🌟 Rewards: Liq rewards (quadratic scoring) + Maker rebates (~${CONFIG.REBATE_RATE*100}% of taker fee)`);

setInterval(tick, CONFIG.TICK_MS);

server.listen(CONFIG.PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  POLYMARKET MARKET MAKER BOT — DEMO MODE             ║`);
  console.log(`║  Dashboard: http://localhost:${CONFIG.PORT}                    ║`);
  console.log(`║  Capital: $${CONFIG.DEMO_CAPITAL.toLocaleString()} | Assets: BTC/ETH/SOL       ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
});
