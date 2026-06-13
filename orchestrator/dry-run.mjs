#!/usr/bin/env node
/**
 * Deterministic dry-run — exercises the cycle's data + decision machinery (the
 * agent's tools) WITHOUT the model, an API key, or any write to the live config.
 * Win%/expectancy comes from the live-model trade logs (futures live ledger when
 * it has ≥ MIN_SAMPLE retained trades, else the confluence-bot backtest).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readResolvedTrades, ledgerTradesNormalized } from './lib/ledger.mjs';
import { readBacktestTrades } from './lib/backtest.mjs';
import { readEvents, summarizeEvents } from './lib/events.mjs';
import { estimatePerformance } from './lib/estimate.mjs';
import { validateProposal } from './lib/guardrails.mjs';
import { UNIVERSE, THRESHOLDS } from './config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  config: join(ROOT, 'orchestrator_config.json'),
  ledger: join(ROOT, 'trade_ledger.jsonl'),
  events: join(ROOT, 'bot_events.jsonl'),
  backtestSpot: join(ROOT, 'backtest_results.json'),
  backtestFutures: join(ROOT, 'backtest_futures_results.json'),
};
const windowMs = Date.now() - THRESHOLDS.EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const cfg = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, 'utf8')) : {};
const ledgerTrades = ledgerTradesNormalized(readResolvedTrades(paths.ledger, { sinceMs: windowMs }));
const backtest = { spot: readBacktestTrades(paths.backtestSpot), futures: readBacktestTrades(paths.backtestFutures) };
const events = summarizeEvents(readEvents(paths.events, { sinceMs: windowMs }));

console.log('=== INPUTS ===');
console.log(`futures live ledger trades (≥${THRESHOLDS.EVAL_WINDOW_DAYS}d): ${ledgerTrades.length}`);
console.log(`backtest trades — spot: ${backtest.spot.length}, futures: ${backtest.futures.length}`);
console.log(`events in window: ${events.total} (${JSON.stringify(events.bySeverity)})`);

const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const r = (x) => (x == null ? 'n/a' : x.toFixed(2) + 'R');

for (const bot of ['spot', 'futures']) {
  const current = cfg[bot] ?? {};
  const trades = { ledgerTrades: bot === 'futures' ? ledgerTrades : [], backtestTrades: backtest[bot] };
  console.log(`\n=== ${bot.toUpperCase()} ===`);

  const baseEst = estimatePerformance(current, trades);
  console.log(`current config baseline: win%=${pct(baseEst.winRate)} expectancy=${r(baseEst.expectancy)} sample=${baseEst.sample} (source: ${baseEst.source})`);

  const reaffirm = validateProposal({ bot, current, candidate: current, estimate: baseEst });
  console.log(`re-affirm current → ${reaffirm.classification} (changes: ${reaffirm.changes.length})`);

  // Example single-change candidate: disable cvd_divergence.
  const candidate = { ...current, active_strategies: (current.active_strategies ?? []).filter((s) => s !== 'cvd_divergence') };
  const est = estimatePerformance(candidate, trades);
  const verdict = validateProposal({ bot, current, candidate, estimate: est });
  console.log(`candidate "disable cvd_divergence": win%=${pct(est.winRate)} expectancy=${r(est.expectancy)} sample=${est.sample} (source: ${est.source}) → ${verdict.classification}`);
  if (verdict.violations.length) console.log(`  violations: ${verdict.violations.join(' | ')}`);
}

console.log(`\n(no live config written — deterministic dry-run; universe: ` +
  `spot ${UNIVERSE.spot.strategies.length}str/${UNIVERSE.spot.filters.length}flt, ` +
  `futures ${UNIVERSE.futures.strategies.length}str/${UNIVERSE.futures.filters.length}flt)`);
