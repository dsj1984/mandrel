/**
 * tests/lib/orchestration/wave-record-projection.test.js — pure unit tests for
 * the per-Story status-recorder helpers (Story #4155 / Epic #4151).
 *
 * The wave-batch aggregation helpers (`aggregateWaveStatus`,
 * `classifyWaveOutcome`, `projectWaveRecord`, `countDoneStories`,
 * `resolveConcurrencyCap`) were deleted in the ready-set cutover. The
 * surviving surface is the per-Story validation / normalization / rollup-row
 * helpers, each exercised here with injected inputs and no I/O.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyParsedReturn,
  normalizeReturnsPure,
  STORY_STATUS_TO_ROW_STATE,
  selectInputFlag,
  toRollupRow,
  VALID_STORY_STATUSES,
  validateEpic,
  validateResults,
  validateReturnsEntry,
} from '../../../.agents/scripts/lib/orchestration/wave-record-projection.js';

describe('wave-record-projection constants', () => {
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
      { storyId: 1, status: 'done', phase: 'done' },
    ]);
    assert.deepEqual(out, [{ storyId: 1, status: 'done', phase: 'done' }]);
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

describe('toRollupRow', () => {
  it('builds a done row', () => {
    const out = toRollupRow(
      { storyId: 1, status: 'done' },
      new Map([[1, 'Story title']]),
    );
    assert.deepEqual(out, { id: 1, title: 'Story title', state: 'done' });
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

describe('validateEpic', () => {
  it('accepts a positive integer', () => {
    assert.doesNotThrow(() => validateEpic(1));
  });

  it('rejects a non-positive epicId', () => {
    assert.throws(() => validateEpic(0), /--epic/);
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
