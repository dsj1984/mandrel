import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acquireEpicPlanLease,
  assertNoOpenPlanChildren,
  buildPlanLeaseCommentBody,
  parsePlanLeaseClaim,
  releaseEpicPlanLease,
  resolveOperator,
} from '../../../.agents/scripts/lib/orchestration/epic-plan-lease-guard.js';
import { planEpic } from '../../../.agents/scripts/lib/orchestration/epic-plan-spec/phases/plan-epic.js';

// ---------------------------------------------------------------------------
// Test doubles. testing-standards § Unit: mock all I/O — these fakes record
// the mutations a real GitHub provider would issue without a network round
// trip. Each test owns its own provider so suites parallelize safely.
// ---------------------------------------------------------------------------

const OPERATOR = 'alice';
const FOREIGN = 'bob';
const CONFIG = { github: { operatorHandle: OPERATOR } };
const NOW = 1_000_000_000_000;

/**
 * Fake provider exposing the lease/guard surface: getTicket (assignees),
 * updateTicket (records assignee writes), getEpic, getTickets (children).
 */
const PLAN_LEASE_MARKER = '<!-- ap:structured-comment type="plan-lease" -->';

function makeProvider({
  assignees = [],
  children = [],
  epic = {},
  comments = [],
} = {}) {
  const state = { assignees: [...assignees], comments: [...comments] };
  const updateCalls = [];
  let nextCommentId = 100;
  return {
    state,
    updateCalls,
    async getTicket(id) {
      return { id, assignees: [...state.assignees] };
    },
    async updateTicket(id, mutations) {
      updateCalls.push({ id, mutations });
      if (Array.isArray(mutations?.assignees)) {
        state.assignees = [...mutations.assignees];
      }
    },
    async getEpic(id) {
      return {
        id,
        title: 'Epic',
        body: 'body',
        labels: ['type::epic'],
        ...epic,
      };
    },
    async getSubTickets(_epicId) {
      return children;
    },
    // Structured-comment surface for the plan-lease claim record.
    async getTicketComments(_ticketId) {
      return [...state.comments];
    },
    async postComment(_ticketId, payload) {
      const id = nextCommentId++;
      state.comments.push({ id, body: payload.body });
      return { id };
    },
    async deleteComment(id) {
      state.comments = state.comments.filter((c) => c.id !== id);
    },
  };
}

/** Seed a marker-annotated plan-lease comment as the real upsert writes it. */
function planLeaseComment({ epicId = 9, owner, claimedAtMs }) {
  return {
    id: 1,
    body: `${PLAN_LEASE_MARKER}\n\n${buildPlanLeaseCommentBody({
      epicId,
      owner,
      claimedAt: new Date(claimedAtMs).toISOString(),
    })}`,
  };
}

// ---------------------------------------------------------------------------
// resolveOperator
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — resolveOperator', () => {
  it('returns the configured operator handle', () => {
    assert.equal(resolveOperator(CONFIG), OPERATOR);
  });

  it('strips a leading @ so the value matches the bare assignee login', () => {
    // GitHub rejects an `@`-prefixed assignee (HTTP 422) and the
    // self-held-claim comparison `owner === operator` would never match a
    // bare login from `assignees`. Mirror the sibling lease guards.
    assert.equal(
      resolveOperator({ github: { operatorHandle: '@alice' } }),
      'alice',
    );
  });

  it('returns null when github.operatorHandle is unset', () => {
    assert.equal(resolveOperator({ github: {} }), null);
  });
});

// ---------------------------------------------------------------------------
// acquireEpicPlanLease — claim-time liveness (Story #4019)
//
// `/plan` emits no story.heartbeat, so the lease records its own
// claim-time in a `plan-lease` structured comment at acquire time. A foreign
// claim fresher than the lease TTL (default 15 min) refuses unless `--steal`;
// a stale or record-less claim is reclaimed automatically — which is what
// makes the documented `--steal` contract decidable.
// ---------------------------------------------------------------------------

