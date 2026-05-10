import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicDeliverPrepare } from '../../.agents/scripts/epic-deliver-prepare.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  EPIC_RUN_STATE_TYPE,
} from '../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Build a minimal in-memory provider matching the surface the prepare runner
 * touches: `getTicket` (Epic snapshot), `getSubTickets` (children for the
 * DAG), `getTicketComments` / `postComment` / `deleteComment` (checkpoint).
 */
function createFakeProvider({ epic, descendants }) {
  let autoId = 1;
  const comments = new Map();
  return {
    _comments: comments,
    async getTicket(id) {
      if (id === epic.id) return epic;
      return descendants.find((d) => d.id === id) ?? null;
    },
    async getSubTickets(_id) {
      return descendants;
    },
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
}

const baseConfig = {
  orchestration: {
    runners: {
      epicRunner: {
        enabled: true,
        concurrencyCap: 3,
        storyRetryCount: 0,
        blockerTimeoutHours: 0,
      },
    },
  },
};

describe('runEpicDeliverPrepare', () => {
  it('snapshots the epic, builds the DAG, initializes the checkpoint, and returns the plan', async () => {
    const epic = { id: 100, labels: ['type::epic', 'epic::auto-close'] };
    const descendants = [
      {
        id: 201,
        number: 201,
        title: 'First story',
        labels: ['type::story'],
        body: '',
      },
      {
        id: 202,
        number: 202,
        title: 'Second story (depends on 201)',
        labels: ['type::story'],
        body: 'blocked by #201',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });

    const out = await runEpicDeliverPrepare({
      epicId: 100,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });

    assert.equal(out.epicId, 100);
    assert.equal(out.autoClose, true, 'autoClose label must be reflected');
    assert.equal(out.totalWaves, 2, 'two waves from 201 → 202 chain');
    assert.equal(out.concurrencyCap, 3);
    assert.equal(out.plan.length, 2);
    assert.deepEqual(
      out.plan[0].stories.map((s) => s.storyId),
      [201],
    );
    assert.deepEqual(
      out.plan[1].stories.map((s) => s.storyId),
      [202],
    );
    assert.ok(typeof out.checkpointInitializedAt === 'string');

    // Checkpoint comment must be persisted on the Epic.
    const epicComments = provider._comments.get(100) ?? [];
    assert.equal(epicComments.length, 1, 'one checkpoint comment');
    assert.ok(
      epicComments[0].body.includes(
        structuredCommentMarker(EPIC_RUN_STATE_TYPE),
      ),
    );
    assert.match(
      epicComments[0].body,
      new RegExp(`"version":\\s*${CHECKPOINT_SCHEMA_VERSION}`),
    );
    assert.match(epicComments[0].body, /"autoClose":\s*true/);
  });

  it('autoClose=false when the label is absent', async () => {
    const epic = { id: 101, labels: ['type::epic'] };
    const descendants = [
      {
        id: 301,
        number: 301,
        title: 'Lonely story',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    const out = await runEpicDeliverPrepare({
      epicId: 101,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(out.autoClose, false);
    assert.equal(out.totalWaves, 1);
  });

  it('throws when the Epic has no child stories', async () => {
    const epic = { id: 102, labels: ['type::epic'] };
    const provider = createFakeProvider({ epic, descendants: [] });
    await assert.rejects(
      runEpicDeliverPrepare({
        epicId: 102,
        injectedProvider: provider,
        injectedConfig: baseConfig,
      }),
      /no child stories to dispatch/,
    );
  });

  it('rejects non-positive epicId', async () => {
    await assert.rejects(
      runEpicDeliverPrepare({ epicId: 0 }),
      /must be a positive integer/,
    );
    await assert.rejects(
      runEpicDeliverPrepare({ epicId: -5 }),
      /must be a positive integer/,
    );
  });
});
