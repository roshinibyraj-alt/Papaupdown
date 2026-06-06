'use strict';

const fetch     = require('node-fetch');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');

// ─────────────────────────────────────────────────────────────────────────────
//  MERGE-ARB MARKET MAKER  —  BTC 5-min binary  —  $2 000 demo
//
//  STRATEGY
//  ─────────
//  Every tick:
//    1. Fetch best bid for UP token and DOWN token.
//    2. Post a maker BID at (best_bid + 0.05), clamped to [BID_MIN, BID_MAX].
//       We are top-of-book → takers fill us → we earn the maker rebate.
//    3. A fill deducts (shares × fill_price) from balance and stores the
//       shares in upInventory / downInventory.
//    4. New bids are posted after each fill so we keep accumulating.
//
//  At T-60 s before window close (MERGE_WINDOW_SECS = 60):
//    5. matched   = min(upInventory, downInventory)
//       UP + DOWN = $1.00 guaranteed → credit (matched × $1.00) to balance.
//    6. leftoverUp   = upInventory  - matched  → sell as taker
//       leftoverDown = downInventory - matched  → sell as taker
//       Taker sells deduct a 2 % fee on proceeds.
//    7. All rebates already added at fill time are correct.
//       Window P&L = merge_proceeds + taker_proceeds + rebates_this_window
//                    – total_cost_this_window
//
//  MATH CHECK (mid-price example: UP bid = 0.55, DOWN bid = 0.45)
//  ────────────────────────────────────────────────────────────────
//  UP fill:   floor(100/0.55)=181 sh, cost=$99.55, rebate=181×0.55×0.004=$0.398
//  DOWN fill: floor(100/0.45)=222 sh, cost=$99.90, rebate=222×0.45×0.004=$0.400
//  Match:     181 pairs → $181.00 guaranteed
//  Leftover:  41 DOWN sh → taker sell @0.45 → proceeds=$18.45, fee=$0.369
//  Net:       $181.00+$18.45-$0.369+$0.798 – $199.45 = +$0.429 ✓
//  Worst case (no merge → resolution): risk = leftover cost on losing side.
// ─────────────────────────────────────────────────────────────────────────────

const GAMMA     = 'https://gamma-api.polymarket.com';
const CLOB_REST = 'https://clob.polymarket.com';

const TRADES_FILE = path.join(__dirname, 'trades.json');
const EQUITY_FILE = path.join(__dirname, 'equity.json');

const MARKET_ID   = 'btc-5m';
const MARKET_SLUG = 'btc-updown-5m';
const ASSET       = 'BTC';

const WINDOW_SIZE        = 300;   // 5 minutes
const MERGE_WINDOW_SECS  = 60;    // start merge at T-60 s
const BID_OFFSET         = 0.05;  // post bid this much ABOVE current best bid
const BID_MIN            = 0.10;  // never bid below 0.10
const BID_MAX            = 0.90;  // never bid above 0.90
const BUDGET_PER_SIDE    = 100;   // $100 per side per window
const STARTING_BALANCE   = 2000;

// Polymarket fee model
// Taker pays 2 % of notional (price × shares)
// Maker receives 20 % of that taker fee → 0.4 % of notional
const TAKER_FEE_RATE   = 0.020;   // 2 %  — charged when WE sell as taker
const MAKER_REBATE_RATE = 0.004;  // 0.4 % — credited when someone else takes our bid

const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
const RESOLVE_DELAY_SECS = 60;

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  balance:         STARTING_BALANCE,
  totalPnl:        0,
  totalRebates:    0,   // lifetime maker rebates earned
  totalTakerFees:  0,   // lifetime taker fees paid
  windowState:     null,
  pendingWindows:  [],
  resolvedWindows: [],
};

/*  windowState shape:
    {
      windowStart: <unix-ts>,
      slug:        <string>,
      upToken:     <string>,
      dnToken:     <string>,
      // UP side
      upBids:      [ { id, limitPrice, shares, cost, placedAt } ],  // open bids
      upFills:     [ { id, fillPrice, shares, cost, rebate, filledAt } ],
      upInventory: <shares held>,
      upSpent:     <total $ spent on UP fills this window>,
      upRebates:   <total rebates from UP fills this window>,
      upBidPlaced: <bool — do we have an open bid right now>,
      // DOWN side
      dnBids:      [],
      dnFills:     [],
      dnInventory: <shares>,
      dnSpent:     <total $ spent>,
      dnRebates:   <total rebates>,
      dnBidPlaced: <bool>,
      // Merge results
      merged:          false,
      matchedPairs:    0,
      mergeProceeds:   0,
      takerUpShares:   0,
      takerDnShares:   0,
      takerProceeds:   0,
      takerFeesPaid:   0,
      windowPnl:       null,   // set after merge
      status:          'active' | 'merged' | 'resolved',
    }
*/

