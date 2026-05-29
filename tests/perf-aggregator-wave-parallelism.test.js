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

// ---------------------------------------------------------------------------
// Story #3343 — single-pass refactor regression guard.
//
// The reference implementation below is a verbatim copy of the pre-#3343
// `computeWaveParallelismRows` body (the version with the O(waves × events)
// nested fallback scan). The refactor must produce **byte-identical** rows
// for any input, so we drive both implementations with the same multi-wave,
// several-thousand-event stream and assert `JSON.stringify` equality.
// ---------------------------------------------------------------------------

const DEFAULT_VERIFY_CONCURRENCY_CAP = 4;
const DEFAULT_WAVE_CONCURRENCY_CAP = 2;

function refIsObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function refTsOf(evt) {
  return evt?.ts ?? evt?.timestamp ?? null;
}
function refTsToMs(ts) {
  if (typeof ts !== 'string') return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}
function refStoryIdOf(evt) {
  const raw = evt?.story ?? evt?.storyId;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function refClamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Verbatim pre-#3343 implementation (nested fallback scan). */
function refComputeWaveParallelismRows(events, opts = {}) {
  const concurrencyCap =
    Number.isInteger(opts.concurrencyCap) && opts.concurrencyCap >= 1
      ? opts.concurrencyCap
      : DEFAULT_WAVE_CONCURRENCY_CAP;
  const verifyConcurrencyCap =
    Number.isInteger(opts.verifyConcurrencyCap) &&
    opts.verifyConcurrencyCap >= 1
      ? opts.verifyConcurrencyCap
      : DEFAULT_VERIFY_CONCURRENCY_CAP;

  const evtArr = [];
  for (const e of events ?? []) {
    if (refIsObject(e) && typeof e.kind === 'string') evtArr.push(e);
  }

  const storyWindows = new Map();
  for (const evt of evtArr) {
    if (evt.kind !== 'state-transition') continue;
    const sid = refStoryIdOf(evt);
    if (sid == null) continue;
    const ms = refTsToMs(refTsOf(evt));
    if (ms == null) continue;
    const to =
      (refIsObject(evt.details) && evt.details.to) ?? evt.to ?? evt.toState;
    const rec = storyWindows.get(sid) ?? { startMs: null, endMs: null };
    if (to === 'agent::executing') {
      if (rec.startMs == null || ms < rec.startMs) rec.startMs = ms;
    } else if (
      to === 'agent::done' ||
      to === 'agent::blocked' ||
      to === 'agent::failed'
    ) {
      if (rec.endMs == null || ms > rec.endMs) rec.endMs = ms;
    }
    storyWindows.set(sid, rec);
  }

  const waves = new Map();
  for (const evt of evtArr) {
    const ts = refTsToMs(refTsOf(evt));
    if (ts == null) continue;
    if (evt.kind === 'wave-start') {
      const idx = Number(evt.index);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const storiesField = Array.isArray(evt.stories) ? evt.stories : [];
      const storyIds = storiesField
        .map((s) => {
          const n = Number(refIsObject(s) ? (s.id ?? s.storyId) : s);
          return Number.isInteger(n) && n > 0 ? n : null;
        })
        .filter((n) => n != null);
      const rec = waves.get(idx) ?? { startMs: null, endMs: null, stories: [] };
      if (rec.startMs == null || ts < rec.startMs) rec.startMs = ts;
      rec.stories = storyIds;
      waves.set(idx, rec);
    } else if (evt.kind === 'wave-complete') {
      const idx = Number(evt.index);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const rec = waves.get(idx) ?? { startMs: null, endMs: null, stories: [] };
      if (rec.endMs == null || ts > rec.endMs) rec.endMs = ts;
      waves.set(idx, rec);
    }
  }

  const orderedWaves = [...waves.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < orderedWaves.length; i += 1) {
    const [idx, rec] = orderedWaves[i];
    if (rec.endMs != null) continue;
    const startMs = rec.startMs;
    if (startMs == null) continue;
    const nextStartMs =
      i + 1 < orderedWaves.length ? orderedWaves[i + 1][1].startMs : Infinity;
    let maxMs = startMs;
    for (const evt of evtArr) {
      const ts = refTsToMs(refTsOf(evt));
      if (ts == null) continue;
      if (ts >= startMs && ts < nextStartMs && ts > maxMs) maxMs = ts;
    }
    rec.endMs = maxMs;
    waves.set(idx, rec);
  }

  const rows = [];
  for (const [idx, rec] of orderedWaves) {
    if (rec.startMs == null) continue;
    const wallClockMs = Math.max(
      0,
      Math.floor((rec.endMs ?? rec.startMs) - rec.startMs),
    );
    let summedStoryMs = 0;
    for (const sid of rec.stories) {
      const w = storyWindows.get(sid);
      if (!w || w.startMs == null || w.endMs == null) continue;
      const dur = w.endMs - w.startMs;
      if (Number.isFinite(dur) && dur > 0) summedStoryMs += Math.floor(dur);
    }
    let utilisation = 0;
    let capBinding = false;
    if (wallClockMs > 0 && concurrencyCap > 0) {
      utilisation = refClamp(
        summedStoryMs / (wallClockMs * concurrencyCap),
        0,
        1,
      );
      capBinding = summedStoryMs / wallClockMs >= concurrencyCap;
    }
    rows.push({
      waveIndex: idx,
      wallClockMs,
      summedStoryMs,
      utilisation,
      capBinding,
      verifyConcurrencyCap,
    });
  }
  return rows;
}

/**
 * Synthesize a multi-wave event stream with several thousand events where
 * a subset of waves never emit `wave-complete` (exercising the fallback
 * sweep). Some interleaved noise events (heartbeats) land between waves to
 * stress the windowed max-timestamp logic.
 */
function buildLargeStream({ waveCount, storiesPerWave, completeEvery }) {
  const events = [];
  const base = Date.UTC(2026, 4, 26, 0, 0, 0);
  let storyId = 1;
  let clock = base;
  const step = 1000; // 1s between events

  for (let w = 0; w < waveCount; w += 1) {
    const waveStartMs = clock;
    const storyIds = [];
    for (let s = 0; s < storiesPerWave; s += 1) {
      storyIds.push(storyId);
      storyId += 1;
    }
    events.push({
      kind: 'wave-start',
      ts: new Date(waveStartMs).toISOString(),
      index: w,
      totalWaves: waveCount,
      stories: storyIds.map((id) => ({ id })),
    });
    clock += step;

    for (const id of storyIds) {
      events.push({
        kind: 'state-transition',
        ts: new Date(clock).toISOString(),
        story: id,
        details: { to: 'agent::executing' },
      });
      clock += step;
      // a noise heartbeat in the middle of the wave
      events.push({
        kind: 'story.heartbeat',
        ts: new Date(clock).toISOString(),
        story: id,
      });
      clock += step;
      events.push({
        kind: 'state-transition',
        ts: new Date(clock).toISOString(),
        story: id,
        details: { to: 'agent::done' },
      });
      clock += step;
    }

    // Only every Nth wave gets a wave-complete; the rest fall back.
    if (Number.isFinite(completeEvery) && w % completeEvery === 0) {
      events.push({
        kind: 'wave-complete',
        ts: new Date(clock).toISOString(),
        index: w,
        totalWaves: waveCount,
      });
    }
    clock += step;
  }
  return events;
}

describe('computeWaveParallelismRows — Story #3343 byte-identical refactor', () => {
  it('matches the pre-refactor rows over a large multi-incomplete-wave stream', () => {
    const events = buildLargeStream({
      waveCount: 80,
      storiesPerWave: 14,
      completeEvery: 3, // ~2/3 of waves hit the fallback path
    });
    // Sanity: several thousand events.
    assert.ok(
      events.length >= 3000,
      `expected ≥3000 events, got ${events.length}`,
    );

    const opts = { concurrencyCap: 3, verifyConcurrencyCap: 5 };
    const expected = refComputeWaveParallelismRows(events, opts);
    const actual = computeWaveParallelismRows(events, opts);

    assert.equal(
      JSON.stringify(actual),
      JSON.stringify(expected),
      'refactored rows must be byte-identical to the prior implementation',
    );
    // Guard: ensure we actually exercised the incomplete-wave fallback.
    assert.ok(expected.length > 1);
  });

  it('matches the pre-refactor rows when no wave ever completes (all-fallback)', () => {
    const events = buildLargeStream({
      waveCount: 40,
      storiesPerWave: 10,
      completeEvery: Number.POSITIVE_INFINITY, // no wave-complete ever
    });
    const opts = { concurrencyCap: 2 };
    assert.equal(
      JSON.stringify(computeWaveParallelismRows(events, opts)),
      JSON.stringify(refComputeWaveParallelismRows(events, opts)),
    );
  });
});
