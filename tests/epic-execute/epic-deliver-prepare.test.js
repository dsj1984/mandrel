import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicDeliverPrepare } from '../../.agents/scripts/epic-deliver-prepare.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  EPIC_RUN_STATE_TYPE,
} from '../fixtures/epic-run-state-store.js';

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
  // Minimal github block — runEpicDeliverPrepare throws when
  // `config.github` is missing (Epic #2880 removed the legacy
  // resolver shim that used to synthesize it for unit-test fixtures).
  github: { owner: 'test-owner', repo: 'test-repo' },
  orchestration: {
    runners: {
      deliverRunner: {
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
    const epic = { id: 100, labels: ['type::epic', 'acceptance::n-a'] };
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

    // The plan must be persisted on the checkpoint in the shape wave-tick
    // expects (`Array<Array<{ storyId, title?, worktree? }>>`). Without
    // this write the tick reports every wave as `wave-complete: empty`.
    const fenced = epicComments[0].body.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(fenced, 'checkpoint body has a fenced JSON block');
    const persisted = JSON.parse(fenced[1]);
    assert.ok(Array.isArray(persisted.plan), 'persisted plan is an array');
    assert.equal(persisted.plan.length, 2);
    assert.deepEqual(
      persisted.plan[0].map((s) => s.storyId),
      [201],
    );
    assert.deepEqual(
      persisted.plan[1].map((s) => s.storyId),
      [202],
    );
  });

  it('builds the plan for a single-story Epic', async () => {
    const epic = { id: 101, labels: ['type::epic', 'acceptance::n-a'] };
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
    assert.equal(out.totalWaves, 1);
  });

  it('throws when the Epic has no child stories', async () => {
    const epic = { id: 102, labels: ['type::epic', 'acceptance::n-a'] };
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

  // ---------------------------------------------------------------------
  // Concurrency-hazard gate (Story #2297)
  // ---------------------------------------------------------------------

  it('proceeds when injected findings are advisory-only (severity soft)', async () => {
    const epic = { id: 110, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 401,
        number: 401,
        title: 'Story',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    const out = await runEpicDeliverPrepare({
      epicId: 110,
      injectedProvider: provider,
      injectedConfig: baseConfig,
      injectedFindings: [
        { kind: 'shared-editor', storySlugs: ['401'], severity: 'soft' },
      ],
    });
    assert.equal(out.concurrencyHazardsBypassed, false);
  });

  it('throws when a hard-severity finding touches a pending Story', async () => {
    const epic = { id: 111, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 501,
        number: 501,
        title: 'Story',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    await assert.rejects(
      runEpicDeliverPrepare({
        epicId: 111,
        injectedProvider: provider,
        injectedConfig: baseConfig,
        injectedFindings: [
          {
            kind: 'shared-editor',
            path: '.github/workflows/quality.yml',
            storySlugs: ['501'],
            severity: 'hard',
          },
        ],
      }),
      /Refusing to flip Epic/,
    );
  });

  it('proceeds when --ignore-concurrency-hazards bypasses a hard-severity finding', async () => {
    const epic = { id: 112, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 601,
        number: 601,
        title: 'Story',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    const out = await runEpicDeliverPrepare({
      epicId: 112,
      injectedProvider: provider,
      injectedConfig: baseConfig,
      injectedFindings: [
        {
          kind: 'shared-editor',
          path: '.github/workflows/quality.yml',
          storySlugs: ['601'],
          severity: 'hard',
        },
      ],
      ignoreConcurrencyHazards: true,
    });
    assert.equal(out.concurrencyHazardsBypassed, true);

    // The bypass MUST be persisted on the checkpoint so retro tooling can
    // flag a run that shipped despite an outstanding hazard.
    const epicComments = provider._comments.get(112) ?? [];
    const fenced = epicComments[0].body.match(/```json\n([\s\S]+?)\n```/);
    const persisted = JSON.parse(fenced[1]);
    assert.equal(persisted.ignoreConcurrencyHazards, true);
  });

  it('drops findings whose Stories are all agent::done before gating', async () => {
    const epic = { id: 113, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 701,
        number: 701,
        title: 'Already finished',
        labels: ['type::story', 'agent::done'],
        body: '',
      },
      {
        id: 702,
        number: 702,
        title: 'Pending',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    // Finding references only the already-done Story — should be filtered.
    const out = await runEpicDeliverPrepare({
      epicId: 113,
      injectedProvider: provider,
      injectedConfig: baseConfig,
      injectedFindings: [
        {
          kind: 'shared-editor',
          path: '.github/workflows/quality.yml',
          storySlugs: ['701'],
          severity: 'hard',
        },
      ],
    });
    assert.equal(out.concurrencyHazardsBypassed, false);
  });

  it('trips on advisory findings when delivery.failOnConcurrencyHazards is true', async () => {
    const epic = { id: 114, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 801,
        number: 801,
        title: 'Story',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    await assert.rejects(
      runEpicDeliverPrepare({
        epicId: 114,
        injectedProvider: provider,
        injectedConfig: {
          ...baseConfig,
          delivery: { failOnConcurrencyHazards: true },
        },
        injectedFindings: [
          {
            kind: 'shared-editor',
            path: '.github/workflows/quality.yml',
            storySlugs: ['801'],
            severity: 'soft',
          },
        ],
      }),
      /Refusing to flip Epic/,
    );
  });
});
