#!/usr/bin/env node
/**
 * Autonomous futures trading bot — parallel to auto_trade.mjs (spot).
 *
 * Runs the identical dual-timeframe signal detection and confluence gate as the
 * spot bot, but executes on Binance USD-M Futures Testnet:
 *   - 2x ISOLATED leverage (curriculum cap is 5x; 2x is the conservative start)
 *   - Native short orders — no inventory constraint
 *   - Exchange-side STOP_MARKET + TAKE_PROFIT_MARKET orders placed at entry
 *     time so the position is self-managed even if the bot misses a scan
 *
 * Requires separate futures testnet credentials (register at testnet.binancefuture.com):
 *   BINANCE_FUTURES_TESTNET_KEY / BINANCE_FUTURES_TESTNET_SECRET
 *
 * State is tracked in auto_trade_futures_state.json — completely independent
 * of the spot bot's state file so the two accounts don't interfere.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { getKlines, accountInfo, placeOrder, getPositions, setLeverage, setMarginType } =
  await import('../src/core/binance_futures.js');
const { findSwingHighs, findSwingLows, scanForSFP, buildSFPTradePlan } = await import('../src/core/sfp.js');
const { scanForDivergence, buildDivergenceTradePlan } = await import('../src/core/divergence.js');
const { detectZones, findZoneRetests, buildZoneTradePlan } = await import('../src/core/levels.js');
const { scanForFibReaction, buildFibTradePlan } = await import('../src/core/fibonacci.js');
const { detectMarketStructure, buildStructureTradePlan } = await import('../src/core/market_structure.js');
const { scanForPinbarSetup, buildPinbarTradePlan } = await import('../src/core/pinbar.js');
const { buildLadderOrders } = await import('../src/core/laddering.js');
const { assessConfluence } = await import('../src/core/confluence.js');
const { evaluateTradeSetup, translateForAccount } = await import('../src/core/risk.js');

const SYMBOLS           = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const INTERVAL          = '15m';
const INTERVAL_HTF      = '4h';
const LEVERAGE          = 2;       // curriculum cap is 5x; 2x is the conservative starting point
const MARGIN_TYPE       = 'ISOLATED';
const RISK_PERCENT      = 1;
const HISTORICAL_WIN_RATE = 58;  // measured: 32W/55 resolved trades, dual-TF + Ch.6 guard + daily bias (div+levels exempted)
const FRESHNESS_BARS    = 2;
const HTF_FRESHNESS_BARS = 3;
const LADDER_ORDERS     = 3;
const RSI_PERIOD        = 14;

const STATE_PATH = join(ROOT, 'auto_trade_futures_state.json');
const LOG_PATH   = join(ROOT, 'auto_trade_futures.log');

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, stamped + '\n');
}

async function getSymbolFilters(symbol) {
  const res = await fetch(`https://testnet.binancefuture.com/fapi/v1/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  const filters = data.symbols[0].filters;
  const lot = filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = filters.find(f => f.filterType === 'MIN_NOTIONAL');
  const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER');
  return {
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    minNotional: Number(notional?.notional ?? notional?.minNotional ?? 0),
    tickSize: Number(priceFilter?.tickSize ?? 0.01),
  };
}

function floorToStep(quantity, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const factor = 10 ** decimals;
  return Number((Math.floor(quantity * factor) / factor).toFixed(decimals));
}

function roundToTick(price, tick) {
  const decimals = Math.max(0, -Math.floor(Math.log10(tick) + 1e-9));
  const factor = 10 ** decimals;
  return Number((Math.round(price * factor) / factor).toFixed(decimals));
}

// ---- Signal detectors (identical logic to auto_trade.mjs) -------------------

function findFreshSFPSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const bearishHits = scanForSFP(klines.slice(lastSwingHigh.index + 1), { level: lastSwingHigh.price, type: 'bearish' })
    .map(h => ({ ...h, index: h.index + lastSwingHigh.index + 1 }));
  const bullishHits = scanForSFP(klines.slice(lastSwingLow.index + 1), { level: lastSwingLow.price, type: 'bullish' })
    .map(h => ({ ...h, index: h.index + lastSwingLow.index + 1 }));

  const candidates = [
    ...bearishHits.map(hit => ({ hit, type: 'bearish', target: lastSwingLow.price, alt: rangeLow })),
    ...bullishHits.map(hit => ({ hit, type: 'bullish', target: lastSwingHigh.price, alt: rangeHigh })),
  ].filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.hit.index - a.hit.index);
  const { hit, type, target, alt } = candidates[0];
  const plan = buildSFPTradePlan({ hit, type, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'sfp',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `sfp:${type}:${hit.bar.open_time}`,
    summary: `${type} SFP (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findFreshDivergenceSignal(klines4h, ctx4h) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx4h;
  const candidates = [];
  for (const type of ['bullish', 'bearish']) {
    const result = scanForDivergence(klines4h, { type, rsiPeriod: RSI_PERIOD });
    if (result.divergence) candidates.push({ hit: result, type });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.newer_swing.index <= HTF_FRESHNESS_BARS);
  if (!fresh.length) return null;

  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'divergence',
    plan,
    confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `divergence:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `4H ${hit.strength} ${type} divergence (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findFreshLevelZoneSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const zones = detectZones(klines);
  const candidates = [];
  for (const zone of zones) {
    const hits = findZoneRetests(klines, zone);
    if (hits.length) candidates.push({ zone, hit: hits[hits.length - 1], touchCount: hits.length });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;

  fresh.sort((a, b) => b.hit.index - a.hit.index);
  const { zone, hit, touchCount } = fresh[0];
  const target = zone.type === 'support' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = zone.type === 'support' ? rangeHigh : rangeLow;
  const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: target, rangeLevel: alt });
  return {
    strategy: 'levels',
    plan,
    confirmedAt: hit.bar.open_time,
    signalKey: `levels:${zone.type}:${zone.classification}:${hit.bar.open_time}`,
    summary: `${zone.classification} ${zone.type} zone retest [${zone.low}-${zone.high}] (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
    hitKind: hit.kind,
    touchCount,
  };
}

function findFreshFibSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, lastIndex } = ctx;
  if (lastSwingHigh.index === lastSwingLow.index) return null;
  const result = scanForFibReaction(klines, { swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  if (!result?.hit) return null;
  if (lastIndex - result.hit.bar_index > FRESHNESS_BARS) return null;
  const plan = buildFibTradePlan({ result, swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  const hitBar = klines[result.hit.bar_index];
  return {
    strategy: 'fibonacci',
    plan,
    confirmedAt: hitBar.open_time,
    signalKey: `fibonacci:${result.type}:${hitBar.open_time}`,
    summary: `${result.type} golden-pocket reaction (${result.hit.kind}, entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findFreshStructureSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { choch, trend } = detectMarketStructure(klines, { swingHighs, swingLows });
  if (!trend || !choch.length) return null;

  const realigning = choch.filter(c => c.direction === trend);
  if (!realigning.length) return null;
  const latest = realigning[realigning.length - 1];
  if (lastIndex - latest.index > FRESHNESS_BARS) return null;

  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: latest, trend, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'market_structure',
    plan,
    confirmedAt: latest.bar.open_time,
    signalKey: `market_structure:${trend}:choch${latest.sequenceNumber}:${latest.bar.open_time}`,
    summary: `${trend} BOS + realigning CHoCH#${latest.sequenceNumber} (entry ${plan.entry}, stop ${plan.stop})`,
  };
}

function findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) {
  const { lastIndex } = ctx4h;
  const { hits } = scanForPinbarSetup(klines4h, { swingHighs: swingHighs4h, swingLows: swingLows4h });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > HTF_FRESHNESS_BARS) return null;
  return { direction: hit.direction };
}


// ---- Main scan --------------------------------------------------------------

const state = loadState();

let info;
try {
  info = await accountInfo();
} catch (err) {
  log(`FATAL: cannot fetch futures account — ${err.message}`);
  log('Ensure BINANCE_FUTURES_TESTNET_KEY / BINANCE_FUTURES_TESTNET_SECRET are set and the futures testnet is accessible.');
  process.exit(1);
}

const usdt = info.balances.find(b => b.asset === 'USDT')?.free ?? 0;
log(`scan start — interval=${INTERVAL}/${INTERVAL_HTF} leverage=${LEVERAGE}x margin=${MARGIN_TYPE} symbols=${SYMBOLS.join(',')} usdt_balance=${usdt}`);

for (const symbol of SYMBOLS) {
  try {
    // Check for an open position first — don't re-enter while one is live
    const { positions } = await getPositions(symbol);
    const openPos = positions.find(p => p.symbol === symbol);

    if (openPos) {
      log(`${symbol}: open ${openPos.side} position (qty ${openPos.quantity} @ ${openPos.entry_price}, PnL ${openPos.unrealized_pnl.toFixed(2)} USDT) — skipping new entries`);
      continue;
    }

    // Position gone but state still says open/executing — SL/TP was hit or manually closed
    if (state[symbol]?.outcome === 'open' || state[symbol]?.outcome === 'executing') {
      log(`${symbol}: position closed (SL/TP hit or manual close) — ready for next setup`);
      state[symbol] = { ...state[symbol], outcome: 'closed', closed_at: new Date().toISOString() };
    }

    // Fetch klines — futures trades both directions so no daily bias filter;
    // only 15m execution TF and 4H for divergence + pinbar bias are needed.
    const [{ klines: rawKlines }, { klines: rawKlines4h }] = await Promise.all([
      getKlines({ symbol, interval: INTERVAL,     limit: 150 }),
      getKlines({ symbol, interval: INTERVAL_HTF, limit: 100 }),
    ]);

    // Drop the still-forming bar (last bar is incomplete)
    const klines   = rawKlines.slice(0, -1);
    const klines4h = rawKlines4h.slice(0, -1);

    const swingHighs = findSwingHighs(klines,  { lookback: 3 });
    const swingLows  = findSwingLows(klines,   { lookback: 3 });
    if (!swingHighs.length || !swingLows.length) { log(`${symbol}: insufficient swing points — skipping`); continue; }

    const ctx = {
      lastSwingHigh: swingHighs[swingHighs.length - 1],
      lastSwingLow:  swingLows[swingLows.length - 1],
      rangeHigh: Math.max(...klines.map(k => k.high)),
      rangeLow:  Math.min(...klines.map(k => k.low)),
      lastIndex: klines.length - 1,
    };

    const swingHighs4h = klines4h.length >= 10 ? findSwingHighs(klines4h, { lookback: 3 }) : [];
    const swingLows4h  = klines4h.length >= 10 ? findSwingLows(klines4h,  { lookback: 3 }) : [];
    const ctx4h = (swingHighs4h.length && swingLows4h.length) ? {
      lastSwingHigh: swingHighs4h[swingHighs4h.length - 1],
      lastSwingLow:  swingLows4h[swingLows4h.length - 1],
      rangeHigh: Math.max(...klines4h.map(k => k.high)),
      rangeLow:  Math.min(...klines4h.map(k => k.low)),
      lastIndex: klines4h.length - 1,
    } : null;

    const sfpSignal       = findFreshSFPSignal(klines, ctx);
    const levelsSignal    = findFreshLevelZoneSignal(klines, ctx);
    const fibSignal       = findFreshFibSignal(klines, ctx);
    const structureSignal = findFreshStructureSignal(klines, ctx, swingHighs, swingLows);
    const divergenceSignal = ctx4h ? findFreshDivergenceSignal(klines4h, ctx4h) : null;
    const htfBias          = ctx4h ? findHTFPinbarBias(klines4h, ctx4h, swingHighs4h, swingLows4h) : null;

    let signals = [sfpSignal, levelsSignal, fibSignal, structureSignal, divergenceSignal].filter(Boolean);
    if (htfBias) {
      const biasSide = htfBias.direction === 'bullish' ? 'long' : 'short';
      const before = signals.length;
      signals = signals.filter(s => s.plan.side === biasSide);
      if (signals.length < before)
        log(`${symbol}: 4H pinbar bias (${htfBias.direction}) filtered out ${before - signals.length} opposing signal(s)`);
    }

    // No daily bias filter for futures — both longs and shorts are valid entries.
    // Counter-trend reversals (e.g. divergence+levels at key support in a bearish
    // daily trend) are fully tradeable on a futures account.

    if (!signals.length) { log(`${symbol}: no fresh signals`); continue; }

    const confluence = assessConfluence({ signals });
    if (!confluence.confluence) {
      log(`${symbol}: ${signals.map(s => `${s.strategy} -> ${s.summary}`).join(' | ')} — ${confluence.reason}`);
      continue;
    }

    const combinedKey = `confluence:${INTERVAL}:${confluence.agreeing_strategies.sort().join('+')}:` +
      signals.filter(s => confluence.agreeing_strategies.includes(s.strategy)).map(s => s.signalKey).sort().join(',');
    if (state[symbol]?.last_signal_key === combinedKey) {
      log(`${symbol}: confluence signal already processed (${combinedKey}) — skipping`);
      continue;
    }

    log(`${symbol}: CONFLUENCE — ${confluence.confidence} (${signals.map(s => `${s.strategy}: ${s.summary}`).join(' | ')})`);

    // Ch.6 same-role level entry rules (identical to spot bot):
    // 2nd same-role touch → SFP required; 3rd+ touch → divergence required.
    if (levelsSignal && confluence.agreeing_strategies.includes('levels') && levelsSignal.hitKind === 'retest') {
      if (levelsSignal.touchCount >= 3) {
        if (!confluence.agreeing_strategies.includes('divergence')) {
          log(`${symbol}: levels zone has ${levelsSignal.touchCount} same-role touches — 3rd+ touch requires divergence confirmation (Ch.6), not present — standing down`);
          state[symbol] = { last_signal_key: combinedKey, outcome: 'insufficient_confirmation' };
          continue;
        }
      } else {
        if (!confluence.agreeing_strategies.includes('sfp')) {
          log(`${symbol}: levels is a same-role retest — SFP required by Ch.6 for non-flip retests, not present — standing down`);
          state[symbol] = { last_signal_key: combinedKey, outcome: 'insufficient_confirmation' };
          continue;
        }
      }
    }

    const plan = confluence.plan;

    // availableCapital = usdt * LEVERAGE: the notional position size is capped at
    // what 2x leverage on our available margin can control
    const gate = evaluateTradeSetup({
      capital: usdt, riskPercent: RISK_PERCENT, leverage: LEVERAGE,
      entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side,
      historicalWinRate: HISTORICAL_WIN_RATE, availableCapital: usdt * LEVERAGE,
    });

    if (!gate.passes) {
      log(`${symbol}: confluence setup found (entry ${plan.entry}, stop ${plan.stop}) but FAILS the risk gate — ${gate.reasons.join('; ')}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'gate_failed' };
      continue;
    }

    const exec = translateForAccount({ plan, accountType: 'futures', positionSizeUsd: gate.position_size });

    if (!exec.executable) {
      log(`${symbol}: not executable — ${exec.note}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'not_executable' };
      continue;
    }

    const filters = await getSymbolFilters(symbol);
    const quantity = floorToStep(exec.quantity, filters.stepSize);
    const notional = quantity * plan.entry;
    if (quantity < filters.minQty || notional < filters.minNotional) {
      log(`${symbol}: executable size (${quantity} ≈ $${notional.toFixed(2)}) below exchange minimum — skipping`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'below_exchange_minimum' };
      continue;
    }

    // Build price ladder across [entry, stop] range — same mechanic as spot bot
    const ladderLow  = Math.min(plan.entry, plan.stop);
    const ladderHigh = Math.max(plan.entry, plan.stop);
    let ladder = null;
    if (ladderHigh > ladderLow) {
      const built = buildLadderOrders({ side: exec.order_side.toLowerCase(), totalSize: quantity, priceLow: ladderLow, priceHigh: ladderHigh, numOrders: LADDER_ORDERS });
      const rungs = built.orders.map(o => ({ price: roundToTick(o.price, filters.tickSize), size: floorToStep(o.size, filters.stepSize) }));
      if (rungs.every(r => r.size >= filters.minQty && r.size * r.price >= filters.minNotional)) ladder = rungs;
    }

    // SL/TP sides are always opposite to the entry side
    const closeSide = plan.side === 'short' ? 'BUY' : 'SELL';
    const slPrice   = roundToTick(plan.stop,   filters.tickSize);
    const tpPrice   = roundToTick(plan.target, filters.tickSize);

    // Idempotent — Binance ignores if already set correctly
    await setLeverage({ symbol, leverage: LEVERAGE });
    await setMarginType({ symbol, marginType: MARGIN_TYPE });

    // Commit dedup key before placing orders — prevents re-fire if execution throws
    state[symbol] = {
      last_signal_key: combinedKey,
      outcome: 'executing',
      position_side: plan.side,
      entry_price: plan.entry,
      sl_price: slPrice,
      tp_price: tpPrice,
      executed_at: new Date().toISOString(),
    };
    saveState(state);

    // Place entry ladder
    const entryOrders = [];
    if (ladder) {
      const avgPrice = (ladder.reduce((s, r) => s + r.price, 0) / ladder.length).toFixed(8);
      log(`${symbol}: EXECUTING ${exec.order_side.toUpperCase()} ${quantity} (${LEVERAGE}x) laddered into ${ladder.length} limit orders across ${ladderLow}-${ladderHigh} (avg ~${avgPrice}) — ${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed`);
      for (const rung of ladder) {
        try {
          const order = await placeOrder({ symbol, side: exec.order_side.toUpperCase(), type: 'LIMIT', quantity: rung.size, price: rung.price });
          log(`${symbol}: entry order — ${JSON.stringify(order)}`);
          entryOrders.push(order);
        } catch (err) {
          log(`${symbol}: entry rung FAILED (price ${rung.price}, qty ${rung.size}) — ${err.message}`);
        }
      }
    } else {
      log(`${symbol}: EXECUTING ${exec.order_side.toUpperCase()} ${quantity} (${LEVERAGE}x) @ ~${plan.entry} — ${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed`);
      try {
        const order = await placeOrder({ symbol, side: exec.order_side.toUpperCase(), type: 'MARKET', quantity });
        log(`${symbol}: entry order — ${JSON.stringify(order)}`);
        entryOrders.push(order);
      } catch (err) {
        log(`${symbol}: entry order FAILED — ${err.message}`);
      }
    }

    // Place SL and TP — closePosition: true so they close whatever fills, regardless of which rungs filled
    let slOrderId = null;
    let tpOrderId = null;

    try {
      const slOrder = await placeOrder({ symbol, side: closeSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: true });
      log(`${symbol}: SL order placed — stopPrice ${slPrice} (${JSON.stringify(slOrder)})`);
      slOrderId = slOrder.order_id;
    } catch (err) {
      log(`${symbol}: SL order FAILED — ${err.message}`);
    }

    try {
      const tpOrder = await placeOrder({ symbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: true });
      log(`${symbol}: TP order placed — stopPrice ${tpPrice} (${JSON.stringify(tpOrder)})`);
      tpOrderId = tpOrder.order_id;
    } catch (err) {
      log(`${symbol}: TP order FAILED — ${err.message}`);
    }

    state[symbol] = {
      ...state[symbol],
      outcome: 'open',
      entry_orders: entryOrders,
      sl_order_id: slOrderId,
      tp_order_id: tpOrderId,
    };

  } catch (err) {
    log(`${symbol}: ERROR — ${err.message}`);
  }
}

saveState(state);
log('scan complete');
