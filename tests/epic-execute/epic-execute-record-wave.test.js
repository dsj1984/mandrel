import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyRecordOutcome,
  emitWaveDispatchEnds,
  parseInputArg,
  runEpicExecuteRecordWave,
  validateResults,
} from '../../.agents/scripts/epic-execute-record-wave.js';
import { initialize as initializeEpicRunState } from '../../.agents/scripts/lib/orchestration/epic-run-state-store.js';

/**
 * tests/epic-execute/epic-execute-record-wave.test.js — the recorder cut
 * over from a wave-batch projector to a per-Story status recorder (Story
 * #4155 / Epic #4151). It splices each returned Story's terminal status into
 * the checkpoint's flat `stories` map, emits one `story.dispatch.end` per
 * Story, and re-renders a flat `epic-run-progress` rollup. No wave index, no
 * wave aggregation, no `currentWave` advance.
 */

function createFakeProvider({ ticketsById } = {}) {
  let autoId = 1;
  const comments = new Map();
  const provider = {
    _comments: comments,
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const c = { id: autoId++, body: payload.body };
      list.push(c);
      comments.set(ticketId, list);
      return c;
    },
    async deleteComment(commentId) {
      for (const [, list] of comments) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
  // Only attach `getTicket` when the test has seeded ticket state.
  // `verifyWaveResults` short-circuits when the provider lacks `getTicket`,
  // so happy-path tests that don't care about verification can omit it.
  if (ticketsById) {
    provider.getTicket = async (id) => ticketsById[id] ?? null;
  }
  return provider;
}

async function seedCheckpoint(provider, epicId, overrides = {}) {
  return initializeEpicRunState({
    provider,
    epicId,
    storyIds: overrides.storyIds ?? [1, 2],
    concurrencyCap: overrides.concurrencyCap ?? 2,
  });
}

const TEST_CONFIG = {
  orchestration: { runners: { deliverRunner: { concurrencyCap: 2 } } },
};

const FAST_RECORD = {
  injectedConfig: TEST_CONFIG,
  // Stub out the curated webhook emits by default so tests that don't care
  // about notify routing can't reach the real notify().
  injectedNotify: async () => {},
};

function recordWave(overrides) {
  return runEpicExecuteRecordWave({ ...FAST_RECORD, ...overrides });
}

describe('classifyRecordOutcome', () => {
  it('all done → complete / dispatch-next', () => {
    assert.deepEqual(
      classifyRecordOutcome([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'done' },
      ]),
      { status: 'complete', nextAction: 'dispatch-next', blockedStoryIds: [] },
    );
  });

  it('any blocked + no failed → blocked / halt-blocked', () => {
    assert.deepEqual(
      classifyRecordOutcome([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked' },
      ]),
      { status: 'blocked', nextAction: 'halt-blocked', blockedStoryIds: [2] },
    );
  });

  it('any failed → failed / halt-failed (wins over blocked)', () => {
    const out = classifyRecordOutcome([
      { storyId: 1, status: 'failed' },
      { storyId: 2, status: 'blocked' },
    ]);
    assert.equal(out.status, 'failed');
    assert.equal(out.nextAction, 'halt-failed');
  });

  it('empty → complete (no-op beat)', () => {
    assert.deepEqual(classifyRecordOutcome([]), {
      status: 'complete',
      nextAction: 'dispatch-next',
      blockedStoryIds: [],
    });
  });
});

describe('validateResults', () => {
  it('accepts canonical /deliver return rows', () => {
    const out = validateResults([
      { storyId: 1, status: 'done', phase: 'done' },
      { storyId: 2, status: 'blocked', blockerCommentId: 'c-1' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].storyId, 1);
    assert.equal(out[1].blockerCommentId, 'c-1');
  });

  it('rejects non-array input', () => {
    assert.throws(() => validateResults('nope'), /must be a JSON array/);
  });

  it('rejects unknown status', () => {
    assert.throws(
      () => validateResults([{ storyId: 1, status: 'cooked' }]),
      /must be one of/,
    );
  });
});

describe('parseInputArg', () => {
  it('parses inline JSON array', () => {
    assert.deepEqual(parseInputArg('[{"storyId":1,"status":"done"}]'), [
      { storyId: 1, status: 'done' },
    ]);
  });

  it('parses @<file> via injected reader', () => {
    const out = parseInputArg('@results.json', {
      readFile: () => '[{"storyId":2,"status":"blocked"}]',
    });
    assert.deepEqual(out, [{ storyId: 2, status: 'blocked' }]);
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseInputArg('{bad'), /not valid JSON/);
  });
});

