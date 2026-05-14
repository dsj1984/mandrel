import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECKPOINT_SCHEMA_VERSION,
  Checkpointer,
  EPIC_RUN_STATE_TYPE,
} from '../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

function createFakeProvider() {
  let autoId = 1;
  const comments = new Map(); // ticketId → [{id, body}]

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

describe('Checkpointer', () => {
  it('initialize() writes fresh state when none exists', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    const state = await cp.initialize({
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
    const cp = new Checkpointer({ provider, epicId: 321 });
    const first = await cp.initialize({ totalWaves: 3, concurrencyCap: 2 });
    const second = await cp.initialize({ totalWaves: 3, concurrencyCap: 2 });
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
    const cp = new Checkpointer({ provider, epicId: 321 });
    // Simulate an in-flight delivery: initial prepare saw 2 waves, then
    // wave 1 ran and the plan + history were persisted.
    await cp.initialize({ totalWaves: 2, concurrencyCap: 2 });
    await cp.write({
      ...(await cp.read()),
      currentWave: 1,
      waves: [{ wave: 0, status: 'complete' }],
      blockerHistory: [{ wave: 0, reason: 'recovered' }],
      plan: [['storyA'], ['storyB']],
    });

    // Re-prepare after reconciler fix expands the DAG to 6 waves.
    const refreshed = await cp.initialize({
      totalWaves: 6,
      concurrencyCap: 4,
    });

    assert.equal(refreshed.totalWaves, 6, 'totalWaves refreshed in place');
    assert.equal(refreshed.concurrencyCap, 4, 'concurrencyCap refreshed');
    assert.equal(refreshed.currentWave, 1, 'currentWave preserved');
    assert.deepEqual(
      refreshed.waves,
      [{ wave: 0, status: 'complete' }],
      'waves[] preserved',
    );
    assert.deepEqual(
      refreshed.blockerHistory,
      [{ wave: 0, reason: 'recovered' }],
      'blockerHistory preserved',
    );
    assert.deepEqual(
      refreshed.plan,
      [['storyA'], ['storyB']],
      'plan preserved (caller overwrites on next write)',
    );

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'still a single checkpoint comment');
  });

  it('write() overwrites prior checkpoints via marker upsert', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    await cp.initialize({ totalWaves: 3, concurrencyCap: 2 });
    await cp.write({ epicId: 321, currentWave: 1, totalWaves: 3, waves: [] });
    await cp.write({ epicId: 321, currentWave: 2, totalWaves: 3, waves: [] });

    const comments = provider._comments.get(321) ?? [];
    assert.equal(comments.length, 1, 'upsert keeps exactly one comment');
    const parsed = await cp.read();
    assert.equal(parsed.currentWave, 2);
  });

  it('read() returns null on missing or malformed comment', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    assert.equal(await cp.read(), null);

    await provider.postComment(321, {
      body: `${structuredCommentMarker(EPIC_RUN_STATE_TYPE)}\n\n\`\`\`json\nnot-json\n\`\`\``,
    });
    assert.equal(await cp.read(), null);
  });

  it('initialize() seeds an empty manualInterventions array', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    const state = await cp.initialize({ totalWaves: 1, concurrencyCap: 1 });
    assert.deepEqual(state.manualInterventions, []);
  });

  it('appendIntervention() appends a record with default source/ts', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    await cp.initialize({ totalWaves: 1, concurrencyCap: 1 });
    const state = await cp.appendIntervention({
      reason: 'discarded -593 lines of working-tree drift',
    });
    assert.equal(state.manualInterventions.length, 1);
    const entry = state.manualInterventions[0];
    assert.equal(entry.reason, 'discarded -593 lines of working-tree drift');
    assert.equal(entry.source, 'host-llm');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('appendIntervention() preserves prior entries and other state fields', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    await cp.initialize({ totalWaves: 2, concurrencyCap: 3 });
    await cp.appendIntervention({ reason: 'first', source: 'host' });
    const state = await cp.appendIntervention({ reason: 'second' });
    assert.equal(state.manualInterventions.length, 2);
    assert.equal(state.manualInterventions[0].reason, 'first');
    assert.equal(state.manualInterventions[0].source, 'host');
    assert.equal(state.manualInterventions[1].reason, 'second');
    assert.equal(state.totalWaves, 2, 'unrelated fields preserved');
    assert.equal(state.concurrencyCap, 3);
  });

  it('appendIntervention() rejects missing reason', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    await cp.initialize({ totalWaves: 1, concurrencyCap: 1 });
    await assert.rejects(
      () => cp.appendIntervention({ reason: '' }),
      /reason: string/,
    );
    await assert.rejects(() => cp.appendIntervention({}), /reason: string/);
  });

  it('appendIntervention() works when manualInterventions was missing (legacy state)', async () => {
    const provider = createFakeProvider();
    const cp = new Checkpointer({ provider, epicId: 321 });
    // Write a checkpoint without the field (legacy run).
    await cp.write({
      epicId: 321,
      currentWave: 0,
      totalWaves: 1,
      waves: [],
    });
    const state = await cp.appendIntervention({ reason: 'legacy upgrade' });
    assert.equal(state.manualInterventions.length, 1);
    assert.equal(state.manualInterventions[0].reason, 'legacy upgrade');
  });
});
