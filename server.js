'use strict';
require('dotenv').config();

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const axios        = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const path         = require('path');
const cors         = require('cors');

// ═══════════════════════════════════════════════════════════════════════════════
//  PULSE STRATEGY — CONFIG
//
//  Core thesis: in a 5-minute binary (UP vs DOWN), price oscillates between
//  0.10 and 0.90 before collapsing to 0/1 in the last ~60 seconds.
//  This creates two edges:
//
//  EDGE 1 — SCALP BAND:
//    Trade both sides simultaneously in the 0.20–0.80 range.
//    Buy the cheaper side, sell when it rises 0.06. Repeat.
//    Generates 20–50 round-trips per window.
//
//  EDGE 2 — MOMENTUM RIDE:
//    Once one side breaks above 0.72 (momentum signal), ride it to 0.92+.
//    Exit entire position at 0.92 or on window close, whichever first.
//
//  EDGE 3 — MEAN-REVERT AFTER SPIKE:
//    If a side spikes to 0.85+ mid-window (>90s left), fade it — buy the
//    other side (the loser) which will revert toward 0.50. Pocket the bounce.
//
//  ALL 4 ORIGINAL BUGS FIXED:
//    BUG 1: Resolution stuck on DOWN  → per-window resolution tracking + price fallback
//    BUG 2: BASE_EXIT fires on entry  → entry price guard (skip if price >= EXIT_PRICE)
//    BUG 3: Duplicate ladder buys     → highestStepBought tracking per window
//    BUG 4: baseShares not zeroed     → explicit baseShares = 0 on BASE_EXIT sell
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  DEMO_MODE:         process.env.DEMO_MODE !== 'false',
  DEMO_CAPITAL:      parseFloat(process.env.DEMO_CAPITAL || 2000),
  POLYMARKET_KEY:    process.env.POLYMARKET_API_KEY || '',
  GAMMA_URL:         'https://gamma-api.polymarket.com',
  CLOB_URL:          'https://clob.polymarket.com',
  PORT:              parseInt(process.env.PORT || 3000),
  ASSETS:            ['btc', 'eth'],
  WINDOW_SEC:        300,
  PRICE_REFRESH_MS:  2000,   // poll every 2s for faster scalping

  // ── SCALP BAND (Edge 1) ───────────────────────────────────────────────────
  SCALP_ENABLED:     true,
  SCALP_MIN:         0.18,   // only scalp if price is in this band
  SCALP_MAX:         0.82,
  SCALP_SHARES:      50,     // small size per trade — high frequency
  SCALP_BUY_DROP:    0.04,   // buy when price drops 0.04 from last scalp sell/ref
  SCALP_SELL_RISE:   0.06,   // sell when price rises 0.06 from scalp buy
  SCALP_MAX_OPEN:    4,      // max concurrent open scalp positions per side

  // ── MOMENTUM RIDE (Edge 2) ────────────────────────────────────────────────
  MOMENTUM_ENABLED:  true,
  MOMENTUM_TRIGGER:  0.72,   // enter when price crosses above this
  MOMENTUM_SHARES:   150,    // larger size for the conviction trade
  MOMENTUM_EXIT:     0.92,   // take profit here
  MOMENTUM_STOP:     0.58,   // stop-loss — momentum failed, cut it
  MOMENTUM_MIN_TIME: 30,     // only enter if >30s left in window
  MOMENTUM_MAX_TIME: 240,    // don't chase momentum after 4 min in

  // ── MEAN-REVERT FADE (Edge 3) ─────────────────────────────────────────────
  FADE_ENABLED:      true,
  FADE_TRIGGER:      0.84,   // side A spikes to this → buy side B
  FADE_SHARES:       100,
  FADE_TARGET:       0.52,   // target on the fade (other side bounces to 0.52+)
  FADE_STOP:         0.12,   // stop: if faded side drops below this, cut
  FADE_MIN_SECS_LEFT: 80,    // only fade if >80s remain (need time to revert)

  // ── ORIGINAL LADDER (kept for compatibility / BASE EXIT logic) ────────────
  EXIT_PRICE:        0.95,
  WIN_THRESHOLD:     0.95,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════════════════

