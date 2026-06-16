import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendIntervention,
  buildStoryStatusMap,
  CHECKPOINT_SCHEMA_VERSION,
  EPIC_RUN_STATE_TYPE,
  initialize,
  mergeStoryStatuses,
  read,
  recordStoryStatus,
  STORY_STATUSES,
  setPhase,
  write,
} from '../../../.agents/scripts/lib/orchestration/epic-run-state-store.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * tests/lib/orchestration/epic-run-state-store.test.js — contract tests for
 * the shrunk per-Story-status checkpoint (Story #4155 / Epic #4151). The
 * checkpoint no longer carries `currentWave`, `plan`, `totalWaves`, or a
 * per-wave `waves[]` history; it carries a flat `stories` status map plus the
 * GLOBAL in-flight `concurrencyCap`, `phase`, `startedAt`, and
 * `manualInterventions[]`.
 */

function createFakeProvider() {
  let autoId = 1;
  const comments = new Map();

  return {
    _comments: comments,
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const comment = { id: autoId++, body: payload.body };
      list.push(comment);
      comments.set(ticketId, list);
      return comment;
    },
    async deleteComment(commentId) {
      for (const [, list] of comments) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
}

describe('epic-run-state-store — pure helpers', () => {
  it('buildStoryStatusMap seeds every Story at pending, keyed by string id', () => {
    const map = buildStoryStatusMap([
      { id: 1, title: 'One' },
      { number: 2 },
      3,
    ]);
    assert.deepEqual(map, {
      1: { status: 'pending', title: 'One' },
      2: { status: 'pending' },
      3: { status: 'pending' },
    });
  });

  it('buildStoryStatusMap drops shapeless / non-positive entries', () => {
    const map = buildStoryStatusMap([{ id: 0 }, { id: -2 }, {}, 'x', 7]);
    assert.deepEqual(map, { 7: { status: 'pending' } });
  });

  it('mergeStoryStatuses keeps recorded progress and refreshes titles', () => {
    const prior = {
      1: { status: 'done', title: 'old' },
      2: { status: 'blocked', blockerCommentId: 'c1' },
    };
    const incoming = {
      1: { status: 'pending', title: 'new' },
      2: { status: 'pending' },
      3: { status: 'pending', title: 'Three' },
    };
    const merged = mergeStoryStatuses(prior, incoming);
    assert.equal(merged['1'].status, 'done', 'recorded done survives');
    assert.equal(merged['1'].title, 'new', 'title refreshed from seed');
    assert.equal(merged['2'].status, 'blocked');
    assert.equal(merged['2'].blockerCommentId, 'c1');
    assert.deepEqual(merged['3'], { status: 'pending', title: 'Three' });
  });

  it('exposes the canonical story-status set', () => {
    assert.deepEqual([...STORY_STATUSES].sort(), [
      'blocked',
      'done',
      'failed',
      'pending',
    ]);
  });
});

describe('epic-run-state-store — initialize', () => {
  it('writes a fresh per-Story-status checkpoint when none exists', async () => {
    const provider = createFakeProvider();
    const state = await initialize({
      provider,
      epicId: 321,
      storyIds: [{ id: 10 }, { id: 11 }],
      concurrencyCap: 3,
    });
    assert.equal(state.version, CHECKPOINT_SCHEMA_VERSION);
    assert.equal(state.concurrencyCap, 3);
    assert.equal(state.phase, 'prepare');
    assert.deepEqual(state.manualInterventions, []);
    assert.deepEqual(state.stories, {
      10: { status: 'pending' },
      11: { status: 'pending' },
    });
    // No wave-batch fields leak onto the fresh checkpoint.
    assert.equal(state.currentWave, undefined);
    assert.equal(state.totalWaves, undefined);
    assert.equal(state.plan, undefined);
    assert.equal(state.waves, undefined);

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1);
    assert.ok(
      comments[0].body.includes(structuredCommentMarker(EPIC_RUN_STATE_TYPE)),
    );
  });

  it('is idempotent when re-called with the same Story set + cap', async () => {
    const provider = createFakeProvider();
    const first = await initialize({
      provider,
      epicId: 321,
      storyIds: [10, 11],
      concurrencyCap: 3,
    });
    const second = await initialize({
      provider,
      epicId: 321,
      storyIds: [10, 11],
      concurrencyCap: 3,
    });
    assert.equal(
      second.startedAt,
      first.startedAt,
      'no rewrite when shape matches',
    );
    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'no duplicate checkpoint comment');
  });

  it('refreshes concurrencyCap and adds new Stories without resetting recorded progress', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [10, 11],
      concurrencyCap: 2,
    });
    // Story 10 reached done since the first prepare.
    await recordStoryStatus({
      provider,
      epicId: 321,
      storyId: 10,
      status: 'done',
    });

    const refreshed = await initialize({
      provider,
      epicId: 321,
      storyIds: [10, 11, 12],
      concurrencyCap: 4,
    });

    assert.equal(refreshed.concurrencyCap, 4);
    assert.equal(
      refreshed.stories['10'].status,
      'done',
      'recorded done preserved across re-prepare',
    );
    assert.equal(refreshed.stories['11'].status, 'pending');
    assert.equal(refreshed.stories['12'].status, 'pending', 'new Story added');

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'still a single checkpoint comment');
  });
});

