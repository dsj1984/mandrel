import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  EPIC_PLAN_STATE_TYPE,
  PLAN_CHECKPOINT_SCHEMA_VERSION,
  PlanCheckpointer,
} from '../fixtures/epic-plan-state-store.js';

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

describe('PlanCheckpointer', () => {
  it('initialize() writes a fresh skeleton when none exists', async () => {
    const provider = createFakeProvider();
    const cp = new PlanCheckpointer({ provider, epicId: 349 });
    const state = await cp.initialize();

    assert.equal(state.version, PLAN_CHECKPOINT_SCHEMA_VERSION);
    assert.equal(state.epicId, 349);
    assert.equal(
      state.phase,
      undefined,
      'write-only phase telemetry is no longer persisted (Story #3909)',
    );
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
    const cp = new PlanCheckpointer({ provider, epicId: 349 });
    const first = await cp.initialize();
    const second = await cp.initialize({ spec: { prdId: 1 } });

    // Seed overrides must not clobber a pre-existing checkpoint.
    assert.deepEqual(second.spec, first.spec);
    const comments = provider._comments.get(349) ?? [];
    assert.equal(comments.length, 1, 'no duplicate checkpoint comment');
  });

  it('updateSpec() merges partial spec payloads', async () => {
    const provider = createFakeProvider();
    const cp = new PlanCheckpointer({ provider, epicId: 349 });
    await cp.initialize();

    const first = await cp.updateSpec({ prdId: 511 });
    assert.equal(first.spec.prdId, 511);
    assert.equal(first.spec.techSpecId, null);

    const second = await cp.updateSpec({
      techSpecId: 512,
      completedAt: '2026-04-21T21:00:00Z',
    });
    assert.equal(second.spec.prdId, 511, 'prior prdId preserved');
    assert.equal(second.spec.techSpecId, 512);
    assert.equal(second.spec.completedAt, '2026-04-21T21:00:00Z');
  });

  it('updateDecompose() merges partial decompose payloads', async () => {
    const provider = createFakeProvider();
    const cp = new PlanCheckpointer({ provider, epicId: 349 });
    await cp.initialize();

    const done = await cp.updateDecompose({
      ticketCount: 18,
      completedAt: '2026-04-21T22:00:00Z',
    });
    assert.equal(done.decompose.ticketCount, 18);
    assert.equal(done.decompose.completedAt, '2026-04-21T22:00:00Z');
  });

  it('setManifestCommentId() records the pointer', async () => {
    const provider = createFakeProvider();
    const cp = new PlanCheckpointer({ provider, epicId: 349 });
    await cp.initialize();

    const state = await cp.setManifestCommentId(99999);
    assert.equal(state.manifestCommentId, 99999);
  });

  it('read() returns null on missing or malformed comment', async () => {
    const provider = createFakeProvider();
    const cp = new PlanCheckpointer({ provider, epicId: 349 });
    assert.equal(await cp.read(), null);

    await provider.postComment(349, {
      body: `${structuredCommentMarker(EPIC_PLAN_STATE_TYPE)}\n\n\`\`\`json\nnot-json\n\`\`\``,
    });
    assert.equal(await cp.read(), null);
  });

  it('constructor rejects invalid arguments', () => {
    assert.throws(
      () => new PlanCheckpointer({ provider: null, epicId: 1 }),
      /requires a provider/,
    );
    assert.throws(
      () => new PlanCheckpointer({ provider: {}, epicId: 'abc' }),
      /numeric epicId/,
    );
  });
});