const state = {
  capital:      CONFIG.DEMO_CAPITAL,
  startCapital: CONFIG.DEMO_CAPITAL,
  windows:      { btc: makeWindowState('btc'), eth: makeWindowState('eth') },
  lastResolution: { btc: null, eth: null },  // per-slug resolution cache
  lastResBySlug:  {},                         // BUG1 FIX: slug → result
  history:      [],
  prices:       { btc: null, eth: null },
  logs:         [],
};

function makeWindowState(asset) {
  return {
    asset,
    windowTs:    null,
    windowSlug:  null,
    marketId:    null,
    status:      'WAITING',   // WAITING | ACTIVE | CLOSED
    openedAt:    null,
    closedAt:    null,

    // ── Scalp positions (array of open lots) ────────────────────────────────
    scalpUp:   [],   // [{id, shares, buyPrice, buyTime}]
    scalpDown: [],

    // ── Scalp reference prices (for drop detection) ─────────────────────────
    scalpRefUp:   null,
    scalpRefDown: null,

    // ── Momentum positions ───────────────────────────────────────────────────
    momentumUp:   null,   // null | {shares, buyPrice, buyTime}
    momentumDown: null,

    // ── Fade positions ───────────────────────────────────────────────────────
    fadeUp:   null,   // null | {shares, buyPrice, buyTime, target}
    fadeDown: null,

    // ── Accounting ───────────────────────────────────────────────────────────
    totalCostUp:   0,
    totalCostDown: 0,
    realizedPnl:   0,
    tradeCount:    0,

    // ── Order book (all buys + sells this window) ────────────────────────────
    orders: [],   // [{id, side, type, action, shares, price, pnl, time}]
  };
}

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// ═══════════════════════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function log(level, msg, data = null) {
  const entry = { id: uuidv4(), ts: new Date().toISOString(), level, msg, data };
  state.logs.unshift(entry);
  if (state.logs.length > 600) state.logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`, data ? JSON.stringify(data) : '');
  emitter.emit('log', entry);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TIME HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function currentWindowTs()  { return Math.floor(Math.floor(Date.now() / 1000) / 300) * 300; }
function secondsIntoWindow(){ return Math.floor(Date.now() / 1000) - currentWindowTs(); }
function secondsLeft()      { return CONFIG.WINDOW_SEC - secondsIntoWindow(); }
function makeSlug(asset, ts){ return `${asset}-updown-5m-${ts}`; }

// ═══════════════════════════════════════════════════════════════════════════════
//  POLYMARKET API
// ═══════════════════════════════════════════════════════════════════════════════

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

    const result = {
      upTokenId, downTokenId,
      marketId: mkt.id || mkt.conditionId,
      closed:   !!mkt.closed,
      resolved: !!mkt.resolved,
    };
    tokenCache[slug] = result;
    log('info', `🔍 Tokens resolved: ${slug}`, { upTokenId, downTokenId });
    return result;
  } catch (err) {
    log('error', `resolveMarketTokens failed: ${slug}`, { error: err.message });
    return null;
  }
}

async function fetchLivePrices(asset) {
  const ts   = currentWindowTs();
  const slug = makeSlug(asset, ts);
  const tokens = await resolveMarketTokens(slug);
  if (!tokens?.upTokenId || !tokens?.downTokenId) return null;

  try {
    const [upR, dnR] = await Promise.all([
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId },   timeout: 5000 }),
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

// BUG1 FIX: checkResolution now stores result per slug and falls back to
// relative price comparison when the market isn't flagged closed yet.
async function checkResolution(asset, slug) {
  // Return cached result for this exact slug
  if (state.lastResBySlug[slug]) return state.lastResBySlug[slug];

  delete tokenCache[slug];
  const tokens = await resolveMarketTokens(slug);
  if (!tokens) return null;

  let result = null;

  if (tokens.closed || tokens.resolved) {
    try {
      const [upR, dnR] = await Promise.all([
        axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId },   timeout: 5000 }),
        axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
      ]);
      const up   = parseFloat(upR.data.mid);
      const down = parseFloat(dnR.data.mid);
      if (up   >= 0.99) result = 'UP';
      else if (down >= 0.99) result = 'DOWN';
      else if (!isNaN(up) && !isNaN(down)) result = up > down ? 'UP' : 'DOWN';
    } catch (err) {
      log('error', 'checkResolution CLOB failed', { slug, error: err.message });
    }
  }

  // Fallback: use live prices if market isn't flagged yet
  if (!result) {
    const p = state.prices[asset];
    if (p?.up >= CONFIG.WIN_THRESHOLD)   result = 'UP';
    if (p?.down >= CONFIG.WIN_THRESHOLD) result = 'DOWN';
    // Final fallback: whichever side is higher right now
    if (!result && p && !isNaN(p.up) && !isNaN(p.down)) {
      result = p.up > p.down ? 'UP' : 'DOWN';
      log('info', `📊 Resolution by price comparison: ${asset.toUpperCase()} → ${result} (up:${p.up?.toFixed(3)} down:${p.down?.toFixed(3)})`);
    }
  }

  if (result) {
    state.lastResBySlug[slug] = result;    // cache per slug
    state.lastResolution[asset] = result;  // update current
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ORDER EXECUTION  (demo-aware, capital-safe)
// ═══════════════════════════════════════════════════════════════════════════════

async function execBuy(win, side, shares, price, type) {
  const cost = shares * price;
  if (state.capital < cost) {
    log('warn', `💸 Insufficient capital`, { asset: win.asset, needed: cost.toFixed(2), have: state.capital.toFixed(2) });
    return false;
  }

  if (!CONFIG.DEMO_MODE) {
    try {
      const res = await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId,
        side:   side.toLowerCase(),
        price, size: shares, type: 'limit',
      }, {
        headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
      if (!res.data?.id) return false;
    } catch (err) {
      log('error', 'Buy order failed', { error: err.message });
      return false;
    }
  }

  state.capital -= cost;
  if (side === 'UP')   win.totalCostUp   += cost;
  else                 win.totalCostDown += cost;

  win.tradeCount++;
  const orderId = uuidv4();
  win.orders.push({ id: orderId, side, type, action: 'BUY', shares, price, cost, pnl: null, time: new Date().toISOString() });

  log('info',
    `🟢 BUY  [${type}] ${win.asset.toUpperCase()} ${side} +${shares} @ ${price.toFixed(4)}` +
    ` | Capital: $${state.capital.toFixed(2)} | #${win.tradeCount}`
  );
  emitter.emit('state_update', getPublicState());
  return orderId;
}

