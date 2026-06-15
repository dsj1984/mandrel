/**
 * wave-tick-fresh-fetch.test.js
 *
 * Story #3026 / refreshed by Story #4155 — verifies the ready-set tick
 * fetches Story labels without `{ fresh: true }` for the cache-warm path and
 * only force-refreshes Stories the lifecycle ledger reports as in-flight
 * (dispatched without a matching end). A Story whose label may have flipped
 * since the last beat is exactly the in-flight one, so it is read fresh; every
 * other Story serves from the provider's in-process cache.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tick } from '../.agents/scripts/lib/wave-runner/tick.js';

function checkpoint(storyIds, concurrencyCap = 3) {
  const stories = {};
  for (const id of storyIds) stories[String(id)] = { status: 'pending' };
  return { epicId: 9000, concurrencyCap, stories };
}

function makeProvider({ tickets } = {}) {
  const calls = [];
  return {
    calls,
    async getTicket(id, opts = {}) {
      calls.push({ id, opts: { ...opts } });
      return tickets[id] ?? null;
    },
  };
}

const STORY_TICKETS = {
  1001: {
    id: 1001,
    title: 'In-flight Story',
    labels: ['agent::ready'],
    body: '',
  },
  1002: { id: 1002, title: 'Other Story', labels: ['agent::ready'], body: '' },
};

describe('wave-runner tick fresh-fetch policy', () => {
  it('fetches all Stories with {} when none are in flight', async () => {
    const provider = makeProvider({ tickets: STORY_TICKETS });

    await tick({
      epic: 9000,
      collaborators: {
        provider,
        epicRunStateStore: { read: async () => checkpoint([1001, 1002]) },
        inFlightReader: async () => [],
        recurringFailureReporter: async () => {},
      },
    });

    const byId = new Map(provider.calls.map((c) => [c.id, c.opts]));
    assert.deepEqual(byId.get(1001), {});
    assert.deepEqual(byId.get(1002), {});
  });

  it('keeps {fresh:true} only for Stories reported in-flight by the ledger', async () => {
    const provider = makeProvider({ tickets: STORY_TICKETS });

    await tick({
      epic: 9000,
      collaborators: {
        provider,
        epicRunStateStore: { read: async () => checkpoint([1001, 1002]) },
        inFlightReader: async () => [1001],
        recurringFailureReporter: async () => {},
      },
    });

    const byId = new Map(provider.calls.map((c) => [c.id, c.opts]));
    assert.deepEqual(byId.get(1001), { fresh: true });
    assert.deepEqual(byId.get(1002), {});
  });

  it('cache-warms every Story when the ledger is silent (cold start)', async () => {
    const provider = makeProvider({ tickets: STORY_TICKETS });

    await tick({
      epic: 9000,
      collaborators: {
        provider,
        epicRunStateStore: { read: async () => checkpoint([1001]) },
        inFlightReader: async () => [],
        recurringFailureReporter: async () => {},
      },
    });

    assert.deepEqual(provider.calls[0].opts, {});
  });
});
