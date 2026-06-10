// tests/wave-record-io-livelock-recovery.test.js
/**
 * Story #3907 — wave-complete livelock recovery in `resolveResolvedResults`.
 *
 * When mode B records a wave with an **empty** `returns` array (the host
 * crashed after the wave's children finished but before `record-wave` ran),
 * the recovery path reconciles every Story in `plan[wave]` from GitHub rather
 * than recording an empty (falsely-`complete`) wave. Confirms:
 *
 *   - `planStoryIdsForWave` extracts the Story IDs for the wave from the
 *     checkpoint plan (tolerating both `number` and `{ id }` entry shapes).
 *   - An empty `returns` + a checkpoint with a planned wave reconciles every
 *     planned Story from GitHub, surfacing the live label state (done /
 *     blocked / failed), not an empty result set.
 *   - An empty `returns` with no resolvable plan degrades to the prior
 *     (empty-result) behaviour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planStoryIdsForWave,
  resolveResolvedResults,
} from '../.agents/scripts/lib/orchestration/wave-record-io.js';

function fakeProvider(ticketsById) {
  return {
    async getTicket(id) {
      return ticketsById.get(id) ?? { id, labels: [], state: 'open' };
    },
    async getTicketComments() {
      return [];
    },
  };
}

describe('planStoryIdsForWave', () => {
  it('extracts ids from a plan with object entries', () => {
    const existing = { plan: [[{ id: 11 }, { id: 12 }], [{ id: 21 }]] };
    assert.deepEqual(planStoryIdsForWave(existing, 0), [11, 12]);
    assert.deepEqual(planStoryIdsForWave(existing, 1), [21]);
  });

  it('extracts ids from a plan with bare-number entries', () => {
    const existing = { plan: [[31, 32]] };
    assert.deepEqual(planStoryIdsForWave(existing, 0), [31, 32]);
  });

  it('returns [] for a missing plan or out-of-range wave', () => {
    assert.deepEqual(planStoryIdsForWave({}, 0), []);
    assert.deepEqual(planStoryIdsForWave({ plan: [[{ id: 1 }]] }, 5), []);
  });
});

describe('resolveResolvedResults — Story #3907 livelock recovery', () => {
  it('reconciles every planned Story from GitHub on an empty returns array', async () => {
    const existing = { plan: [[{ id: 101 }, { id: 102 }]] };
    const provider = fakeProvider(
      new Map([
        [101, { id: 101, labels: ['agent::done'], state: 'closed' }],
        [102, { id: 102, labels: ['agent::blocked'], state: 'open' }],
      ]),
    );

    const { resolvedResults, parseFailures } = await resolveResolvedResults({
      provider,
      epicId: 100,
      wave: 0,
      returns: [],
      existing,
    });

    assert.equal(parseFailures.length, 0);
    const byId = new Map(resolvedResults.map((r) => [r.storyId, r.status]));
    assert.equal(byId.get(101), 'done');
    assert.equal(byId.get(102), 'blocked');
    // Every reconciled row is flagged as GitHub-sourced.
    assert.ok(resolvedResults.every((r) => r.reconciledFromGitHub === true));
  });

  it('degrades to an empty result set when the plan has no resolvable Stories', async () => {
    const provider = fakeProvider(new Map());
    const { resolvedResults, parseFailures } = await resolveResolvedResults({
      provider,
      epicId: 100,
      wave: 0,
      returns: [],
      existing: { plan: [] },
    });
    assert.deepEqual(resolvedResults, []);
    assert.deepEqual(parseFailures, []);
  });
});
