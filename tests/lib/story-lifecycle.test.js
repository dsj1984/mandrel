import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATE_LABELS } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import { composeStoryBody } from '../../.agents/scripts/providers/github/tickets.js';
import {
  batchTransitionTickets,
  fetchChildTickets,
  resolveStoryHierarchy,
} from '../../.agents/scripts/lib/story-lifecycle.js';

describe('story-lifecycle', () => {
  describe('resolveStoryHierarchy', () => {
    it('extracts both Epic and parent references', () => {
      const body =
        'Some story description\n\n---\nparent: #42\nEpic: #7\n\nblocked by #5';
      assert.deepEqual(resolveStoryHierarchy(body), {
        epicId: 7,
        parentId: 42,
      });
    });

    it('returns null for missing references', () => {
      assert.deepEqual(resolveStoryHierarchy('no refs here'), {
        epicId: null,
        parentId: null,
      });
    });

    it('handles undefined/null body gracefully', () => {
      assert.deepEqual(resolveStoryHierarchy(undefined), {
        epicId: null,
        parentId: null,
      });
      assert.deepEqual(resolveStoryHierarchy(null), {
        epicId: null,
        parentId: null,
      });
    });

    it('is case-insensitive for "Epic:" and "parent:"', () => {
      assert.deepEqual(resolveStoryHierarchy('EPIC: #1\nPARENT: #2'), {
        epicId: 1,
        parentId: 2,
      });
    });
  });

  // Story #4102 — the producer↔consumer contract for the Story-body Epic
  // reference. composeStoryBody is the sole writer of the `Epic: #N` trailer
  // and resolveStoryHierarchy is the sole reader; under the 2-tier hierarchy a
  // directly-attached Story has epicId === parentId, and the round-trip must
  // recover a non-null epicId so story-init can resolve the hierarchy.
  describe('composeStoryBody ↔ resolveStoryHierarchy round-trip (Story #4102)', () => {
    it('recovers a non-null epicId for a directly-attached 2-tier Story', () => {
      const body = composeStoryBody({
        body: '# Story body',
        parentId: 23,
        epicId: 23,
        dependencies: [],
      });
      assert.deepEqual(resolveStoryHierarchy(body), {
        epicId: 23,
        parentId: 23,
      });
    });

    it('resolves epicId: null for a standalone Story (parent but no Epic)', () => {
      const body = composeStoryBody({
        body: '# Story body',
        parentId: 23,
        dependencies: [],
      });
      assert.deepEqual(resolveStoryHierarchy(body), {
        epicId: null,
        parentId: 23,
      });
    });
  });

  describe('fetchChildTickets', () => {
    it('returns the provider getSubTickets payload unchanged', async () => {
      const provider = {
        getSubTickets: async (id) => {
          assert.equal(id, 100);
          return [
            { id: 1, labels: ['type::story'] },
            { id: 2, labels: ['type::story'] },
          ];
        },
      };
      const tickets = await fetchChildTickets(provider, 100);
      assert.deepEqual(
        tickets.map((t) => t.id),
        [1, 2],
      );
    });

    it('returns [] for 2-tier Stories with no children', async () => {
      const provider = {
        getSubTickets: async () => [],
      };
      const tickets = await fetchChildTickets(provider, 100);
      assert.deepEqual(tickets, []);
    });
  });

  describe('batchTransitionTickets', () => {
    function makeProvider(calls) {
      return {
        updateTicket: async (id, patch) => {
          calls.push({ id, patch });
        },
      };
    }

    it('transitions eligible tickets in parallel', async () => {
      const calls = [];
      const provider = makeProvider(calls);
      const tickets = [
        { id: 1, labels: ['type::task'] },
        { id: 2, labels: ['type::task'] },
      ];
      const result = await batchTransitionTickets(
        provider,
        tickets,
        STATE_LABELS.EXECUTING,
      );
      assert.deepEqual(result.transitioned.sort(), [1, 2]);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.failed, []);
      assert.equal(calls.length, 2);
    });

    it('skips tickets already at the target state', async () => {
      const calls = [];
      const provider = makeProvider(calls);
      const tickets = [
        { id: 1, labels: [STATE_LABELS.EXECUTING] },
        { id: 2, labels: ['type::task'] },
      ];
      const result = await batchTransitionTickets(
        provider,
        tickets,
        STATE_LABELS.EXECUTING,
      );
      assert.deepEqual(result.transitioned, [2]);
      assert.deepEqual(result.skipped, [1]);
    });

    it('skips done tickets when transitioning to a non-done target', async () => {
      const calls = [];
      const provider = makeProvider(calls);
      const tickets = [
        { id: 1, labels: [STATE_LABELS.DONE] },
        { id: 2, labels: ['type::task'] },
      ];
      const result = await batchTransitionTickets(
        provider,
        tickets,
        STATE_LABELS.EXECUTING,
      );
      assert.deepEqual(result.transitioned, [2]);
      assert.deepEqual(result.skipped, [1]);
    });

    it('records failures without aborting the batch', async () => {
      let count = 0;
      const provider = {
        updateTicket: async (id) => {
          count += 1;
          if (id === 2) throw new Error('api down');
        },
      };
      const tickets = [
        { id: 1, labels: ['type::task'] },
        { id: 2, labels: ['type::task'] },
        { id: 3, labels: ['type::task'] },
      ];
      const result = await batchTransitionTickets(
        provider,
        tickets,
        STATE_LABELS.EXECUTING,
        {
          retries: 1, // permanent-error path: no retries
          onError: () => {
            /* suppress default stderr */
          },
        },
      );
      assert.deepEqual(result.transitioned.sort(), [1, 3]);
      assert.deepEqual(result.failed, [
        { id: 2, error: 'api down', attempts: 1 },
      ]);
      assert.equal(count, 3);
    });

    it('retries transient errors with exponential backoff', async () => {
      const attempts = new Map();
      const provider = {
        updateTicket: async (id) => {
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          if (id === 5 && n < 3) {
            const err = new Error('rate limit exceeded');
            err.status = 429;
            throw err;
          }
        },
      };
      const tickets = [{ id: 5, labels: ['type::task'] }];
      const result = await batchTransitionTickets(
        provider,
        tickets,
        STATE_LABELS.EXECUTING,
        { retries: 3, retryBaseMs: 1 },
      );
      assert.deepEqual(result.transitioned, [5]);
      assert.equal(attempts.get(5), 3);
    });

    it('does not retry non-transient (4xx) errors', async () => {
      const attempts = new Map();
      const provider = {
        updateTicket: async (id) => {
          attempts.set(id, (attempts.get(id) ?? 0) + 1);
          const err = new Error('forbidden');
          err.status = 403;
          throw err;
        },
      };
      const tickets = [{ id: 7, labels: ['type::task'] }];
      const result = await batchTransitionTickets(
        provider,
        tickets,
        STATE_LABELS.EXECUTING,
        { retries: 3, retryBaseMs: 1, onError: () => {} },
      );
      assert.equal(attempts.get(7), 1, 'must not retry 403');
      assert.equal(result.failed.length, 1);
    });

    it('invokes progress callback on transitions and skips', async () => {
      const events = [];
      const provider = { updateTicket: async () => {} };
      const tickets = [
        { id: 1, labels: ['type::task'] },
        { id: 2, labels: [STATE_LABELS.EXECUTING] },
      ];
      await batchTransitionTickets(provider, tickets, STATE_LABELS.EXECUTING, {
        progress: (phase, msg) => events.push([phase, msg]),
      });
      assert.ok(events.some(([p, m]) => p === 'TICKETS' && m.includes('#1')));
      assert.ok(events.some(([_p, m]) => m.includes('#2')));
    });
  });
});
