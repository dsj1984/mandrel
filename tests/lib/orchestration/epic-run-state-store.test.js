import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendIntervention,
  CHECKPOINT_SCHEMA_VERSION,
  EPIC_RUN_STATE_TYPE,
  initialize,
  read,
  setPhase,
  write,
} from '../../../.agents/scripts/lib/orchestration/epic-run-state-store.js';
import { Checkpointer } from '../../fixtures/epic-run-state-store.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

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

/** Strip volatile fields so two snapshots taken at different timestamps compare. */
function strip(state) {
  if (!state) return state;
  const { lastUpdatedAt: _l, startedAt: _s, ...rest } = state;
  return rest;
}

describe('epic-run-state-store', () => {
  it('initialize() writes fresh state when none exists', async () => {
    const provider = createFakeProvider();
    const state = await initialize({
      provider,
      epicId: 321,
      totalWaves: 3,
      concurrencyCap: 2,
    });
    assert.equal(state.version, CHECKPOINT_SCHEMA_VERSION);
    assert.equal(state.totalWaves, 3);
    assert.equal(state.currentWave, 0);

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1);
    assert.ok(
      comments[0].body.includes(structuredCommentMarker(EPIC_RUN_STATE_TYPE)),
    );
  });

  it('initialize() is idempotent when re-called with the same shape', async () => {
    const provider = createFakeProvider();
    const first = await initialize({
      provider,
      epicId: 321,
      totalWaves: 3,
      concurrencyCap: 2,
    });
    const second = await initialize({
      provider,
      epicId: 321,
      totalWaves: 3,
      concurrencyCap: 2,
    });
    assert.equal(second.totalWaves, 3);
    assert.equal(second.concurrencyCap, 2);
    assert.equal(
      second.startedAt,
      first.startedAt,
      'no rewrite when shape matches',
    );
    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'no duplicate checkpoint comment');
  });

  it('initialize() refreshes totalWaves/concurrencyCap when re-prepare detects a delta', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      totalWaves: 2,
      concurrencyCap: 2,
    });
    await write({
      provider,
      epicId: 321,
      state: {
        ...(await read({ provider, epicId: 321 })),
        currentWave: 1,
        waves: [{ wave: 0, status: 'complete' }],
        blockerHistory: [{ wave: 0, reason: 'recovered' }],
        plan: [['storyA'], ['storyB']],
      },
    });

    const refreshed = await initialize({
      provider,
      epicId: 321,
      totalWaves: 6,
      concurrencyCap: 4,
    });

    assert.equal(refreshed.totalWaves, 6);
    assert.equal(refreshed.concurrencyCap, 4);
    assert.equal(refreshed.currentWave, 1);
    assert.deepEqual(refreshed.waves, [{ wave: 0, status: 'complete' }]);
    assert.deepEqual(refreshed.blockerHistory, [
      { wave: 0, reason: 'recovered' },
    ]);
    assert.deepEqual(refreshed.plan, [['storyA'], ['storyB']]);

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'still a single checkpoint comment');
  });

  it('write() overwrites prior checkpoints via marker upsert', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      totalWaves: 3,
      concurrencyCap: 2,
    });
    await write({
      provider,
      epicId: 321,
      state: { epicId: 321, currentWave: 1, totalWaves: 3, waves: [] },
    });
    await write({
      provider,
      epicId: 321,
      state: { epicId: 321, currentWave: 2, totalWaves: 3, waves: [] },
    });

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'upsert keeps exactly one comment');
    const parsed = await read({ provider, epicId: 321 });
    assert.equal(parsed.currentWave, 2);
  });

  it('read() returns null on missing or malformed comment', async () => {
    const provider = createFakeProvider();
    assert.equal(await read({ provider, epicId: 321 }), null);

    await provider.postComment(321, {
      body: `${structuredCommentMarker(EPIC_RUN_STATE_TYPE)}\n\n\`\`\`json\nnot-json\n\`\`\``,
    });
    assert.equal(await read({ provider, epicId: 321 }), null);
  });

  it('initialize() seeds an empty manualInterventions array', async () => {
    const provider = createFakeProvider();
    const state = await initialize({
      provider,
      epicId: 321,
      totalWaves: 1,
      concurrencyCap: 1,
    });
    assert.deepEqual(state.manualInterventions, []);
  });

  it('appendIntervention() appends a record with default source/ts', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      totalWaves: 1,
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

  it('appendIntervention() preserves prior entries and other state fields', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      totalWaves: 2,
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
    assert.equal(state.totalWaves, 2);
    assert.equal(state.concurrencyCap, 3);
  });

  it('appendIntervention() rejects missing reason', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      totalWaves: 1,
      concurrencyCap: 1,
    });
    await assert.rejects(
      () =>
        appendIntervention({
          provider,
          epicId: 321,
          entry: { reason: '' },
        }),
      /reason: string/,
    );
    await assert.rejects(
      () => appendIntervention({ provider, epicId: 321, entry: {} }),
      /reason: string/,
    );
  });

  it('appendIntervention() works when manualInterventions was missing (legacy state)', async () => {
    const provider = createFakeProvider();
    await write({
      provider,
      epicId: 321,
      state: {
        epicId: 321,
        currentWave: 0,
        totalWaves: 1,
        waves: [],
      },
    });
    const state = await appendIntervention({
      provider,
      epicId: 321,
      entry: { reason: 'legacy upgrade' },
    });
    assert.equal(state.manualInterventions.length, 1);
    assert.equal(state.manualInterventions[0].reason, 'legacy upgrade');
  });

  it('setPhase() advances the phase field and preserves other state', async () => {
    const provider = createFakeProvider();
    await initialize({
      provider,
      epicId: 321,
      totalWaves: 3,
      concurrencyCap: 2,
    });
    const updated = await setPhase({
      provider,
      epicId: 321,
      nextPhase: 'wave-loop',
    });
    assert.equal(updated.phase, 'wave-loop');
    assert.equal(updated.totalWaves, 3);
  });

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
          totalWaves: 1,
          concurrencyCap: 1,
        }),
      /requires a provider/,
    );
  });

  it('write() produces byte-identical comment body to Checkpointer.write()', async () => {
    const seed = {
      epicId: 888,
      startedAt: '2026-04-21T20:00:00.000Z',
      currentWave: 1,
      totalWaves: 4,
      concurrencyCap: 3,
      phase: 'iterate-waves',
      waves: [{ wave: 0, status: 'complete' }],
      blockerHistory: [{ wave: 0, reason: 'ok' }],
      manualInterventions: [],
      plan: [['s1'], ['s2', 's3']],
    };

    const providerA = createFakeProvider();
    const providerB = createFakeProvider();

    await write({ provider: providerA, epicId: 888, state: seed });
    const cp = new Checkpointer({ provider: providerB, epicId: 888 });
    await cp.write(seed);

    const a = await read({ provider: providerA, epicId: 888 });
    const b = await cp.read();

    assert.deepEqual(
      strip(a),
      strip(b),
      'epic-run-state-store and Checkpointer write equivalent state',
    );
    assert.equal(a.version, CHECKPOINT_SCHEMA_VERSION);
    assert.equal(b.version, CHECKPOINT_SCHEMA_VERSION);
  });

  it('round-trip: write then read returns the persisted state', async () => {
    const provider = createFakeProvider();
    const seed = {
      epicId: 321,
      startedAt: '2026-04-21T20:00:00.000Z',
      currentWave: 2,
      totalWaves: 5,
      concurrencyCap: 3,
      phase: 'close-tail',
      waves: [],
      blockerHistory: [],
      manualInterventions: [
        { reason: 'r', source: 'host-llm', ts: '2026-04-21T20:00:00.000Z' },
      ],
    };
    const written = await write({ provider, epicId: 321, state: seed });
    const got = await read({ provider, epicId: 321 });
    assert.deepEqual(got, written);
  });
});
