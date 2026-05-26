/**
 * Unit tests for `computeWaveParallelismRows` and the
 * `computeEpicPerfReport(events)` derivation path (Epic #3019 /
 * Story #3025 / Task #3028).
 *
 * Covers:
 *   - Single-wave happy path: utilisation = summedStoryMs /
 *     (wallClockMs * concurrencyCap), clamped to [0, 1].
 *   - Multi-wave run: each wave is bracketed by its own
 *     `wave-start` / `wave-complete` pair.
 *   - Zero-Story wave: produces a row whose summedStoryMs / utilisation
 *     are both 0 without throwing.
 *   - Clamping edge: when summedStoryMs / wallClockMs ≥ concurrencyCap,
 *     utilisation clamps at 1 and capBinding flips true.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeEpicPerfReport,
  computeWaveParallelismRows,
} from '../.agents/scripts/lib/observability/perf-aggregator.js';

function tx({ ts, story, to }) {
  return {
    kind: 'state-transition',
    ts,
    story,
    details: { to },
  };
}

function waveStart({ ts, index, stories, totalWaves = 1 }) {
  return {
    kind: 'wave-start',
    ts,
    index,
    totalWaves,
    stories: stories.map((id) => ({ id })),
  };
}

function waveComplete({ ts, index, totalWaves = 1 }) {
  return { kind: 'wave-complete', ts, index, totalWaves };
}

describe('computeWaveParallelismRows — Story #3025 / Task #3028', () => {
  it('single wave: utilisation = summedStoryMs / (wallClockMs * cap), capBinding false when below cap', () => {
    // Wave 0 wall-clock = 10s; Stories 1+2 each ran 6s in serial-ish overlap.
    const events = [
      waveStart({ ts: '2026-05-26T00:00:00.000Z', index: 0, stories: [1, 2] }),
      tx({ ts: '2026-05-26T00:00:01.000Z', story: 1, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:07.000Z', story: 1, to: 'agent::done' }),
      tx({ ts: '2026-05-26T00:00:02.000Z', story: 2, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:08.000Z', story: 2, to: 'agent::done' }),
      waveComplete({ ts: '2026-05-26T00:00:10.000Z', index: 0 }),
    ];
    const rows = computeWaveParallelismRows(events, {
      concurrencyCap: 2,
      verifyConcurrencyCap: 4,
    });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.waveIndex, 0);
    assert.equal(r.wallClockMs, 10000);
    // Story 1: 6000ms, Story 2: 6000ms → summed = 12000ms
    assert.equal(r.summedStoryMs, 12000);
    // utilisation = 12000 / (10000 * 2) = 0.6
    assert.equal(Math.round(r.utilisation * 1000) / 1000, 0.6);
    assert.equal(r.capBinding, false);
    assert.equal(r.verifyConcurrencyCap, 4);
  });

  it('multi-wave: emits one row per wave with independent windows', () => {
    const events = [
      waveStart({
        ts: '2026-05-26T00:00:00.000Z',
        index: 0,
        stories: [1],
        totalWaves: 2,
      }),
      tx({ ts: '2026-05-26T00:00:01.000Z', story: 1, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:03.000Z', story: 1, to: 'agent::done' }),
      waveComplete({
        ts: '2026-05-26T00:00:05.000Z',
        index: 0,
        totalWaves: 2,
      }),
      waveStart({
        ts: '2026-05-26T00:00:10.000Z',
        index: 1,
        stories: [2],
        totalWaves: 2,
      }),
      tx({ ts: '2026-05-26T00:00:11.000Z', story: 2, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:15.000Z', story: 2, to: 'agent::done' }),
      waveComplete({
        ts: '2026-05-26T00:00:20.000Z',
        index: 1,
        totalWaves: 2,
      }),
    ];
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 2 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].waveIndex, 0);
    assert.equal(rows[0].wallClockMs, 5000);
    assert.equal(rows[0].summedStoryMs, 2000);
    assert.equal(rows[1].waveIndex, 1);
    assert.equal(rows[1].wallClockMs, 10000);
    assert.equal(rows[1].summedStoryMs, 4000);
  });

  it('zero-Story wave: row emitted with summedStoryMs and utilisation = 0', () => {
    const events = [
      waveStart({ ts: '2026-05-26T00:00:00.000Z', index: 0, stories: [] }),
      waveComplete({ ts: '2026-05-26T00:00:05.000Z', index: 0 }),
    ];
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 2 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summedStoryMs, 0);
    assert.equal(rows[0].utilisation, 0);
    assert.equal(rows[0].capBinding, false);
    assert.equal(rows[0].wallClockMs, 5000);
  });

  it('clamping edge: utilisation clamps to 1 and capBinding flips true at saturation', () => {
    // Two Stories each ran 10s in a 10s wave with cap=2: summed=20000,
    // wallClock=10000, summed/wall = 2 ≥ cap → capBinding true,
    // utilisation = 20000 / (10000 * 2) = 1.0.
    const events = [
      waveStart({ ts: '2026-05-26T00:00:00.000Z', index: 0, stories: [1, 2] }),
      tx({ ts: '2026-05-26T00:00:00.000Z', story: 1, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:10.000Z', story: 1, to: 'agent::done' }),
      tx({ ts: '2026-05-26T00:00:00.000Z', story: 2, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:10.000Z', story: 2, to: 'agent::done' }),
      waveComplete({ ts: '2026-05-26T00:00:10.000Z', index: 0 }),
    ];
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 2 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wallClockMs, 10000);
    assert.equal(rows[0].summedStoryMs, 20000);
    assert.equal(rows[0].utilisation, 1);
    assert.equal(rows[0].capBinding, true);
  });

  it('computeEpicPerfReport derives waveParallelism when handed raw events', () => {
    const events = [
      waveStart({ ts: '2026-05-26T00:00:00.000Z', index: 0, stories: [1] }),
      tx({ ts: '2026-05-26T00:00:01.000Z', story: 1, to: 'agent::executing' }),
      tx({ ts: '2026-05-26T00:00:03.000Z', story: 1, to: 'agent::done' }),
      waveComplete({ ts: '2026-05-26T00:00:05.000Z', index: 0 }),
    ];
    const report = computeEpicPerfReport([], {
      epicId: 3019,
      events,
      concurrencyCap: 2,
      verifyConcurrencyCap: 4,
    });
    assert.equal(report.waveParallelism.length, 1);
    assert.equal(report.waveParallelism[0].waveIndex, 0);
    assert.equal(report.waveParallelism[0].summedStoryMs, 2000);
  });
});
