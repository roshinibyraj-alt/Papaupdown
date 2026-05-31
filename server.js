'use strict';
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const axios      = require('axios');
const { v4: uuidv4 } = require('uuid');
const EventEmitter   = require('events');
const path       = require('path');
const cors       = require('cors');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  DEMO_MODE:        process.env.DEMO_MODE !== 'false',
  DEMO_CAPITAL:     parseFloat(process.env.DEMO_CAPITAL  || 2000),
  POLYMARKET_KEY:   process.env.POLYMARKET_API_KEY || '',
  GAMMA_URL:        'https://gamma-api.polymarket.com',
  CLOB_URL:         'https://clob.polymarket.com',
  PORT:             parseInt(process.env.PORT || 3000),
  ASSETS:           ['btc', 'eth'],

  // Ladder parameters
  BASE_SHARES:      100,      // always held, only sold at EXIT_PRICE
  LADDER_SHARES:    100,      // shares bought on each 0.05 drop
  DROP_STEP:        0.05,     // buy trigger: price dropped this much from last buy
  RISE_STEP:        0.10,     // sell trigger: price rose this much from last buy avg
  RANGE_MIN:        0.05,     // no buys below this
  RANGE_MAX:        0.90,     // no buys above this
  EXIT_PRICE:       0.95,     // base shares sold here
  WIN_THRESHOLD:    0.95,     // price above this = that side won the window
  WINDOW_SEC:       300,      // 5 minutes
  PRICE_REFRESH_MS: 3000,     // price poll interval
};

// ─── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  capital:       CONFIG.DEMO_CAPITAL,
  startCapital:  CONFIG.DEMO_CAPITAL,

  // Per-asset ladder state
  ladders: {
    btc: makeLadderState('btc'),
    eth: makeLadderState('eth'),
  },

  // Last resolved window per asset: null | 'UP' | 'DOWN'
  lastResolution: { btc: null, eth: null },

  // History of closed windows
  history: [],

  // Live prices
  prices: { btc: null, eth: null },

  // Logs
  logs: [],
};

function makeLadderState(asset) {
  return {
    asset,
    active:        false,       // is ladder running?
    side:          null,        // 'UP' | 'DOWN'
    windowTs:      null,        // current window timestamp
    windowSlug:    null,
    marketId:      null,

    // Position tracking
    baseShares:    0,           // always 100 once bought
    ladderShares:  0,           // additional shares from ladder buys
    totalShares:   0,           // baseShares + ladderShares

    baseBuyPrice:  null,        // price at which base was bought
    lastBuyPrice:  null,        // price of most recent ladder buy (drop reference)
    avgBuyPrice:   0,           // weighted average of ALL buys
    totalCost:     0,           // total money spent this window

    // Ladder levels bought so far
    levels:        [],          // [{price, shares, cost, type:'base'|'ladder', time}]

    // Sells done this window
    sells:         [],          // [{price, shares, proceeds, time, reason}]

    // P&L for this window
    realizedPnl:   0,
    status:        'WAITING',   // WAITING | ACTIVE | CLOSED
    openedAt:      null,
    closedAt:      null,

    // For detecting 0.05 drops and 0.10 rises
    lastSellPrice: null,        // reference price after a sell (for next drop calc)
  };
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// ─── LOGGING ───────────────────────────────────────────────────────────────────
function log(level, msg, data = null) {
  const entry = { id: uuidv4(), ts: new Date().toISOString(), level, msg, data };
  state.logs.unshift(entry);
  if (state.logs.length > 400) state.logs.pop();
  console.log(`[${level.toUpperCase()}] ${msg}`, data ? JSON.stringify(data) : '');
  emitter.emit('log', entry);
}

// ─── WINDOW / SLUG HELPERS ────────────────────────────────────────────────────
function currentWindowTs() {
  return Math.floor(Math.floor(Date.now() / 1000) / 300) * 300;
}
function secondsIntoWindow() {
  return Math.floor(Date.now() / 1000) - currentWindowTs();
}
function secondsLeft() {
  return CONFIG.WINDOW_SEC - secondsIntoWindow();
}
function makeSlug(asset, ts) {
  return `${asset}-updown-5m-${ts}`;
}

// ─── POLYMARKET API ────────────────────────────────────────────────────────────

// Cache: slug → { upTokenId, downTokenId, marketId }
const tokenCache = {};

async function resolveMarketTokens(slug) {
  if (tokenCache[slug]) return tokenCache[slug];

  try {
    const res = await axios.get(`${CONFIG.GAMMA_URL}/markets`, {
      params: { slug },
      timeout: 8000,
    });
    const list = Array.isArray(res.data) ? res.data : [res.data];
    const market = list.find(m => m && m.slug === slug);
    if (!market) {
      log('warn', `Gamma API: market not found for slug ${slug}`);
      return null;
    }

    const outcomes  = typeof market.outcomes     === 'string' ? JSON.parse(market.outcomes)     : (market.outcomes     || []);
    const tokenIds  = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || []);

    let upTokenId = null, downTokenId = null;
    outcomes.forEach((o, i) => {
      const n = (o || '').toLowerCase();
      if (n === 'up')   upTokenId   = tokenIds[i];
      if (n === 'down') downTokenId = tokenIds[i];
    });
    // fallback by index if outcome labels differ
    if (!upTokenId   && tokenIds[0]) upTokenId   = tokenIds[0];
    if (!downTokenId && tokenIds[1]) downTokenId = tokenIds[1];

    const result = {
      upTokenId,
      downTokenId,
      marketId:  market.id || market.conditionId,
      closed:    !!market.closed,
      resolved:  !!market.resolved,
      market,
    };
    tokenCache[slug] = result;
    log('info', `🔍 Market tokens resolved: ${slug}`, { upTokenId, downTokenId });
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
  if (!tokens || !tokens.upTokenId || !tokens.downTokenId) {
    log('warn', `fetchLivePrices: no token IDs for ${slug} — skipping`);
    return null;
  }

  try {
    const [upRes, downRes] = await Promise.all([
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId },   timeout: 5000 }),
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
    ]);

    const up   = parseFloat(upRes.data.mid);
    const down = parseFloat(downRes.data.mid);

    if (isNaN(up) || isNaN(down)) {
      log('warn', `fetchLivePrices: NaN midpoint for ${slug}`, { upRaw: upRes.data, downRaw: downRes.data });
      return null;
    }

    return { slug, marketId: tokens.marketId, up, down, live: true };
  } catch (err) {
    log('error', `fetchLivePrices CLOB midpoint failed: ${slug}`, { error: err.message });
    return null;
  }
}