let equityCurve  = [];
const priceBook  = {};          // tokenId → { bid, ask }
const marketCache= {};          // 'btc-5m:CWS' → { upToken, dnToken, slug }
let   btcPrice   = 0;
let   btcWs      = null;

let emitFn = () => {};
let logFn  = () => {};

// ── Pure math helpers ─────────────────────────────────────────────────────────
function fl2(n){ return Math.round(n * 100) / 100; }
function fl4(n){ return Math.round(n * 10000) / 10000; }
// integer penny-safe add / subtract
function addM(a, b){ return fl2((a * 100 + b * 100) / 100); }
function subM(a, b){ return fl2((a * 100 - b * 100) / 100); }

function sharesForBudget(budget, price){
  // How many whole shares can we buy with 'budget' at 'price'?
  if (price <= 0) return 0;
  return Math.floor(budget / price);
}
function makerRebate(shares, price){
  // Maker earns 0.4 % of (shares × price) when a taker fills our bid
  return fl4(shares * price * MAKER_REBATE_RATE);
}
function takerFee(shares, price){
  // We pay 2 % of notional when we sell as taker
  return fl4(shares * price * TAKER_FEE_RATE);
}
function tradeId(){ return `M${Date.now().toString(36).toUpperCase()}`; }

// ── Persist ───────────────────────────────────────────────────────────────────
function loadState(){
  try {
    if (fs.existsSync(TRADES_FILE)){
      const raw = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      state = { ...state, ...raw };
      if (!state.pendingWindows)  state.pendingWindows  = [];
      if (!state.resolvedWindows) state.resolvedWindows = [];
      if (!state.totalRebates)    state.totalRebates    = 0;
      if (!state.totalTakerFees)  state.totalTakerFees  = 0;
    }
  } catch(e){ log(`⚠️  State load: ${e.message}`); }
}
function saveState(){ fs.writeFileSync(TRADES_FILE, JSON.stringify(state, null, 2)); }

function loadEquity(){
  try {
    if (fs.existsSync(EQUITY_FILE)){
      equityCurve = JSON.parse(fs.readFileSync(EQUITY_FILE, 'utf8'));
      if (!Array.isArray(equityCurve)) equityCurve = [];
    }
  } catch(_){ equityCurve = []; }
}
function saveEquity(){ fs.writeFileSync(EQUITY_FILE, JSON.stringify(equityCurve)); }

function recordEquity(){
  equityCurve.push({
    ts:      Date.now(),
    balance: fl2(state.balance),
    pnl:     fl4(state.totalPnl),
    rebates: fl4(state.totalRebates),
  });
  if (equityCurve.length > 2000) equityCurve = equityCurve.slice(-2000);
  saveEquity();
}

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg){
  const line = `[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${msg}`;
  console.log(line);
  logFn(line);
}

// ── Window helpers ────────────────────────────────────────────────────────────
function currentWindowStart(){
  return Math.floor(Math.floor(Date.now() / 1000) / WINDOW_SIZE) * WINDOW_SIZE;
}
function windowElapsed(){
  return Math.floor(Date.now() / 1000) - currentWindowStart();
}
function windowRemaining(){
  return WINDOW_SIZE - windowElapsed();
}
function getBid(tid){
  return (priceBook[tid] && priceBook[tid].bid > 0) ? priceBook[tid].bid : 0;
}
function getAsk(tid){
  return (priceBook[tid] && priceBook[tid].ask > 0) ? priceBook[tid].ask : 0;
}
function getMid(tid){
  const b = priceBook[tid];
  if (!b) return 0;
  if (b.bid > 0 && b.ask > 0) return (b.bid + b.ask) / 2;
  return b.bid || b.ask || 0;
}

// ── Binance price feed ────────────────────────────────────────────────────────
function connectBinance(){
  if (btcWs){ try{ btcWs.terminate(); }catch(_){} }
  const ws = new WebSocket(BINANCE_WS);
  ws.on('open',    () => log('✅ Binance BTC/USD connected'));
  ws.on('message', raw => {
    try {
      const p = parseFloat(JSON.parse(raw).p);
      if (p > 0) btcPrice = p;
    } catch(_){}
  });
  ws.on('close', () => setTimeout(connectBinance, 3000));
  ws.on('error', () => {});
  btcWs = ws;
}

