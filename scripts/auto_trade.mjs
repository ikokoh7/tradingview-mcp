#!/usr/bin/env node
/**
 * Standalone autonomous multi-strategy scan -> confluence -> risk gate ->
 * spot-account execution pass.
 *
 * Run on a timer (Windows Task Scheduler) — each invocation does ONE pass:
 * scans BTC/ETH/BNB on the 15m timeframe with TWO independently-coded
 * strategies — Swing Failure Pattern (close-based sweep confirmation) and
 * RSI Divergence (close-based price/oscillator swing comparison) — and
 * requires CONFLUENCE: per the curriculum's repeated guidance that
 * complementary techniques produce more accurate setups ("adding further
 * confirmations leads to a more profitable setup"; SFP retests are "higher
 * conviction, not a lesser consolation entry"), a setup is only acted on
 * when 2+ strategies independently agree on direction. Disagreement or a
 * lone signal both result in standing down — no rule exists to force a call
 * from a single uncorroborated read, and inventing one would just be live
 * judgment wearing code's clothing.
 *
 * A confirmed confluence then runs through the deterministic Trading Trident
 * risk rules (caps, R:R/win-rate breakeven, capital-aware sizing), gets
 * translated into a spot-executable order, and is placed — only if every
 * rule passes and the order is faithfully executable on a SPOT account (no
 * shorting; bearish signals require existing inventory to sell).
 *
 * State is tracked in auto_trade_state.json (one entry per symbol, keyed on
 * the agreeing strategies + their confirming candles' open_times) so the
 * same confirmed confluence is never acted on twice across repeated polls.
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
const { scanForDivergence, buildDivergenceTradePlan } = await import('../src/core/divergence.js');
const { assessConfluence } = await import('../src/core/confluence.js');
const { evaluateTradeSetup, translateForAccount } = await import('../src/core/risk.js');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const INTERVAL = '15m';
const RISK_PERCENT = 1; // bottom of the curriculum's 1-3% per-trade cap
const HISTORICAL_WIN_RATE = 40; // conservative placeholder pending a measured backtest harness
const FRESHNESS_BARS = 2; // only act on signals confirmed within the last N closed bars
const RSI_PERIOD = 14; // curriculum default for divergence detection

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

// ---- Strategy detectors --------------------------------------------------
// Each returns a candidate signal in the common shape confluence_assess
// expects ({ strategy, plan, confirmedAt, signalKey, summary }), or null if
// that strategy found nothing fresh. Kept independent and side-effect-free —
// confluence is what decides whether either is acted on.

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

  // If both directions are fresh (rare), the most recently confirmed sweep wins.
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

function findFreshDivergenceSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const candidates = [];
  for (const type of ['bullish', 'bearish']) {
    const result = scanForDivergence(klines, { type, rsiPeriod: RSI_PERIOD });
    if (result.divergence) candidates.push({ hit: result, type });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.newer_swing.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;

  // If both directions are fresh (rare), the most recently confirmed swing wins.
  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  // Bullish divergence predicts a bottom -> targets the upside (last swing high / range high);
  // bearish predicts a top -> targets the downside (last swing low / range low) — same
  // opposite-side-target convention as SFP's buildSFPTradePlan.
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return {
    strategy: 'divergence',
    plan,
    confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `${hit.pattern} ${type} divergence (entry ${plan.entry}, stop ${plan.stop})`,
  };
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
    const ctx = { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex };

    // Run every coded strategy independently, then require AGREEMENT before
    // acting — the curriculum is explicit that techniques COMPLEMENT each
    // other for more accurate setups ("adding further confirmations leads to
    // a more profitable setup"; SFP retests are "higher conviction, not a
    // lesser consolation entry"). One strategy alone is no longer sufficient.
    const sfpSignal = findFreshSFPSignal(klines, ctx);
    const divergenceSignal = findFreshDivergenceSignal(klines, ctx);
    const signals = [sfpSignal, divergenceSignal].filter(Boolean);

    if (!signals.length) { log(`${symbol}: no fresh signals from either strategy within the last ${FRESHNESS_BARS} closed bars`); continue; }

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

    const plan = confluence.plan;
    const gate = evaluateTradeSetup({
      capital: usdt, riskPercent: RISK_PERCENT, leverage: 1,
      entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side,
      historicalWinRate: HISTORICAL_WIN_RATE, availableCapital: usdt,
    });

    if (!gate.passes) {
      log(`${symbol}: confluence setup found (entry ${plan.entry}, stop ${plan.stop}) but FAILS the risk gate — ${gate.reasons.join('; ')}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'gate_failed' };
      continue;
    }

    const asset = symbol.replace('USDT', '');
    const exec = translateForAccount({ plan, accountType: 'spot', positionSizeUsd: gate.position_size, heldQuantity: balanceOf(asset) });

    if (!exec.executable) {
      log(`${symbol}: confluence setup passes the gate (entry ${plan.entry}, stop ${plan.stop}, R:R 1:${gate.reward_per_risk.toFixed(2)}) ` +
          `but is NOT executable on this spot account — ${exec.note}`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'not_executable' };
      continue;
    }

    const filters = await getSymbolFilters(symbol);
    const quantity = floorToStep(exec.quantity, filters.stepSize);
    const notional = quantity * plan.entry;
    if (quantity < filters.minQty || notional < filters.minNotional) {
      log(`${symbol}: confluence signal is valid but the executable size (${quantity} ${asset} ≈ $${notional.toFixed(2)}) ` +
          `falls below the exchange minimum (minQty ${filters.minQty}, minNotional $${filters.minNotional}) — skipping`);
      state[symbol] = { last_signal_key: combinedKey, outcome: 'below_exchange_minimum' };
      continue;
    }

    log(`${symbol}: EXECUTING ${exec.order_side} ${quantity} ${asset} @ ~${plan.entry} — ` +
        `${confluence.confidence}, R:R 1:${gate.reward_per_risk.toFixed(2)}, gate passed (${exec.note})`);

    const order = await placeOrder({ symbol, side: exec.order_side, type: 'MARKET', quantity });
    log(`${symbol}: order result — ${JSON.stringify(order)}`);

    state[symbol] = { last_signal_key: combinedKey, outcome: 'executed', order, executed_at: new Date().toISOString() };
  } catch (err) {
    log(`${symbol}: ERROR — ${err.message}`);
  }
}

saveState(state);
log('scan complete');
