/**
 * Story #1795 — Per-wave primeTicketCache contract tests.
 *
 * `dispatchWave` pre-loads Epic + Tech Spec + Story tickets via
 * `provider.primeTicketCache` once per wave so subsequent per-Task
 * hydration is served from cache. The seam is exposed via the helper
 * exports `collectHierarchyIds` and `primeWaveHierarchy` so the
 * behaviour is verifiable without driving the full dispatcher loop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectHierarchyIds,
  primeWaveHierarchy,
} from '../../../.agents/scripts/lib/orchestration/wave-dispatcher.js';

const BODY = (epic, tech, story) =>
  `parent: #${story}\nEpic: #${epic}\nTech Spec: #${tech}\nStory: #${story}\n`;

function makeRecordingProvider({ ticketsById = {} } = {}) {
  const getTicketCalls = [];
  const primeCalls = [];
  return {
    async getTicket(id) {
      getTicketCalls.push(id);
      return ticketsById[id] ?? { id, labels: [], body: '' };
    },
    primeTicketCache(tickets) {
      primeCalls.push(tickets.map((t) => t.id));
    },
    getTicketCalls,
    primeCalls,
  };
}

describe('collectHierarchyIds', () => {
  it('returns unique Epic / Tech Spec / Story IDs across tasks', () => {
    const tasks = [
      { body: BODY(1788, 1790, 1795) },
      { body: BODY(1788, 1790, 1795) }, // duplicate
      { body: BODY(1788, 1790, 1799) }, // different story
    ];
    const ids = collectHierarchyIds(tasks, 1788);
    assert.deepEqual(ids.sort(), [1788, 1790, 1795, 1799]);
  });

  it('tolerates tasks with no parseable hierarchy', () => {
    const ids = collectHierarchyIds([{ body: 'no hierarchy here' }], undefined);
    assert.deepEqual(ids, []);
  });

  it('honours the explicit epicId fallback', () => {
    const ids = collectHierarchyIds([{ body: 'parent: #1795' }], 1788);
    assert.deepEqual(ids.sort(), [1788]);
  });
});

describe('primeWaveHierarchy', () => {
  it('issues at most one getTicket per unique hierarchy id', async () => {
    const provider = makeRecordingProvider({
      ticketsById: {
        1788: { id: 1788, labels: ['type::epic'], body: '' },
        1790: { id: 1790, labels: ['type::techspec'], body: '' },
        1795: { id: 1795, labels: ['type::story'], body: '' },
      },
    });
    const eligible = [
      { body: BODY(1788, 1790, 1795) },
      { body: BODY(1788, 1790, 1795) },
      { body: BODY(1788, 1790, 1795) },
    ];
    const result = await primeWaveHierarchy(eligible, {
      provider,
      epicId: 1788,
    });
    assert.deepEqual(result.primed.sort(), [1788, 1790, 1795]);
    assert.equal(
      provider.getTicketCalls.length,
      3,
      `expected 3 unique getTicket calls, got ${provider.getTicketCalls.length}`,
    );
    assert.equal(provider.primeCalls.length, 1);
    assert.deepEqual(provider.primeCalls[0].sort(), [1788, 1790, 1795]);
  });

  it('best-effort: a fetch failure for one ID does not block the rest', async () => {
    const provider = {
      async getTicket(id) {
        if (id === 1790) throw new Error('boom');
        return { id, labels: [], body: '' };
      },
      primed: [],
      primeTicketCache(tickets) {
        this.primed.push(...tickets.map((t) => t.id));
      },
    };
    const eligible = [{ body: BODY(1788, 1790, 1795) }];
    const result = await primeWaveHierarchy(eligible, {
      provider,
      epicId: 1788,
    });
    assert.ok(result.primed.includes(1788));
    assert.ok(result.primed.includes(1795));
    assert.ok(!result.primed.includes(1790));
  });

  it('no-ops when provider lacks primeTicketCache', async () => {
    const provider = { async getTicket() {} };
    const result = await primeWaveHierarchy(
      [{ body: BODY(1788, 1790, 1795) }],
      { provider, epicId: 1788 },
    );
    assert.deepEqual(result.primed, []);
  });
});