// ── Market discovery (reuse from original) ────────────────────────────────────
function extractTokenIds(mkt){
  if (!mkt) return null;
  let ids = mkt.clobTokenIds ?? mkt.clob_token_ids;
  if (typeof ids === 'string'){ try{ ids = JSON.parse(ids); }catch(_){ ids = null; } }
  let outcomes = mkt.outcomes;
  if (typeof outcomes === 'string'){ try{ outcomes = JSON.parse(outcomes); }catch(_){ outcomes = null; } }
  if (Array.isArray(ids) && ids.length >= 2 && ids[0] && ids[1]){
    if (Array.isArray(outcomes) && outcomes.length >= 2){
      const ui = outcomes.findIndex(o => /up/i.test(String(o)));
      const di = outcomes.findIndex(o => /down/i.test(String(o)));
      if (ui >= 0 && di >= 0) return { upToken: String(ids[ui]), dnToken: String(ids[di]) };
    }
    return { upToken: String(ids[0]), dnToken: String(ids[1]) };
  }
  if (Array.isArray(mkt.tokens) && mkt.tokens.length >= 2){
    const up = mkt.tokens.find(t => /up|yes/i.test(t.outcome ?? ''));
    const dn = mkt.tokens.find(t => /down|no/i.test(t.outcome ?? ''));
    if (up?.token_id && dn?.token_id) return { upToken: up.token_id, dnToken: dn.token_id };
    return { upToken: mkt.tokens[0].token_id, dnToken: mkt.tokens[1].token_id };
  }
  return null;
}

async function getJson(url){
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
  } catch(_){ return null; }
}

function seedPrices(mkt, tokens){
  let prices = mkt.outcomePrices, outcomes = mkt.outcomes;
  if (typeof prices   === 'string'){ try{ prices   = JSON.parse(prices);   }catch(_){ prices   = null; } }
  if (typeof outcomes === 'string'){ try{ outcomes = JSON.parse(outcomes); }catch(_){ outcomes = null; } }
  const bestAsk = parseFloat(mkt.bestAsk ?? 0) || 0;
  const bestBid = parseFloat(mkt.bestBid ?? 0) || 0;
  if (bestAsk > 0 || bestBid > 0){
    priceBook[tokens.upToken] = { bid: bestBid, ask: bestAsk };
    priceBook[tokens.dnToken] = { bid: Math.max(0, 1 - bestAsk), ask: Math.min(1, 1 - bestBid) };
  } else if (Array.isArray(prices) && Array.isArray(outcomes)){
    const ui = outcomes.findIndex(o => /up/i.test(String(o)));
    const di = outcomes.findIndex(o => /down/i.test(String(o)));
    if (ui >= 0 && di >= 0){
      const up = parseFloat(prices[ui]) || 0;
      const dn = parseFloat(prices[di]) || 0;
      if (up > 0) priceBook[tokens.upToken] = { bid: Math.max(0, up - 0.01), ask: Math.min(1, up + 0.01) };
      if (dn > 0) priceBook[tokens.dnToken] = { bid: Math.max(0, dn - 0.01), ask: Math.min(1, dn + 0.01) };
    }
  }
}

let discovering = false;
async function refreshMarket(){
  if (discovering) return;
  discovering = true;
  try {
    const cws      = currentWindowStart();
    const cacheKey = `${MARKET_ID}:${cws}`;
    if (marketCache[cacheKey]){ discovering = false; return; }

    for (const offset of [0, 1, -1, 2, -2]){
      const t    = cws + offset * WINDOW_SIZE;
      const slug = `${MARKET_SLUG}-${t}`;
      const ev   = await getJson(`${GAMMA}/events/slug/${slug}`);
      if (ev?.markets?.length){
        const mkt    = ev.markets.find(m => m.acceptingOrders !== false) ?? ev.markets[0];
        const tokens = extractTokenIds(mkt);
        if (tokens){
          seedPrices(mkt, tokens);
          marketCache[cacheKey] = { windowStart: cws, upToken: tokens.upToken, dnToken: tokens.dnToken, slug };
          log(`✅ [BTC] Found ${slug}`);
          break;
        }
      }
      const mkt2 = await getJson(`${GAMMA}/markets/slug/${slug}`);
      if (mkt2){
        const tokens = extractTokenIds(mkt2);
        if (tokens){
          seedPrices(mkt2, tokens);
          marketCache[cacheKey] = { windowStart: cws, upToken: tokens.upToken, dnToken: tokens.dnToken, slug };
          log(`✅ [BTC] Found ${slug}`);
          break;
        }
      }
    }
  } finally { discovering = false; }
}

