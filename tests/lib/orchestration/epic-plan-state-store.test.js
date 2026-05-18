import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EPIC_PLAN_STATE_TYPE,
  initialize,
  PLAN_CHECKPOINT_SCHEMA_VERSION,
  PLAN_PHASES,
  read,
  setPhase,
  write,
} from '../../../.agents/scripts/lib/orchestration/epic-plan-state-store.js';
import { PlanCheckpointer } from '../../../.agents/scripts/lib/orchestration/plan-runner/plan-checkpointer.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

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

/** Strip volatile fields so two snapshots taken at different timestamps compare. */
function strip(state) {
  if (!state) return state;
  const { lastUpdatedAt: _l, startedAt: _s, ...rest } = state;
  return rest;
}

describe('epic-plan-state-store', () => {
  it('initialize() writes a fresh skeleton when none exists', async () => {
    const provider = createFakeProvider();
    const state = await initialize({ provider, epicId: 349 });

    assert.equal(state.version, PLAN_CHECKPOINT_SCHEMA_VERSION);
    assert.equal(state.epicId, 349);
    assert.equal(state.phase, PLAN_PHASES.PLANNING);
    assert.deepEqual(state.spec, {
      prdId: null,
      techSpecId: null,
      acceptanceSpecId: null,
      completedAt: null,
    });
    assert.deepEqual(state.decompose, {
      ticketCount: null,
      completedAt: null,
    });
    assert.equal(state.manifestCommentId, null);

    const comments = provider._comments.get(349) ?? [];
    assert.equal(comments.length, 1);
    assert.ok(
      comments[0].body.includes(structuredCommentMarker(EPIC_PLAN_STATE_TYPE)),
    );
  });

  it('initialize() is idempotent when state exists', async () => {
    const provider = createFakeProvider();
    await initialize({ provider, epicId: 349 });
    const second = await initialize({
      provider,
      epicId: 349,
      seed: { phase: PLAN_PHASES.READY },
    });

    // Seed overrides must not clobber a pre-existing checkpoint.
    assert.equal(second.phase, PLAN_PHASES.PLANNING);
    const comments = provider._comments.get(349) ?? [];
    assert.equal(comments.length, 1, 'no duplicate checkpoint comment');
  });

  it('setPhase() updates only the phase field and preserves schema', async () => {
    const provider = createFakeProvider();
    const initial = await initialize({ provider, epicId: 349 });

    const updated = await setPhase({
      provider,
      epicId: 349,
      nextPhase: PLAN_PHASES.REVIEW_SPEC,
    });

    assert.equal(updated.phase, PLAN_PHASES.REVIEW_SPEC);
    assert.equal(updated.startedAt, initial.startedAt);
    assert.deepEqual(updated.spec, initial.spec);
    const comments = provider._comments.get(349) ?? [];
    assert.equal(comments.length, 1, 'upsert keeps exactly one comment');
  });

  it('setPhase() rejects unknown phase values', async () => {
    const provider = createFakeProvider();
    await assert.rejects(
      () => setPhase({ provider, epicId: 349, nextPhase: 'not-a-phase' }),
      /unknown phase/,
    );
  });

  it('read() returns null on missing or malformed comment', async () => {
    const provider = createFakeProvider();
    assert.equal(await read({ provider, epicId: 349 }), null);

    await provider.postComment(349, {
      body: `${structuredCommentMarker(EPIC_PLAN_STATE_TYPE)}\n\n\`\`\`json\nnot-json\n\`\`\``,
    });
    assert.equal(await read({ provider, epicId: 349 }), null);
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
      () => initialize({ provider: null, epicId: 1 }),
      /requires a provider/,
    );
    await assert.rejects(
      () =>
        setPhase({
          provider: null,
          epicId: 1,
          nextPhase: PLAN_PHASES.PLANNING,
        }),
      /requires a provider/,
    );
  });

  it('write() produces byte-identical comment body to PlanCheckpointer.write()', async () => {
    // Method-equivalence: invoke both surfaces with the same epicId and
    // verify they emit the same structured-comment body (minus the volatile
    // `lastUpdatedAt` timestamp written at the moment of the call).
    const seed = {
      epicId: 777,
      phase: PLAN_PHASES.DECOMPOSING,
      startedAt: '2026-04-21T20:00:00.000Z',
      spec: {
        prdId: 511,
        techSpecId: 512,
        acceptanceSpecId: null,
        completedAt: '2026-04-21T21:00:00Z',
      },
      decompose: { ticketCount: 18, completedAt: '2026-04-21T22:00:00Z' },
      manifestCommentId: 99999,
    };

    const providerA = createFakeProvider();
    const providerB = createFakeProvider();

    await write({ provider: providerA, epicId: 777, state: seed });
    const cp = new PlanCheckpointer({ provider: providerB, epicId: 777 });
    await cp.write(seed);

    const a = await read({ provider: providerA, epicId: 777 });
    const b = await cp.read();

    assert.deepEqual(
      strip(a),
      strip(b),
      'epic-plan-state-store and PlanCheckpointer write equivalent state',
    );
    assert.equal(a.version, PLAN_CHECKPOINT_SCHEMA_VERSION);
    assert.equal(b.version, PLAN_CHECKPOINT_SCHEMA_VERSION);
  });

  it('round-trip: write then read returns the persisted state', async () => {
    const provider = createFakeProvider();
    const seed = {
      epicId: 349,
      phase: PLAN_PHASES.READY,
      startedAt: '2026-04-21T20:00:00.000Z',
      spec: {
        prdId: 1,
        techSpecId: 2,
        acceptanceSpecId: 3,
        completedAt: '2026-04-22T00:00:00.000Z',
      },
      decompose: { ticketCount: 7, completedAt: '2026-04-22T00:10:00.000Z' },
      manifestCommentId: 42,
    };
    const written = await write({ provider, epicId: 349, state: seed });
    const got = await read({ provider, epicId: 349 });
    assert.deepEqual(got, written);
  });
});