describe('epic-run-state-store — read/write', () => {
  it('write overwrites prior checkpoints via marker upsert', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 2,
    });
    await write({
      provider,
      epicId: 321,
      state: {
        epicId: 321,
        concurrencyCap: 2,
        stories: { 1: { status: 'done' } },
      },
    });
    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'upsert keeps exactly one comment');
    const parsed = await read({ provider, epicId: 321 });
    assert.equal(parsed.stories['1'].status, 'done');
  });

  it('read returns null on missing or malformed comment', async () => {
    const provider = createFakeProvider();
    assert.equal(await read({ provider, epicId: 321 }), null);

    await provider.postComment(321, {
      body: `${structuredCommentMarker(EPIC_RUN_STATE_TYPE)}\n\n\`\`\`json\nnot-json\n\`\`\``,
    });
    assert.equal(await read({ provider, epicId: 321 }), null);
  });

  it('round-trip: write then read returns the persisted state', async () => {
    const provider = createFakeProvider();
    const seed = {
      epicId: 321,
      startedAt: '2026-04-21T20:00:00.000Z',
      concurrencyCap: 3,
      phase: 'wave-loop',
      stories: { 1: { status: 'done' }, 2: { status: 'pending' } },
      manualInterventions: [
        { reason: 'r', source: 'host-llm', ts: '2026-04-21T20:00:00.000Z' },
      ],
    };
    const written = await write({ provider, epicId: 321, state: seed });
    const got = await read({ provider, epicId: 321 });
    assert.deepEqual(got, written);
  });
});

describe('epic-run-state-store — recordStoryStatus', () => {
  it('splices a single Story status into the map, preserving others', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1, 2],
      concurrencyCap: 2,
    });
    const state = await recordStoryStatus({
      provider,
      epicId: 321,
      storyId: 2,
      status: 'done',
      title: 'Two',
    });
    assert.equal(state.stories['2'].status, 'done');
    assert.equal(state.stories['2'].title, 'Two');
    assert.equal(state.stories['1'].status, 'pending', 'other Story untouched');
  });

  it('records a blocker comment id only for the blocked status', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 1,
    });
    const state = await recordStoryStatus({
      provider,
      epicId: 321,
      storyId: 1,
      status: 'blocked',
      blockerCommentId: 99,
    });
    assert.equal(state.stories['1'].status, 'blocked');
    assert.equal(state.stories['1'].blockerCommentId, '99');
  });

  it('upgrades a legacy checkpoint with no stories map in place', async () => {
    const provider = createFakeProvider();
    await write({
      provider,
      epicId: 321,
      state: { epicId: 321, concurrencyCap: 1 },
    });
    const state = await recordStoryStatus({
      provider,
      epicId: 321,
      storyId: 5,
      status: 'failed',
    });
    assert.deepEqual(state.stories, { 5: { status: 'failed' } });
  });

  it('rejects a bad storyId or unknown status', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 1,
    });
    await assert.rejects(
      () =>
        recordStoryStatus({
          provider,
          epicId: 321,
          storyId: 0,
          status: 'done',
        }),
      /positive integer/,
    );
    await assert.rejects(
      () =>
        recordStoryStatus({
          provider,
          epicId: 321,
          storyId: 1,
          status: 'cooked',
        }),
      /must be one of/,
    );
  });
});