async function pollPrices(){
  const cws = currentWindowStart();
  const w   = marketCache[`${MARKET_ID}:${cws}`];
  const extraTokens = new Set();
  for (const pw of state.pendingWindows){
    if (pw.upToken) extraTokens.add(pw.upToken);
    if (pw.dnToken) extraTokens.add(pw.dnToken);
  }
  const tokens = w
    ? [w.upToken, w.dnToken, ...extraTokens]
    : [...extraTokens];

  await Promise.all(tokens.map(async tid => {
    try {
      const [ar, br] = await Promise.all([
        fetch(`${CLOB_REST}/price?token_id=${tid}&side=BUY`,  { timeout: 3000 }),
        fetch(`${CLOB_REST}/price?token_id=${tid}&side=SELL`, { timeout: 3000 }),
      ]);
      const ask = parseFloat((await ar.json()).price ?? 0) || 0;
      const bid = parseFloat((await br.json()).price ?? 0) || 0;
      if (ask > 0 || bid > 0) priceBook[tid] = { bid, ask };
    } catch(_){}
  }));
}

// ── Window state management ───────────────────────────────────────────────────
function freshWindowState(cws, w){
  return {
    windowStart:  cws,
    slug:         w.slug,
    upToken:      w.upToken,
    dnToken:      w.dnToken,
    // UP side
    upBids:       [],
    upFills:      [],
    upInventory:  0,
    upSpent:      0,
    upRebates:    0,
    upBidPlaced:  false,
    upBudgetLeft: BUDGET_PER_SIDE,
    // DOWN side
    dnBids:       [],
    dnFills:      [],
    dnInventory:  0,
    dnSpent:      0,
    dnRebates:    0,
    dnBidPlaced:  false,
    dnBudgetLeft: BUDGET_PER_SIDE,
    // Merge
    merged:        false,
    matchedPairs:  0,
    mergeProceeds: 0,
    takerUpShares: 0,
    takerDnShares: 0,
    takerProceeds: 0,
    takerFeesPaid: 0,
    windowPnl:     null,
    status:        'active',
  };
}

function ensureWindowState(){
  const cws = currentWindowStart();
  const w   = marketCache[`${MARKET_ID}:${cws}`];
  if (!w) return;

  // If no window state yet, or it's from a previous window → rotate
  if (!state.windowState || state.windowState.windowStart !== cws){
    // Archive old window if it had fills and wasn't fully handled
    if (state.windowState && state.windowState.windowStart !== cws){
      archiveWindow(state.windowState);
    }
    state.windowState = freshWindowState(cws, w);
    log(`🆕 [BTC] New window started — ${new Date(cws * 1000).toLocaleTimeString()}`);
    saveState();
  }
}

function archiveWindow(ws){
  if (!ws || (ws.upFills.length === 0 && ws.dnFills.length === 0)) return;
  // If merge wasn't done (e.g. bot restarted mid-window), force merge now
  if (!ws.merged) doMerge(ws, true);
  state.pendingWindows.push({
    windowKey:   `btc:${ws.windowStart}`,
    windowStart: ws.windowStart,
    slug:        ws.slug,
    upToken:     ws.upToken,
    dnToken:     ws.dnToken,
    upFills:     ws.upFills,
    dnFills:     ws.dnFills,
    upInventory: ws.upInventory,
    dnInventory: ws.dnInventory,
    upSpent:     ws.upSpent,
    dnSpent:     ws.dnSpent,
    upRebates:   ws.upRebates,
    dnRebates:   ws.dnRebates,
    merged:      ws.merged,
    matchedPairs:  ws.matchedPairs,
    mergeProceeds: ws.mergeProceeds,
    takerUpShares: ws.takerUpShares,
    takerDnShares: ws.takerDnShares,
    takerProceeds: ws.takerProceeds,
    takerFeesPaid: ws.takerFeesPaid,
    windowPnl:   ws.windowPnl,
    status:      'pending',
    archivedAt:  new Date().toISOString(),
  });
  log(`📦 [BTC] Window archived for resolution — ${ws.upFills.length} UP fills, ${ws.dnFills.length} DN fills`);
}

