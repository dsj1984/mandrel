// tests/retro-perf-heuristics.test.js
/**
 * Story #3042 / Task #3045 — `classifyPerfSignals` heuristics over the
 * `epic-perf-report.waveParallelism` row shape.
 *
 * Confirms each of the three signal kinds and the no-signal happy path:
 *   - `low-utilisation` per wave below the threshold.
 *   - `high-bootstrap-share` when summed story-init time exceeds threshold
 *     of the cumulative summedStoryMs.
 *   - `cap-binding-run` for runs of consecutive capBinding waves.
 *   - Empty array when no signal trips.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyPerfSignals,
  DEFAULT_RETRO_PERF_THRESHOLDS,
  resolvePerfThresholds,
} from '../.agents/scripts/lib/orchestration/retro-perf-heuristics.js';

function makeReport({ waveParallelism = [], storyPerfSummaries = [] } = {}) {
  return {
    kind: 'epic-perf-report',
    epicId: 99,
    generatedAt: '2026-05-26T00:00:00Z',
    waveParallelism,
    storyPerfSummaries,
  };
}

describe('classifyPerfSignals (Story #3045)', () => {
  it('returns [] when no signal trips', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: false,
        },
        {
          waveIndex: 1,
          wallClockMs: 2000,
          summedStoryMs: 2400,
          utilisation: 0.6,
          capBinding: true,
        },
      ],
      storyPerfSummaries: [{ phaseTimingsMs: { 'story-init': 100 } }],
    });
    const signals = classifyPerfSignals(report);
    assert.deepEqual(signals, []);
  });

  it('returns low-utilisation per wave below threshold', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 400,
          utilisation: 0.2,
          capBinding: false,
        },
        {
          waveIndex: 1,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: false,
        },
        {
          waveIndex: 2,
          wallClockMs: 1000,
          summedStoryMs: 200,
          utilisation: 0.1,
          capBinding: false,
        },
      ],
    });
    const signals = classifyPerfSignals(report);
    const lows = signals.filter((s) => s.kind === 'low-utilisation');
    assert.equal(lows.length, 2);
    assert.equal(lows[0].waveIndex, 0);
    assert.equal(lows[0].utilisation, 0.2);
    assert.equal(lows[0].threshold, DEFAULT_RETRO_PERF_THRESHOLDS.utilisation);
    assert.equal(lows[1].waveIndex, 2);
  });

  it('returns high-bootstrap-share when story-init dwarfs wave time', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1000,
          utilisation: 0.75,
          capBinding: false,
        },
      ],
      storyPerfSummaries: [
        { phaseTimingsMs: { 'story-init': 500 } },
        { phaseTimingsMs: { 'story-init': 200 } },
      ],
    });
    const signals = classifyPerfSignals(report);
    const highs = signals.filter((s) => s.kind === 'high-bootstrap-share');
    assert.equal(highs.length, 1);
    assert.equal(highs[0].bootstrapMs, 700);
    assert.equal(highs[0].summedStoryMs, 1000);
    assert.equal(highs[0].share, 0.7);
  });

  it('does not emit high-bootstrap-share when bootstrap is small', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1000,
          utilisation: 0.75,
          capBinding: false,
        },
      ],
      storyPerfSummaries: [{ phaseTimingsMs: { 'story-init': 100 } }],
    });
    const signals = classifyPerfSignals(report);
    assert.equal(
      signals.filter((s) => s.kind === 'high-bootstrap-share').length,
      0,
    );
  });

  it('returns cap-binding-run when consecutive waves cap-bind', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: false,
        },
        {
          waveIndex: 1,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
        {
          waveIndex: 2,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
        {
          waveIndex: 3,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
      ],
    });
    const signals = classifyPerfSignals(report);
    const runs = signals.filter((s) => s.kind === 'cap-binding-run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].fromWaveIndex, 1);
    assert.equal(runs[0].toWaveIndex, 3);
    assert.equal(runs[0].runLength, 3);
  });

  it('does not emit cap-binding-run for single-wave bindings', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
        {
          waveIndex: 1,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: false,
        },
        {
          waveIndex: 2,
          wallClockMs: 1000,
          summedStoryMs: 2000,
          utilisation: 1,
          capBinding: true,
        },
      ],
    });
    const signals = classifyPerfSignals(report);
    const runs = signals.filter((s) => s.kind === 'cap-binding-run');
    assert.equal(runs.length, 0);
  });

  it('returns [] when report is malformed', () => {
    assert.deepEqual(classifyPerfSignals(null), []);
    assert.deepEqual(classifyPerfSignals(undefined), []);
    assert.deepEqual(classifyPerfSignals({}), []);
    assert.deepEqual(classifyPerfSignals({ waveParallelism: 'nope' }), []);
  });

  it('respects custom thresholds', () => {
    const report = makeReport({
      waveParallelism: [
        {
          waveIndex: 0,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: true,
        },
        {
          waveIndex: 1,
          wallClockMs: 1000,
          summedStoryMs: 1500,
          utilisation: 0.75,
          capBinding: true,
        },
      ],
    });
    // Raise utilisation threshold so 0.75 is "low"; require run length 2.
    const signals = classifyPerfSignals(report, {
      utilisation: 0.8,
      bootstrapShare: 0.4,
      capBindingRunLength: 2,
    });
    assert.equal(signals.filter((s) => s.kind === 'low-utilisation').length, 2);
    assert.equal(signals.filter((s) => s.kind === 'cap-binding-run').length, 1);
  });

  it('resolvePerfThresholds falls back to documented defaults', () => {
    assert.deepEqual(
      resolvePerfThresholds(undefined),
      DEFAULT_RETRO_PERF_THRESHOLDS,
    );
    assert.deepEqual(
      resolvePerfThresholds(null),
      DEFAULT_RETRO_PERF_THRESHOLDS,
    );
    assert.deepEqual(resolvePerfThresholds({}), DEFAULT_RETRO_PERF_THRESHOLDS);
    assert.deepEqual(
      resolvePerfThresholds({ utilisation: -1, capBindingRunLength: 0 }),
      DEFAULT_RETRO_PERF_THRESHOLDS,
    );
    assert.equal(resolvePerfThresholds({ utilisation: 0.5 }).utilisation, 0.5);
  });
});
