/**
 * Unit tests for `lib/observability/perf-aggregator.js` (Epic #1030 /
 * Story #1123 / Task #1135). Covers empty NDJSON, single-Story rollup,
 * multi-Story aggregation, and the topHotspots ranking.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeEpicPerfReport,
  computeStoryPerfSummary,
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

  it('coerces waveParallelism rows to non-negative integers', () => {
    const out = computeEpicPerfReport([], {
      epicId: 1,
      waveParallelism: [
        {
          wave: 1,
          wallClockMs: 1000,
          sumStoryMs: 4000,
          utilization: 0.25,
          stories: 4,
        },
        {
          wave: -2,
          wallClockMs: 'bad',
          sumStoryMs: null,
          utilization: -1,
          stories: 1.7,
        },
      ],
    });
    assert.equal(out.waveParallelism.length, 2);
    assert.equal(out.waveParallelism[1].wave, 0);
    assert.equal(out.waveParallelism[1].wallClockMs, 0);
    assert.equal(out.waveParallelism[1].sumStoryMs, 0);
    assert.equal(out.waveParallelism[1].utilization, 0);
    assert.equal(out.waveParallelism[1].stories, 1);
  });

  it('rejects bad epicId', () => {
    assert.throws(() => computeEpicPerfReport([], { epicId: 0 }), /epicId/);
  });

  describe('dispatchModel propagation (Epic #1185)', () => {
    const baseSummary = (overrides) => ({
      kind: 'story-perf-summary',
      epicId: 1185,
      closedAt: '2026-05-11T00:00:00.000Z',
      frictionByCategory: { 'Tool Limitation': 1 },
      phaseTimingsMs: {},
      topSlowPhasesVsBaseline: [],
      reworkScore: { filesEditedBeyondThreshold: 0 },
      retryDensity: { retries: 0, uniqueCommands: 0 },
      ...overrides,
    });

    it('produces records byte-identical to the pre-Epic shape when dispatchModel is absent', () => {
      const out = computeEpicPerfReport([baseSummary({ storyId: 1042 })], {
        epicId: 1185,
      });
      assert.equal(out.mostFrictionStories.length, 1);
      assert.deepEqual(out.mostFrictionStories[0], {
        storyId: 1042,
        frictionCount: 1,
      });
      // No `dispatchModel` key on the record — must be omitted, not null.
      assert.equal(
        Object.hasOwn(out.mostFrictionStories[0], 'dispatchModel'),
        false,
      );
    });

    for (const value of ['haiku', 'sonnet', 'opus']) {
      it(`carries dispatchModel: '${value}' through unchanged onto the record`, () => {
        const out = computeEpicPerfReport(
          [baseSummary({ storyId: 1042, dispatchModel: value })],
          { epicId: 1185 },
        );
        assert.equal(out.mostFrictionStories.length, 1);
        assert.deepEqual(out.mostFrictionStories[0], {
          storyId: 1042,
          frictionCount: 1,
          dispatchModel: value,
        });
      });
    }

    it('ignores an invalid dispatchModel string (omits the field)', () => {
      const out = computeEpicPerfReport(
        [baseSummary({ storyId: 1042, dispatchModel: 'gpt-4' })],
        { epicId: 1185 },
      );
      assert.equal(
        Object.hasOwn(out.mostFrictionStories[0], 'dispatchModel'),
        false,
      );
    });

    it('ignores null/non-string dispatchModel (omits the field)', () => {
      const summaries = [
        baseSummary({ storyId: 1042, dispatchModel: null }),
        baseSummary({ storyId: 1043, dispatchModel: 7 }),
      ];
      const out = computeEpicPerfReport(summaries, { epicId: 1185 });
      for (const row of out.mostFrictionStories) {
        assert.equal(Object.hasOwn(row, 'dispatchModel'), false);
      }
    });
  });
});