// ── CORE: Place maker bids ────────────────────────────────────────────────────
//
//  We post a limit BID at (current best bid + BID_OFFSET).
//  This puts us at the TOP of the bid book → we get filled first.
//  We are the MAKER → zero fee, plus 0.4% rebate when a taker hits us.
//
function placeMakerBid(side){
  const ws      = state.windowState;
  if (!ws || ws.status !== 'active') return;
  const tokenId = side === 'UP' ? ws.upToken : ws.dnToken;
  const budget  = side === 'UP' ? ws.upBudgetLeft : ws.dnBudgetLeft;
  if (budget < 1) return; // no budget left this window

  const bestBid = getBid(tokenId);
  if (bestBid <= 0) return; // no price data yet

  // Our bid price: just above the current best bid, within range
  const rawBid  = fl2(bestBid + BID_OFFSET);
  const bidPrice= Math.min(BID_MAX, Math.max(BID_MIN, rawBid));

  const shares  = sharesForBudget(budget, bidPrice);
  if (shares <= 0) return;

  const cost    = fl2(shares * bidPrice);
  const rebate  = makerRebate(shares, bidPrice);
  const order   = {
    id:        tradeId(),
    side,
    bidPrice,
    shares,
    cost,
    rebate,
    placedAt:  new Date().toISOString(),
  };

  if (side === 'UP'){ ws.upBids.push(order); ws.upBidPlaced = true; }
  else              { ws.dnBids.push(order); ws.dnBidPlaced = true; }

  log(`📋 [BTC] ${side} MAKER BID @${bidPrice.toFixed(2)} × ${shares} sh | cost=$${cost.toFixed(2)} | est.rebate=$${rebate.toFixed(4)}`);
  saveState();
}

// ── CORE: Simulate fill ───────────────────────────────────────────────────────
//
//  A maker bid is "filled" when the live price moves DOWN to our bid level
//  (a taker sells into our resting bid).
//
function checkFills(){
  const ws = state.windowState;
  if (!ws || ws.status !== 'active') return;

  for (const side of ['UP', 'DOWN']){
    const bids    = side === 'UP' ? ws.upBids : ws.dnBids;
    const tokenId = side === 'UP' ? ws.upToken : ws.dnToken;
    const curBid  = getBid(tokenId); // live best bid in market
    if (curBid <= 0) continue;

    for (let i = bids.length - 1; i >= 0; i--){
      const order = bids[i];
      // Fill condition: market bid has dropped to or below our posted bid
      // (meaning our bid is now at or above market → a taker will hit us)
      if (curBid <= order.bidPrice){
        // ── FILL ──────────────────────────────────────────────────────────
        const fill = {
          id:        order.id,
          side,
          fillPrice: order.bidPrice,
          shares:    order.shares,
          cost:      order.cost,       // shares × fillPrice
          rebate:    order.rebate,     // 0.4 % of notional
          filledAt:  new Date().toISOString(),
        };

        // Deduct cost from balance, credit rebate immediately
        state.balance    = subM(state.balance, fill.cost);
        state.balance    = addM(state.balance, fill.rebate);
        state.totalRebates = fl4(state.totalRebates + fill.rebate);

        if (side === 'UP'){
          ws.upFills.push(fill);
          ws.upInventory   += fill.shares;
          ws.upSpent        = fl2(ws.upSpent + fill.cost);
          ws.upRebates      = fl4(ws.upRebates + fill.rebate);
          ws.upBudgetLeft   = fl2(Math.max(0, ws.upBudgetLeft - fill.cost));
          ws.upBidPlaced    = false;  // allow new bid
          bids.splice(i, 1);
        } else {
          ws.dnFills.push(fill);
          ws.dnInventory   += fill.shares;
          ws.dnSpent        = fl2(ws.dnSpent + fill.cost);
          ws.dnRebates      = fl4(ws.dnRebates + fill.rebate);
          ws.dnBudgetLeft   = fl2(Math.max(0, ws.dnBudgetLeft - fill.cost));
          ws.dnBidPlaced    = false;
          bids.splice(i, 1);
        }

        log(`✅ [BTC] ${side} FILLED @${fill.fillPrice.toFixed(2)} × ${fill.shares} sh | cost=$${fill.cost.toFixed(2)} | rebate=+$${fill.rebate.toFixed(4)} | bal=$${state.balance.toFixed(2)}`);
        saveState();
      }
    }
  }
}