describe('epic-run-state-store — interventions + phase', () => {
  it('initialize seeds an empty manualInterventions array', async () => {
    const provider = createFakeProvider();
    const state = await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 1,
    });
    assert.deepEqual(state.manualInterventions, []);
  });

  it('appendIntervention appends a record with default source/ts', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 1,
    });
    const state = await appendIntervention({
      provider,
      epicId: 321,
      entry: { reason: 'discarded -593 lines of working-tree drift' },
    });
    assert.equal(state.manualInterventions.length, 1);
    const entry = state.manualInterventions[0];
    assert.equal(entry.reason, 'discarded -593 lines of working-tree drift');
    assert.equal(entry.source, 'host-llm');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('appendIntervention preserves prior entries and other state fields', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 3,
    });
    await appendIntervention({
      provider,
      epicId: 321,
      entry: { reason: 'first', source: 'host' },
    });
    const state = await appendIntervention({
      provider,
      epicId: 321,
      entry: { reason: 'second' },
    });
    assert.equal(state.manualInterventions.length, 2);
    assert.equal(state.manualInterventions[0].reason, 'first');
    assert.equal(state.manualInterventions[0].source, 'host');
    assert.equal(state.manualInterventions[1].reason, 'second');
    assert.equal(state.concurrencyCap, 3);
  });

  it('appendIntervention rejects a missing reason', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 1,
    });
    await assert.rejects(
      () =>
        appendIntervention({ provider, epicId: 321, entry: { reason: '' } }),
      /reason: string/,
    );
    await assert.rejects(
      () => appendIntervention({ provider, epicId: 321, entry: {} }),
      /reason: string/,
    );
  });

  it('appendIntervention works when manualInterventions was missing (legacy state)', async () => {
    const provider = createFakeProvider();
    await write({
      provider,
      epicId: 321,
      state: { epicId: 321, concurrencyCap: 1, stories: {} },
    });
    const state = await appendIntervention({
      provider,
      epicId: 321,
      entry: { reason: 'legacy upgrade' },
    });
    assert.equal(state.manualInterventions.length, 1);
    assert.equal(state.manualInterventions[0].reason, 'legacy upgrade');
  });

  it('setPhase advances the phase field and preserves other state', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      storyIds: [1],
      concurrencyCap: 2,
    });
    const updated = await setPhase({
      provider,
      epicId: 321,
      nextPhase: 'wave-loop',
    });
    assert.equal(updated.phase, 'wave-loop');
    assert.equal(updated.concurrencyCap, 2);
  });
});

describe('epic-run-state-store — argument validation', () => {
  it('rejects invalid arguments', async () => {
    await assert.rejects(
      () => read({ provider: null, epicId: 1 }),
      /requires a provider/,
    );
    await assert.rejects(
      () => read({ provider: {}, epicId: 'abc' }),
      /numeric epicId/,
    );
    await assert.rejects(
      () => write({ provider: null, epicId: 1, state: {} }),
      /requires a provider/,
    );
    await assert.rejects(
      () =>
        initialize({
          provider: null,
          epicId: 1,
          storyIds: [1],
          concurrencyCap: 1,
        }),
      /requires a provider/,
    );
  });
});