describe('runEpicExecuteRecordWave', () => {
  it('records each Story status into the checkpoint and returns dispatch-next', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 700, { storyIds: [1, 2] });

    const out = await recordWave({
      epicId: 700,
      results: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'done' },
      ],
      injectedProvider: provider,
    });

    assert.equal(out.recorded, true);
    assert.equal(out.status, 'complete');
    assert.equal(out.nextAction, 'dispatch-next');
    assert.deepEqual(out.stories.map((s) => s.id).sort(), [1, 2]);
  });

  it('returns halt-blocked when any Story returned blocked', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 701, { storyIds: [1, 2] });

    const out = await recordWave({
      epicId: 701,
      results: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked', blockerCommentId: 'b-2' },
      ],
      injectedProvider: provider,
    });

    assert.equal(out.status, 'blocked');
    assert.equal(out.nextAction, 'halt-blocked');
    assert.deepEqual(out.blockedStoryIds, [2]);
  });

  it('persists the recorded statuses on the checkpoint stories map', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 702, { storyIds: [1, 2, 3] });

    await recordWave({
      epicId: 702,
      results: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked', blockerCommentId: 'b-2' },
      ],
      injectedProvider: provider,
    });

    const { read } = await import(
      '../../.agents/scripts/lib/orchestration/epic-run-state-store.js'
    );
    const state = await read({ provider, epicId: 702 });
    assert.equal(state.stories['1'].status, 'done');
    assert.equal(state.stories['2'].status, 'blocked');
    assert.equal(state.stories['2'].blockerCommentId, 'b-2');
    assert.equal(
      state.stories['3'].status,
      'pending',
      'untouched Story stays pending',
    );
  });

  it('downgrades unverified `done` claims to failed', async () => {
    // Story 1 claims done but its live ticket carries agent::executing.
    const provider = createFakeProvider({
      ticketsById: {
        1: { id: 1, labels: ['agent::executing'], state: 'open' },
      },
    });
    await seedCheckpoint(provider, 703, { storyIds: [1] });

    const out = await recordWave({
      epicId: 703,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
    });

    assert.equal(out.stories[0].status, 'failed');
    assert.ok(out.discrepancies?.some((d) => d.storyId === 1));
  });

  it('upserts a single flat epic-run-progress comment', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 704, { storyIds: [1, 2] });

    await recordWave({
      epicId: 704,
      results: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'done' },
      ],
      injectedProvider: provider,
    });

    const comments = provider._comments.get(704) ?? [];
    const progress = comments.filter((c) =>
      c.body.includes('epic-run-progress'),
    );
    assert.equal(progress.length, 1, 'exactly one rollup comment');
    // Flat table (ID/State/Title), not wave-grouped.
    assert.match(progress[0].body, /\| ID \| State \| Title \|/);
  });

  it('throws when no checkpoint exists', async () => {
    const provider = createFakeProvider();
    await assert.rejects(
      () =>
        recordWave({
          epicId: 999,
          results: [{ storyId: 1, status: 'done' }],
          injectedProvider: provider,
        }),
      /no epic-run-state checkpoint/,
    );
  });

  it('rejects passing both results and returns', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 705);
    await assert.rejects(
      () =>
        recordWave({
          epicId: 705,
          results: [],
          returns: [],
          injectedProvider: provider,
        }),
      /not both/,
    );
  });

  it('rejects malformed per-Story rows', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 706);
    await assert.rejects(
      () =>
        recordWave({
          epicId: 706,
          results: [{ storyId: -1, status: 'done' }],
          injectedProvider: provider,
        }),
      /positive integer/,
    );
  });
});

describe('runEpicExecuteRecordWave — curated webhook emits', () => {
  it('fires epic-started + epic-progress on the first record beat', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 800, { storyIds: [1, 2] });
    const events = [];
    await recordWave({
      epicId: 800,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
      injectedNotify: async (_id, payload) => events.push(payload.event),
    });
    assert.ok(events.includes('epic-started'));
    assert.ok(events.includes('epic-progress'));
  });

  it('fires epic-blocked on a blocked record beat', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 801, { storyIds: [1] });
    const events = [];
    await recordWave({
      epicId: 801,
      results: [{ storyId: 1, status: 'blocked', blockerCommentId: 'b' }],
      injectedProvider: provider,
      injectedNotify: async (_id, payload) => events.push(payload.event),
    });
    assert.ok(events.includes('epic-blocked'));
  });
});

describe('emitWaveDispatchEnds (Story #3900)', () => {
  it('emits one dispatch-end per verified Story, mapping status to outcome', () => {
    const seen = [];
    const count = emitWaveDispatchEnds({
      epicId: 12,
      verified: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked' },
      ],
      emit: (args) => seen.push(args),
    });
    assert.equal(count, 2);
    assert.deepEqual(
      seen.map((s) => s.storyId),
      [1, 2],
    );
  });

  it('skips entries without a positive storyId', () => {
    const seen = [];
    const count = emitWaveDispatchEnds({
      epicId: 12,
      verified: [{ storyId: 0, status: 'done' }, { status: 'done' }],
      emit: (args) => seen.push(args),
    });
    assert.equal(count, 0);
    assert.equal(seen.length, 0);
  });

  it('is best-effort: one failed emit does not abort the rest', () => {
    const seen = [];
    const count = emitWaveDispatchEnds({
      epicId: 12,
      verified: [
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'done' },
      ],
      emit: (args) => {
        if (args.storyId === 1) throw new Error('boom');
        seen.push(args);
      },
    });
    assert.equal(count, 1);
    assert.deepEqual(
      seen.map((s) => s.storyId),
      [2],
    );
  });

  it('tolerates an empty / missing verified list', () => {
    assert.equal(emitWaveDispatchEnds({ epicId: 1, verified: [] }), 0);
    assert.equal(emitWaveDispatchEnds({ epicId: 1 }), 0);
  });
});