// ── CORE: Merge at T-60 s ─────────────────────────────────────────────────────
//
//  MERGE MATH:
//    matched = min(upInventory, downInventory)
//    mergeProceeds = matched × $1.00              ← guaranteed, riskless
//    leftoverUp   = upInventory  - matched
//    leftoverDown = downInventory - matched
//    takerProceeds = (leftoverUp × upMid) + (leftoverDown × dnMid)
//    takerFeesPaid = takerFee(leftoverUp, upMid) + takerFee(leftoverDown, dnMid)
//
//    windowPnl = mergeProceeds + takerProceeds - takerFeesPaid
//                + upRebates + dnRebates
//                - upSpent - dnSpent
//
function doMerge(ws, forced){
  if (ws.merged) return;
  ws.merged = true;

  const upInv = ws.upInventory;
  const dnInv = ws.dnInventory;

  if (upInv === 0 && dnInv === 0){
    ws.windowPnl = 0;
    ws.status    = 'merged';
    log(`⚡ [BTC] Merge: no inventory — window P&L = $0`);
    return;
  }

  // Matched pairs: guaranteed $1 each
  const matched      = Math.min(upInv, dnInv);
  const mergeProceeds = fl2(matched * 1.00);

  // Leftover: sell as taker
  const leftoverUp = upInv - matched;
  const leftoverDn = dnInv - matched;

  const upMid = getMid(ws.upToken);
  const dnMid = getMid(ws.dnToken);

  const takerProceedsUp = fl2(leftoverUp * upMid);
  const takerProceedsDn = fl2(leftoverDn * dnMid);
  const takerFeeUp      = takerFee(leftoverUp, upMid);
  const takerFeeDn      = takerFee(leftoverDn, dnMid);

  const totalTakerProceeds = fl2(takerProceedsUp + takerProceedsDn);
  const totalTakerFees     = fl4(takerFeeUp + takerFeeDn);

  // Credit merge proceeds and taker proceeds to balance
  state.balance = addM(state.balance, mergeProceeds);
  state.balance = addM(state.balance, totalTakerProceeds);
  state.balance = subM(state.balance, totalTakerFees);
  state.totalTakerFees = fl4(state.totalTakerFees + totalTakerFees);

  // Window P&L = everything in – everything spent
  const totalIn  = mergeProceeds + totalTakerProceeds - totalTakerFees
                   + ws.upRebates + ws.dnRebates;
  const totalOut = ws.upSpent + ws.dnSpent;
  const windowPnl = fl4(totalIn - totalOut);

  state.totalPnl = fl4(state.totalPnl + windowPnl);

  ws.matchedPairs   = matched;
  ws.mergeProceeds  = mergeProceeds;
  ws.takerUpShares  = leftoverUp;
  ws.takerDnShares  = leftoverDn;
  ws.takerProceeds  = totalTakerProceeds;
  ws.takerFeesPaid  = totalTakerFees;
  ws.windowPnl      = windowPnl;
  ws.status         = 'merged';

  const label = forced ? '⚡ [BTC] FORCED MERGE' : '⚡ [BTC] MERGE T-60s';
  log(`${label} | pairs=${matched} → $${mergeProceeds.toFixed(2)} | ↑left=${leftoverUp} ↓left=${leftoverDn} → taker $${totalTakerProceeds.toFixed(2)} fee=$${totalTakerFees.toFixed(4)} | rebates=$${(ws.upRebates+ws.dnRebates).toFixed(4)} | windowPnl=${windowPnl >= 0 ? '+' : ''}$${windowPnl.toFixed(4)} | bal=$${state.balance.toFixed(2)}`);
  recordEquity();
  saveState();
}

