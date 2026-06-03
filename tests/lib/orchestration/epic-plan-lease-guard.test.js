import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LEASE_TTL_MS_DEFAULT } from '../../../.agents/scripts/lib/config/limits.js';
import {
  acquireEpicPlanLease,
  assertNoOpenPlanChildren,
  latestHeartbeatForOwner,
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
const FRESH_TS = new Date(NOW - 1000).toISOString();
const STALE_TS = new Date(NOW - (LEASE_TTL_MS_DEFAULT + 1000)).toISOString();

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

let ledgerDir;
beforeEach(() => {
  ledgerDir = mkdtempSync(path.join(tmpdir(), 'epic-plan-lease-'));
});
afterEach(() => {
  ledgerDir = null;
});

function writeLedger(records) {
  const p = path.join(ledgerDir, 'lifecycle.ndjson');
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(p, `${text}\n`, 'utf8');
  return p;
}

function heartbeatRecord({ operator, timestamp }) {
  return {
    kind: 'emitted',
    ts: timestamp,
    event: 'story.heartbeat',
    payload: {
      event: 'story.heartbeat',
      storyId: 1,
      epicId: 9,
      phase: 'implementing',
      timestamp,
      operator,
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

  it('returns null when github.operatorHandle is unset', () => {
    assert.equal(resolveOperator({ github: {} }), null);
  });
});

// ---------------------------------------------------------------------------
// latestHeartbeatForOwner
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — latestHeartbeatForOwner', () => {
  it('returns the most recent heartbeat epoch-ms for the owner', () => {
    const older = new Date(NOW - 5000).toISOString();
    const newer = new Date(NOW - 1000).toISOString();
    const ledgerPath = writeLedger([
      heartbeatRecord({ operator: FOREIGN, timestamp: older }),
      heartbeatRecord({ operator: FOREIGN, timestamp: newer }),
      heartbeatRecord({ operator: OPERATOR, timestamp: FRESH_TS }),
    ]);

    const result = latestHeartbeatForOwner({
      epicId: 9,
      owner: FOREIGN,
      ledgerPath,
    });
    assert.equal(result, Date.parse(newer));
  });

  it('returns null when no heartbeat exists for the owner', () => {
    const ledgerPath = writeLedger([
      heartbeatRecord({ operator: OPERATOR, timestamp: FRESH_TS }),
    ]);
    assert.equal(
      latestHeartbeatForOwner({ epicId: 9, owner: FOREIGN, ledgerPath }),
      null,
    );
  });

  it('returns null when the ledger file is absent', () => {
    assert.equal(
      latestHeartbeatForOwner({
        epicId: 9,
        owner: FOREIGN,
        ledgerPath: path.join(ledgerDir, 'does-not-exist.ndjson'),
      }),
      null,
    );
  });

  it('downgrades a corrupt ledger to null rather than throwing', () => {
    const p = path.join(ledgerDir, 'lifecycle.ndjson');
    writeFileSync(p, '{not valid json\n', 'utf8');
    assert.equal(
      latestHeartbeatForOwner({ epicId: 9, owner: FOREIGN, ledgerPath: p }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// acquireEpicPlanLease — AC1: live foreign claim exits non-zero, names owner
// ---------------------------------------------------------------------------

describe('epic-plan-lease-guard — acquireEpicPlanLease', () => {
  it('refuses a live foreign claim and names the current owner (AC1)', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });
    const ledgerPath = writeLedger([
      heartbeatRecord({ operator: FOREIGN, timestamp: FRESH_TS }),
    ]);

    await assert.rejects(
      acquireEpicPlanLease({
        provider,
        epicId: 9,
        config: CONFIG,
        now: NOW,
        ledgerPath,
      }),
      (err) => {
        assert.match(err.message, /claimed by 'bob'/);
        assert.match(err.message, /#9/);
        return true;
      },
    );
    // no assignee mutation when the claim is refused
    assert.equal(provider.updateCalls.length, 0);
  });

  it('claims an unassigned Epic', async () => {
    const provider = makeProvider({ assignees: [] });
    const ledgerPath = writeLedger([]);

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
      ledgerPath,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, OPERATOR);
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });

  it('reclaims an Epic whose foreign claim heartbeat is stale', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });
    const ledgerPath = writeLedger([
      heartbeatRecord({ operator: FOREIGN, timestamp: STALE_TS }),
    ]);

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
      ledgerPath,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, [OPERATOR]);
  });

  it('degrades to a no-op when no operator is configured', async () => {
    const provider = makeProvider({ assignees: [FOREIGN] });
    const ledgerPath = writeLedger([
      heartbeatRecord({ operator: FOREIGN, timestamp: FRESH_TS }),
    ]);

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: { github: {} },
      now: NOW,
      ledgerPath,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'no-operator');
    // no assignee mutation when the lease cannot be keyed
    assert.equal(provider.updateCalls.length, 0);
  });

  it('re-affirms a self-held claim without re-writing', async () => {
    const provider = makeProvider({ assignees: [OPERATOR] });
    const ledgerPath = writeLedger([
      heartbeatRecord({ operator: OPERATOR, timestamp: FRESH_TS }),
    ]);

    const result = await acquireEpicPlanLease({
      provider,
      epicId: 9,
      config: CONFIG,
      now: NOW,
      ledgerPath,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    assert.equal(provider.updateCalls.length, 0);
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