const TTL_MS = 900_000; // LEASE_TTL_MS_DEFAULT

describe('epic-plan-lease-guard — acquireEpicPlanLease (claim-time liveness)', () => {
  it('refuses a foreign claim whose recorded claim-time is within the TTL', async () => {
    const provider = makeProvider({
      assignees: [FOREIGN],
      comments: [
        planLeaseComment({ owner: FOREIGN, claimedAtMs: NOW - 60_000 }),
      ],
    });

    await assert.rejects(
      acquireEpicPlanLease({
        provider,
        epicId: 9,
        config: CONFIG,
        now: NOW,
      }),
      (err) => {
        assert.match(err.message, /claimed by 'bob'/);
        assert.match(err.message, /#9/);
        assert.match(err.message, /--steal/);
        assert.match(err.message, /minute\(s\) old/);
        return true;
      },
    );
    // no assignee mutation when the claim is refused
    assert.equal(provider.updateCalls.length, 0);
  });

  it('reclaims a foreign claim whose claim-time is older than the TTL', async () => {
    const provider = makeProvider({
      assignees: [FOREIGN],
      comments: [
        planLeaseComment({ owner: FOREIGN, claimedAtMs: NOW - TTL_MS - 1 }),
      ],
    });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });

  it('reclaims a foreign claim with no plan-lease record (nothing to wait on)', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });

  it('ignores a plan-lease record naming a different owner than the assignee', async () => {
    const provider = makeProvider({
      assignees: [FOREIGN],
      comments: [
        planLeaseComment({ owner: 'carol', claimedAtMs: NOW - 1_000 }),
      ],
    });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
  });

  it('transfers a live foreign claim when steal is set', async () => {
    const provider = makeProvider({
      assignees: [FOREIGN],
      comments: [
        planLeaseComment({ owner: FOREIGN, claimedAtMs: NOW - 60_000 }),
      ],
    });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      steal: true,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'stolen');
    assert.equal(result.previousOwner, FOREIGN);
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });

  it('records the claim-time on acquire (the liveness signal /plan emits)', async () => {
    const provider = makeProvider({ assignees: [] });

    await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    const leaseComments = provider.state.comments.filter((c) =>
      c.body.includes(PLAN_LEASE_MARKER),
    );
    assert.equal(leaseComments.length, 1);
    const claim = parsePlanLeaseClaim(leaseComments[0].body);
    assert.ok(claim);
    assert.equal(claim.owner, OPERATOR);
    assert.equal(claim.claimedAtMs, NOW);
  });

  it('claims an unassigned Epic', async () => {
    const provider = makeProvider({ assignees: [] });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'unclaimed');
    assert.equal(result.owner, OPERATOR);
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });

  it('fails closed (throws) when no operator is configured', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });

    await assert.rejects(
      acquireEpicPlanLease({
        provider,
        epicId: 9,
        config: { github: {} },
        now: NOW,
      }),
      /no operator identity is configured/,
    );
    // no assignee mutation when the lease cannot be keyed
    assert.equal(provider.updateCalls.length, 0);
  });

  it('fails closed when operatorHandle is still the @[USERNAME] placeholder', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });

    await assert.rejects(
      acquireEpicPlanLease({
        provider,
        epicId: 9,
        config: { github: { operatorHandle: '@[USERNAME]' } },
        now: NOW,
      }),
      /placeholder/,
    );
    assert.equal(provider.updateCalls.length, 0);
  });

  it('re-affirms a self-held claim without re-writing assignees', async () => {
    const provider = makeProvider({ assignees: [OPERATOR] });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    assert.equal(
      provider.updateCalls.filter((c) => c.mutations?.assignees).length,
      0,
    );
  });

  // Audit #3513 — the '@'-strip bug: when operatorHandle carries a leading
  // '@' but the assignee is the bare login, the self-held lease must still
  // match (owner === operator) and re-affirm without re-writing — not refuse
  // or reclaim its own claim.
  it('recognizes a self-held lease when operatorHandle has a leading @', async () => {
    // Assignee is the BARE login; operatorHandle carries the '@' prefix.
    const provider = makeProvider({ assignees: [OPERATOR] });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: { github: { operatorHandle: `@${OPERATOR}` } },
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    assert.equal(
      provider.updateCalls.filter((c) => c.mutations?.assignees).length,
      0,
    );
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });
});

