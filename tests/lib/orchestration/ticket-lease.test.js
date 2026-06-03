import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LEASE_TTL_MS_DEFAULT } from '../../../.agents/scripts/lib/config/limits.js';
import {
  acquireLease,
  currentOwner,
  describeLease,
  isClaimLive,
  latestHeartbeatForOwner,
  normalizeOperatorHandle,
  releaseLease,
} from '../../../.agents/scripts/lib/orchestration/ticket-lease.js';

// ---------------------------------------------------------------------------
// Fake ticketing provider — records the assignees writes so unit tests can
// assert the side effect without a real GitHub round-trip (testing-standards
// § Unit: mock all I/O).
// ---------------------------------------------------------------------------

/**
 * @param {string[]} initialAssignees
 */
function makeProvider(initialAssignees = []) {
  const state = { assignees: [...initialAssignees] };
  const updateCalls = [];
  return {
    state,
    updateCalls,
    async getTicket(_id) {
      return { id: _id, assignees: [...state.assignees] };
    },
    async updateTicket(id, mutations) {
      updateCalls.push({ id, mutations });
      if (Array.isArray(mutations?.assignees)) {
        state.assignees = [...mutations.assignees];
      }
    },
  };
}

const NOW = 1_000_000_000_000; // fixed clock
const FRESH = NOW - 1000; // 1s ago — live
const STALE = NOW - (LEASE_TTL_MS_DEFAULT + 1000); // older than TTL — stale

describe('ticket-lease — normalizeOperatorHandle', () => {
  it('strips a single leading @ and trims whitespace', () => {
    assert.equal(normalizeOperatorHandle('@alice'), 'alice');
    assert.equal(normalizeOperatorHandle('  @bob '), 'bob');
    assert.equal(normalizeOperatorHandle('carol'), 'carol');
  });

  it('returns null for empty / whitespace / non-string input', () => {
    assert.equal(normalizeOperatorHandle(''), null);
    assert.equal(normalizeOperatorHandle('   '), null);
    assert.equal(normalizeOperatorHandle('@'), null);
    assert.equal(normalizeOperatorHandle(undefined), null);
    assert.equal(normalizeOperatorHandle(null), null);
    assert.equal(normalizeOperatorHandle(42), null);
  });
});

describe('ticket-lease — currentOwner', () => {
  it('returns the first assignee or null for an empty/absent list', () => {
    assert.equal(currentOwner(['bob', 'carol']), 'bob');
    assert.equal(currentOwner([]), null);
    assert.equal(currentOwner(undefined), null);
    assert.equal(currentOwner(null), null);
  });
});

