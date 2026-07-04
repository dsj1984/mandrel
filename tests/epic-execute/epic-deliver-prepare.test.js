import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicDeliverPrepare } from '../../.agents/scripts/epic-deliver-prepare.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  EPIC_RUN_STATE_TYPE,
  EPIC_RUN_STATE_TYPE as STORE_TYPE,
} from '../../.agents/scripts/lib/orchestration/epic-run-state-store.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import { tick } from '../../.agents/scripts/lib/wave-runner/tick.js';

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

/** Seed a prior `epic-run-state` checkpoint comment onto the Epic. */
function seedCheckpoint(provider, epicId, state) {
  const fenced = JSON.stringify(
    { version: CHECKPOINT_SCHEMA_VERSION, ...state },
    null,
    2,
  );
  const body = `${structuredCommentMarker(STORE_TYPE)}\n\`\`\`json\n${fenced}\n\`\`\``;
  const list = provider._comments.get(epicId) ?? [];
  list.push({ id: 9000, body });
  provider._comments.set(epicId, list);
}

/** Parse the `epic-run-state` checkpoint currently persisted on the Epic. */
function readPersistedCheckpoint(provider, epicId) {
  const comments = provider._comments.get(epicId) ?? [];
  const checkpoint = comments.find((c) =>
    c.body.includes(structuredCommentMarker(STORE_TYPE)),
  );
  const fenced = checkpoint.body.match(/```json\n([\s\S]+?)\n```/);
  return JSON.parse(fenced[1]);
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
    assert.equal(out.storyCount, 2, 'two open Stories: 201 → 202 chain');
    assert.equal(out.concurrencyCap, 3);
    // The envelope carries a flat dispatch hint (no wave grouping).
    assert.deepEqual(
      out.stories.map((s) => s.storyId).sort((a, b) => a - b),
      [201, 202],
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

    // The checkpoint carries a flat per-Story status map (each seeded at
    // pending), the global cap, and NO wave-batch fields.
    const fenced = epicComments[0].body.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(fenced, 'checkpoint body has a fenced JSON block');
    const persisted = JSON.parse(fenced[1]);
    assert.equal(persisted.concurrencyCap, 3);
    assert.deepEqual(persisted.stories, {
      201: { status: 'pending', title: 'First story' },
      202: {
        status: 'pending',
        title: 'Second story (depends on 201)',
      },
    });
    assert.equal(persisted.plan, undefined, 'no wave plan persisted');
    assert.equal(persisted.currentWave, undefined);
    assert.equal(persisted.totalWaves, undefined);
  });

  it('seeds the checkpoint for a single-story Epic', async () => {
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
    assert.equal(out.storyCount, 1);
    assert.deepEqual(
      out.stories.map((s) => s.storyId),
      [301],
    );
  });

  it('carries no techSpecId even for a legacy body with a Planning Artifacts checklist (Story #4324)', async () => {
    // The Tech Spec is folded into the Epic body — resolveEpicLinkages and
    // the techSpecId envelope field are retired. A historical Epic body that
    // still carries the retired `## Planning Artifacts` checklist must not
    // resurrect the field (or break the prepare) — the legacy content is
    // simply ignored.
    const epic = {
      id: 110,
      labels: ['type::epic', 'acceptance::n-a'],
      body: ['## Planning Artifacts', '', '- [x] Tech Spec: #922'].join('\n'),
    };
    const descendants = [
      {
        id: 401,
        number: 401,
        title: 'Story A',
        labels: ['type::story'],
        body: '',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });
    const out = await runEpicDeliverPrepare({
      epicId: 110,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    assert.equal(out.storyCount, 1);
    assert.ok(
      !('techSpecId' in out),
      'prepare envelope must not carry techSpecId after the #4324 fold',
    );
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

  // ---------------------------------------------------------------------
  // Resume under the ready-set runtime (Story #4155)
  // ---------------------------------------------------------------------

  it('preserves recorded Story statuses across a re-prepare and dispatches the genuinely-ready Story', async () => {
    // A parked run already recorded Story 201 done. On resume the recomputed
    // Story set still contains 201 + 202; the re-prepare must NOT reset 201's
    // recorded status, and the tick must dispatch the genuinely-ready 202
    // (whose only dependency, 201, is done) — no wave pointer involved.
    const epic = { id: 120, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 201,
        number: 201,
        title: 'First',
        labels: ['type::story', 'agent::done'],
        body: '',
        state: 'closed',
      },
      {
        id: 202,
        number: 202,
        title: 'Second (depends on 201)',
        labels: ['type::story', 'agent::ready'],
        body: 'blocked by #201',
        state: 'open',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });

    // Prior checkpoint in the new per-Story-status shape: 201 already done.
    seedCheckpoint(provider, 120, {
      epicId: 120,
      startedAt: '2026-05-01T00:00:00.000Z',
      concurrencyCap: 3,
      phase: 'wave-loop',
      stories: {
        201: { status: 'done', title: 'First' },
        202: { status: 'pending' },
      },
      manualInterventions: [],
    });

    const out = await runEpicDeliverPrepare({
      epicId: 120,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    // The recomputed open set is just the one not-done Story (the DAG drops
    // closed Story 201).
    assert.equal(out.storyCount, 1);

    // Recorded progress survives the merge: 201 stays done (it is preserved
    // from the prior checkpoint even though it is no longer in the open set),
    // 202 stays pending.
    const persisted = readPersistedCheckpoint(provider, 120);
    assert.equal(persisted.stories['201'].status, 'done');
    assert.equal(persisted.stories['202'].status, 'pending');

    // The tick dispatches the genuinely-ready Story #202.
    const result = await tick({
      epic: 120,
      collaborators: { provider },
      ctx: { config: baseConfig },
    });
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [202],
    );
  });

  it('is idempotent on a no-op re-prepare (single checkpoint comment, preserved startedAt)', async () => {
    const epic = { id: 121, labels: ['type::epic', 'acceptance::n-a'] };
    const descendants = [
      {
        id: 301,
        number: 301,
        title: 'A',
        labels: ['type::story'],
        body: '',
        state: 'open',
      },
      {
        id: 302,
        number: 302,
        title: 'B (depends on 301)',
        labels: ['type::story'],
        body: 'blocked by #301',
        state: 'open',
      },
    ];
    const provider = createFakeProvider({ epic, descendants });

    const first = await runEpicDeliverPrepare({
      epicId: 121,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });
    await runEpicDeliverPrepare({
      epicId: 121,
      injectedProvider: provider,
      injectedConfig: baseConfig,
    });

    const epicComments = provider._comments.get(121) ?? [];
    assert.equal(epicComments.length, 1, 'single checkpoint comment');
    const persisted = readPersistedCheckpoint(provider, 121);
    assert.equal(
      persisted.startedAt,
      first.checkpointInitializedAt,
      'startedAt preserved on idempotent re-prepare',
    );
    assert.deepEqual(Object.keys(persisted.stories).sort(), ['301', '302']);
  });
});
