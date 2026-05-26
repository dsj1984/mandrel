/**
 * wave-tick-fresh-fetch.test.js
 *
 * Story #3026 — verifies the wave-runner tick fetches Story labels
 * without `{ fresh: true }` for the cache-warm path and only force-
 * refreshes Stories that the checkpoint flagged as halted on a prior
 * wave (mirroring `iterate-waves`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tick } from '../.agents/scripts/lib/wave-runner/tick.js';

function makeCheckpoint({ haltedStoryIds = [] } = {}) {
  return {
    currentWave: 0,
    totalWaves: 1,
    plan: [[1001, 1002]],
    waves: [
      {
        index: 0,
        status: 'halted',
        stories: haltedStoryIds.map((id) => ({ storyId: id })),
      },
    ],
  };
}

function makeProvider({ tickets } = {}) {
  const calls = [];
  return {
    calls,
    async getTicket(id, opts = {}) {
      calls.push({ id, opts: { ...opts } });
      const ticket = tickets[id];
      if (!ticket) return null;
      return ticket;
    },
  };
}

const STORY_TICKETS = {
  1001: { id: 1001, title: 'Halted Story', labels: ['agent::executing'] },
  1002: { id: 1002, title: 'Fresh Story', labels: ['agent::ready'] },
};

describe('wave-runner tick fresh-fetch policy', () => {
  it('fetches all Stories with {} when none are flagged halted', async () => {
    const provider = makeProvider({ tickets: STORY_TICKETS });
    const checkpoint = makeCheckpoint({ haltedStoryIds: [] });

    await tick({
      epic: 9000,
      collaborators: {
        provider,
        epicRunStateStore: { read: async () => checkpoint },
        signalEmit: async () => {},
        inFlightReader: async () => [],
        recurringFailureReporter: async () => {},
      },
    });

    const byId = new Map(provider.calls.map((c) => [c.id, c.opts]));
    assert.deepEqual(byId.get(1001), {});
    assert.deepEqual(byId.get(1002), {});
  });

  it('keeps {fresh:true} only for Stories in haltedStoryIds', async () => {
    const provider = makeProvider({ tickets: STORY_TICKETS });
    const checkpoint = makeCheckpoint({ haltedStoryIds: [1001] });

    await tick({
      epic: 9000,
      collaborators: {
        provider,
        epicRunStateStore: { read: async () => checkpoint },
        signalEmit: async () => {},
        inFlightReader: async () => [],
        recurringFailureReporter: async () => {},
      },
    });

    const byId = new Map(provider.calls.map((c) => [c.id, c.opts]));
    assert.deepEqual(byId.get(1001), { fresh: true });
    assert.deepEqual(byId.get(1002), {});
  });

  it('treats a missing waves array as no-halted (cache-warm everything)', async () => {
    const provider = makeProvider({ tickets: STORY_TICKETS });
    const checkpoint = {
      currentWave: 0,
      totalWaves: 1,
      plan: [[1001]],
      // no `waves` field — pre-resume cold start
    };

    await tick({
      epic: 9000,
      collaborators: {
        provider,
        epicRunStateStore: { read: async () => checkpoint },
        signalEmit: async () => {},
        inFlightReader: async () => [],
        recurringFailureReporter: async () => {},
      },
    });

    assert.deepEqual(provider.calls[0].opts, {});
  });
});
