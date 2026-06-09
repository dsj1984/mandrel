/**
 * Unit tests for `lib/observability/perf-aggregator.js` (Epic #1030 /
 * Story #1123 / Task #1135). Covers empty NDJSON, single-Story rollup,
 * multi-Story aggregation, and the topHotspots ranking.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  coerceWaveParallelismRow,
  collectValidStorySamples,
  computeEpicPerfReport,
  computeStoryPerfSummary,
  computeWaveParallelismRows,
} from '../../../.agents/scripts/lib/observability/perf-aggregator.js';

describe('computeStoryPerfSummary', () => {
  it('produces a well-formed payload from an empty event stream', () => {
    const out = computeStoryPerfSummary([], {
      storyId: 1,
      epicId: 2,
      closedAt: '2026-05-07T00:00:00.000Z',
    });
    assert.equal(out.kind, 'story-perf-summary');
    assert.equal(out.storyId, 1);
    assert.equal(out.epicId, 2);
    assert.equal(out.closedAt, '2026-05-07T00:00:00.000Z');
    assert.deepEqual(out.frictionByCategory, {});
    assert.deepEqual(out.phaseTimingsMs, {});
    assert.deepEqual(out.topSlowPhasesVsBaseline, []);
    assert.deepEqual(out.reworkScore, { filesEditedBeyondThreshold: 0 });
    assert.deepEqual(out.retryDensity, { retries: 0, uniqueCommands: 0 });
  });

  it('aggregates friction events by category', () => {
    const events = [
      { kind: 'friction', details: { category: 'Tool Limitation' } },
      { kind: 'friction', details: { category: 'Tool Limitation' } },
      { kind: 'friction', details: { category: 'Execution Error' } },
      { kind: 'friction', details: {} },
      { kind: 'trace' },
    ];
    const out = computeStoryPerfSummary(events, { storyId: 10, epicId: 20 });
    assert.deepEqual(out.frictionByCategory, {
      'Tool Limitation': 2,
      'Execution Error': 1,
      Unknown: 1,
    });
  });

  it('flattens phase-timer summaries into phaseTimingsMs', () => {
    const out = computeStoryPerfSummary([], {
      storyId: 1,
      epicId: 2,
      phaseTiming: {
        phases: [
          { name: 'install', elapsedMs: 1500 },
          { name: 'test', elapsedMs: 9200 },
          { name: 'invalid', elapsedMs: -3 },
        ],
      },
    });
    assert.deepEqual(out.phaseTimingsMs, {
      install: 1500,
      test: 9200,
      invalid: 0,
    });
  });

  it('sorts topSlowPhasesVsBaseline by ratio desc and respects limit', () => {
    const events = [
      {
        kind: 'hotspot',
        phase: 'lint',
        details: { elapsedMs: 1200, baselineP95Ms: 600, ratio: 2.0 },
      },
      {
        kind: 'hotspot',
        phase: 'test',
        details: { elapsedMs: 9000, baselineP95Ms: 4500, ratio: 2.0 },
      },
      {
        kind: 'hotspot',
        phase: 'install',
        details: { elapsedMs: 4000, baselineP95Ms: 1000, ratio: 4.0 },
      },
    ];
    const out = computeStoryPerfSummary(events, { storyId: 1, epicId: 2 });
    assert.equal(out.topSlowPhasesVsBaseline[0].phase, 'install');
    assert.equal(out.topSlowPhasesVsBaseline[0].ratio, 4.0);
    assert.equal(out.topSlowPhasesVsBaseline.length, 3);
  });

  it('builds reworkScore with the heaviest path', () => {
    const events = [
      { kind: 'rework', details: { path: 'src/a.js', edits: 6 } },
      { kind: 'rework', details: { path: 'src/a.js', edits: 8 } },
      { kind: 'rework', details: { path: 'src/b.js', edits: 5 } },
    ];
    const out = computeStoryPerfSummary(events, { storyId: 1, epicId: 2 });
    assert.equal(out.reworkScore.filesEditedBeyondThreshold, 2);
    assert.equal(out.reworkScore.topPath, 'src/a.js');
    assert.equal(out.reworkScore.topPathEdits, 8);
  });

  it('counts retries and unique commands', () => {
    const events = [
      { kind: 'retry', details: { command: 'npm test' } },
      { kind: 'retry', details: { command: 'npm test' } },
      { kind: 'retry', details: { command: 'npm run lint' } },
      { kind: 'retry', details: {} },
    ];
    const out = computeStoryPerfSummary(events, { storyId: 1, epicId: 2 });
    assert.equal(out.retryDensity.retries, 4);
    assert.equal(out.retryDensity.uniqueCommands, 2);
  });

  it('rejects bad storyId/epicId inputs', () => {
    assert.throws(
      () => computeStoryPerfSummary([], { storyId: 0, epicId: 1 }),
      /storyId/,
    );
    assert.throws(
      () => computeStoryPerfSummary([], { storyId: 1, epicId: -2 }),
      /epicId/,
    );
  });
});

describe('computeEpicPerfReport', () => {
  it('returns the zero-shape on empty input', () => {
    const out = computeEpicPerfReport([], { epicId: 99 });
    assert.equal(out.kind, 'epic-perf-report');
    assert.equal(out.epicId, 99);
    assert.deepEqual(out.signalCounts, {
      friction: 0,
      hotspot: 0,
      rework: 0,
      churn: 0,
      idle: 0,
      retry: 0,
    });
    assert.deepEqual(out.waveParallelism, []);
    assert.deepEqual(out.topHotspots, []);
    assert.deepEqual(out.mostFrictionStories, []);
  });

  it('rolls up friction-only counts when only summaries are passed', () => {
    const summaries = [
      {
        kind: 'story-perf-summary',
        storyId: 1,
        epicId: 100,
        closedAt: '2026-05-07T00:00:00.000Z',
        frictionByCategory: { 'Tool Limitation': 2 },
        phaseTimingsMs: {},
        topSlowPhasesVsBaseline: [],
        reworkScore: { filesEditedBeyondThreshold: 0 },
        retryDensity: { retries: 0, uniqueCommands: 0 },
      },
      {
        kind: 'story-perf-summary',
        storyId: 2,
        epicId: 100,
        closedAt: '2026-05-07T00:00:00.000Z',
        frictionByCategory: { 'Execution Error': 5 },
        phaseTimingsMs: {},
        topSlowPhasesVsBaseline: [],
        reworkScore: { filesEditedBeyondThreshold: 0 },
        retryDensity: { retries: 0, uniqueCommands: 0 },
      },
    ];
    const out = computeEpicPerfReport(summaries, { epicId: 100 });
    assert.equal(out.signalCounts.friction, 7);
    assert.deepEqual(out.mostFrictionStories, [
      { storyId: 2, frictionCount: 5 },
      { storyId: 1, frictionCount: 2 },
    ]);
  });

  it('rolls up signalCounts off raw events when provided', () => {
    const summaries = [];
    const events = [
      { kind: 'friction' },
      { kind: 'friction' },
      { kind: 'rework' },
      { kind: 'churn' },
      { kind: 'idle' },
      { kind: 'idle' },
      { kind: 'retry' },
      { kind: 'hotspot' },
      { kind: 'trace' }, // ignored — not a derived signal kind
    ];
    const out = computeEpicPerfReport(summaries, { epicId: 1, events });
    assert.equal(out.signalCounts.friction, 2);
    assert.equal(out.signalCounts.rework, 1);
    assert.equal(out.signalCounts.churn, 1);
    assert.equal(out.signalCounts.idle, 2);
    assert.equal(out.signalCounts.retry, 1);
    assert.equal(out.signalCounts.hotspot, 1);
  });

  it('aggregates topHotspots by phase across summaries', () => {
    const summaries = [
      {
        kind: 'story-perf-summary',
        storyId: 1,
        epicId: 1,
        closedAt: '2026-05-07T00:00:00.000Z',
        frictionByCategory: {},
        phaseTimingsMs: {},
        topSlowPhasesVsBaseline: [
          { phase: 'test', elapsedMs: 9000, baselineP95Ms: 3000, ratio: 3.0 },
          { phase: 'lint', elapsedMs: 1500, baselineP95Ms: 1000, ratio: 1.5 },
        ],
        reworkScore: { filesEditedBeyondThreshold: 0 },
        retryDensity: { retries: 0, uniqueCommands: 0 },
      },
      {
        kind: 'story-perf-summary',
        storyId: 2,
        epicId: 1,
        closedAt: '2026-05-07T00:00:00.000Z',
        frictionByCategory: {},
        phaseTimingsMs: {},
        topSlowPhasesVsBaseline: [
          { phase: 'test', elapsedMs: 6000, baselineP95Ms: 3000, ratio: 2.0 },
        ],
        reworkScore: { filesEditedBeyondThreshold: 0 },
        retryDensity: { retries: 0, uniqueCommands: 0 },
      },
    ];
    const out = computeEpicPerfReport(summaries, { epicId: 1 });
    assert.equal(out.topHotspots[0].phase, 'test');
    assert.equal(out.topHotspots[0].occurrences, 2);
    assert.equal(out.topHotspots[0].avgRatio, 2.5);
    assert.equal(out.topHotspots[1].phase, 'lint');
    assert.equal(out.topHotspots[1].occurrences, 1);
  });

  it('honours an explicit topHotspots override', () => {
    const out = computeEpicPerfReport([], {
      epicId: 1,
      topHotspots: [{ phase: 'install', occurrences: 7, avgRatio: 1.9 }],
    });
    assert.deepEqual(out.topHotspots, [
      { phase: 'install', occurrences: 7, avgRatio: 1.9 },
    ]);
  });

  it('coerces waveParallelism rows to the schema-canonical utilisation shape', () => {
    const out = computeEpicPerfReport([], {
      epicId: 1,
      waveParallelism: [
        {
          waveIndex: 1,
          storyCount: 3,
          wallClockMs: 1000,
          summedStoryMs: 4000,
          utilisation: 0.25,
          capBinding: true,
          verifyConcurrencyCap: 4,
        },
        {
          waveIndex: -2,
          wallClockMs: 'bad',
          summedStoryMs: null,
          utilisation: -1,
          capBinding: 0,
          verifyConcurrencyCap: 0,
        },
      ],
    });
    assert.equal(out.waveParallelism.length, 2);
    // First row passes through (already canonical).
    assert.equal(out.waveParallelism[0].waveIndex, 1);
    assert.equal(out.waveParallelism[0].storyCount, 3);
    assert.equal(out.waveParallelism[0].capBinding, true);
    assert.equal(out.waveParallelism[0].verifyConcurrencyCap, 4);
    // Second row coerces garbage to safe defaults.
    assert.equal(out.waveParallelism[1].waveIndex, 0);
    assert.equal(out.waveParallelism[1].storyCount, 0);
    assert.equal(out.waveParallelism[1].wallClockMs, 0);
    assert.equal(out.waveParallelism[1].summedStoryMs, 0);
    assert.equal(out.waveParallelism[1].utilisation, 0);
    assert.equal(out.waveParallelism[1].capBinding, false);
    // verifyConcurrencyCap falls back to the project default when omitted/invalid.
    assert.equal(out.waveParallelism[1].verifyConcurrencyCap, 4);
  });

  it('rejects bad epicId', () => {
    assert.throws(() => computeEpicPerfReport([], { epicId: 0 }), /epicId/);
  });
});

describe('computeWaveParallelismRows (Story #3850 fixes)', () => {
  // Helper to build a minimal lifecycle event stream.
  function makeEvents({ waves = [], transitions = [] } = {}) {
    const events = [];
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    for (const w of waves) {
      events.push({
        kind: 'wave-start',
        index: w.index,
        stories: w.stories.map((id) => ({ id })),
        ts: new Date(base + w.startOffset).toISOString(),
      });
      if (w.endOffset != null) {
        events.push({
          kind: 'wave-complete',
          index: w.index,
          ts: new Date(base + w.endOffset).toISOString(),
        });
      }
    }
    for (const t of transitions) {
      events.push({
        kind: 'state-transition',
        story: t.storyId,
        details: { to: t.to },
        ts: new Date(base + t.offset).toISOString(),
      });
    }
    return events;
  }

  it('emits storyCount matching the wave-start stories array', () => {
    const events = makeEvents({
      waves: [
        { index: 0, stories: [1, 2, 3], startOffset: 0, endOffset: 5000 },
      ],
      transitions: [
        { storyId: 1, to: 'agent::executing', offset: 100 },
        { storyId: 1, to: 'agent::done', offset: 2000 },
        { storyId: 2, to: 'agent::executing', offset: 100 },
        { storyId: 2, to: 'agent::done', offset: 2000 },
        { storyId: 3, to: 'agent::executing', offset: 100 },
        { storyId: 3, to: 'agent::done', offset: 2000 },
      ],
    });
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 4 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].storyCount, 3);
  });

  it('Fix C: 1-Story wave with cap=3 scores utilisation 1.0, not 0.33', () => {
    // Wall=5000ms, story active for 5000ms, storyCount=1, cap=3.
    // Old formula: 5000 / (5000 * 3) = 0.33.
    // New formula: 5000 / (5000 * min(1, 3)) = 1.0.
    const events = makeEvents({
      waves: [{ index: 0, stories: [1], startOffset: 0, endOffset: 5000 }],
      transitions: [
        { storyId: 1, to: 'agent::executing', offset: 0 },
        { storyId: 1, to: 'agent::done', offset: 5000 },
      ],
    });
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 3 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].storyCount, 1);
    // Utilisation should be clamped to 1.0 for a fully-busy single-story wave.
    assert.ok(
      rows[0].utilisation >= 0.99,
      `expected utilisation ≈ 1.0 but got ${rows[0].utilisation}`,
    );
  });

  it('Fix C: 2-Story wave at cap=3 uses min(2,3)=2 as denominator', () => {
    // Both stories run from 0 to 5000ms (wallClock=5000). summedStoryMs=10000.
    // Old formula: 10000 / (5000 * 3) = 0.67.
    // New formula: 10000 / (5000 * min(2,3)) = 10000 / 10000 = 1.0.
    const events = makeEvents({
      waves: [{ index: 0, stories: [1, 2], startOffset: 0, endOffset: 5000 }],
      transitions: [
        { storyId: 1, to: 'agent::executing', offset: 0 },
        { storyId: 1, to: 'agent::done', offset: 5000 },
        { storyId: 2, to: 'agent::executing', offset: 0 },
        { storyId: 2, to: 'agent::done', offset: 5000 },
      ],
    });
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 3 });
    assert.equal(rows[0].storyCount, 2);
    assert.ok(
      rows[0].utilisation >= 0.99,
      `expected utilisation ≈ 1.0 but got ${rows[0].utilisation}`,
    );
  });

  it('Fix C: wide wave (storyCount >= cap) uses concurrencyCap denominator', () => {
    // 4 stories, cap=2. effectiveCap = min(4, 2) = 2.
    // summedStoryMs=4000 (each story 1000ms), wallClock=1000.
    // utilisation = 4000 / (1000 * 2) = 2.0, clamped to 1.0.
    const events = makeEvents({
      waves: [
        { index: 0, stories: [1, 2, 3, 4], startOffset: 0, endOffset: 1000 },
      ],
      transitions: [
        { storyId: 1, to: 'agent::executing', offset: 0 },
        { storyId: 1, to: 'agent::done', offset: 1000 },
        { storyId: 2, to: 'agent::executing', offset: 0 },
        { storyId: 2, to: 'agent::done', offset: 1000 },
        { storyId: 3, to: 'agent::executing', offset: 0 },
        { storyId: 3, to: 'agent::done', offset: 1000 },
        { storyId: 4, to: 'agent::executing', offset: 0 },
        { storyId: 4, to: 'agent::done', offset: 1000 },
      ],
    });
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 2 });
    assert.equal(rows[0].storyCount, 4);
    // capBinding: summedStoryMs/wallClock = 4000/1000 = 4 >= cap(2) → true.
    assert.equal(rows[0].capBinding, true);
    // utilisation clamped to 1.0 (4000 / (1000 * 2) = 2.0).
    assert.equal(rows[0].utilisation, 1);
  });

  it('returns empty array on empty event stream', () => {
    const rows = computeWaveParallelismRows([], { concurrencyCap: 2 });
    assert.deepEqual(rows, []);
  });
});

describe('coerceWaveParallelismRow (Story #3850: storyCount field)', () => {
  it('passes storyCount through when present', () => {
    const row = coerceWaveParallelismRow({
      waveIndex: 0,
      storyCount: 2,
      wallClockMs: 1000,
      summedStoryMs: 2000,
      utilisation: 0.5,
      capBinding: false,
      verifyConcurrencyCap: 4,
    });
    assert.equal(row.storyCount, 2);
  });

  it('defaults storyCount to 0 when absent (older payloads)', () => {
    const row = coerceWaveParallelismRow({
      waveIndex: 0,
      wallClockMs: 1000,
      summedStoryMs: 2000,
      utilisation: 0.5,
      capBinding: false,
      verifyConcurrencyCap: 4,
    });
    assert.equal(row.storyCount, 0);
  });

  it('coerces negative storyCount to 0', () => {
    const row = coerceWaveParallelismRow({
      waveIndex: 0,
      storyCount: -5,
      wallClockMs: 0,
      summedStoryMs: 0,
      utilisation: 0,
      capBinding: false,
      verifyConcurrencyCap: 4,
    });
    assert.equal(row.storyCount, 0);
  });
});

describe('collectValidStorySamples (predicate)', () => {
  const cases = [
    { name: 'null input → []', input: null, expected: [] },
    { name: 'undefined input → []', input: undefined, expected: [] },
    { name: 'empty iterable → []', input: [], expected: [] },
    {
      name: 'drops non-object entries (null/string/number)',
      input: [null, 'nope', 42],
      expected: [],
    },
    {
      name: 'drops entries with wrong kind',
      input: [{ kind: 'other' }, { kind: 'story-perf-summary', storyId: 1 }],
      expected: [{ kind: 'story-perf-summary', storyId: 1 }],
    },
    {
      name: 'drops entries with no kind field',
      input: [{ storyId: 1 }, { kind: 'story-perf-summary', storyId: 2 }],
      expected: [{ kind: 'story-perf-summary', storyId: 2 }],
    },
    {
      name: 'preserves multiple valid samples in iteration order',
      input: [
        { kind: 'story-perf-summary', storyId: 1 },
        { kind: 'story-perf-summary', storyId: 2 },
      ],
      expected: [
        { kind: 'story-perf-summary', storyId: 1 },
        { kind: 'story-perf-summary', storyId: 2 },
      ],
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      assert.deepEqual(collectValidStorySamples(tc.input), tc.expected);
    });
  }
});