describe('ticket-lease — latestHeartbeatForOwner', () => {
  let ledgerDir;
  beforeEach(() => {
    ledgerDir = mkdtempSync(path.join(tmpdir(), 'ticket-lease-hb-'));
  });
  afterEach(() => {
    ledgerDir = null;
  });

  function writeLedger(records) {
    const p = path.join(ledgerDir, 'lifecycle.ndjson');
    writeFileSync(p, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return p;
  }

  function heartbeat(operator, timestamp) {
    return {
      kind: 'emitted',
      ts: timestamp,
      event: 'story.heartbeat',
      payload: { event: 'story.heartbeat', timestamp, operator },
    };
  }

  it('returns the most recent heartbeat epoch-ms for the owner', () => {
    const older = new Date(NOW - 5000).toISOString();
    const newer = new Date(NOW - 1000).toISOString();
    const ledgerPath = writeLedger([
      heartbeat('bob', older),
      heartbeat('bob', newer),
      heartbeat('alice', new Date(NOW - 100).toISOString()),
    ]);
    assert.equal(
      latestHeartbeatForOwner({ epicId: 9, owner: 'bob', ledgerPath }),
      Date.parse(newer),
    );
  });

  it('returns null for an absent ledger', () => {
    assert.equal(
      latestHeartbeatForOwner({
        epicId: 9,
        owner: 'bob',
        ledgerPath: path.join(ledgerDir, 'missing.ndjson'),
      }),
      null,
    );
  });

  it('downgrades a corrupt ledger to null instead of throwing', () => {
    const p = path.join(ledgerDir, 'lifecycle.ndjson');
    writeFileSync(p, '{not json\n');
    assert.equal(
      latestHeartbeatForOwner({ epicId: 9, owner: 'bob', ledgerPath: p }),
      null,
    );
  });
});

describe('ticket-lease — isClaimLive', () => {
  it('treats a heartbeat within the TTL as live', () => {
    assert.equal(
      isClaimLive({ heartbeatAt: FRESH, ttlMs: 5000, now: NOW }),
      true,
    );
  });

  it('treats a heartbeat older than the TTL as stale', () => {
    assert.equal(
      isClaimLive({ heartbeatAt: STALE, ttlMs: 5000, now: NOW }),
      false,
    );
  });

  it('treats a missing heartbeat as stale (reclaimable)', () => {
    assert.equal(
      isClaimLive({ heartbeatAt: null, ttlMs: 5000, now: NOW }),
      false,
    );
    assert.equal(
      isClaimLive({ heartbeatAt: undefined, ttlMs: 5000, now: NOW }),
      false,
    );
  });

  // Story #3513 — the TTL boundary is inclusive: a heartbeat exactly `ttlMs`
  // old (`now - heartbeatAt === ttlMs`) is still live (the comparison is `<=`,
  // not `<`). A claim is only stale once it is strictly older than the TTL.
  it('treats a heartbeat exactly at the TTL boundary as live (inclusive)', () => {
    assert.equal(
      isClaimLive({ heartbeatAt: NOW - 5000, ttlMs: 5000, now: NOW }),
      true,
    );
    // One ms past the boundary flips to stale.
    assert.equal(
      isClaimLive({ heartbeatAt: NOW - 5001, ttlMs: 5000, now: NOW }),
      false,
    );
  });
});

describe('ticket-lease — acquireLease', () => {
  // AC1: assigns an unassigned ticket to the operator and returns acquired:true
  it('claims an unassigned ticket and writes the operator to assignees', async () => {
    const provider = makeProvider([]);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.previousOwner, null);
    assert.equal(result.reason, 'unclaimed');
    // assert the assignees write happened
    assert.equal(provider.updateCalls.length, 1);
    assert.deepEqual(provider.updateCalls[0].mutations, {
      assignees: ['alice'],
    });
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('re-affirms a self-held claim without re-writing assignees', async () => {
    const provider = makeProvider(['alice']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: FRESH,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    assert.equal(provider.updateCalls.length, 0);
  });

  // AC2: returns acquired:false with the foreign owner for a live foreign claim
  it('refuses a live foreign claim and reports the foreign owner', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: FRESH,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, false);
    assert.equal(result.owner, 'bob');
    assert.equal(result.reason, 'held');
    assert.equal(provider.updateCalls.length, 0);
    assert.deepEqual(provider.state.assignees, ['bob']);
  });

  // AC3: reclaims and reassigns when the existing claim heartbeat is stale
  it('reclaims a ticket whose foreign claim heartbeat is older than the TTL', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: STALE,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.previousOwner, 'bob');
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.updateCalls[0].mutations, {
      assignees: ['alice'],
    });
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('reclaims a foreign claim that has never emitted a heartbeat', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      // no heartbeatAt — never claimed-alive
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  // AC4: steal:true transfers ownership from a live foreign claim
  it('steals a live foreign claim when steal:true is set', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: FRESH,
      steal: true,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.previousOwner, 'bob');
    assert.equal(result.reason, 'stolen');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  // Story #3513 — `steal:true` only changes the outcome for a *live* foreign
  // claim (it forces the transfer that would otherwise be refused). For every
  // non-live-foreign starting state it is inert: the same path runs as without
  // the flag, and `reason` is NOT `stolen`.
  it('with steal:true on an unassigned ticket, claims it as unclaimed (not stolen)', async () => {
    const provider = makeProvider([]);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      steal: true,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.previousOwner, null);
    assert.equal(result.reason, 'unclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('with steal:true on a self-held claim, re-affirms without re-writing (already-held)', async () => {
    const provider = makeProvider(['alice']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: FRESH,
      steal: true,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    // steal must not force a redundant assignee write on a self-held claim
    assert.equal(provider.updateCalls.length, 0);
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('with steal:true on a stale foreign claim, reports reclaimed (not stolen)', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: STALE,
      steal: true,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.previousOwner, 'bob');
    // a stale claim is reclaimed on its own merits — steal is inert here
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('falls back to the configured TTL when no explicit ttlMs is given', async () => {
    const provider = makeProvider(['bob']);

    // Heartbeat newer than the config-resolved default → still live → no take.
    const result = await acquireLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: NOW - 1000,
      config: { delivery: { lease: { ttlMs: 60_000 } } },
      now: NOW,
    });

    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'held');
  });

  it('rejects a missing provider', async () => {
    await assert.rejects(
      acquireLease({ ticketId: 1, operator: 'alice' }),
      /provider with getTicket/,
    );
  });

  it('rejects a non-positive ticketId', async () => {
    await assert.rejects(
      acquireLease({
        provider: makeProvider(),
        ticketId: 0,
        operator: 'alice',
      }),
      /ticketId must be a positive integer/,
    );
  });

  it('rejects an empty operator', async () => {
    await assert.rejects(
      acquireLease({ provider: makeProvider(), ticketId: 1, operator: '' }),
      /operator must be a non-empty string/,
    );
  });
});

describe('ticket-lease — releaseLease', () => {
  // AC5: clears the assignment when the operator still holds it
  it('clears the assignment when the operator still holds the lease', async () => {
    const provider = makeProvider(['alice']);

    const result = await releaseLease({
      provider,
      ticketId: 42,
      operator: 'alice',
    });

    assert.equal(result.released, true);
    assert.equal(result.owner, null);
    assert.equal(result.reason, 'released');
    assert.deepEqual(provider.updateCalls[0].mutations, { assignees: [] });
    assert.deepEqual(provider.state.assignees, []);
  });

  // AC5: no-op when the ticket was reassigned away from the operator
  it('is a no-op when the ticket was reassigned to someone else', async () => {
    const provider = makeProvider(['bob']);

    const result = await releaseLease({
      provider,
      ticketId: 42,
      operator: 'alice',
    });

    assert.equal(result.released, false);
    assert.equal(result.owner, 'bob');
    assert.equal(result.reason, 'not-held');
    assert.equal(provider.updateCalls.length, 0);
    // bob's claim survives the stale release
    assert.deepEqual(provider.state.assignees, ['bob']);
  });

  it('is a no-op on an already-unassigned ticket', async () => {
    const provider = makeProvider([]);

    const result = await releaseLease({
      provider,
      ticketId: 42,
      operator: 'alice',
    });

    assert.equal(result.released, false);
    assert.equal(result.reason, 'not-held');
    assert.equal(provider.updateCalls.length, 0);
  });
});

describe('ticket-lease — describeLease', () => {
  it('reports an unclaimed ticket without mutating it', async () => {
    const provider = makeProvider([]);

    const snapshot = await describeLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      ttlMs: 5000,
      now: NOW,
    });

    assert.deepEqual(snapshot, {
      ticketId: 42,
      owner: null,
      heldByOperator: false,
      live: false,
      ttlMs: 5000,
    });
    assert.equal(provider.updateCalls.length, 0);
  });

  it('reports a live foreign claim', async () => {
    const provider = makeProvider(['bob']);

    const snapshot = await describeLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: FRESH,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(snapshot.owner, 'bob');
    assert.equal(snapshot.heldByOperator, false);
    assert.equal(snapshot.live, true);
  });

  it('reports a self-held claim', async () => {
    const provider = makeProvider(['alice']);

    const snapshot = await describeLease({
      provider,
      ticketId: 42,
      operator: 'alice',
      heartbeatAt: FRESH,
      ttlMs: 5000,
      now: NOW,
    });

    assert.equal(snapshot.heldByOperator, true);
    assert.equal(snapshot.live, true);
  });
});
