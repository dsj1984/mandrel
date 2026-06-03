import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acquireEpicPlanLease,
  assertNoOpenPlanChildren,
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
function makeProvider({ assignees = [], children = [], epic = {} } = {}) {
  const state = { assignees: [...assignees] };
  const updateCalls = [];
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
// acquireEpicPlanLease — fail-closed (audit #3513)
//
// `/epic-plan` emits no story.heartbeat during its run, so there is no
// live-heartbeat source to judge a concurrent plan's liveness from. The guard
// therefore fails closed: ANY foreign assignee is treated as a live claim and
// refuses the take (naming the owner) unless `--steal` transfers it. There is
// no ledger plumbing on this path any more — liveness is anchored to `now`.
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — acquireEpicPlanLease (fail-closed)', () => {
  it('refuses ANY foreign assignee and names the current owner — no heartbeat needed', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });

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
        return true;
      },
    );
    // no assignee mutation when the claim is refused
    assert.equal(provider.updateCalls.length, 0);
  });

  it('transfers a foreign claim when steal is set', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });

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

  it('re-affirms a self-held claim without re-writing', async () => {
    const provider = makeProvider({ assignees: [OPERATOR] });

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    assert.equal(provider.updateCalls.length, 0);
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
    assert.equal(provider.updateCalls.length, 0);
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
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
  it('throws when the Epic has open Feature/Story children and force is absent (AC3)', async () => {
    const provider = makeProvider({
      children: [
        {
          id: 11,
          title: 'Feature A',
          labels: ['type::feature'],
          state: 'open',
        },
        { id: 12, title: 'Story B', labels: ['type::story'], state: 'open' },
      ],
    });

    await assert.rejects(
      assertNoOpenPlanChildren({ provider, epicId: 9, force: false }),
      (err) => {
        assert.match(err.message, /already has 2 open Feature\/Story/);
        assert.match(err.message, /--force/);
        return true;
      },
    );
  });

  it('passes when force is set even with open children', async () => {
    const provider = makeProvider({
      children: [
        {
          id: 11,
          title: 'Feature A',
          labels: ['type::feature'],
          state: 'open',
        },
      ],
    });
    const result = await assertNoOpenPlanChildren({
      provider,
      epicId: 9,
      force: true,
    });
    assert.deepEqual(result.openChildren, []);
  });

  it('passes when the Epic has no open Feature/Story children', async () => {
    const provider = makeProvider({
      children: [
        // context tickets are not Feature/Story — they must not trip the guard
        { id: 13, title: 'PRD', labels: ['context::prd'], state: 'open' },
      ],
    });
    const result = await assertNoOpenPlanChildren({
      provider,
      epicId: 9,
      force: false,
    });
    assert.deepEqual(result.openChildren, []);
  });
});

// ---------------------------------------------------------------------------
// planEpic find-or-create — AC2: re-running reuses linked PRD / Tech Spec
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — context-ticket find-or-create (AC2)', () => {
  /**
   * Provider stub for planEpic: tracks createTicket calls (the duplication we
   * are guarding against) and serves an Epic that already links a PRD + Tech
   * Spec via linkedIssues.
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

  it('reuses the already-linked PRD and Tech Spec instead of creating duplicates', async () => {
    const provider = makePlanProvider({
      prd: 501,
      techSpec: 502,
      acceptanceSpec: null,
    });

    await planEpic(
      9,
      provider,
      { prdContent: 'PRD body', techSpecContent: 'Tech Spec body' },
      {},
      { force: false },
    );

    // No new PRD or Tech Spec issues are created on a re-run.
    assert.equal(provider.createCalls.length, 0);
  });

  it('creates the PRD and Tech Spec when none are linked yet', async () => {
    const provider = makePlanProvider({
      prd: null,
      techSpec: null,
      acceptanceSpec: null,
    });

    await planEpic(
      9,
      provider,
      { prdContent: 'PRD body', techSpecContent: 'Tech Spec body' },
      {},
      { force: false },
    );

    const labels = provider.createCalls.map((c) => c.labels?.[0]);
    assert.ok(labels.includes('context::prd'));
    assert.ok(labels.includes('context::tech-spec'));
  });
});
