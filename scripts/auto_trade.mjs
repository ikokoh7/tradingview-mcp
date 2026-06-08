#!/usr/bin/env node
/**
 * Standalone autonomous SFP scan -> risk gate -> spot-account execution pass.
 *
 * Run on a timer (Windows Task Scheduler) — each invocation does ONE pass:
 * scans BTC/ETH/BNB on the 15m timeframe for confirmed Swing Failure Patterns
 * (close-based sweep confirmation per the curriculum), gates any hit through
 * the deterministic Trading Trident risk rules (caps, R:R/win-rate breakeven,
 * capital-aware sizing), translates the resulting plan into a spot-executable
 * order, and places it — only if every rule passes and the order is faithfully
 * executable on a SPOT account (no shorting; bearish signals require existing
 * inventory to sell).
 *
 * State is tracked in auto_trade_state.json (one entry per symbol, keyed on
 * the confirming candle's open_time) so the same confirmed signal is never
 * acted on twice across repeated polls.
 *
 * TESTNET ONLY — uses core/binance.js (testnet), never core/binance_live.js.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Minimal .env loader (KEY=VALUE per line, # comments) — no extra dependency.
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

const { getKlines, accountInfo, placeOrder } = await import('../src/core/binance.js');
const { findSwingHighs, findSwingLows, scanForSFP, buildSFPTradePlan } = await import('../src/core/sfp.js');
const { evaluateTradeSetup, translateForAccount } = await import('../src/core/risk.js');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const INTERVAL = '15m';
const RISK_PERCENT = 1; // bottom of the curriculum's 1-3% per-trade cap
const HISTORICAL_WIN_RATE = 40; // conservative placeholder pending a measured backtest harness
const FRESHNESS_BARS = 2; // only act on sweeps confirmed within the last N closed bars

const STATE_PATH = join(ROOT, 'auto_trade_state.json');
const LOG_PATH = join(ROOT, 'auto_trade.log');

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

// Exchange LOT_SIZE/MIN_NOTIONAL filters are enforced server-side and reject
// any quantity that doesn't land on the symbol's step size or clear the min
// order value — fetch them once per pass so orders are placed at a valid precision.
async function getSymbolFilters(symbol) {
  const res = await fetch(`https://testnet.binance.vision/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  const filters = data.symbols[0].filters;
  const lot = filters.find(f => f.filterType === 'LOT_SIZE');
  const notional = filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
  return { stepSize: Number(lot.stepSize), minQty: Number(lot.minQty), minNotional: Number(notional?.minNotional ?? 0) };
}

function floorToStep(quantity, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const factor = 10 ** decimals;
  return Number((Math.floor(quantity * factor) / factor).toFixed(decimals));
}

const state = loadState();
const account = await accountInfo();
const balanceOf = (asset) => account.balances.find(b => b.asset === asset)?.free ?? 0;
const usdt = balanceOf('USDT');

log(`scan start — interval=${INTERVAL} symbols=${SYMBOLS.join(',')} usdt_balance=${usdt.toFixed(2)}`);

for (const symbol of SYMBOLS) {
  try {
    const { klines: rawKlines } = await getKlines({ symbol, interval: INTERVAL, limit: 150 });
    // Exclude the still-forming candle — its OHLC keeps changing until close_time
    // passes, which would make signals flicker in and out between polls. Only
    // confirmed, closed bars are stable enough to act on.
    const klines = rawKlines.filter(k => k.close_time <= Date.now());
    if (klines.length < 10) { log(`${symbol}: not enough closed bars yet — skipping`); continue; }
    const swingHighs = findSwingHighs(klines, { lookback: 3 });
    const swingLows = findSwingLows(klines, { lookback: 3 });
    if (!swingHighs.length || !swingLows.length) { log(`${symbol}: no swing points established yet — skipping`); continue; }

    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const lastSwingLow = swingLows[swingLows.length - 1];
    const rangeHigh = Math.max(...klines.map(k => k.high));
    const rangeLow = Math.min(...klines.map(k => k.low));
    const lastIndex = klines.length - 1;

    const bearishHits = scanForSFP(klines.slice(lastSwingHigh.index + 1), { level: lastSwingHigh.price, type: 'bearish' })
      .map(h => ({ ...h, index: h.index + lastSwingHigh.index + 1 }));
    const bullishHits = scanForSFP(klines.slice(lastSwingLow.index + 1), { level: lastSwingLow.price, type: 'bullish' })
      .map(h => ({ ...h, index: h.index + lastSwingLow.index + 1 }));

    const candidates = [
      ...bearishHits.map(hit => ({ hit, type: 'bearish', target: lastSwingLow.price, alt: rangeLow })),
      ...bullishHits.map(hit => ({ hit, type: 'bullish', target: lastSwingHigh.price, alt: rangeHigh })),
    ].filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);

    if (!candidates.length) { log(`${symbol}: no fresh confirmed SFP within the last ${FRESHNESS_BARS} closed bars`); continue; }

    // If both directions are fresh (rare), the most recently confirmed sweep wins.
    candidates.sort((a, b) => b.hit.index - a.hit.index);
    const { hit, type, target, alt } = candidates[0];

    const signalKey = `${symbol}:${INTERVAL}:${hit.bar.open_time}:${type}`;
    if (state[symbol]?.last_signal_key === signalKey) {
      log(`${symbol}: signal already processed (${signalKey}) — skipping`);
      continue;
    }

    const plan = buildSFPTradePlan({ hit, type, lastSwingLevel: target, rangeLevel: alt });
    const gate = evaluateTradeSetup({
      capital: usdt, riskPercent: RISK_PERCENT, leverage: 1,
      entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side,
      historicalWinRate: HISTORICAL_WIN_RATE, availableCapital: usdt,
    });

    if (!gate.passes) {
      log(`${symbol}: ${type} SFP found (entry ${plan.entry}, stop ${plan.stop}) but FAILS the risk gate — ${gate.reasons.join('; ')}`);
      state[symbol] = { last_signal_key: signalKey, outcome: 'gate_failed' };
      continue;
    }

    const asset = symbol.replace('USDT', '');
    const exec = translateForAccount({ plan, accountType: 'spot', positionSizeUsd: gate.position_size, heldQuantity: balanceOf(asset) });

    if (!exec.executable) {
      log(`${symbol}: ${type} SFP passes the gate (entry ${plan.entry}, stop ${plan.stop}, R:R 1:${gate.reward_per_risk.toFixed(2)}) ` +
          `but is NOT executable on this spot account — ${exec.note}`);
      state[symbol] = { last_signal_key: signalKey, outcome: 'not_executable' };
      continue;
    }

    const filters = await getSymbolFilters(symbol);
    const quantity = floorToStep(exec.quantity, filters.stepSize);
    const notional = quantity * plan.entry;
    if (quantity < filters.minQty || notional < filters.minNotional) {
      log(`${symbol}: ${type} SFP signal is valid but the executable size (${quantity} ${asset} ≈ $${notional.toFixed(2)}) ` +
          `falls below the exchange minimum (minQty ${filters.minQty}, minNotional $${filters.minNotional}) — skipping`);
      state[symbol] = { last_signal_key: signalKey, outcome: 'below_exchange_minimum' };
      continue;
    }

    log(`${symbol}: EXECUTING ${exec.order_side} ${quantity} ${asset} @ ~${plan.entry} — ` +
        `${type} SFP, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed (${exec.note})`);

    const order = await placeOrder({ symbol, side: exec.order_side, type: 'MARKET', quantity });
    log(`${symbol}: order result — ${JSON.stringify(order)}`);

    state[symbol] = { last_signal_key: signalKey, outcome: 'executed', order, executed_at: new Date().toISOString() };
  } catch (err) {
    log(`${symbol}: ERROR — ${err.message}`);
  }
}

saveState(state);
log('scan complete');