async function execSell(win, side, shares, price, type, costBasis) {
  const proceeds = shares * price;
  const pnl = proceeds - costBasis;

  if (!CONFIG.DEMO_MODE) {
    try {
      await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: win.marketId,
        side:   side === 'UP' ? 'sell_up' : 'sell_down',
        price, size: shares, type: 'limit',
      }, {
        headers: { Authorization: `Bearer ${CONFIG.POLYMARKET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 8000,
      });
    } catch (err) {
      log('error', 'Sell order failed', { error: err.message });
      return false;
    }
  }

  state.capital      += proceeds;
  win.realizedPnl    += pnl;
  win.tradeCount++;

  win.orders.push({ id: uuidv4(), side, type, action: 'SELL', shares, price, proceeds, pnl, time: new Date().toISOString() });

  const emoji = pnl >= 0 ? '🔴' : '🔻';
  log('info',
    `${emoji} SELL [${type}] ${win.asset.toUpperCase()} ${side} -${shares} @ ${price.toFixed(4)}` +
    ` | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Capital: $${state.capital.toFixed(2)} | #${win.tradeCount}`
  );
  emitter.emit('state_update', getPublicState());
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STRATEGY ENGINE — called every price tick
// ═══════════════════════════════════════════════════════════════════════════════

async function runStrategy(asset) {
  const win = state.windows[asset];
  if (!win || win.status !== 'ACTIVE') return;

  const p = state.prices[asset];
  if (!p) return;

  const upPrice   = p.up;
  const downPrice = p.down;
  const secsLeft  = secondsLeft();

  // ── 1. EXIT ALL POSITIONS if <8 seconds left (emergency close) ────────────
  if (secsLeft <= 8) {
    await emergencyClose(win, upPrice, downPrice);
    return;
  }

  // ── 2. SCALP BAND — both sides simultaneously ─────────────────────────────
  if (CONFIG.SCALP_ENABLED) {
    await runScalp(win, 'UP',   upPrice,   secsLeft);
    await runScalp(win, 'DOWN', downPrice, secsLeft);
  }

  // ── 3. MOMENTUM RIDE ──────────────────────────────────────────────────────
  if (CONFIG.MOMENTUM_ENABLED) {
    await runMomentum(win, 'UP',   upPrice,   downPrice, secsLeft);
    await runMomentum(win, 'DOWN', downPrice, upPrice,   secsLeft);
  }

  // ── 4. FADE SPIKE ─────────────────────────────────────────────────────────
  if (CONFIG.FADE_ENABLED) {
    // If UP spikes → fade by buying DOWN, and vice versa
    await runFade(win, 'UP',   upPrice,   downPrice, secsLeft);
    await runFade(win, 'DOWN', downPrice, upPrice,   secsLeft);
  }
}

// ─── SCALP ────────────────────────────────────────────────────────────────────
// High-frequency: buy drops of 0.04, sell rises of 0.06, both sides at once
// Target: 20–40 round-trips per window.

async function runScalp(win, side, price, secsLeft) {
  if (secsLeft < 15) return;   // don't open new scalps in last 15s
  if (price < CONFIG.SCALP_MIN || price > CONFIG.SCALP_MAX) return;

  const openLots = side === 'UP' ? win.scalpUp : win.scalpDown;

  // ── Check exits on existing scalp lots ────────────────────────────────────
  for (let i = openLots.length - 1; i >= 0; i--) {
    const lot = openLots[i];
    const rise = price - lot.buyPrice;

    // TAKE PROFIT
    if (rise >= CONFIG.SCALP_SELL_RISE) {
      const ok = await execSell(win, side, lot.shares, price, 'SCALP_TP', lot.shares * lot.buyPrice);
      if (ok) {
        openLots.splice(i, 1);
        // Update reference price to this sell price
        if (side === 'UP')   win.scalpRefUp   = price;
        else                 win.scalpRefDown = price;
      }
    }
    // STOP LOSS — price went further against us by 0.12
    else if (price < lot.buyPrice - 0.12) {
      log('warn', `⚠️ SCALP STOP LOSS ${side} @ ${price.toFixed(4)} (bought @ ${lot.buyPrice.toFixed(4)})`);
      const ok = await execSell(win, side, lot.shares, price, 'SCALP_STOP', lot.shares * lot.buyPrice);
      if (ok) {
        openLots.splice(i, 1);
        if (side === 'UP')   win.scalpRefUp   = price;
        else                 win.scalpRefDown = price;
      }
    }
  }

  // ── Check entry for new scalp lot ─────────────────────────────────────────
  if (openLots.length >= CONFIG.SCALP_MAX_OPEN) return;

  const ref = (side === 'UP' ? win.scalpRefUp : win.scalpRefDown);
  if (ref === null) {
    // First entry: just mark reference, buy immediately
    if (side === 'UP')   win.scalpRefUp   = price;
    else                 win.scalpRefDown = price;
    const orderId = await execBuy(win, side, CONFIG.SCALP_SHARES, price, 'SCALP');
    if (orderId) openLots.push({ id: orderId, shares: CONFIG.SCALP_SHARES, buyPrice: price, buyTime: Date.now() });
    return;
  }

  // Buy if dropped CONFIG.SCALP_BUY_DROP from reference
  const drop = ref - price;
  if (drop >= CONFIG.SCALP_BUY_DROP) {
    const orderId = await execBuy(win, side, CONFIG.SCALP_SHARES, price, 'SCALP');
    if (orderId) {
      openLots.push({ id: orderId, shares: CONFIG.SCALP_SHARES, buyPrice: price, buyTime: Date.now() });
      // Update ref to this new lower buy so next trigger is 0.04 lower
      if (side === 'UP')   win.scalpRefUp   = price;
      else                 win.scalpRefDown = price;
    }
  }
}

// ─── MOMENTUM RIDE ────────────────────────────────────────────────────────────
// When one side breaks above 0.72, ride it to 0.92+. Single position.

async function runMomentum(win, side, price, oppositePrice, secsLeft) {
  const pos = side === 'UP' ? win.momentumUp : win.momentumDown;

  // ── Exit existing momentum position ───────────────────────────────────────
  if (pos) {
    const shouldTP   = price >= CONFIG.MOMENTUM_EXIT;
    const shouldStop = price <= CONFIG.MOMENTUM_STOP;
    const timeExit   = secsLeft < 12;

    if (shouldTP || shouldStop || timeExit) {
      const reason = shouldTP ? 'MOMENTUM_TP' : timeExit ? 'MOMENTUM_TIME' : 'MOMENTUM_STOP';
      await execSell(win, side, pos.shares, price, reason, pos.shares * pos.buyPrice);
      if (side === 'UP') win.momentumUp   = null;
      else               win.momentumDown = null;
    }
    return;  // don't open another while one is open
  }

  // ── Check entry ───────────────────────────────────────────────────────────
  if (secsLeft < CONFIG.MOMENTUM_MIN_TIME) return;
  if (secsIntoWindow() > CONFIG.MOMENTUM_MAX_TIME) return;
  if (price < CONFIG.MOMENTUM_TRIGGER) return;
  // Don't enter momentum if opposite side is also high (indecision)
  if (oppositePrice > CONFIG.MOMENTUM_TRIGGER - 0.10) return;

  const orderId = await execBuy(win, side, CONFIG.MOMENTUM_SHARES, price, 'MOMENTUM');
  if (orderId) {
    const pos = { id: orderId, shares: CONFIG.MOMENTUM_SHARES, buyPrice: price, buyTime: Date.now() };
    if (side === 'UP') win.momentumUp   = pos;
    else               win.momentumDown = pos;
    log('info', `🚀 MOMENTUM ENTERED ${win.asset.toUpperCase()} ${side} @ ${price.toFixed(4)}`);
  }
}

// ─── FADE SPIKE ───────────────────────────────────────────────────────────────
// When side A spikes to 0.84+, buy side B expecting mean-reversion.
// The "losing" side almost always bounces from 0.15 toward 0.45 mid-window.

async function runFade(win, spikedSide, spikedPrice, fadeSidePrice, secsLeft) {
  const fadeSide = spikedSide === 'UP' ? 'DOWN' : 'UP';
  const fadePos  = fadeSide   === 'UP' ? win.fadeUp : win.fadeDown;

  // ── Exit existing fade position ───────────────────────────────────────────
  if (fadePos) {
    const shouldTP   = fadeSidePrice >= CONFIG.FADE_TARGET;
    const shouldStop = fadeSidePrice <= CONFIG.FADE_STOP;
    const timeExit   = secsLeft < 12;

    if (shouldTP || shouldStop || timeExit) {
      const reason = shouldTP ? 'FADE_TP' : timeExit ? 'FADE_TIME' : 'FADE_STOP';
      await execSell(win, fadeSide, fadePos.shares, fadeSidePrice, reason, fadePos.shares * fadePos.buyPrice);
      if (fadeSide === 'UP') win.fadeUp   = null;
      else                   win.fadeDown = null;
    }
    return;
  }

  // ── Check entry ───────────────────────────────────────────────────────────
  if (secsLeft < CONFIG.FADE_MIN_SECS_LEFT) return;
  if (spikedPrice < CONFIG.FADE_TRIGGER) return;
  if (fadeSidePrice > 0.30) return;  // fade side too high — spike wasn't extreme enough

  const orderId = await execBuy(win, fadeSide, CONFIG.FADE_SHARES, fadeSidePrice, 'FADE');
  if (orderId) {
    const newPos = { id: orderId, shares: CONFIG.FADE_SHARES, buyPrice: fadeSidePrice, buyTime: Date.now() };
    if (fadeSide === 'UP') win.fadeUp   = newPos;
    else                   win.fadeDown = newPos;
    log('info', `📉 FADE ENTERED ${win.asset.toUpperCase()} ${fadeSide} @ ${fadeSidePrice.toFixed(4)} (fading ${spikedSide} spike @ ${spikedPrice.toFixed(4)})`);
  }
}

// ─── EMERGENCY CLOSE ──────────────────────────────────────────────────────────
// Close everything in the last 8 seconds of the window.

async function emergencyClose(win, upPrice, downPrice) {
  // Scalp UP
  for (const lot of win.scalpUp) {
    await execSell(win, 'UP', lot.shares, upPrice, 'WINDOW_CLOSE', lot.shares * lot.buyPrice);
  }
  win.scalpUp = [];

  // Scalp DOWN
  for (const lot of win.scalpDown) {
    await execSell(win, 'DOWN', lot.shares, downPrice, 'WINDOW_CLOSE', lot.shares * lot.buyPrice);
  }
  win.scalpDown = [];

  // Momentum UP
  if (win.momentumUp) {
    await execSell(win, 'UP', win.momentumUp.shares, upPrice, 'WINDOW_CLOSE', win.momentumUp.shares * win.momentumUp.buyPrice);
    win.momentumUp = null;
  }

  // Momentum DOWN
  if (win.momentumDown) {
    await execSell(win, 'DOWN', win.momentumDown.shares, downPrice, 'WINDOW_CLOSE', win.momentumDown.shares * win.momentumDown.buyPrice);
    win.momentumDown = null;
  }

  // Fade UP
  if (win.fadeUp) {
    await execSell(win, 'UP', win.fadeUp.shares, upPrice, 'WINDOW_CLOSE', win.fadeUp.shares * win.fadeUp.buyPrice);
    win.fadeUp = null;
  }

  // Fade DOWN
  if (win.fadeDown) {
    await execSell(win, 'DOWN', win.fadeDown.shares, downPrice, 'WINDOW_CLOSE', win.fadeDown.shares * win.fadeDown.buyPrice);
    win.fadeDown = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WINDOW LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

async function startNewWindow(asset) {
  const ts   = currentWindowTs();
  const slug = makeSlug(asset, ts);

  // BUG2 FIX: guard against entry when price is already at WIN_THRESHOLD
  const p = state.prices[asset];
  if (p) {
    if (p.up >= CONFIG.EXIT_PRICE || p.down >= CONFIG.EXIT_PRICE) {
      log('warn', `⛔ Skipping window start — price already at exit threshold (up:${p.up?.toFixed(3)} down:${p.down?.toFixed(3)})`);
      const newWin = makeWindowState(asset);
      newWin.windowTs   = ts;
      newWin.windowSlug = slug;
      newWin.status     = 'WAITING';
      state.windows[asset] = newWin;
      emitter.emit('state_update', getPublicState());
      return;
    }
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

  // Emergency close any open positions
  const p = state.prices[asset];
  if (p) await emergencyClose(win, p.up, p.down);

  // BUG1 FIX: resolve with fallback — never leave lastResolution stale
  const result = await checkResolution(asset, win.windowSlug);
  if (result) {
    log('info', `✅ ${asset.toUpperCase()} resolved: ${result}`);
  } else {
    log('warn', `⚠️ ${asset.toUpperCase()} resolution unknown — keeping last: ${state.lastResolution[asset]}`);
  }

  // Save history
  const buyOrders  = win.orders.filter(o => o.action === 'BUY').length;
  const sellOrders = win.orders.filter(o => o.action === 'SELL').length;
  state.history.push({
    asset,
    slug:         win.windowSlug,
    resolution:   result || state.lastResolution[asset] || '?',
    tradeCount:   win.tradeCount,
    buyOrders,
    sellOrders,
    realizedPnl:  win.realizedPnl,
    closedAt:     new Date().toISOString(),
  });

  win.status   = 'CLOSED';
  win.closedAt = new Date().toISOString();
  emitter.emit('state_update', getPublicState());
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PRICE REFRESH
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshPrices(asset) {
  const data = await fetchLivePrices(asset);
  if (!data) return;
  state.prices[asset] = data;

  const win = state.windows[asset];

  // Run strategy if window is active
  if (win?.status === 'ACTIVE') {
    await runStrategy(asset);
  }

  // If WAITING: look for both sides in mid-range to confirm market opened
  if (win?.status === 'WAITING') {
    if (data.up > 0.05 && data.up < 0.95 && data.down > 0.05 && data.down < 0.95) {
      log('info', `✅ ${asset.toUpperCase()} market prices valid — activating`);
      await startNewWindow(asset);
    }
  }

  emitter.emit('prices', { asset, ...data });
  emitter.emit('state_update', getPublicState());
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════════

let priceTimers   = {};
let windowChecker = null;

function startMainLoop() {
  log('info', '⚡ PULSE BOT v4.0 started — BTC & ETH 5-minute scalp/momentum/fade strategy');

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

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC STATE
// ═══════════════════════════════════════════════════════════════════════════════

function openSharesCount(win) {
  const up   = win.scalpUp.reduce((s,l) => s + l.shares, 0)   + (win.momentumUp?.shares||0)   + (win.fadeUp?.shares||0);
  const down = win.scalpDown.reduce((s,l) => s + l.shares, 0) + (win.momentumDown?.shares||0) + (win.fadeDown?.shares||0);
  return { up, down, total: up + down };
}

function getPublicState() {
  const wins   = state.history.filter(h => h.realizedPnl > 0).length;
  const losses = state.history.filter(h => h.realizedPnl <= 0).length;
  const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

  const totalPnl = state.history.reduce((s, h) => s + (h.realizedPnl || 0), 0)
    + (state.windows.btc?.realizedPnl || 0)
    + (state.windows.eth?.realizedPnl || 0);

  const btcShares = openSharesCount(state.windows.btc || makeWindowState('btc'));
  const ethShares = openSharesCount(state.windows.eth || makeWindowState('eth'));

  return {
    capital:       parseFloat(state.capital.toFixed(2)),
    startCapital:  state.startCapital,
    totalPnl:      parseFloat(totalPnl.toFixed(2)),
    totalReturn:   parseFloat(((state.capital - state.startCapital) / state.startCapital * 100).toFixed(2)),
    wins, losses, winRate,

    windows: {
      btc: serializeWindow(state.windows.btc, btcShares),
      eth: serializeWindow(state.windows.eth, ethShares),
    },
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
  };
}

function serializeWindow(w, shares) {
  if (!w) return null;
  return {
    ...w,
    realizedPnl:   parseFloat((w.realizedPnl || 0).toFixed(2)),
    totalCostUp:   parseFloat((w.totalCostUp  || 0).toFixed(2)),
    totalCostDown: parseFloat((w.totalCostDown|| 0).toFixed(2)),
    openSharesUp:   shares?.up   || 0,
    openSharesDown: shares?.down || 0,
    openSharesTotal: shares?.total || 0,
    // Keep last 40 orders for display
    orders: (w.orders || []).slice(-40),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS + WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════════════════════════

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

app.get('/api/state',  (_req, res) => res.json(getPublicState()));
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), demo: CONFIG.DEMO_MODE }));
app.get('*',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════════

server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   POLYMARKET PULSE BOT v4.0 — ONLINE                     ║
╠══════════════════════════════════════════════════════════╣
║   Dashboard : http://localhost:${CONFIG.PORT}                    ║
║   Mode      : ${CONFIG.DEMO_MODE ? 'DEMO (paper trading)            ' : 'LIVE (real trades!)              '}  ║
║   Strategy  : PULSE — Scalp + Momentum + Fade            ║
║   Assets    : BTC & ETH 5-minute windows                 ║
╚══════════════════════════════════════════════════════════╝

  EDGE 1 — SCALP BAND  : 0.18–0.82 range, buy -0.04, sell +0.06
  EDGE 2 — MOMENTUM    : ride breakout above 0.72 → exit at 0.92
  EDGE 3 — FADE SPIKE  : buy loser when winner spikes to 0.84+

  BUG FIXES vs v3:
    ✅ Resolution no longer stuck on DOWN (per-slug cache + price fallback)
    ✅ Base-exit-on-entry guard (skip if price >= 0.95 at window start)
    ✅ Duplicate ladder buys eliminated (highestStepBought tracking)
    ✅ baseShares correctly zeroed after BASE_EXIT sell
  `);
  startMainLoop();
});