describe('epic-plan-lease-guard — parsePlanLeaseClaim', () => {
  it('round-trips the body buildPlanLeaseCommentBody renders', () => {
    const body = buildPlanLeaseCommentBody({
      epicId: 9,
      owner: 'alice',
      claimedAt: '2026-06-11T10:00:00.000Z',
    });
    const claim = parsePlanLeaseClaim(body);
    assert.deepEqual(claim, {
      owner: 'alice',
      claimedAtMs: Date.parse('2026-06-11T10:00:00.000Z'),
    });
  });

  it('returns null for a body with no readable record', () => {
    assert.equal(parsePlanLeaseClaim('no json here'), null);
    assert.equal(parsePlanLeaseClaim(null), null);
    assert.equal(parsePlanLeaseClaim('```json\n{"kind":"other"}\n```'), null);
  });
});

// ---------------------------------------------------------------------------
// releaseEpicPlanLease
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — releaseEpicPlanLease', () => {
  it('clears the assignment when the operator holds it', async () => {
    const provider = makeProvider({ assignees: [OPERATOR] });
    const result = await releaseEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
    });
    assert.equal(result.released, true);
    assert.deepEqual(provider.state.assignees, []);
  });

  it('is a best-effort no-op when reassigned elsewhere', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });
    const result = await releaseEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
    });
    assert.equal(result.released, false);
    assert.deepEqual(provider.state.assignees, [FOREIGN]);
  });

  it('skips (does not throw) when no operator is configured', async () => {
    const provider = makeProvider({ assignees: [OPERATOR] });
    const result = await releaseEpicPlanLease({
      provider,
      epicId: 9,
      config: { github: {} },
    });
    assert.equal(result.released, false);
    assert.equal(result.reason, 'no-operator');
  });
});

