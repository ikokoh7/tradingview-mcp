#!/usr/bin/env node
/**
 * Walk-forward backtesting harness — measures the real win rate of the
 * six-strategy confluence system so HISTORICAL_WIN_RATE in auto_trade.mjs
 * can be replaced with a measured number instead of the current placeholder.
 *
 * Methodology:
 *   For each symbol, fetch ~2000 closed 15m bars from the Binance MAINNET
 *   public API (no auth required). Walk forward bar by bar from bar 150
 *   onward. At each step, run all six strategy detectors on the trailing
 *   150-bar window (identical to what the live bot sees). When two or more
 *   strategies agree — confluence — record the trade. Simulate its outcome
 *   by walking the remaining bars: a trade wins when its close crosses the
 *   target, loses when its close crosses the stop (close-based throughout,
 *   consistent with the system's own entry discipline). Cap open trades at
 *   100 bars so the stats stay bounded.
 *
 *   The risk gate is deliberately skipped here — we are measuring raw signal
 *   quality (what is the true win rate the risk gate should be calibrated
 *   against), not the post-filtered rate.
 *
 * Output:
 *   Console summary per symbol and overall.
 *   backtest_results.json written to the repo root.
 *
 * Usage:
 *   node scripts/run_backtest.mjs
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { findSwingHighs, findSwingLows, scanForSFP, buildSFPTradePlan } = await import('../src/core/sfp.js');
const { scanForDivergence, buildDivergenceTradePlan } = await import('../src/core/divergence.js');
const { detectZones, findZoneRetests, buildZoneTradePlan } = await import('../src/core/levels.js');
const { scanForFibReaction, buildFibTradePlan } = await import('../src/core/fibonacci.js');
const { detectMarketStructure, buildStructureTradePlan } = await import('../src/core/market_structure.js');
const { scanForPinbarSetup, buildPinbarTradePlan } = await import('../src/core/pinbar.js');
const { assessConfluence } = await import('../src/core/confluence.js');

const SYMBOLS     = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const INTERVAL    = '15m';
const WINDOW_SIZE = 150;   // trailing bar window — mirrors the live bot's limit
const FRESHNESS_BARS = 2;  // same as auto_trade.mjs
const RSI_PERIOD  = 14;    // curriculum default
const MAX_HOLD    = 100;   // bars before marking a trade 'open' (unresolved)
const PAGES       = 2;     // pages × 1000 bars = 2000 bars ≈ 20 days of 15m data

// ---- Mainnet public klines (no auth) ----------------------------------------

function fetchKlinesPage(symbol, interval, limit, endTime) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (endTime != null) params.set('endTime', String(endTime));
    https.get({
      hostname: 'api.binance.com',
      path: `/api/v3/klines?${params}`,
      agent: false,
      headers: { 'User-Agent': 'tradingview-mcp-backtest/1.0' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).map(k => ({
            open_time: k[0], open: Number(k[1]), high: Number(k[2]),
            low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), close_time: k[6],
          })));
        } catch (e) { reject(new Error(`Parse error: ${e.message} — body: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchHistory(symbol) {
  let allBars = [];
  let endTime = undefined;
  for (let p = 0; p < PAGES; p++) {
    const page = await fetchKlinesPage(symbol, INTERVAL, 1000, endTime);
    if (!page.length) break;
    allBars = [...page, ...allBars];     // oldest-first
    endTime = page[0].open_time - 1;    // next page ends just before this one
  }
  allBars.sort((a, b) => a.open_time - b.open_time);
  const now = Date.now();
  return allBars.filter(k => k.close_time <= now); // closed bars only
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
  return { strategy: 'sfp', plan, confirmedAt: hit.bar.open_time,
    signalKey: `sfp:${type}:${hit.bar.open_time}`,
    summary: `${type} SFP (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})` };
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
  fresh.sort((a, b) => b.hit.newer_swing.index - a.hit.newer_swing.index);
  const { hit, type } = fresh[0];
  const target = type === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = type === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildDivergenceTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'divergence', plan, confirmedAt: hit.newer_swing.bar.open_time,
    signalKey: `divergence:${hit.pattern}:${type}:${hit.newer_swing.bar.open_time}`,
    summary: `${hit.pattern} ${type} divergence (entry ${plan.entry}, stop ${plan.stop})` };
}

function findFreshLevelZoneSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const zones = detectZones(klines);
  const candidates = [];
  for (const zone of zones) {
    const hits = findZoneRetests(klines, zone);
    if (hits.length) candidates.push({ zone, hit: hits[hits.length - 1] });
  }
  const fresh = candidates.filter(c => lastIndex - c.hit.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.hit.index - a.hit.index);
  const { zone, hit } = fresh[0];
  const target = zone.type === 'support' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = zone.type === 'support' ? rangeHigh : rangeLow;
  const plan = buildZoneTradePlan({ zone, hit, oppositeZoneLevel: target, rangeLevel: alt });
  return { strategy: 'levels', plan, confirmedAt: hit.bar.open_time,
    signalKey: `levels:${zone.type}:${zone.classification}:${hit.bar.open_time}`,
    summary: `${zone.classification} ${zone.type} zone retest [${zone.low}-${zone.high}] (${hit.kind})` };
}

function findFreshFibSignal(klines, ctx) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  if (lastSwingHigh.index === lastSwingLow.index) return null;
  const { direction, hits } = scanForFibReaction(klines, { swingHigh: lastSwingHigh, swingLow: lastSwingLow });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildFibTradePlan({ hit, direction, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'fibonacci', plan, confirmedAt: hit.bar.open_time,
    signalKey: `fibonacci:${direction}:${hit.bar.open_time}`,
    summary: `${direction} golden-pocket reaction (${hit.kind}, entry ${plan.entry}, stop ${plan.stop})` };
}

function findFreshStructureSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { choch, trend } = detectMarketStructure(klines, { swingHighs, swingLows });
  if (!trend || !choch.length) return null;
  const fresh = choch.filter(c => lastIndex - c.index <= FRESHNESS_BARS);
  if (!fresh.length) return null;
  const c = fresh[fresh.length - 1];
  const target = trend === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = trend === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildStructureTradePlan({ choch: c, trend, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'market_structure', plan, confirmedAt: c.bar.open_time,
    signalKey: `market_structure:${trend}:${c.bar.open_time}`,
    summary: `${trend} CHoCH entry (entry ${plan.entry}, stop ${plan.stop})` };
}

function findFreshPinbarSignal(klines, ctx, swingHighs, swingLows) {
  const { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex } = ctx;
  const { hits } = scanForPinbarSetup(klines, { swingHighs, swingLows });
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (lastIndex - hit.index > FRESHNESS_BARS) return null;
  const target = hit.direction === 'bullish' ? lastSwingHigh.price : lastSwingLow.price;
  const alt    = hit.direction === 'bullish' ? rangeHigh : rangeLow;
  const plan = buildPinbarTradePlan({ hit, lastSwingLevel: target, rangeLevel: alt });
  return { strategy: 'pinbar', plan, confirmedAt: hit.bar.open_time,
    signalKey: `pinbar:${hit.direction}:${hit.biasIndex}:${hit.bar.open_time}`,
    summary: `${hit.direction} pinbar at swing extreme + level retest (entry ${plan.entry}, stop ${plan.stop})` };
}

// ---- Outcome simulation ------------------------------------------------------

function simulateOutcome(allBars, { entry, stop, target, side, startIndex }) {
  const isLong = String(side).toUpperCase() === 'BUY';
  for (let i = startIndex + 1; i < allBars.length && i <= startIndex + MAX_HOLD; i++) {
    const close = allBars[i].close;
    if (isLong) {
      if (close >= target) return { outcome: 'win',  exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
      if (close <= stop)   return { outcome: 'loss', exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
    } else {
      if (close <= target) return { outcome: 'win',  exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
      if (close >= stop)   return { outcome: 'loss', exitIndex: i, exitPrice: close, barsHeld: i - startIndex };
    }
  }
  return { outcome: 'open', exitIndex: null, exitPrice: null, barsHeld: null };
}

// ---- Walk-forward engine ------------------------------------------------------

async function backtestSymbol(symbol) {
  process.stdout.write(`${symbol}: fetching history... `);
  const allBars = await fetchHistory(symbol);
  console.log(`${allBars.length} closed bars`);

  const trades = [];
  const seenKeys = new Set();

  for (let i = WINDOW_SIZE; i < allBars.length; i++) {
    const klines = allBars.slice(i - WINDOW_SIZE + 1, i + 1);
    let swingHighs, swingLows, ctx, signals, confluence;

    try {
      swingHighs = findSwingHighs(klines, { lookback: 3 });
      swingLows  = findSwingLows(klines, { lookback: 3 });
      if (!swingHighs.length || !swingLows.length) continue;

      const lastSwingHigh = swingHighs[swingHighs.length - 1];
      const lastSwingLow  = swingLows[swingLows.length - 1];
      const rangeHigh = Math.max(...klines.map(k => k.high));
      const rangeLow  = Math.min(...klines.map(k => k.low));
      const lastIndex = klines.length - 1;
      ctx = { lastSwingHigh, lastSwingLow, rangeHigh, rangeLow, lastIndex };

      const sfpSig       = findFreshSFPSignal(klines, ctx);
      const divSig       = findFreshDivergenceSignal(klines, ctx);
      const levelsSig    = findFreshLevelZoneSignal(klines, ctx);
      const fibSig       = findFreshFibSignal(klines, ctx);
      const structureSig = findFreshStructureSignal(klines, ctx, swingHighs, swingLows);
      const pinbarSig    = findFreshPinbarSignal(klines, ctx, swingHighs, swingLows);
      signals = [sfpSig, divSig, levelsSig, fibSig, structureSig, pinbarSig].filter(Boolean);
    } catch { continue; }

    if (!signals.length) continue;
    const conf = assessConfluence({ signals });
    if (!conf.confluence) continue;

    // Dedup — same confluence can span several sequential bars while still fresh
    const key = `${symbol}:${conf.agreeing_strategies.sort().join('+')}:` +
      signals.filter(s => conf.agreeing_strategies.includes(s.strategy))
             .map(s => s.signalKey).sort().join(',');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const plan = conf.plan;
    const rr = Math.abs(plan.target - plan.entry) / Math.abs(plan.entry - plan.stop);
    const sim = simulateOutcome(allBars, { entry: plan.entry, stop: plan.stop, target: plan.target, side: plan.side, startIndex: i });

    trades.push({
      symbol,
      bar_time:   new Date(allBars[i].open_time).toISOString(),
      strategies: conf.agreeing_strategies.sort(),
      confidence: conf.confidence,
      side:       plan.side,
      entry:      plan.entry,
      stop:       plan.stop,
      target:     plan.target,
      rr:         Math.round(rr * 100) / 100,
      ...sim,
    });
  }

  return trades;
}

// ---- Summary stats -----------------------------------------------------------

function summarise(trades) {
  const resolved = trades.filter(t => t.outcome !== 'open');
  const wins     = resolved.filter(t => t.outcome === 'win');
  const losses   = resolved.filter(t => t.outcome === 'loss');
  const open     = trades.filter(t => t.outcome === 'open');
  const winRate  = resolved.length ? Math.round((wins.length / resolved.length) * 100) : null;
  const avgRR    = resolved.length
    ? Math.round(resolved.reduce((s, t) => s + t.rr, 0) / resolved.length * 100) / 100
    : null;
  const avgBars  = wins.concat(losses).filter(t => t.barsHeld != null).length
    ? Math.round(wins.concat(losses).filter(t => t.barsHeld != null)
        .reduce((s, t) => s + t.barsHeld, 0) / wins.concat(losses).filter(t => t.barsHeld != null).length)
    : null;

  // Break down by strategy combination
  const byCombination = {};
  for (const t of resolved) {
    const k = t.strategies.join('+');
    if (!byCombination[k]) byCombination[k] = { wins: 0, total: 0 };
    byCombination[k].total++;
    if (t.outcome === 'win') byCombination[k].wins++;
  }

  return { total: trades.length, wins: wins.length, losses: losses.length, open: open.length,
           winRate, avgRR, avgBars, byCombination };
}

function printSummary(label, stats) {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ${label}`);
  console.log(`${'─'.repeat(52)}`);
  console.log(`  Total trades:   ${stats.total}  (${stats.wins}W / ${stats.losses}L / ${stats.open} open)`);
  console.log(`  Win rate:       ${stats.winRate != null ? stats.winRate + '%' : 'n/a'} (resolved trades only)`);
  console.log(`  Avg R:R setup:  ${stats.avgRR != null ? '1:' + stats.avgRR : 'n/a'}`);
  console.log(`  Avg bars held:  ${stats.avgBars != null ? stats.avgBars : 'n/a'}`);
  if (Object.keys(stats.byCombination).length) {
    console.log(`  By strategy combination:`);
    for (const [combo, s] of Object.entries(stats.byCombination)) {
      const wr = Math.round(s.wins / s.total * 100);
      console.log(`    ${combo.padEnd(38)} ${wr}%  (${s.wins}/${s.total})`);
    }
  }
}

// ---- Main -------------------------------------------------------------------

console.log(`\nBacktest — ${SYMBOLS.join(', ')} — ${INTERVAL} — ${PAGES * 1000} bars each\n`);

const allTrades = [];
for (const symbol of SYMBOLS) {
  const trades = await backtestSymbol(symbol);
  const stats  = summarise(trades);
  printSummary(symbol, stats);
  allTrades.push(...trades);
}

const overall = summarise(allTrades);
printSummary('OVERALL', overall);

const outPath = join(ROOT, 'backtest_results.json');
writeFileSync(outPath, JSON.stringify({ run_at: new Date().toISOString(), summary: overall, trades: allTrades }, null, 2));
console.log(`\nFull trade log written to: backtest_results.json\n`);

if (overall.winRate != null) {
  console.log(`>>> Suggested HISTORICAL_WIN_RATE = ${overall.winRate}`);
  console.log(`    (replace the placeholder in scripts/auto_trade.mjs line ~80)\n`);
}
