/**
 * tests/lib/orchestration/wave-record-projection.test.js — pure unit tests for
 * the projection helpers extracted from `epic-execute-record-wave.js`.
 *
 * No subprocess, no network, no filesystem: every test injects its own
 * inputs and asserts on the returned shape. Covers the projection
 * aggregator (`projectWaveRecord`) plus the individual pure helpers that
 * back it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateWaveStatus,
  classifyParsedReturn,
  classifyWaveOutcome,
  countDoneStories,
  normalizeReturnsPure,
  projectWaveRecord,
  resolveConcurrencyCap,
  STORY_STATUS_TO_ROW_STATE,
  selectInputFlag,
  toRollupRow,
  VALID_RESULT_STATUSES,
  VALID_STORY_STATUSES,
  validateEpicWave,
  validateResults,
  validateResultsReturnsXor,
  validateReturnsEntry,
} from '../../../.agents/scripts/lib/orchestration/wave-record-projection.js';

describe('wave-record-projection constants', () => {
  it('exposes the canonical result-status set', () => {
    assert.deepEqual([...VALID_RESULT_STATUSES].sort(), [
      'blocked',
      'complete',
      'failed',
    ]);
  });

  it('exposes the canonical story-status set', () => {
    assert.deepEqual([...VALID_STORY_STATUSES].sort(), [
      'blocked',
      'done',
      'failed',
    ]);
  });

  it('maps every story status to a row state', () => {
    for (const status of VALID_STORY_STATUSES) {
      assert.ok(
        STORY_STATUS_TO_ROW_STATE[status],
        `status ${status} should map to a row state`,
      );
    }
  });
});

describe('validateResults', () => {
  it('normalizes a happy-path row', () => {
    const out = validateResults([
      {
        storyId: 1,
        status: 'done',
        phase: 'done',
        tasksDone: 2,
        tasksTotal: 2,
      },
    ]);
    assert.deepEqual(out, [
      {
        storyId: 1,
        status: 'done',
        phase: 'done',
        tasksDone: 2,
        tasksTotal: 2,
      },
    ]);
  });

  it('coerces blockerCommentId to string', () => {
    const out = validateResults([
      { storyId: 7, status: 'blocked', blockerCommentId: 42 },
    ]);
    assert.equal(out[0].blockerCommentId, '42');
  });

  it('throws on non-array input', () => {
    assert.throws(() => validateResults(null), /must be a JSON array/);
  });

  it('throws on bad storyId', () => {
    assert.throws(
      () => validateResults([{ storyId: -1, status: 'done' }]),
      /must be a positive integer/,
    );
  });

  it('throws on unknown status', () => {
    assert.throws(
      () => validateResults([{ storyId: 1, status: 'cooked' }]),
      /must be one of/,
    );
  });
});

describe('validateReturnsEntry', () => {
  it('returns a normalized pair on a string returnText', () => {
    assert.deepEqual(validateReturnsEntry({ storyId: 5, returnText: 'x' }, 0), {
      storyId: 5,
      returnText: 'x',
    });
  });

  it('JSON-stringifies an object returnText', () => {
    assert.deepEqual(
      validateReturnsEntry(
        { storyId: 5, returnText: { storyId: 5, status: 'done' } },
        0,
      ),
      { storyId: 5, returnText: '{"storyId":5,"status":"done"}' },
    );
  });

  it('treats null returnText as empty string', () => {
    assert.deepEqual(validateReturnsEntry({ storyId: 5 }, 0), {
      storyId: 5,
      returnText: '',
    });
  });

  it('throws on non-object entries', () => {
    assert.throws(() => validateReturnsEntry('nope', 3), /returns\[3\]/);
  });
});

describe('classifyParsedReturn', () => {
  it('passes through a matching parse', () => {
    const parsed = { ok: true, value: { storyId: 9, status: 'done' } };
    assert.deepEqual(classifyParsedReturn(parsed, 9), {
      ok: true,
      value: { storyId: 9, status: 'done' },
    });
  });

  it('flags a storyId mismatch', () => {
    const parsed = { ok: true, value: { storyId: 8, status: 'done' } };
    const out = classifyParsedReturn(parsed, 9);
    assert.equal(out.ok, false);
    assert.match(out.error, /disagrees with expected 9/);
  });

  it('passes through a parse error', () => {
    const parsed = { ok: false, error: 'parse boom' };
    assert.deepEqual(classifyParsedReturn(parsed, 9), {
      ok: false,
      error: 'parse boom',
    });
  });
});

describe('aggregateWaveStatus', () => {
  it('all-done → complete', () => {
    assert.deepEqual(
      aggregateWaveStatus([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'done' },
      ]),
      { status: 'complete', blockedStoryIds: [] },
    );
  });

  it('any failed → failed', () => {
    assert.deepEqual(
      aggregateWaveStatus([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'failed' },
        { storyId: 3, status: 'blocked' },
      ]),
      { status: 'failed', blockedStoryIds: [3] },
    );
  });

  it('blocked + no failures → blocked', () => {
    assert.deepEqual(
      aggregateWaveStatus([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked' },
      ]),
      { status: 'blocked', blockedStoryIds: [2] },
    );
  });

  it('empty wave → complete (no blockers)', () => {
    assert.deepEqual(aggregateWaveStatus([]), {
      status: 'complete',
      blockedStoryIds: [],
    });
  });

  it('tolerates non-array input', () => {
    assert.deepEqual(aggregateWaveStatus(null), {
      status: 'complete',
      blockedStoryIds: [],
    });
  });
});

describe('classifyWaveOutcome', () => {
  it('complete + remaining → dispatch-next', () => {
    assert.deepEqual(
      classifyWaveOutcome({
        resultStatus: 'complete',
        currentWave: 0,
        totalWaves: 3,
      }),
      { nextAction: 'dispatch-next', remainingWaves: 2 },
    );
  });

  it('complete + last → finalize', () => {
    assert.deepEqual(
      classifyWaveOutcome({
        resultStatus: 'complete',
        currentWave: 2,
        totalWaves: 3,
      }),
      { nextAction: 'finalize', remainingWaves: 0 },
    );
  });

  it('blocked → halt-blocked', () => {
    assert.equal(
      classifyWaveOutcome({
        resultStatus: 'blocked',
        currentWave: 1,
        totalWaves: 3,
      }).nextAction,
      'halt-blocked',
    );
  });

  it('failed → halt-failed', () => {
    assert.equal(
      classifyWaveOutcome({
        resultStatus: 'failed',
        currentWave: 0,
        totalWaves: 3,
      }).nextAction,
      'halt-failed',
    );
  });

  it('throws on unknown status', () => {
    assert.throws(() =>
      classifyWaveOutcome({
        resultStatus: 'bogus',
        currentWave: 0,
        totalWaves: 1,
      }),
    );
  });
});

describe('toRollupRow', () => {
  it('builds a done row with task counts', () => {
    const out = toRollupRow(
      { storyId: 1, status: 'done', tasksDone: 3, tasksTotal: 3 },
      new Map([[1, 'Story title']]),
    );
    assert.deepEqual(out, {
      id: 1,
      title: 'Story title',
      state: 'done',
      tasksDone: 3,
      tasksTotal: 3,
    });
  });

  it('attaches blockerCommentId only for blocked rows', () => {
    const blocked = toRollupRow(
      { storyId: 9, status: 'blocked', blockerCommentId: 88 },
      new Map(),
    );
    assert.equal(blocked.blockerCommentId, '88');
    const done = toRollupRow(
      { storyId: 10, status: 'done', blockerCommentId: 99 },
      new Map(),
    );
    assert.equal(done.blockerCommentId, undefined);
  });

  it('falls back to empty title for unknown stories', () => {
    const out = toRollupRow({ storyId: 99, status: 'done' }, new Map());
    assert.equal(out.title, '');
  });
});

describe('countDoneStories', () => {
  it('sums done rows across waves', () => {
    assert.equal(
      countDoneStories([
        { stories: [{ state: 'done' }, { state: 'failed' }] },
        { stories: [{ state: 'done' }] },
      ]),
      2,
    );
  });

  it('tolerates malformed waves', () => {
    assert.equal(
      countDoneStories([
        { stories: null },
        {},
        { stories: [{ state: 'done' }] },
      ]),
      1,
    );
  });
});

describe('validateEpicWave', () => {
  it('accepts positive integers', () => {
    assert.doesNotThrow(() => validateEpicWave(1, 0));
  });

  it('rejects non-positive epicId', () => {
    assert.throws(() => validateEpicWave(0, 0), /--epic/);
  });

  it('rejects negative wave', () => {
    assert.throws(() => validateEpicWave(1, -1), /--wave/);
  });
});

describe('validateResultsReturnsXor', () => {
  it('accepts results only', () => {
    assert.doesNotThrow(() => validateResultsReturnsXor([], null));
  });

  it('accepts returns only', () => {
    assert.doesNotThrow(() => validateResultsReturnsXor(null, []));
  });

  it('throws on neither', () => {
    assert.throws(() => validateResultsReturnsXor(null, null), /required/);
  });

  it('throws on both', () => {
    assert.throws(() => validateResultsReturnsXor([], []), /not both/);
  });
});

describe('resolveConcurrencyCap', () => {
  it('prefers the override', () => {
    assert.equal(resolveConcurrencyCap(5, { concurrencyCap: 2 }, {}), 5);
  });

  it('falls back to existing when override is null', () => {
    assert.equal(resolveConcurrencyCap(null, { concurrencyCap: 3 }, {}), 3);
  });

  it('throws on a non-integer resolved cap', () => {
    assert.throws(() => resolveConcurrencyCap(0, {}, {}));
  });
});

describe('selectInputFlag', () => {
  it('returns results when only results provided', () => {
    assert.equal(selectInputFlag(true, false), 'results');
  });

  it('returns returns when only returns provided', () => {
    assert.equal(selectInputFlag(false, true), 'returns');
  });

  it('throws on both', () => {
    assert.throws(() => selectInputFlag(true, true), /not both/);
  });

  it('throws on neither', () => {
    assert.throws(() => selectInputFlag(false, false), /required/);
  });
});

describe('normalizeReturnsPure', () => {
  it('parses well-formed return text', async () => {
    const envelopeText = JSON.stringify({
      storyId: 1,
      status: 'done',
      tasksDone: 2,
      tasksTotal: 2,
      branchDeleted: true,
    });
    const out = await normalizeReturnsPure({
      returns: [{ storyId: 1, returnText: envelopeText }],
    });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].storyId, 1);
    assert.equal(out.results[0].status, 'done');
    assert.deepEqual(out.parseFailures, []);
  });

  it('records a parse failure with no reconcile hook and uses placeholder row', async () => {
    const out = await normalizeReturnsPure({
      returns: [{ storyId: 5, returnText: 'not-json' }],
    });
    assert.equal(out.results.length, 1);
    assert.deepEqual(out.results[0], { storyId: 5, status: 'failed' });
    assert.equal(out.parseFailures.length, 1);
    assert.equal(out.parseFailures[0].storyId, 5);
  });

  it('uses reconcile hook on parse failure when provided', async () => {
    const seen = [];
    const reconcile = async ({ storyId }) => {
      seen.push(storyId);
      return { storyId, status: 'blocked', blockerCommentId: 'c-1' };
    };
    const out = await normalizeReturnsPure({
      returns: [{ storyId: 8, returnText: 'malformed' }],
      reconcile,
    });
    assert.deepEqual(seen, [8]);
    assert.equal(out.results[0].status, 'blocked');
  });

  it('throws on non-array input', async () => {
    await assert.rejects(
      () => normalizeReturnsPure({ returns: 'nope' }),
      /must be a JSON array/,
    );
  });
});

describe('projectWaveRecord — happy path', () => {
  it('appends a new wave record and advances currentWave on complete', () => {
    const verified = [
      { storyId: 10, status: 'done', tasksDone: 2, tasksTotal: 2 },
      { storyId: 11, status: 'done', tasksDone: 1, tasksTotal: 1 },
    ];
    const existing = {
      currentWave: 0,
      totalWaves: 3,
      waves: [],
    };
    const titleById = new Map([
      [10, 'Ten'],
      [11, 'Eleven'],
    ]);
    const fixedNow = () => new Date('2026-05-15T11:00:00.000Z');

    const out = projectWaveRecord({
      wave: 0,
      verified,
      existing,
      concurrencyCap: 2,
      titleById,
      now: fixedNow,
    });

    assert.equal(out.status, 'complete');
    assert.deepEqual(out.blockedStoryIds, []);
    assert.equal(out.totalWaves, 3);
    assert.equal(out.nextCurrentWave, 1);
    assert.equal(out.nextAction, 'dispatch-next');
    assert.equal(out.remainingWaves, 2);
    assert.equal(out.nextWaves.length, 1);
    assert.equal(out.newRecord.index, 0);
    assert.equal(out.newRecord.status, 'complete');
    assert.equal(out.newRecord.concurrencyCap, 2);
    assert.equal(out.newRecord.completedAt, '2026-05-15T11:00:00.000Z');
    assert.equal(out.newRecord.stories.length, 2);
    assert.deepEqual(out.rollupRows[0], {
      id: 10,
      title: 'Ten',
      state: 'done',
      tasksDone: 2,
      tasksTotal: 2,
    });
    assert.equal(out.rollupWaves[0].wave, 0);
    assert.equal(out.rollupWaves[0].concurrencyCap, 2);
  });

  it('replaces an existing record for the same wave (idempotent re-run)', () => {
    const existing = {
      currentWave: 0,
      totalWaves: 2,
      waves: [
        {
          index: 0,
          status: 'failed',
          concurrencyCap: 1,
          stories: [{ id: 1, state: 'failed' }],
          completedAt: '2026-05-15T10:00:00.000Z',
        },
      ],
    };
    const out = projectWaveRecord({
      wave: 0,
      verified: [{ storyId: 1, status: 'done' }],
      existing,
      concurrencyCap: 1,
      titleById: new Map([[1, 'One']]),
      now: () => new Date('2026-05-15T11:00:00.000Z'),
    });
    assert.equal(out.nextWaves.length, 1);
    assert.equal(out.nextWaves[0].status, 'complete');
    assert.equal(out.nextWaves[0].completedAt, '2026-05-15T11:00:00.000Z');
    assert.equal(out.nextCurrentWave, 1);
    assert.equal(out.nextAction, 'dispatch-next');
  });

  it('caps nextCurrentWave at totalWaves on final-wave complete', () => {
    const out = projectWaveRecord({
      wave: 2,
      verified: [{ storyId: 1, status: 'done' }],
      existing: { currentWave: 2, totalWaves: 3, waves: [] },
      concurrencyCap: 1,
      titleById: new Map(),
    });
    assert.equal(out.nextCurrentWave, 3);
    assert.equal(out.nextAction, 'finalize');
  });
});

describe('projectWaveRecord — non-happy paths', () => {
  it('blocked wave preserves currentWave and emits halt-blocked', () => {
    const out = projectWaveRecord({
      wave: 1,
      verified: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked', blockerCommentId: 'b-2' },
      ],
      existing: { currentWave: 1, totalWaves: 3, waves: [] },
      concurrencyCap: 2,
      titleById: new Map(),
    });
    assert.equal(out.status, 'blocked');
    assert.deepEqual(out.blockedStoryIds, [2]);
    assert.equal(out.nextCurrentWave, 1);
    assert.equal(out.nextAction, 'halt-blocked');
    const blockedRow = out.rollupRows.find((r) => r.id === 2);
    assert.equal(blockedRow.blockerCommentId, 'b-2');
  });

  it('failed wave preserves currentWave and emits halt-failed', () => {
    const out = projectWaveRecord({
      wave: 0,
      verified: [
        { storyId: 1, status: 'failed' },
        { storyId: 2, status: 'done' },
      ],
      existing: { currentWave: 0, totalWaves: 2, waves: [] },
      concurrencyCap: 1,
      titleById: new Map(),
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.nextCurrentWave, 0);
    assert.equal(out.nextAction, 'halt-failed');
  });

  it('empty wave aggregates to complete and advances the cursor', () => {
    const out = projectWaveRecord({
      wave: 0,
      verified: [],
      existing: { currentWave: 0, totalWaves: 1, waves: [] },
      concurrencyCap: 1,
      titleById: new Map(),
    });
    assert.equal(out.status, 'complete');
    assert.equal(out.rollupRows.length, 0);
    assert.equal(out.nextCurrentWave, 1);
    assert.equal(out.nextAction, 'finalize');
  });

  it('sorts prior waves in index order regardless of input order', () => {
    const existing = {
      currentWave: 0,
      totalWaves: 3,
      waves: [
        { index: 2, status: 'complete', concurrencyCap: 1, stories: [] },
        { index: 0, status: 'complete', concurrencyCap: 1, stories: [] },
      ],
    };
    const out = projectWaveRecord({
      wave: 1,
      verified: [{ storyId: 1, status: 'done' }],
      existing,
      concurrencyCap: 1,
      titleById: new Map([[1, 'A']]),
    });
    assert.deepEqual(
      out.nextWaves.map((w) => w.index),
      [0, 1, 2],
    );
  });

  it('throws on bad wave', () => {
    assert.throws(
      () =>
        projectWaveRecord({
          wave: -1,
          verified: [],
          existing: { totalWaves: 1, waves: [] },
          concurrencyCap: 1,
          titleById: new Map(),
        }),
      /wave must be a non-negative integer/,
    );
  });

  it('throws when titleById is not a Map', () => {
    assert.throws(
      () =>
        projectWaveRecord({
          wave: 0,
          verified: [],
          existing: { totalWaves: 1, waves: [] },
          concurrencyCap: 1,
          titleById: {},
        }),
      /titleById must be a Map/,
    );
  });

  it('throws when existing checkpoint is missing', () => {
    assert.throws(
      () =>
        projectWaveRecord({
          wave: 0,
          verified: [],
          existing: null,
          concurrencyCap: 1,
          titleById: new Map(),
        }),
      /existing checkpoint is required/,
    );
  });
});