// ---------------------------------------------------------------------------
// assertNoOpenPlanChildren — AC3: refuse persist on open children sans --force
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — assertNoOpenPlanChildren', () => {
  it('throws when the Epic has open Story children and force is absent (AC3)', async () => {
    const provider = makeProvider({
      children: [
        { id: 11, title: 'Story A', labels: ['type::story'], state: 'open' },
        { id: 12, title: 'Story B', labels: ['type::story'], state: 'open' },
      ],
    });

    await assert.rejects(
      assertNoOpenPlanChildren({ provider, epicId: 9, force: false }),
      (err) => {
        assert.match(err.message, /already has 2 open plan child/);
        assert.match(err.message, /--force/);
        return true;
      },
    );
  });

  it('throws with a migration hint when the Epic has open legacy Feature children', async () => {
    const provider = makeProvider({
      children: [
        {
          id: 21,
          title: 'Legacy Feature',
          labels: ['type::feature'],
          state: 'open',
        },
        { id: 22, title: 'Story C', labels: ['type::story'], state: 'open' },
      ],
    });

    await assert.rejects(
      assertNoOpenPlanChildren({ provider, epicId: 9, force: false }),
      (err) => {
        assert.match(err.message, /already has 2 open plan child/);
        assert.match(err.message, /#21 Legacy Feature/);
        assert.match(err.message, /not type::story/);
        assert.match(err.message, /legacy pre-v4 Feature/);
        assert.match(err.message, /v1\.60\.0 migration notes/);
        return true;
      },
    );
  });

  it('passes when force is set even with open children', async () => {
    const provider = makeProvider({
      children: [
        { id: 11, title: 'Story A', labels: ['type::story'], state: 'open' },
      ],
    });
    const result = await assertNoOpenPlanChildren({
      provider,
      epicId: 9,
      force: true,
    });
    assert.deepEqual(result.openChildren, []);
  });

  it('passes when the Epic has no open Story children', async () => {
    const provider = makeProvider({
      children: [
        // context tickets are not Stories — they must not trip the guard
        {
          id: 13,
          title: 'Tech Spec',
          labels: ['context::tech-spec'],
          state: 'open',
        },
      ],
    });
    const result = await assertNoOpenPlanChildren({
      provider,
      epicId: 9,
      force: false,
    });
    assert.deepEqual(result.openChildren, []);
  });

  it('does not count context tickets that also carry type::story (Story #4246)', async () => {
    // Regression: createTicket's default-label injection stamps the three
    // context spec tickets with type::story alongside their context:: label.
    // On a FIRST decompose these are the only open children — the guard must
    // exclude them (by their context:: label) rather than refuse persist.
    const provider = makeProvider({
      children: [
        {
          id: 14,
          title: 'Tech Spec',
          labels: ['type::story', 'context::tech-spec'],
          state: 'open',
        },
        {
          id: 15,
          title: 'Acceptance Spec',
          labels: ['type::story', 'context::acceptance-spec'],
          state: 'open',
        },
      ],
    });
    const result = await assertNoOpenPlanChildren({
      provider,
      epicId: 9,
      force: false,
    });
    assert.deepEqual(result.openChildren, []);
  });

  it('still refuses real Stories even when context tickets are present (Story #4246)', async () => {
    // The context exclusion must not blind the guard to a genuine open Story
    // sitting alongside the context tickets on a re-decompose.
    const provider = makeProvider({
      children: [
        {
          id: 13,
          title: 'Tech Spec',
          labels: ['type::story', 'context::tech-spec'],
          state: 'open',
        },
        { id: 16, title: 'Story A', labels: ['type::story'], state: 'open' },
      ],
    });
    await assert.rejects(
      assertNoOpenPlanChildren({ provider, epicId: 9, force: false }),
      (err) => {
        assert.match(err.message, /already has 1 open plan child/);
        assert.match(err.message, /#16 Story A/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// planEpic find-or-create — AC2: re-running reuses the linked Tech Spec
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — context-ticket find-or-create (AC2)', () => {
  /**
   * Provider stub for planEpic: tracks createTicket calls (the duplication we
   * are guarding against) and serves an Epic that already links a Tech Spec
   * via linkedIssues.
   */
  function makePlanProvider(linkedIssues) {
    const createCalls = [];
    return {
      createCalls,
      primeTicketCache() {},
      async getEpic(id) {
        return {
          id,
          title: 'Demo Epic',
          body: 'Epic body',
          labels: ['type::epic', 'acceptance::n-a'],
          linkedIssues,
        };
      },
      async createTicket(_parentId, ticketData) {
        const id = 1000 + createCalls.length;
        createCalls.push(ticketData);
        return { id, url: `https://example/${id}` };
      },
      async updateTicket() {},
      async postComment() {
        return { commentId: 1 };
      },
      async removeSubIssue() {},
      async getTickets() {
        return [];
      },
    };
  }

  it('reuses the already-linked Tech Spec instead of creating a duplicate', async () => {
    const provider = makePlanProvider({
      techSpec: 502,
      acceptanceSpec: null,
    });

    await planEpic(
      9,
      provider,
      { techSpecContent: 'Tech Spec body' },
      {},
      { force: false },
    );

    // No new Tech Spec issue is created on a re-run.
    assert.equal(provider.createCalls.length, 0);
  });

  it('creates the Tech Spec when none is linked yet', async () => {
    const provider = makePlanProvider({
      techSpec: null,
      acceptanceSpec: null,
    });

    await planEpic(
      9,
      provider,
      { techSpecContent: 'Tech Spec body' },
      {},
      { force: false },
    );

    const labels = provider.createCalls.map((c) => c.labels?.[0]);
    assert.ok(!labels.includes('context::prd'));
    assert.ok(labels.includes('context::tech-spec'));
  });
});