async function checkResolution(asset, slug) {
  // Refresh cache for this slug (market may now be closed/resolved)
  delete tokenCache[slug];
  const tokens = await resolveMarketTokens(slug);
  if (!tokens) return null;

  if (!tokens.closed && !tokens.resolved) return null;

  // Fetch final midpoints to determine winner
  try {
    const [upRes, downRes] = await Promise.all([
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.upTokenId },   timeout: 5000 }),
      axios.get(`${CONFIG.CLOB_URL}/midpoint`, { params: { token_id: tokens.downTokenId }, timeout: 5000 }),
    ]);
    const up   = parseFloat(upRes.data.mid);
    const down = parseFloat(downRes.data.mid);
    if (up   >= 0.99) return 'UP';
    if (down >= 0.99) return 'DOWN';
    // Resolved but prices not settled yet — use higher price
    if (!isNaN(up) && !isNaN(down)) return up > down ? 'UP' : 'DOWN';
    return null;
  } catch (err) {
    log('error', 'checkResolution CLOB failed', { slug, error: err.message });
    return null;
  }
}

// ─── ORDER EXECUTION ──────────────────────────────────────────────────────────
async function executeBuy(ladder, shares, price, type) {
  const cost = shares * price;
  if (state.capital < cost) {
    log('warn', `Insufficient capital for ${type} buy`, {
      asset: ladder.asset, needed: cost.toFixed(2), capital: state.capital.toFixed(2),
    });
    return false;
  }

  if (!CONFIG.DEMO_MODE) {
    try {
      const res = await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: ladder.marketId,
        side:   ladder.side.toLowerCase(),
        price,
        size:   shares,
        type:   'limit',
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

  // Record
  state.capital -= cost;
  ladder.levels.push({ price, shares, cost, type, time: new Date().toISOString() });

  if (type === 'base') {
    ladder.baseShares   = shares;
    ladder.baseBuyPrice = price;
    ladder.lastBuyPrice = price;
    ladder.lastSellPrice = price; // reference for drop tracking
  } else {
    ladder.ladderShares += shares;
    ladder.lastBuyPrice  = price;
  }

  ladder.totalShares = ladder.baseShares + ladder.ladderShares;
  ladder.totalCost  += cost;
  ladder.avgBuyPrice = ladder.totalCost / ladder.totalShares;

  log('info',
    `🟢 BUY [${type.toUpperCase()}] ${ladder.asset.toUpperCase()} ${ladder.side} +${shares} @ ${price.toFixed(4)}` +
    ` | Total: ${ladder.totalShares} shares | Avg: ${ladder.avgBuyPrice.toFixed(4)} | Capital: $${state.capital.toFixed(2)}`
  );
  emitter.emit('state_update', getPublicState());
  return true;
}

async function executeSell(ladder, shares, price, reason) {
  const proceeds = shares * price;

  if (!CONFIG.DEMO_MODE) {
    try {
      await axios.post(`${CONFIG.CLOB_URL}/order`, {
        market: ladder.marketId,
        side:   ladder.side.toLowerCase() === 'up' ? 'sell_up' : 'sell_down',
        price,
        size:   shares,
        type:   'limit',
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
  ladder.realizedPnl += proceeds - (ladder.avgBuyPrice * shares);
  ladder.ladderShares = Math.max(0, ladder.ladderShares - shares);
  ladder.totalShares  = ladder.baseShares + ladder.ladderShares;

  // Recalculate cost after sell
  ladder.totalCost = ladder.totalShares * ladder.avgBuyPrice;

  ladder.sells.push({ price, shares, proceeds, reason, time: new Date().toISOString() });

  // After a ladder sell, reset lastBuyPrice to current price as new drop reference
  ladder.lastBuyPrice  = price;
  ladder.lastSellPrice = price;

  log('info',
    `🔴 SELL [${reason}] ${ladder.asset.toUpperCase()} ${ladder.side} -${shares} @ ${price.toFixed(4)}` +
    ` | Kept: ${ladder.totalShares} shares | Proceeds: $${proceeds.toFixed(2)} | Capital: $${state.capital.toFixed(2)}`
  );
  emitter.emit('state_update', getPublicState());
  return true;
}

// ─── LADDER LOGIC ─────────────────────────────────────────────────────────────
async function checkLadder(asset) {
  const ladder = state.ladders[asset];
  if (!ladder.active || ladder.status !== 'ACTIVE') return;

  const priceData = state.prices[asset];
  if (!priceData) return;

  const price = ladder.side === 'UP' ? priceData.up : priceData.down;
  if (!price || isNaN(price)) return;

  // ── Check base exit at 0.95 ───────────────────────────────────────────────
  if (price >= CONFIG.EXIT_PRICE && ladder.baseShares > 0) {
    log('info', `🏁 BASE EXIT at ${price.toFixed(4)} for ${asset.toUpperCase()} ${ladder.side}`);
    await executeSell(ladder, ladder.baseShares, price, 'BASE_EXIT');
    // After base sold, close the ladder for this window
    ladder.status   = 'CLOSED';
    ladder.active   = false;
    ladder.closedAt = new Date().toISOString();
    emitter.emit('state_update', getPublicState());
    return;
  }

  // ── Check ladder sell: price rose 0.10 from last buy price ───────────────
  if (ladder.ladderShares > 0 && ladder.lastBuyPrice !== null) {
    const riseFromLastBuy = price - ladder.lastBuyPrice;
    if (riseFromLastBuy >= CONFIG.RISE_STEP) {
      const sharesToSell = ladder.ladderShares; // sell ALL except base
      log('info',
        `📈 RISE SELL: +${riseFromLastBuy.toFixed(3)} rise detected @ ${price.toFixed(4)}` +
        ` | Selling ${sharesToSell} ladder shares`
      );
      await executeSell(ladder, sharesToSell, price, 'RISE_SELL');
      return;
    }
  }

  // ── Check ladder buy: price dropped 0.05 from reference ──────────────────
  if (price < CONFIG.RANGE_MAX && price > CONFIG.RANGE_MIN) {
    const refPrice = ladder.lastSellPrice ?? ladder.baseBuyPrice;
    if (refPrice !== null) {
      const dropFromRef = refPrice - price;
      if (dropFromRef >= CONFIG.DROP_STEP) {
        const stepsBought = Math.floor(dropFromRef / CONFIG.DROP_STEP);
        const stepsAlreadyBought = ladder.levels.filter(l => l.type === 'ladder').length;

        if (stepsBought > stepsAlreadyBought) {
          log('info',
            `📉 DROP BUY: -${dropFromRef.toFixed(3)} drop detected @ ${price.toFixed(4)}` +
            ` | Step ${stepsBought}`
          );
          await executeBuy(ladder, CONFIG.LADDER_SHARES, price, 'ladder');
        }
      }
    }
  }
}

// ─── WINDOW LIFECYCLE ─────────────────────────────────────────────────────────
async function startNewWindow(asset) {
  const ts   = currentWindowTs();
  const slug = makeSlug(asset, ts);

  // Reset ladder completely
  const newLadder = makeLadderState(asset);
  newLadder.windowTs   = ts;
  newLadder.windowSlug = slug;
  state.ladders[asset] = newLadder;

  log('info', `🪟 New window: ${slug}`);

  // Determine which side to activate
  const lastRes = state.lastResolution[asset];
  let activeSide = null;

  if (lastRes === 'UP' || lastRes === 'DOWN') {
    activeSide = lastRes;
  } else {
    // Check current prices — if either side already above WIN_THRESHOLD, use that
    const prices = state.prices[asset];
    if (prices) {
      if (prices.up   >= CONFIG.WIN_THRESHOLD) activeSide = 'UP';
      if (prices.down >= CONFIG.WIN_THRESHOLD) activeSide = 'DOWN';
    }
  }

  if (!activeSide) {
    log('info', `⏳ ${asset.toUpperCase()}: No previous resolution — waiting`);
    newLadder.status = 'WAITING';
    emitter.emit('state_update', getPublicState());
    return;
  }

  // Fetch market ID via real Gamma API (free, no auth)
  const tokens = await resolveMarketTokens(slug);
  if (!tokens) {
    log('error', `Market not found on Gamma API: ${slug}`);
    newLadder.status = 'WAITING';
    return;
  }
  const marketId = tokens.marketId;

  newLadder.side      = activeSide;
  newLadder.marketId  = marketId;
  newLadder.active    = true;
  newLadder.status    = 'ACTIVE';
  newLadder.openedAt  = new Date().toISOString();

  log('info', `🚀 ${asset.toUpperCase()} ${activeSide} LADDER ACTIVATED (prev resolution: ${lastRes})`);

  // Immediately buy base shares
  const currentPrice = state.prices[asset];
  const entryPrice   = currentPrice
    ? (activeSide === 'UP' ? currentPrice.up : currentPrice.down)
    : 0.50;

  await executeBuy(newLadder, CONFIG.BASE_SHARES, entryPrice, 'base');

  emitter.emit('state_update', getPublicState());
}

async function closeWindow(asset) {
  const ladder = state.ladders[asset];
  if (!ladder || !ladder.windowSlug) return;

  log('info', `⏸ Window closing: ${ladder.windowSlug}`);

  // Check resolution
  let result = await checkResolution(asset, ladder.windowSlug);

  // Also check current prices for WIN_THRESHOLD
  if (!result) {
    const p = state.prices[asset];
    if (p?.up   >= CONFIG.WIN_THRESHOLD) result = 'UP';
    if (p?.down >= CONFIG.WIN_THRESHOLD) result = 'DOWN';
  }

  if (result) {
    state.lastResolution[asset] = result;
    log('info', `✅ ${asset.toUpperCase()} window resolved: ${result}`);
  } else {
    log('warn', `⚠️ ${asset.toUpperCase()} could not determine resolution`);
  }

  // Close any remaining positions at current price
  if (ladder.active && ladder.totalShares > 0) {
    const p     = state.prices[asset];
    const price = p ? (ladder.side === 'UP' ? p.up : p.down) : ladder.avgBuyPrice;
    const totalProceeds = ladder.totalShares * price;
    state.capital      += totalProceeds;
    ladder.realizedPnl += totalProceeds - ladder.totalCost;
    log('info', `📦 Window closed — liquidated ${ladder.totalShares} shares @ ${price?.toFixed(4)}`);
  }

  // Save to history
  state.history.push({
    asset,
    slug:       ladder.windowSlug,
    side:       ladder.side,
    resolution: result,
    buys:       ladder.levels.length,
    sells:      ladder.sells.length,
    totalShares: ladder.totalShares,
    realizedPnl: ladder.realizedPnl,
    closedAt:   new Date().toISOString(),
  });

  ladder.active   = false;
  ladder.status   = 'CLOSED';
  ladder.closedAt = new Date().toISOString();
  emitter.emit('state_update', getPublicState());
}

// ─── PRICE REFRESH ────────────────────────────────────────────────────────────
async function refreshPrices(asset) {
  const data = await fetchLivePrices(asset);
  if (!data) return;
  state.prices[asset] = data;

  // Check WIN_THRESHOLD mid-window — if we see 0.95+ we know the winner
  const ladder = state.ladders[asset];
  if (ladder?.active && ladder.status === 'ACTIVE') {
    const price = ladder.side === 'UP' ? data.up : data.down;
    // Run ladder logic
    await checkLadder(asset);
  }

  // If waiting (no previous resolution), check if prices reveal a winner
  if (ladder?.status === 'WAITING') {
    if (data.up   >= CONFIG.WIN_THRESHOLD) { state.lastResolution[asset] = 'UP';   await startNewWindow(asset); }
    if (data.down >= CONFIG.WIN_THRESHOLD) { state.lastResolution[asset] = 'DOWN'; await startNewWindow(asset); }
  }

  emitter.emit('prices', { asset, ...data });
  emitter.emit('state_update', getPublicState());
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
let priceTimers   = {};
let windowChecker = null;
let lastWindowTs  = {};

function startMainLoop() {
  log('info', '🤖 Ladder Bot v3.0 started — BTC & ETH 5-minute windows');

  // Price refresh every 3s per asset
  CONFIG.ASSETS.forEach(asset => {
    clearInterval(priceTimers[asset]);
    priceTimers[asset] = setInterval(() => refreshPrices(asset), CONFIG.PRICE_REFRESH_MS);
    refreshPrices(asset); // immediate
  });

  // Window manager every 5s
  clearInterval(windowChecker);
  windowChecker = setInterval(async () => {
    const ts = currentWindowTs();

    for (const asset of CONFIG.ASSETS) {
      const ladder = state.ladders[asset];

      // New window detected
      if (ladder.windowTs !== ts) {
        // Close old window first
        if (ladder.windowTs !== null) {
          await closeWindow(asset);
        }
        // Start new window
        await startNewWindow(asset);
      }
    }
  }, 5000);
}

// ─── PUBLIC STATE ─────────────────────────────────────────────────────────────
function getPublicState() {
  const btcLadder = state.ladders.btc;
  const ethLadder = state.ladders.eth;

  const totalInvested =
    (btcLadder.totalShares * btcLadder.avgBuyPrice) +
    (ethLadder.totalShares * ethLadder.avgBuyPrice);

  const totalPnl = state.history.reduce((s, h) => s + (h.realizedPnl || 0), 0) +
    btcLadder.realizedPnl + ethLadder.realizedPnl;

  const wins   = state.history.filter(h => h.realizedPnl > 0).length;
  const losses = state.history.filter(h => h.realizedPnl <= 0 && h.resolution).length;
  const winRate = (wins + losses) > 0
    ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

  const secIn   = secondsIntoWindow();
  const secLeft = secondsLeft();

  return {
    capital:       parseFloat(state.capital.toFixed(2)),
    startCapital:  state.startCapital,
    totalInvested: parseFloat(totalInvested.toFixed(2)),
    totalPnl:      parseFloat(totalPnl.toFixed(2)),
    totalReturn:   parseFloat(((state.capital - state.startCapital) / state.startCapital * 100).toFixed(2)),
    wins, losses, winRate,

    ladders: {
      btc: serializeLadder(btcLadder),
      eth: serializeLadder(ethLadder),
    },
    lastResolution: state.lastResolution,
    history:        state.history.slice(-40).reverse(),
    prices:         state.prices,

    windowSecsIn:   secIn,
    windowSecsLeft: secLeft,
    currentTs:      currentWindowTs(),
    logs:           state.logs.slice(0, 100),
    demoMode:       CONFIG.DEMO_MODE,
    config:         CONFIG,
    timestamp:      new Date().toISOString(),
  };
}

function serializeLadder(l) {
  return {
    ...l,
    avgBuyPrice:  parseFloat((l.avgBuyPrice  || 0).toFixed(4)),
    baseBuyPrice: parseFloat((l.baseBuyPrice || 0).toFixed(4)),
    lastBuyPrice: parseFloat((l.lastBuyPrice || 0).toFixed(4)),
    totalCost:    parseFloat((l.totalCost    || 0).toFixed(2)),
    realizedPnl:  parseFloat((l.realizedPnl  || 0).toFixed(2)),
  };
}

// ─── EXPRESS + WS ─────────────────────────────────────────────────────────────
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

emitter.on('state_update', d  => broadcast('STATE_UPDATE', d));
emitter.on('log',          e  => broadcast('LOG', e));
emitter.on('prices',       p  => broadcast('PRICES', p));

app.get('/api/state',  (_req, res) => res.json(getPublicState()));
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), demo: CONFIG.DEMO_MODE }));
app.get('*',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── BOOT ─────────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   POLYMARKET LADDER BOT v3.0 — ONLINE            ║
╠══════════════════════════════════════════════════╣
║   Dashboard : http://localhost:${CONFIG.PORT}              ║
║   Mode      : ${CONFIG.DEMO_MODE ? 'DEMO (paper trading)        ' : 'LIVE (real trades!)         '}  ║
║   Strategy  : Ladder — BTC & ETH 5m windows      ║
╚══════════════════════════════════════════════════╝
  `);
  startMainLoop();
});