// ── Resolution: any unmerged positions (e.g. forced archive) ──────────────────
const lastResolvLog = {};
async function checkResolution(){
  const nowSec    = Math.floor(Date.now() / 1000);
  const toResolve = state.pendingWindows.filter(w =>
    nowSec >= w.windowStart + WINDOW_SIZE + RESOLVE_DELAY_SECS && w.status === 'pending'
  );

  for (const pw of toResolve){
    // If already merged, just move to resolved
    if (pw.merged){
      pw.status     = 'resolved';
      pw.resolvedAt = new Date().toISOString();
      state.pendingWindows  = state.pendingWindows.filter(w => w.windowKey !== pw.windowKey);
      state.resolvedWindows.unshift(pw);
      if (state.resolvedWindows.length > 50) state.resolvedWindows = state.resolvedWindows.slice(0, 50);
      recordEquity(); saveState();
      log(`✅ [BTC] Window ${new Date(pw.windowStart*1000).toLocaleTimeString()} resolved (merged) — P&L=${pw.windowPnl >= 0 ? '+' : ''}$${(pw.windowPnl||0).toFixed(4)}`);
      emitFn('snapshot', buildSnapshot());
      continue;
    }

    // Not merged (forced archive without merge) → need Polymarket outcome
    let mktData = await getJson(`${GAMMA}/markets/slug/${pw.slug}`);
    if (!mktData){
      const ev = await getJson(`${GAMMA}/events/slug/${pw.slug}`);
      if (ev?.markets?.length) mktData = ev.markets[0];
    }
    if (!mktData){
      const now = Date.now();
      if (!lastResolvLog[pw.windowKey] || now - lastResolvLog[pw.windowKey] > 30000){
        log(`⏳ [BTC] Cannot fetch market ${pw.slug} — retrying`);
        lastResolvLog[pw.windowKey] = now;
      }
      continue;
    }

    const isClosed = mktData.closed === true || mktData.active === false;
    if (!isClosed){
      const now = Date.now();
      if (!lastResolvLog[pw.windowKey] || now - lastResolvLog[pw.windowKey] > 30000){
        log(`⏳ [BTC] Waiting for Polymarket resolution — ${pw.slug}`);
        lastResolvLog[pw.windowKey] = now;
      }
      continue;
    }

    let outcomePrices = mktData.outcomePrices, outcomes = mktData.outcomes;
    if (typeof outcomePrices === 'string'){ try{ outcomePrices = JSON.parse(outcomePrices); }catch(_){ outcomePrices = null; } }
    if (typeof outcomes      === 'string'){ try{ outcomes      = JSON.parse(outcomes);      }catch(_){ outcomes      = null; } }
    if (!Array.isArray(outcomePrices) || outcomePrices.length < 2) continue;

    let upIdx = 0, dnIdx = 1;
    if (Array.isArray(outcomes)){
      const ui = outcomes.findIndex(o => /up/i.test(String(o)));
      const di = outcomes.findIndex(o => /down/i.test(String(o)));
      if (ui >= 0 && di >= 0){ upIdx = ui; dnIdx = di; }
    }

    const upRes = parseFloat(outcomePrices[upIdx]) || 0;
    const dnRes = parseFloat(outcomePrices[dnIdx]) || 0;
    if (upRes < 0.99 && dnRes < 0.99){
      const now = Date.now();
      if (!lastResolvLog[pw.windowKey] || now - lastResolvLog[pw.windowKey] > 30000){
        log(`⏳ [BTC] Not fully resolved yet — UP=${upRes} DN=${dnRes}`);
        lastResolvLog[pw.windowKey] = now;
      }
      continue;
    }

    const upWon = upRes >= 0.99;
    // UP inventory resolves at $1 if UP won, $0 if DOWN won
    // DN inventory resolves at $1 if DOWN won, $0 if UP won
    const upResolvePrice = upWon ? 1.00 : 0.00;
    const dnResolvePrice = upWon ? 0.00 : 1.00;

    const upProceeds = fl2(pw.upInventory * upResolvePrice);
    const dnProceeds = fl2(pw.dnInventory * dnResolvePrice);
    const totalProceeds = fl2(upProceeds + dnProceeds);

    state.balance  = addM(state.balance, totalProceeds);
    const totalRebates = fl4((pw.upRebates || 0) + (pw.dnRebates || 0));
    const totalSpent   = fl2((pw.upSpent || 0) + (pw.dnSpent || 0));
    // rebates already credited at fill time, so pnl = proceeds - spent
    // (rebates were already added to balance when fills happened)
    const windowPnl    = fl4(totalProceeds - totalSpent);
    state.totalPnl     = fl4(state.totalPnl + windowPnl);

    pw.upWon      = upWon;
    pw.windowPnl  = windowPnl;
    pw.status     = 'resolved';
    pw.resolvedAt = new Date().toISOString();

    delete lastResolvLog[pw.windowKey];
    state.pendingWindows  = state.pendingWindows.filter(w => w.windowKey !== pw.windowKey);
    state.resolvedWindows.unshift(pw);
    if (state.resolvedWindows.length > 50) state.resolvedWindows = state.resolvedWindows.slice(0, 50);

    recordEquity(); saveState();
    log(`${windowPnl >= 0 ? '🟢' : '🔴'} [BTC] RESOLVED — ${upWon ? 'UP' : 'DOWN'} WON | UP=${pw.upInventory}sh DN=${pw.dnInventory}sh | proceeds=$${totalProceeds.toFixed(2)} | pnl=${windowPnl >= 0 ? '+' : ''}$${windowPnl.toFixed(4)} | bal=$${state.balance.toFixed(2)}`);
    emitFn('snapshot', buildSnapshot());
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────
function buildSnapshot(){
  const ws      = state.windowState;
  const elapsed = windowElapsed();
  const rem     = windowRemaining();

  // Live floating value of current inventory (before merge)
  let upFloatVal = 0, dnFloatVal = 0;
  if (ws){
    const upMid = getMid(ws.upToken);
    const dnMid = getMid(ws.dnToken);
    upFloatVal = fl2(ws.upInventory * upMid);
    dnFloatVal = fl2(ws.dnInventory * dnMid);
  }

  const allResolved = state.resolvedWindows;
  const totalWindows= allResolved.length;
  const profitWindows = allResolved.filter(w => (w.windowPnl || 0) > 0).length;

  return {
    // Capital
    balance:          fl2(state.balance),
    startingBalance:  STARTING_BALANCE,
    totalPnl:         fl4(state.totalPnl),
    totalRebates:     fl4(state.totalRebates),
    totalTakerFees:   fl4(state.totalTakerFees),
    // Window
    windowElapsed:    elapsed,
    windowRemaining:  rem,
    windowStart:      currentWindowStart(),
    mergeTriggered:   ws ? ws.merged : false,
    // BTC price
    btcPrice,
    // Current window state
    windowState: ws ? {
      upToken:      ws.upToken,
      dnToken:      ws.dnToken,
      upPrice:      fl2(getMid(ws.upToken || '')),
      dnPrice:      fl2(getMid(ws.dnToken || '')),
      upBid:        fl2(getBid(ws.upToken || '')),
      dnBid:        fl2(getBid(ws.dnToken || '')),
      upInventory:  ws.upInventory,
      dnInventory:  ws.dnInventory,
      upSpent:      ws.upSpent,
      dnSpent:      ws.dnSpent,
      upRebates:    ws.upRebates,
      dnRebates:    ws.dnRebates,
      upBudgetLeft: ws.upBudgetLeft,
      dnBudgetLeft: ws.dnBudgetLeft,
      upBidPlaced:  ws.upBidPlaced,
      dnBidPlaced:  ws.dnBidPlaced,
      upFillCount:  ws.upFills.length,
      dnFillCount:  ws.dnFills.length,
      upFloatVal,
      dnFloatVal,
      // Merge results (if already merged)
      merged:        ws.merged,
      matchedPairs:  ws.matchedPairs,
      mergeProceeds: ws.mergeProceeds,
      takerUpShares: ws.takerUpShares,
      takerDnShares: ws.takerDnShares,
      takerProceeds: ws.takerProceeds,
      takerFeesPaid: ws.takerFeesPaid,
      windowPnl:     ws.windowPnl,
      status:        ws.status,
      upFills:       ws.upFills.slice(-10),  // last 10 fills
      dnFills:       ws.dnFills.slice(-10),
    } : null,
    // Stats
    totalWindows,
    profitWindows,
    // History
    pendingWindows:  state.pendingWindows,
    resolvedWindows: state.resolvedWindows.slice(0, 20),
    equityCurve,
  };
}

// ── Main tick ─────────────────────────────────────────────────────────────────
async function tick(){
  try {
    await refreshMarket();
    await pollPrices();

    ensureWindowState();

    const ws  = state.windowState;
    const rem = windowRemaining();

    if (ws && ws.status === 'active'){
      // Check if any open bids got filled
      checkFills();

      // If merge window has arrived → do merge
      if (rem <= MERGE_WINDOW_SECS){
        doMerge(ws, false);
      } else {
        // Post new maker bids if we don't have one on each side and budget remains
        if (!ws.upBidPlaced && ws.upBudgetLeft >= 1) placeMakerBid('UP');
        if (!ws.dnBidPlaced && ws.dnBudgetLeft >= 1) placeMakerBid('DOWN');
      }
    }

    await checkResolution();
    emitFn('snapshot', buildSnapshot());
  } catch(e){ log(`⚠️  tick: ${e.message}`); }
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start(emit, logEmit){
  emitFn = emit; logFn = logEmit;
  loadState(); loadEquity();
  log('🚀 MERGE-ARB MARKET MAKER — BTC 5-min binary');
  log(`   Maker bids at best_bid+${BID_OFFSET} | Range ${BID_MIN}–${BID_MAX}`);
  log(`   Budget $${BUDGET_PER_SIDE}/side | Merge at T-${MERGE_WINDOW_SECS}s`);
  log(`   Maker rebate=${MAKER_REBATE_RATE*100}% | Taker fee=${TAKER_FEE_RATE*100}%`);
  log(`💰 Balance: $${state.balance.toFixed(2)}`);
  connectBinance();
  await tick();
  setInterval(tick, 2000);
}

module.exports = { start, buildSnapshot };
