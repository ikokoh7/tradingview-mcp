/**
 * Tests for the deterministic risk-management rules in core/risk.js.
 * Pure functions — no live chart/exchange connection needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionSize,
  riskRewardRatio,
  breakevenWinRate,
  minRewardPerRiskForWinRate,
  drawdownRecovery,
  evolvingR,
  checkRiskLimits,
  evaluateTradeSetup,
} from '../src/core/risk.js';

describe('positionSize()', () => {
  it('matches the curriculum worked example: $10k, 3% risk, 5% stop -> $6000', () => {
    const { position_size, risk_amount } = positionSize({ capital: 10000, riskPercent: 3, stopLossPercent: 5 });
    assert.equal(risk_amount, 300);
    assert.equal(position_size, 6000);
  });

  it('matches the second worked example: $1k, 1% risk, 5% stop -> $200', () => {
    const { position_size } = positionSize({ capital: 1000, riskPercent: 1, stopLossPercent: 5 });
    assert.equal(position_size, 200);
  });

  it('rejects non-positive capital', () => {
    assert.throws(() => positionSize({ capital: 0, riskPercent: 1, stopLossPercent: 5 }));
  });

  it('rejects out-of-range risk percent', () => {
    assert.throws(() => positionSize({ capital: 1000, riskPercent: 150, stopLossPercent: 5 }));
  });
});

describe('riskRewardRatio()', () => {
  it('matches the curriculum worked example: long $100 entry, $50 stop, $200 target -> 1:2 (ratio 0.5)', () => {
    const { risk, reward, ratio } = riskRewardRatio({ entry: 100, stop: 50, target: 200, side: 'long' });
    assert.equal(risk, 50);
    assert.equal(reward, 100);
    assert.equal(ratio, 0.5);
  });

  it('handles shorts symmetrically', () => {
    const { risk, reward, ratio } = riskRewardRatio({ entry: 100, stop: 150, target: 0.01 + 50, side: 'short' });
    assert.equal(risk, 50);
    assert.ok(reward > 0);
    assert.ok(ratio > 0);
  });

  it('rejects a stop on the wrong side of entry for a long', () => {
    assert.throws(() => riskRewardRatio({ entry: 100, stop: 150, target: 200, side: 'long' }));
  });

  it('rejects a target on the wrong side of entry for a long', () => {
    assert.throws(() => riskRewardRatio({ entry: 100, stop: 50, target: 80, side: 'long' }));
  });
});

describe('breakevenWinRate()', () => {
  it('a 1:1 reward:risk requires a 50% win rate to break even', () => {
    assert.equal(breakevenWinRate({ rewardPerRisk: 1 }).breakeven_win_rate_percent, 50);
  });

  it('matches the curriculum worked example: 1:2 R:R -> 33% breakeven win rate', () => {
    const { breakeven_win_rate_percent } = breakevenWinRate({ rewardPerRisk: 2 });
    assert.ok(Math.abs(breakeven_win_rate_percent - 33.33) < 0.01);
  });
});

describe('minRewardPerRiskForWinRate()', () => {
  it('matches every row of the curriculum lookup table', () => {
    const cases = [
      [25, 3], [33, 2], [40, 1.5], [50, 1], [60, 0.7], [75, 0.3],
    ];
    for (const [winRate, expected] of cases) {
      const { min_reward_per_risk } = minRewardPerRiskForWinRate({ winRate });
      assert.ok(Math.abs(min_reward_per_risk - expected) < 0.05, `win rate ${winRate}%: expected ~${expected}, got ${min_reward_per_risk}`);
    }
  });
});

describe('drawdownRecovery()', () => {
  it('matches every row of the curriculum drawdown table', () => {
    const cases = [
      [10, 11.11], [20, 25], [30, 42.86], [40, 66.67],
      [50, 100], [60, 150], [70, 233.33], [80, 400], [90, 900],
    ];
    for (const [loss, expected] of cases) {
      const { recovery_percent_required } = drawdownRecovery({ lossPercent: loss });
      assert.ok(Math.abs(recovery_percent_required - expected) < 0.5, `loss ${loss}%: expected ~${expected}%, got ${recovery_percent_required}%`);
    }
  });
});

describe('evolvingR()', () => {
  it('matches the curriculum worked example: risked 2%, now up 6% -> currentR = 3', () => {
    // entry 100, stop 98 (2% risk), current 106 (6% gain) -> R = 6/2 = 3
    const { current_r } = evolvingR({ entry: 100, stop: 98, current: 106, side: 'long' });
    assert.equal(current_r, 3);
  });

  it('flags the early-exit threshold when 0 < currentR < 0.5', () => {
    const { current_r, below_early_exit_threshold } = evolvingR({ entry: 100, stop: 98, current: 100.5, side: 'long' });
    assert.ok(current_r > 0 && current_r < 0.5);
    assert.equal(below_early_exit_threshold, true);
  });

  it('does not flag when currentR is at or above 0.5', () => {
    const { below_early_exit_threshold } = evolvingR({ entry: 100, stop: 98, current: 101, side: 'long' });
    assert.equal(below_early_exit_threshold, false);
  });

  it('does not flag when the trade is at a loss (negative R)', () => {
    const { current_r, below_early_exit_threshold } = evolvingR({ entry: 100, stop: 98, current: 99, side: 'long' });
    assert.ok(current_r < 0);
    assert.equal(below_early_exit_threshold, false);
  });
});

describe('checkRiskLimits()', () => {
  it('passes within the 1-3% risk and 5x leverage caps', () => {
    assert.equal(checkRiskLimits({ riskPercent: 2, leverage: 3 }).passes, true);
  });

  it('flags risk above 3%', () => {
    const { passes, violations } = checkRiskLimits({ riskPercent: 5, leverage: 1 });
    assert.equal(passes, false);
    assert.ok(violations.some(v => v.includes('riskPercent')));
  });

  it('flags leverage above 5x', () => {
    const { passes, violations } = checkRiskLimits({ riskPercent: 1, leverage: 10 });
    assert.equal(passes, false);
    assert.ok(violations.some(v => v.includes('leverage')));
  });
});

describe('evaluateTradeSetup() — Trading Trident gate', () => {
  it('passes a clean setup that clears all caps and the win-rate breakeven check', () => {
    const result = evaluateTradeSetup({
      capital: 10000,
      riskPercent: 2,
      leverage: 3,
      entry: 100,
      stop: 95,
      target: 120,
      side: 'long',
      historicalWinRate: 40,
    });
    assert.equal(result.passes, true);
    assert.deepEqual(result.reasons, []);
    assert.ok(result.position_size > 0);
  });

  it('fails when risk % exceeds the cap, with a reason', () => {
    const result = evaluateTradeSetup({
      capital: 10000,
      riskPercent: 8,
      entry: 100,
      stop: 95,
      target: 120,
    });
    assert.equal(result.passes, false);
    assert.ok(result.reasons.some(r => r.includes('riskPercent')));
  });

  it('fails when reward:risk is below the breakeven threshold for the stated win rate', () => {
    // 40% win rate requires >= 1:1.5 reward:risk; this trade offers only 1:1
    const result = evaluateTradeSetup({
      capital: 10000,
      riskPercent: 2,
      entry: 100,
      stop: 95,
      target: 105,
      historicalWinRate: 40,
    });
    assert.equal(result.passes, false);
    assert.ok(result.reasons.some(r => r.includes('below the')));
  });
});
