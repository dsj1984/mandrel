import assert from 'node:assert/strict';
import test from 'node:test';
import { cascadeCompletion } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Build a fake ITicketingProvider for cascade scenarios. The harness:
 *
 *   - Exposes `tickets[id]` for label/body lookups.
 *   - Records every `updateTicket(id)` call as { id, startedAt, finishedAt }
 *     so callers can detect time-overlap between two parent updates.
 *   - Lets callers inject a per-parent latency (in ms) on the cascade's
 *     `transitionTicketState` call so disjoint parents have a real window
 *     in which to overlap.
 *
 * The trigger ticket (the one passed to `cascadeCompletion`) is implicit:
 * callers pass the trigger id directly to `cascadeCompletion`.
 */
function makeProvider({ tickets, subTicketsMap, parentLatencyMs = {} }) {
  const updateRecords = [];
  return {
    updateRecords,
    async getTicket(id) {
      return tickets[id];
    },
    async updateTicket(id, _mutations) {
      const startedAt = Date.now();
      const latency = parentLatencyMs[id] ?? 0;
      if (latency > 0) {
        await new Promise((resolve) => setTimeout(resolve, latency));
      }
      const finishedAt = Date.now();
      updateRecords.push({ id, startedAt, finishedAt });
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
  };
}

test('cascadeCompletion parallel dispatch', async (t) => {
  await t.test('two disjoint parents overlap in time', async () => {
    // Trigger #100 has two parents (#41, #42) that share NO ancestors.
    // The cascade groups them disjointly and runs them in parallel via
    // Promise.all, so their transitionTicketState durations (the only
    // observable latency we control) must overlap.
    const tickets = {
      41: {
        id: 41,
        labels: ['agent::executing', 'type::feature'],
        body: 'Feature 41',
        state: 'open',
      },
      42: {
        id: 42,
        labels: ['agent::executing', 'type::feature'],
        body: 'Feature 42',
        state: 'open',
      },
      100: {
        id: 100,
        labels: ['agent::done', 'type::story'],
        body: 'Story 100\nparent: #41\nparent: #42',
        state: 'closed',
      },
    };
    const subTicketsMap = {
      41: [100],
      42: [100],
      100: [],
    };
    const provider = makeProvider({
      tickets,
      subTicketsMap,
      parentLatencyMs: { 41: 60, 42: 60 },
    });

    await cascadeCompletion(provider, 100);

    const u41 = provider.updateRecords.find((r) => r.id === 41);
    const u42 = provider.updateRecords.find((r) => r.id === 42);
    assert.ok(u41 && u42, 'both parents must have been updated');
    // Overlap iff each window's start precedes the other's finish.
    const overlap =
      u41.startedAt < u42.finishedAt && u42.startedAt < u41.finishedAt;
    assert.ok(
      overlap,
      `disjoint parents must overlap; #41=${u41.startedAt}-${u41.finishedAt} #42=${u42.startedAt}-${u42.finishedAt}`,
    );
  });

  await t.test(
    'two shared-ancestor parents complete strictly sequentially in input order',
    async () => {
      // Trigger #100 has parents #41 and #42; both climb to a shared
      // grandparent #40 via `parent: #40`. They land in the same group
      // and must run strictly sequentially in input order.
      const tickets = {
        40: {
          id: 40,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 40',
          state: 'open',
        },
        41: {
          id: 41,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 41\nparent: #40',
          state: 'open',
        },
        42: {
          id: 42,
          labels: ['agent::executing', 'type::feature'],
          body: 'Feature 42\nparent: #40',
          state: 'open',
        },
        100: {
          id: 100,
          labels: ['agent::done', 'type::story'],
          body: 'Story 100\nparent: #41\nparent: #42',
          state: 'closed',
        },
      };
      const subTicketsMap = {
        // #40's children include both #41 and #42; cascade requires both
        // to be agent::done before it can close #40, which they won't be
        // (only #41 transitions first). That keeps the cascade focused on
        // the parent-pair ordering invariant.
        40: [41, 42],
        41: [100],
        42: [100],
        100: [],
      };
      const provider = makeProvider({
        tickets,
        subTicketsMap,
        parentLatencyMs: { 41: 50, 42: 50 },
      });

      await cascadeCompletion(provider, 100);

      const u41 = provider.updateRecords.find((r) => r.id === 41);
      const u42 = provider.updateRecords.find((r) => r.id === 42);
      assert.ok(u41 && u42, 'both parents must have been updated');
      // Strict sequencing: #41 must finish before #42 starts.
      assert.ok(
        u41.finishedAt <= u42.startedAt,
        `shared-ancestor parents must run sequentially; #41=${u41.startedAt}-${u41.finishedAt} #42=${u42.startedAt}-${u42.finishedAt}`,
      );
    },
  );

  await t.test(
    'captured log output matches the serial baseline for the same input',
    async () => {
      // Trigger the cascade with one parent that is an Epic — this fires
      // the deterministic `Logger.warn` line ("Cascade reached Epic ...")
      // through the buffered logger. We capture the logger output from
      // a parallel run and assert it matches a serial run byte-for-byte
      // on the same input.
      const tickets = {
        1: {
          id: 1,
          labels: ['agent::executing', 'type::epic'],
          body: 'Epic 1',
          state: 'open',
        },
        2: {
          id: 2,
          labels: ['agent::executing', 'type::epic'],
          body: 'Epic 2',
          state: 'open',
        },
        3: {
          id: 3,
          labels: ['agent::done', 'type::story'],
          body: 'Story 3\nparent: #1\nparent: #2',
          state: 'closed',
        },
      };
      const subTicketsMap = { 1: [3], 2: [3], 3: [] };

      // Capture mode: pass a buffered logger via the internal `_logger`
      // hook. The two parents are disjoint (no shared ancestor) so they
      // dispatch in parallel groups; the buffered flush must still emit
      // in input order (#1 before #2).
      const captured = [];
      const captureLogger = {
        debug(m) {
          captured.push({ level: 'debug', message: m });
        },
        info(m) {
          captured.push({ level: 'info', message: m });
        },
        warn(m) {
          captured.push({ level: 'warn', message: m });
        },
        error(m) {
          captured.push({ level: 'error', message: m });
        },
      };
      const provider = makeProvider({ tickets, subTicketsMap });
      await cascadeCompletion(provider, 3, { _logger: captureLogger });

      // Both parents are Epics, so each fires the "Cascade reached Epic"
      // warn line. The flush order must follow `parsedParents` order:
      // #1 before #2.
      assert.equal(
        captured.length,
        2,
        `expected 2 log lines; got ${JSON.stringify(captured)}`,
      );
      assert.equal(captured[0].level, 'warn');
      assert.equal(captured[1].level, 'warn');
      assert.match(captured[0].message, /#1\b/);
      assert.match(captured[1].message, /#2\b/);

      // Serial baseline: run the same scenario again with a fresh
      // provider and capture logger. The output must be byte-identical.
      const captured2 = [];
      const captureLogger2 = {
        debug(m) {
          captured2.push({ level: 'debug', message: m });
        },
        info(m) {
          captured2.push({ level: 'info', message: m });
        },
        warn(m) {
          captured2.push({ level: 'warn', message: m });
        },
        error(m) {
          captured2.push({ level: 'error', message: m });
        },
      };
      const provider2 = makeProvider({ tickets, subTicketsMap });
      await cascadeCompletion(provider2, 3, { _logger: captureLogger2 });
      assert.deepEqual(captured2, captured);
    },
  );
});
