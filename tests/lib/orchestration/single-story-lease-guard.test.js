import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEASE_TTL_MS_DEFAULT } from '../../../.agents/scripts/lib/config/limits.js';
import {
  acquireStoryLease,
  releaseStoryLease,
  resolveOperator,
} from '../../../.agents/scripts/lib/orchestration/single-story-lease-guard.js';
import { decideStoryBranchSeed } from '../../../.agents/scripts/single-story-init.js';

// ---------------------------------------------------------------------------
// Fake ticketing provider — records assignee writes so unit tests can assert
// the side effect without a real GitHub round-trip (testing-standards § Unit:
// mock all I/O).
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
    async getTicket(id) {
      return { id, assignees: [...state.assignees] };
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
const STALE = NOW - (LEASE_TTL_MS_DEFAULT + 1000); // older than the default TTL
const CONFIG = { github: { operatorHandle: '@alice' } };

describe('single-story-lease-guard — resolveOperator', () => {
  it('strips a leading @ from the configured operator handle', () => {
    assert.equal(
      resolveOperator({ github: { operatorHandle: '@alice' } }),
      'alice',
    );
  });

  it('accepts a bare handle without an @', () => {
    assert.equal(resolveOperator({ github: { operatorHandle: 'bob' } }), 'bob');
  });

  it('throws when no operator handle is configured', () => {
    assert.throws(
      () => resolveOperator({ github: {} }),
      /github.operatorHandle is not configured/,
    );
    assert.throws(
      () => resolveOperator({}),
      /operatorHandle is not configured/,
    );
  });
});

describe('single-story-lease-guard — acquireStoryLease', () => {
  it('claims an unassigned Story for the resolved operator', async () => {
    // Arrange
    const provider = makeProvider([]);

    // Act
    const result = await acquireStoryLease({
      provider,
      storyId: 3483,
      config: CONFIG,
      now: NOW,
    });

    // Assert
    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.reason, 'unclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('re-affirms a self-held claim without re-writing assignees', async () => {
    const provider = makeProvider(['alice']);

    const result = await acquireStoryLease({
      provider,
      storyId: 3483,
      config: CONFIG,
      heartbeatAt: FRESH,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'already-held');
    assert.equal(provider.updateCalls.length, 0);
  });

  // AC1: a live foreign claim exits non-zero and names the current owner.
  it('throws and names the owner when a live foreign claim blocks the take', async () => {
    const provider = makeProvider(['bob']);

    await assert.rejects(
      acquireStoryLease({
        provider,
        storyId: 3483,
        config: CONFIG,
        heartbeatAt: FRESH,
        now: NOW,
      }),
      (err) => {
        assert.match(err.message, /Story #3483 is currently held by @bob/);
        return true;
      },
    );
    // The foreign claim must survive — no assignee write happened.
    assert.equal(provider.updateCalls.length, 0);
    assert.deepEqual(provider.state.assignees, ['bob']);
  });

  it('reclaims a stale foreign claim instead of throwing', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireStoryLease({
      provider,
      storyId: 3483,
      config: CONFIG,
      heartbeatAt: STALE,
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'alice');
    assert.equal(result.previousOwner, 'bob');
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('reclaims a foreign claim that never emitted a heartbeat', async () => {
    const provider = makeProvider(['bob']);

    const result = await acquireStoryLease({
      provider,
      storyId: 3483,
      config: CONFIG,
      // no heartbeatAt — treated as stale/reclaimable
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('honours an explicit operator override (bypassing config)', async () => {
    const provider = makeProvider([]);

    const result = await acquireStoryLease({
      provider,
      storyId: 3483,
      config: {},
      operator: 'carol',
      now: NOW,
    });

    assert.equal(result.acquired, true);
    assert.equal(result.owner, 'carol');
    assert.deepEqual(provider.state.assignees, ['carol']);
  });
});

describe('single-story-lease-guard — releaseStoryLease', () => {
  // AC2: clears the Story assignment on successful completion.
  it('clears the assignment when the operator still holds the lease', async () => {
    const provider = makeProvider(['alice']);

    const result = await releaseStoryLease({
      provider,
      storyId: 3483,
      config: CONFIG,
    });

    assert.equal(result.released, true);
    assert.equal(result.owner, null);
    assert.equal(result.reason, 'released');
    assert.deepEqual(provider.updateCalls[0].mutations, { assignees: [] });
    assert.deepEqual(provider.state.assignees, []);
  });

  it('is a no-op when the Story was reassigned to someone else', async () => {
    const provider = makeProvider(['bob']);

    const result = await releaseStoryLease({
      provider,
      storyId: 3483,
      config: CONFIG,
    });

    assert.equal(result.released, false);
    assert.equal(result.reason, 'not-held');
    assert.equal(provider.updateCalls.length, 0);
    // bob's claim survives the stale release
    assert.deepEqual(provider.state.assignees, ['bob']);
  });
});

describe('single-story-init — decideStoryBranchSeed', () => {
  // AC3: an existing story- branch is reused, never re-created.
  it('reuses an existing local branch (never re-creates it)', () => {
    assert.equal(
      decideStoryBranchSeed({ localHas: true, remoteHas: false }),
      'reuse',
    );
    assert.equal(
      decideStoryBranchSeed({ localHas: true, remoteHas: true }),
      'reuse',
    );
  });

  it('fetches a remote-only branch', () => {
    assert.equal(
      decideStoryBranchSeed({ localHas: false, remoteHas: true }),
      'fetch',
    );
  });

  it('creates the branch when neither local nor remote exists', () => {
    assert.equal(
      decideStoryBranchSeed({ localHas: false, remoteHas: false }),
      'create',
    );
  });
});
