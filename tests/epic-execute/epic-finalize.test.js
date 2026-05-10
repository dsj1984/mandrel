import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicFinalize } from '../../.agents/scripts/epic-finalize.js';
import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import { Checkpointer } from '../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {} };
}

/**
 * Fake provider satisfying the surface `runEpicFinalize` exercises:
 * `getTicketComments` / `postComment` / `deleteComment` (Checkpointer +
 * BookendChainer), plus `getTicket` / `updateTicket` for transitionTicketState.
 */
function createFakeProvider({ initialLabels = [] } = {}) {
  let autoId = 1;
  const comments = new Map();
  const tickets = new Map();
  return {
    _comments: comments,
    _tickets: tickets,
    _labelsFor(id) {
      return tickets.get(id)?.labels ?? [];
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
    async getTicket(id) {
      return tickets.get(id) ?? { id, labels: [...initialLabels] };
    },
    async updateTicket(id, updates) {
      const existing = tickets.get(id) ?? {
        id,
        labels: [...initialLabels],
        state: 'open',
      };
      let labels = [...existing.labels];
      if (updates?.labels?.add) {
        for (const l of updates.labels.add) {
          if (!labels.includes(l)) labels.push(l);
        }
      }
      if (updates?.labels?.remove) {
        labels = labels.filter((l) => !updates.labels.remove.includes(l));
      }
      const next = {
        ...existing,
        labels,
        state: updates?.state ?? existing.state,
      };
      tickets.set(id, next);
      return next;
    },
  };
}

async function seedCheckpoint(provider, epicId, autoClose) {
  const cp = new Checkpointer({ provider, epicId });
  return cp.initialize({
    totalWaves: 2,
    concurrencyCap: 2,
    autoClose,
  });
}

describe('runEpicFinalize', () => {
  it('flips Epic to agent::review and posts hand-off when autoClose=false', async () => {
    const provider = createFakeProvider({
      initialLabels: ['type::epic', 'agent::executing'],
    });
    await seedCheckpoint(provider, 100, false);

    const out = await runEpicFinalize({
      epicId: 100,
      injectedProvider: provider,
      injectedConfig: { orchestration: { runners: { deliverRunner: {} } } },
      loggerImpl: quietLogger(),
      // No-project column-sync stub.
      columnSyncImpl: {
        async sync() {
          return { status: 'skipped', reason: 'no-project' };
        },
      },
    });

    assert.equal(out.flipped, true);
    assert.equal(out.autoClose, false);
    assert.equal(out.bookendsExecuted, false);
    assert.equal(out.columnSynced, false, 'sync skipped → columnSynced=false');
    assert.deepEqual(out.remainingSteps, [
      '/epic-code-review',
      'epic-retro helper',
      '/epic-close',
    ]);
    // Epic ticket carries agent::review.
    assert.ok(provider._labelsFor(100).includes(AGENT_LABELS.REVIEW));
    assert.ok(!provider._labelsFor(100).includes(AGENT_LABELS.EXECUTING));
    // Hand-off comment was posted.
    const all = provider._comments.get(100) ?? [];
    const handoff = all.find(
      (c) => /agent::review/.test(c.body) && /epic-code-review/.test(c.body),
    );
    assert.ok(handoff, 'hand-off comment must be posted');
  });

  it('autoClose=true without a runSkill adapter posts the missing-runSkill hand-off', async () => {
    const provider = createFakeProvider({
      initialLabels: ['type::epic', 'agent::executing'],
    });
    await seedCheckpoint(provider, 101, true);

    const out = await runEpicFinalize({
      epicId: 101,
      injectedProvider: provider,
      injectedConfig: { orchestration: { runners: { deliverRunner: {} } } },
      loggerImpl: quietLogger(),
      columnSyncImpl: {
        async sync() {
          return { status: 'synced', column: 'Review' };
        },
      },
    });

    assert.equal(out.autoClose, true);
    assert.equal(out.bookendsExecuted, false, 'CLI never has runSkill adapter');
    assert.equal(out.columnSynced, true);
    // The hand-off body should mention /epic-close as a manual remaining step.
    const all = provider._comments.get(101) ?? [];
    const handoff = all.find((c) => /epic-close/.test(c.body));
    assert.ok(handoff, 'hand-off comment must list /epic-close');
  });

  it('treats missing checkpoint as autoClose=false', async () => {
    const provider = createFakeProvider({
      initialLabels: ['type::epic', 'agent::executing'],
    });
    // No checkpoint seeded.
    const out = await runEpicFinalize({
      epicId: 102,
      injectedProvider: provider,
      injectedConfig: { orchestration: { runners: { deliverRunner: {} } } },
      loggerImpl: quietLogger(),
      columnSyncImpl: {
        async sync() {
          return { status: 'skipped', reason: 'no-project' };
        },
      },
    });
    assert.equal(out.autoClose, false);
    assert.equal(out.flipped, true);
  });

  it('rejects non-positive epicId', async () => {
    await assert.rejects(
      runEpicFinalize({ epicId: 0 }),
      /must be a positive integer/,
    );
  });
});
