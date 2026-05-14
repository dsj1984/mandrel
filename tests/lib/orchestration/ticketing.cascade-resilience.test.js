import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetParentCascadeLocks,
  __setCascadeRetryDelays,
  cascadeCompletion,
} from '../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Story #1817 — Regression coverage for cascade-completion resilience.
 *
 * The legacy implementation collapsed `gh`-thrown errors to a bare "exit 1"
 * message and offered no retry, mutex, or idempotency for the parent
 * transition. These tests exercise the documented failure modes against a
 * mock provider whose error shapes mirror what `gh-exec` produces in
 * production:
 *
 *   - secondary rate limit (`GhRateLimitError` with stderr carrying
 *     "secondary rate limit");
 *   - concurrent-edit race (two cascades targeting the same parent in the
 *     same wave);
 *   - "already done" idempotency (a sibling cascade flipped the parent
 *     before us, so re-fetching shows `agent::done`).
 */

function makeRateLimitError() {
  const err = new Error('gh-exec: gh API rate limit exceeded');
  err.name = 'GhRateLimitError';
  err.stderr =
    'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
  err.code = 1;
  return err;
}

function makeProvider({ tickets, subTicketsMap, transitionPlan }) {
  const updateRecords = [];
  const plan = new Map(Object.entries(transitionPlan ?? {}));
  return {
    updateRecords,
    plan,
    async getTicket(id) {
      return tickets[id];
    },
    async updateTicket(id, mutations) {
      updateRecords.push({ id, mutations });
      const handler = plan.get(String(id));
      if (typeof handler === 'function') {
        await handler(id, mutations, tickets);
      }
    },
    async postComment() {},
    async getTicketDependencies(id) {
      const t = tickets[id];
      if (!t) return { blocks: [], blockedBy: [] };
      const matches = t.body ? [...t.body.matchAll(/parent:\s*#(\d+)/gi)] : [];
      const blocks = matches.map((m) => Number.parseInt(m[1], 10));
      return { blocks, blockedBy: [] };
    },
    async getSubTickets(id) {
      const ids = subTicketsMap[id] ?? [];
      return ids.map((sid) => tickets[sid]);
    },
    invalidateTicket() {},
  };
}

test('cascadeCompletion resilience (Story #1817)', async (t) => {
  t.beforeEach(() => {
    __resetParentCascadeLocks();
    __setCascadeRetryDelays({ delays: [1, 1, 1], sleep: async () => {} });
  });

  t.after(() => {
    __setCascadeRetryDelays();
  });

  await t.test(
    'retries a secondary-rate-limit on the parent transition, then succeeds',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
      };
      let attempts = 0;
      const provider = makeProvider({
        tickets,
        subTicketsMap: { 41: [100], 100: [] },
        transitionPlan: {
          41: async () => {
            attempts += 1;
            if (attempts < 3) throw makeRateLimitError();
            tickets[41].labels = ['agent::done', 'type::feature'];
            tickets[41].state = 'closed';
          },
        },
      });
      const captured = [];
      const captureLogger = {
        debug: (m) => captured.push({ level: 'debug', message: m }),
        info: (m) => captured.push({ level: 'info', message: m }),
        warn: (m) => captured.push({ level: 'warn', message: m }),
        error: (m) => captured.push({ level: 'error', message: m }),
      };

      const result = await cascadeCompletion(provider, 100, {
        _logger: captureLogger,
      });

      assert.equal(attempts, 3, 'transition must retry twice then succeed');
      assert.deepEqual(result.cascadedTo, [41]);
      assert.deepEqual(result.failed, []);
      const retryLines = captured.filter((c) =>
        /transient GhRateLimitError/.test(c.message),
      );
      assert.ok(
        retryLines.length >= 2,
        `expected retry warn lines; got ${JSON.stringify(captured)}`,
      );
      // stderr must be surfaced — the legacy log swallowed it.
      assert.ok(
        retryLines.some((c) => /secondary rate limit/i.test(c.message)),
        'retry warn line must include stderr context',
      );
    },
  );

  await t.test(
    'surfaces stderr and exit code when a non-transient gh failure occurs',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
      };
      const provider = makeProvider({
        tickets,
        subTicketsMap: { 41: [100], 100: [] },
        transitionPlan: {
          41: async () => {
            const err = new Error('gh-exec: gh exited with code 1');
            err.name = 'GhExecError';
            err.stderr = 'HTTP 422: Validation Failed (something specific)';
            err.code = 1;
            throw err;
          },
        },
      });
      const captured = [];
      const captureLogger = {
        debug: (m) => captured.push({ level: 'debug', message: m }),
        info: (m) => captured.push({ level: 'info', message: m }),
        warn: (m) => captured.push({ level: 'warn', message: m }),
        error: (m) => captured.push({ level: 'error', message: m }),
      };

      const result = await cascadeCompletion(provider, 100, {
        _logger: captureLogger,
      });

      assert.equal(result.cascadedTo.length, 0);
      assert.equal(result.failed.length, 1);
      const detail = result.failed[0].error;
      assert.match(detail, /GhExecError/);
      assert.match(detail, /exit=1/);
      assert.match(detail, /stderr=HTTP 422.*Validation Failed/);
      // No retry: a non-transient error must surface on the first attempt.
      const failWarn = captured.find((c) =>
        /Cascade to parent #41 failed/.test(c.message),
      );
      assert.ok(failWarn, 'failure must be logged on the buffered logger');
      assert.match(failWarn.message, /stderr=HTTP 422/);
    },
  );

  await t.test(
    'serializes two concurrent cascades against the same parent (mutex)',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
        101: {
          id: 101,
          labels: ['agent::done', 'type::story'],
          body: 'Story 101\nparent: #41',
          state: 'closed',
        },
      };
      const transitions = [];
      const provider = makeProvider({
        tickets,
        subTicketsMap: { 41: [100, 101], 100: [], 101: [] },
        transitionPlan: {
          41: async () => {
            const startedAt = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 25));
            const finishedAt = Date.now();
            transitions.push({ startedAt, finishedAt });
            tickets[41].labels = ['agent::done', 'type::feature'];
            tickets[41].state = 'closed';
          },
        },
      });

      // Fire two cascades against the same parent in parallel — the second
      // should observe `agent::done` after the first finishes and
      // short-circuit (idempotency) rather than fire a second PATCH.
      const [r1, r2] = await Promise.all([
        cascadeCompletion(provider, 100),
        cascadeCompletion(provider, 101),
      ]);

      // Exactly one transition must have run end-to-end.
      assert.equal(
        transitions.length,
        1,
        `expected exactly one parent transition; got ${transitions.length}`,
      );
      // One winner reports cascadedTo=[41]; the other short-circuits with
      // cascadedTo=[].
      const winners = [r1, r2].filter((r) => r.cascadedTo.includes(41));
      const noops = [r1, r2].filter((r) => r.cascadedTo.length === 0);
      assert.equal(winners.length, 1, 'exactly one cascade must win');
      assert.equal(noops.length, 1, 'the other cascade must short-circuit');
    },
  );

  await t.test(
    'classifies HTTP 5xx and HTTP 429 as transient and retries',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
      };
      let attempts = 0;
      const provider = makeProvider({
        tickets,
        subTicketsMap: { 41: [100], 100: [] },
        transitionPlan: {
          41: async () => {
            attempts += 1;
            if (attempts === 1) {
              const err = new Error('upstream blew up');
              err.status = 502;
              throw err;
            }
            if (attempts === 2) {
              const err = new Error('too many requests');
              err.status = 429;
              throw err;
            }
            tickets[41].labels = ['agent::done', 'type::feature'];
            tickets[41].state = 'closed';
          },
        },
      });

      const result = await cascadeCompletion(provider, 100);
      assert.equal(attempts, 3);
      assert.deepEqual(result.cascadedTo, [41]);
    },
  );

  await t.test(
    'truncates an oversize stderr in the formatted failure message',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
      };
      const bigStderr = 'X'.repeat(2000);
      const provider = makeProvider({
        tickets,
        subTicketsMap: { 41: [100], 100: [] },
        transitionPlan: {
          41: async () => {
            const err = new Error('boom');
            err.stderr = bigStderr;
            throw err;
          },
        },
      });
      const result = await cascadeCompletion(provider, 100);
      assert.equal(result.failed.length, 1);
      // Truncated to ~400 chars + ellipsis marker.
      assert.ok(
        result.failed[0].error.length < 600,
        `expected truncated detail; got ${result.failed[0].error.length} chars`,
      );
      assert.match(result.failed[0].error, /…/);
    },
  );

  await t.test(
    'tolerates a throwing provider.invalidateTicket during the idempotency check',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
      };
      const provider = {
        async getTicket(id) {
          return tickets[id];
        },
        async updateTicket(id) {
          tickets[id].labels = ['agent::done', 'type::feature'];
          tickets[id].state = 'closed';
        },
        async postComment() {},
        async getTicketDependencies(id) {
          const matches = tickets[id]?.body
            ? [...tickets[id].body.matchAll(/parent:\s*#(\d+)/gi)]
            : [];
          return {
            blocks: matches.map((m) => Number.parseInt(m[1], 10)),
            blockedBy: [],
          };
        },
        async getSubTickets() {
          return [tickets[100]];
        },
        invalidateTicket() {
          throw new Error('cache invalidation hook explodes');
        },
      };
      const result = await cascadeCompletion(provider, 100);
      assert.deepEqual(result.cascadedTo, [41]);
      assert.deepEqual(result.failed, []);
    },
  );

  await t.test(
    'exercises the default sleep schedule when __setCascadeRetryDelays is reset',
    async () => {
      // Restore the production sleep + default delays, then drive a tiny
      // retry against an injected delay of [1] so the default sleep
      // function runs end-to-end (cheap; <5ms wall clock).
      __setCascadeRetryDelays({ delays: [1] });
      try {
        const tickets = {
          41: {
            id: 41,
            labels: ['agent::executing', 'type::feature'],
            body: 'Feature 41',
            state: 'open',
          },
          100: {
            id: 100,
            labels: ['agent::done', 'type::story'],
            body: 'Story 100\nparent: #41',
            state: 'closed',
          },
        };
        let attempts = 0;
        const provider = makeProvider({
          tickets,
          subTicketsMap: { 41: [100], 100: [] },
          transitionPlan: {
            41: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw makeRateLimitError();
              }
              tickets[41].labels = ['agent::done', 'type::feature'];
              tickets[41].state = 'closed';
            },
          },
        });
        const result = await cascadeCompletion(provider, 100);
        assert.equal(attempts, 2);
        assert.deepEqual(result.cascadedTo, [41]);
      } finally {
        __setCascadeRetryDelays({ delays: [1, 1, 1], sleep: async () => {} });
      }
    },
  );

  await t.test(
    'idempotent: re-running cascadeCompletion after a winner short-circuits',
    async () => {
      const tickets = {
        41: {
          id: 41,
          labels: ['agent::done', 'type::feature'],
          body: 'Feature 41',
          state: 'closed',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41',
          state: 'closed',
        },
      };
      let transitions = 0;
      const provider = makeProvider({
        tickets,
        subTicketsMap: { 41: [100], 100: [] },
        transitionPlan: {
          41: async () => {
            transitions += 1;
          },
        },
      });

      const result = await cascadeCompletion(provider, 100);
      assert.equal(transitions, 0, 'parent already done — no transition');
      assert.deepEqual(result.cascadedTo, []);
      assert.deepEqual(result.failed, []);
    },
  );
});
