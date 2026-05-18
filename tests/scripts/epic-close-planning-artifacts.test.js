/**
 * epic-close-planning-artifacts.test.js — Story #1951
 *
 * Covers the planning-artifact close + Epic-state recovery helpers and
 * their composition in `runEpicCloseTail`. Drives the helpers directly
 * with stub providers and transition functions — no preflight, no
 * provider factory.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicCloseTail } from '../../.agents/scripts/epic-close.js';
import {
  closePlanningArtifacts,
  verifyAndRecoverEpicClose,
} from '../../.agents/scripts/lib/epic-close-tail-helpers.js';
import {
  __resetParentCascadeLocks,
  __setCascadeRetryDelays,
  cascadeCompletion,
} from '../../.agents/scripts/lib/orchestration/ticketing.js';

function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    _lines: lines,
  };
}

describe('closePlanningArtifacts', () => {
  it('closes both PRD and Tech Spec when linked, cascade:false', async () => {
    const calls = [];
    const transitionFn = async (_provider, id, state, opts) => {
      calls.push({ id, state, opts });
    };
    const result = await closePlanningArtifacts({
      epicId: 100,
      epic: { linkedIssues: { prd: 101, techSpec: 102 } },
      provider: {},
      logger: makeLogger(),
      transitionFn,
    });
    assert.equal(result.prd.status, 'closed');
    assert.equal(result.prd.id, 101);
    assert.equal(result.techSpec.status, 'closed');
    assert.equal(result.techSpec.id, 102);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, 101);
    assert.equal(calls[0].opts.cascade, false);
    assert.equal(calls[1].id, 102);
    assert.equal(calls[1].opts.cascade, false);
  });

  it('reports per-ticket partial failure without throwing', async () => {
    const transitionFn = async (_provider, id) => {
      if (id === 102) throw new Error('boom: tech spec transient');
    };
    const logger = makeLogger();
    const result = await closePlanningArtifacts({
      epicId: 100,
      epic: { linkedIssues: { prd: 101, techSpec: 102 } },
      provider: {},
      logger,
      transitionFn,
    });
    assert.equal(result.prd.status, 'closed');
    assert.equal(result.techSpec.status, 'failed');
    assert.match(result.techSpec.detail, /boom/);
    // Failure log surfaced on warn, not error.
    assert.equal(logger._lines.warn.length, 1);
    assert.match(logger._lines.warn[0], /techSpec #102/);
  });

  it('skips when linkedIssues is missing entirely', async () => {
    const calls = [];
    const result = await closePlanningArtifacts({
      epicId: 100,
      epic: null,
      provider: {},
      logger: makeLogger(),
      transitionFn: async (_p, id) => calls.push(id),
    });
    assert.equal(result.prd.status, 'skipped');
    assert.equal(result.techSpec.status, 'skipped');
    assert.equal(calls.length, 0);
  });

  it('dispatches all three transitions in parallel before any resolves (Story #2465)', async () => {
    // Each transitionFn invocation is gated on a per-id deferred; we
    // record the in-flight count when the third call enters. If the
    // helper is serial, the third dispatch only fires after the first
    // resolves, and `maxInFlight` would peak at 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const releasers = [];
    const dispatchedIds = [];
    const transitionFn = (_provider, id) => {
      dispatchedIds.push(id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        releasers.push(() => {
          inFlight -= 1;
          resolve();
        });
      });
    };
    const pending = closePlanningArtifacts({
      epicId: 100,
      epic: {
        linkedIssues: { prd: 101, techSpec: 102, acceptanceSpec: 103 },
      },
      provider: {},
      logger: makeLogger(),
      transitionFn,
    });
    // Let microtasks drain so all three dispatches enter transitionFn
    // before we release any of them.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      maxInFlight,
      3,
      `expected all three transitions to be in flight concurrently, got ${maxInFlight}`,
    );
    assert.deepEqual(dispatchedIds, [101, 102, 103]);
    for (const release of releasers) release();
    const result = await pending;
    // Preserve canonical key order in the returned envelope.
    assert.deepEqual(Object.keys(result), ['prd', 'techSpec', 'acceptanceSpec']);
    assert.equal(result.prd.status, 'closed');
    assert.equal(result.techSpec.status, 'closed');
    assert.equal(result.acceptanceSpec.status, 'closed');
  });

  it('skips when only one of PRD / Tech Spec is linked', async () => {
    const calls = [];
    const result = await closePlanningArtifacts({
      epicId: 100,
      epic: { linkedIssues: { prd: 101, techSpec: null } },
      provider: {},
      logger: makeLogger(),
      transitionFn: async (_p, id) => calls.push(id),
    });
    assert.equal(result.prd.status, 'closed');
    assert.equal(result.techSpec.status, 'skipped');
    assert.equal(result.techSpec.detail, 'no-link');
    assert.deepEqual(calls, [101]);
  });
});

describe('verifyAndRecoverEpicClose', () => {
  it('returns already-closed when Epic state is already closed', async () => {
    const provider = {
      getTicket: async () => ({ state: 'closed' }),
    };
    const transitionCalls = [];
    const result = await verifyAndRecoverEpicClose({
      epicId: 200,
      provider,
      logger: makeLogger(),
      transitionFn: async (_p, id) => transitionCalls.push(id),
    });
    assert.equal(result.status, 'already-closed');
    assert.equal(transitionCalls.length, 0);
  });

  it('fires recovery transition when Epic is still open', async () => {
    const provider = {
      getTicket: async () => ({ state: 'open' }),
    };
    const transitionCalls = [];
    const transitionFn = async (_p, id, state, opts) => {
      transitionCalls.push({ id, state, opts });
    };
    const logger = makeLogger();
    const result = await verifyAndRecoverEpicClose({
      epicId: 200,
      provider,
      logger,
      transitionFn,
    });
    assert.equal(result.status, 'recovered');
    assert.equal(result.priorState, 'open');
    assert.equal(transitionCalls.length, 1);
    assert.equal(transitionCalls[0].id, 200);
    assert.equal(transitionCalls[0].opts.cascade, false);
    assert.match(logger._lines.warn.join('\n'), /still open after PR finalize/);
  });

  it('returns still-open when recovery transition itself throws', async () => {
    const provider = {
      getTicket: async () => ({ state: 'open' }),
    };
    const transitionFn = async () => {
      throw new Error('gh 403');
    };
    const result = await verifyAndRecoverEpicClose({
      epicId: 200,
      provider,
      logger: makeLogger(),
      transitionFn,
    });
    assert.equal(result.status, 'still-open');
    assert.match(result.detail, /gh 403/);
  });

  it('returns check-failed when the snapshot read throws', async () => {
    const provider = {
      getTicket: async () => {
        throw new Error('rate limited');
      },
    };
    const transitionCalls = [];
    const result = await verifyAndRecoverEpicClose({
      epicId: 200,
      provider,
      logger: makeLogger(),
      transitionFn: async () => transitionCalls.push(1),
    });
    assert.equal(result.status, 'check-failed');
    assert.match(result.detail, /rate limited/);
    assert.equal(transitionCalls.length, 0);
  });

  it('calls provider.invalidateTicket before reading when available', async () => {
    const invalidated = [];
    const provider = {
      getTicket: async () => ({ state: 'closed' }),
      invalidateTicket: (id) => invalidated.push(id),
    };
    await verifyAndRecoverEpicClose({
      epicId: 200,
      provider,
      logger: makeLogger(),
      transitionFn: async () => {},
    });
    assert.deepEqual(invalidated, [200]);
  });
});

describe('runEpicCloseTail (idempotency + composition)', () => {
  it('composes planning-close + epic-recovery and returns both envelopes', async () => {
    const provider = {
      getEpic: async () => ({
        id: 300,
        title: 'Test Epic',
        body: 'PRD: #301\nTech Spec: #302',
        linkedIssues: { prd: 301, techSpec: 302 },
      }),
    };
    const planningCalls = [];
    const closePlanningArtifactsFn = async ({ epicId, epic }) => {
      planningCalls.push({ epicId, prd: epic?.linkedIssues?.prd });
      return {
        prd: { id: 301, status: 'closed' },
        techSpec: { id: 302, status: 'closed' },
      };
    };
    const verifyAndRecoverEpicCloseFn = async () => ({
      status: 'recovered',
      priorState: 'open',
    });
    const out = await runEpicCloseTail({
      epicId: 300,
      provider,
      logger: makeLogger(),
      closePlanningArtifactsFn,
      verifyAndRecoverEpicCloseFn,
    });
    assert.equal(out.planningClose.prd.status, 'closed');
    assert.equal(out.epicClose.status, 'recovered');
    assert.equal(planningCalls[0].prd, 301);
  });

  it('is idempotent — running against an already-closed Epic with already-closed planning tickets is a no-op envelope', async () => {
    // Simulate: planning tickets already done (transitionFn no-ops),
    // Epic already closed.
    const provider = {
      getEpic: async () => ({
        id: 300,
        linkedIssues: { prd: 301, techSpec: 302 },
      }),
      getTicket: async () => ({ state: 'closed' }),
    };
    const transitionCalls = [];
    const transitionFn = async (_p, id) => transitionCalls.push(id);
    const out = await runEpicCloseTail({
      epicId: 300,
      provider,
      logger: makeLogger(),
      closePlanningArtifactsFn: (args) =>
        closePlanningArtifacts({ ...args, transitionFn }),
      verifyAndRecoverEpicCloseFn: (args) =>
        verifyAndRecoverEpicClose({ ...args, transitionFn }),
    });
    // Planning transitions did fire (the helper does not pre-check state —
    // transitionTicketState is itself idempotent under the agent::done
    // label) but the Epic state-recovery short-circuits to already-closed.
    assert.equal(out.planningClose.prd.status, 'closed');
    assert.equal(out.planningClose.techSpec.status, 'closed');
    assert.equal(out.epicClose.status, 'already-closed');
    assert.deepEqual(transitionCalls, [301, 302]);
  });

  it('throws TypeError for invalid epicId', async () => {
    await assert.rejects(
      () => runEpicCloseTail({ epicId: 0, provider: {} }),
      /positive integer/,
    );
    await assert.rejects(
      () => runEpicCloseTail({ epicId: 100 }),
      /provider is required/,
    );
  });

  it('cascade no longer excludes planning tickets (Story #1951)', async () => {
    // Regression: a PRD (context::prd) used to short-circuit the cascade.
    // After Story #1951 the cascade closes planning parents the same way
    // it closes Features.
    __resetParentCascadeLocks();
    __setCascadeRetryDelays({ delays: [1, 1, 1], sleep: async () => {} });
    try {
      const tickets = {
        // PRD parent — previously excluded, now eligible.
        500: {
          id: 500,
          labels: ['agent::executing', 'context::prd'],
          body: 'PRD body',
          state: 'open',
        },
        // Story child that already closed and references the PRD.
        501: {
          id: 501,
          labels: ['agent::done', 'type::story'],
          body: 'Story 501\nparent: #500',
          state: 'closed',
        },
      };
      const updateRecords = [];
      const provider = {
        async getTicket(id) {
          return tickets[id];
        },
        async updateTicket(id, mutations) {
          updateRecords.push({ id, mutations });
          if (mutations.labels?.add?.includes('agent::done')) {
            tickets[id] = {
              ...tickets[id],
              labels: ['agent::done', 'context::prd'],
              state: 'closed',
            };
          }
        },
        async postComment() {},
        async getTicketDependencies(id) {
          const t = tickets[id];
          const matches = t?.body
            ? [...t.body.matchAll(/parent:\s*#(\d+)/gi)]
            : [];
          return {
            blocks: matches.map((m) => Number.parseInt(m[1], 10)),
            blockedBy: [],
          };
        },
        async getSubTickets(id) {
          if (id === 500) return [tickets[501]];
          return [];
        },
        invalidateTicket() {},
      };
      const result = await cascadeCompletion(provider, 501);
      assert.deepEqual(result.cascadedTo, [500]);
      assert.deepEqual(result.failed, []);
      const flipped = updateRecords.find((r) => r.id === 500);
      assert.ok(flipped, 'PRD #500 must be updated by the cascade');
      assert.ok(
        flipped.mutations.labels?.add?.includes('agent::done'),
        'PRD #500 must transition to agent::done',
      );
    } finally {
      __setCascadeRetryDelays();
      __resetParentCascadeLocks();
    }
  });

  it('cascade still excludes Epics (Epic exclusion stays)', async () => {
    __resetParentCascadeLocks();
    __setCascadeRetryDelays({ delays: [1, 1, 1], sleep: async () => {} });
    try {
      const tickets = {
        600: {
          id: 600,
          labels: ['agent::executing', 'type::epic'],
          body: 'Epic body',
          state: 'open',
        },
        601: {
          id: 601,
          labels: ['agent::done', 'type::story'],
          body: 'Story 601\nparent: #600',
          state: 'closed',
        },
      };
      const updateRecords = [];
      const provider = {
        async getTicket(id) {
          return tickets[id];
        },
        async updateTicket(id, mutations) {
          updateRecords.push({ id, mutations });
        },
        async postComment() {},
        async getTicketDependencies(id) {
          const t = tickets[id];
          const matches = t?.body
            ? [...t.body.matchAll(/parent:\s*#(\d+)/gi)]
            : [];
          return {
            blocks: matches.map((m) => Number.parseInt(m[1], 10)),
            blockedBy: [],
          };
        },
        async getSubTickets(id) {
          if (id === 600) return [tickets[601]];
          return [];
        },
        invalidateTicket() {},
      };
      const result = await cascadeCompletion(provider, 601);
      assert.deepEqual(result.cascadedTo, []);
      // Epic must NOT have been updated by the cascade.
      assert.equal(
        updateRecords.find((r) => r.id === 600),
        undefined,
      );
    } finally {
      __setCascadeRetryDelays();
      __resetParentCascadeLocks();
    }
  });

  it('falls back to getTicket when provider lacks getEpic', async () => {
    const provider = {
      getTicket: async (id) => ({
        id,
        linkedIssues: { prd: 401, techSpec: 402 },
      }),
    };
    const planningCalls = [];
    const closePlanningArtifactsFn = async ({ epic }) => {
      planningCalls.push(epic?.linkedIssues?.prd);
      return {
        prd: { id: 401, status: 'closed' },
        techSpec: { id: 402, status: 'closed' },
      };
    };
    const verifyAndRecoverEpicCloseFn = async () => ({
      status: 'already-closed',
    });
    await runEpicCloseTail({
      epicId: 400,
      provider,
      logger: makeLogger(),
      closePlanningArtifactsFn,
      verifyAndRecoverEpicCloseFn,
    });
    assert.deepEqual(planningCalls, [401]);
  });
});
