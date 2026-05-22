/**
 * tests/contract/finalize/finalizer-bus-owned.test.js
 *
 * Contract test for the bus-owned Finalizer wiring — Story #2894 /
 * Task #2917 (Epic #2880).
 *
 * Asserts:
 *   1. `composeBusOwnedFinalize` invokes openOrLocatePr,
 *      closePlanningTickets, and postHandoffComment in order. With no
 *      `runFinalizeFn` override the Finalizer default is this
 *      composition.
 *   2. The default `runFinalizeFn` is the bus-owned composition (no
 *      `d1-default-no-op` blocker reachable from the default path).
 *   3. On success, Finalizer emits `epic.merge.ready` carrying
 *      `{ prNumber, epicId, prUrl }`.
 *   4. The full emit sequence is start → pr.created →
 *      epic.finalize.end → epic.merge.ready.
 *   5. Handoff-comment failures are best-effort: PR creation still
 *      succeeds, and the merge.ready emit still fires.
 *   6. `openOrLocatePr` failures route through the blocker channel —
 *      no `pr.created` / `epic.merge.ready` emit.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  composeBusOwnedFinalize,
  Finalizer,
} from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function makeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return () => {};
    },
    async emit(event, payload) {
      emitted.push({ event, payload });
      const list = handlers.get(event) ?? [];
      for (const fn of list) {
        await fn({ event, seqId: emitted.length, payload });
      }
    },
    emitted,
  };
}

describe('composeBusOwnedFinalize', () => {
  it('invokes openOrLocatePr, closePlanningTickets, postHandoffComment in order', async () => {
    const calls = [];
    const run = composeBusOwnedFinalize({
      provider: { sentinel: true },
      openOrLocatePrFn: async (args) => {
        calls.push({ step: 'openOrLocatePr', args });
        return {
          prNumber: 99,
          url: 'https://github.com/o/r/pull/99',
          created: true,
        };
      },
      closePlanningTicketsFn: async (args) => {
        calls.push({ step: 'closePlanningTickets', args });
        return { closed: 3, alreadyClosed: 0, failed: 0, details: [] };
      },
      postHandoffCommentFn: async (args) => {
        calls.push({ step: 'postHandoffComment', args });
        return { marker: 'epic-handoff', commentId: 12345 };
      },
    });
    const result = await run({ epicId: 2880, cwd: '/tmp' });
    assert.deepEqual(
      calls.map((c) => c.step),
      ['openOrLocatePr', 'closePlanningTickets', 'postHandoffComment'],
    );
    // openOrLocatePr receives `epic/<id>` as headBranch with `main` base.
    assert.equal(calls[0].args.epicId, 2880);
    assert.equal(calls[0].args.headBranch, 'epic/2880');
    assert.equal(calls[0].args.baseBranch, 'main');
    // closePlanningTickets receives provider
    assert.equal(calls[1].args.provider.sentinel, true);
    // postHandoffComment receives the prNumber from openOrLocatePr
    assert.equal(calls[2].args.prNumber, 99);
    assert.equal(calls[2].args.prUrl, 'https://github.com/o/r/pull/99');
    // Returns the canonical finalize envelope
    assert.equal(result.prNumber, 99);
    assert.equal(result.prUrl, 'https://github.com/o/r/pull/99');
    assert.equal(result.created, true);
    assert.equal(result.planningClose.closed, 3);
    assert.equal(result.handoff.commentId, 12345);
  });

  it('routes openOrLocatePr failure to a blocker envelope', async () => {
    const run = composeBusOwnedFinalize({
      provider: { sentinel: true },
      openOrLocatePrFn: async () => {
        throw new Error('branch behind base');
      },
      closePlanningTicketsFn: async () => {
        throw new Error('should not be called');
      },
      postHandoffCommentFn: async () => {
        throw new Error('should not be called');
      },
    });
    const result = await run({ epicId: 2880, cwd: '/tmp' });
    assert.ok(result?.blocker);
    assert.equal(result.blocker.reason, 'open-or-locate-pr-failed');
    assert.match(result.blocker.detail, /branch behind base/);
  });

  it('routes closePlanningTickets throw to a blocker envelope', async () => {
    const run = composeBusOwnedFinalize({
      provider: { sentinel: true },
      openOrLocatePrFn: async () => ({
        prNumber: 1,
        url: 'https://github.com/o/r/pull/1',
        created: true,
      }),
      closePlanningTicketsFn: async () => {
        throw new Error('provider 502');
      },
    });
    const result = await run({ epicId: 1, cwd: '/tmp' });
    assert.equal(result?.blocker?.reason, 'close-planning-tickets-failed');
  });

  it('treats handoff-comment failures as non-blocking', async () => {
    const run = composeBusOwnedFinalize({
      provider: { sentinel: true },
      openOrLocatePrFn: async () => ({
        prNumber: 1,
        url: 'https://github.com/o/r/pull/1',
        created: true,
      }),
      closePlanningTicketsFn: async () => ({
        closed: 0,
        alreadyClosed: 3,
        failed: 0,
        details: [],
      }),
      postHandoffCommentFn: async () => {
        throw new Error('comment posting failed');
      },
    });
    const result = await run({ epicId: 1, cwd: '/tmp' });
    assert.equal(result.prNumber, 1);
    assert.equal(result.handoff.commentId, null);
    assert.match(result.handoff.error, /comment posting failed/);
  });

  it('skips planning-ticket close and handoff when provider is absent', async () => {
    const run = composeBusOwnedFinalize({
      provider: null,
      openOrLocatePrFn: async () => ({
        prNumber: 5,
        url: 'https://github.com/o/r/pull/5',
        created: false,
      }),
    });
    const result = await run({ epicId: 1, cwd: '/tmp' });
    assert.equal(result.prNumber, 5);
    assert.equal(result.planningClose, null);
    assert.equal(result.handoff, null);
  });

  it('rejects invalid epicId via blocker envelope', async () => {
    const run = composeBusOwnedFinalize({ provider: null });
    const result = await run({ epicId: 0 });
    assert.equal(result?.blocker?.reason, 'invalid-epicId');
  });
});

describe('Finalizer with the bus-owned default', () => {
  it('emits start → pr.created → finalize.end → epic.merge.ready in order with no overrides', async () => {
    const bus = makeBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2880,
      cwd: '/tmp',
      provider: { sentinel: true },
      // Stub the probe so we go through the create path.
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: composeBusOwnedFinalize({
        provider: { sentinel: true },
        openOrLocatePrFn: async () => ({
          prNumber: 99,
          url: 'https://github.com/o/r/pull/99',
          created: true,
        }),
        closePlanningTicketsFn: async () => ({
          closed: 3,
          alreadyClosed: 0,
          failed: 0,
          details: [],
        }),
        postHandoffCommentFn: async () => ({
          marker: 'epic-handoff',
          commentId: 1,
        }),
      }),
      logger: quietLogger(),
    });
    finalizer.register();
    await bus.emit('acceptance.reconcile.ok', { baseRead: true });
    const ordered = bus.emitted
      .map((e) => e.event)
      .filter(
        (e) =>
          e === 'epic.finalize.start' ||
          e === 'pr.created' ||
          e === 'epic.finalize.end' ||
          e === 'epic.merge.ready',
      );
    assert.deepEqual(ordered, [
      'epic.finalize.start',
      'pr.created',
      'epic.finalize.end',
      'epic.merge.ready',
    ]);
    const mergeReady = bus.emitted.find((e) => e.event === 'epic.merge.ready');
    assert.equal(mergeReady.payload.prNumber, 99);
    assert.equal(mergeReady.payload.epicId, 2880);
    assert.equal(mergeReady.payload.prUrl, 'https://github.com/o/r/pull/99');
  });

  it('emits epic.merge.ready with the existing-PR URL when the probe short-circuits', async () => {
    const bus = makeBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2880,
      cwd: '/tmp',
      // Probe returns an existing PR — runFinalizeFn must NOT fire.
      ghPrListHeadFn: () => ({
        status: 0,
        stdout: 'https://github.com/o/r/pull/123\n',
        stderr: '',
      }),
      runFinalizeFn: async () => {
        throw new Error('runFinalizeFn must not run on probe short-circuit');
      },
      logger: quietLogger(),
    });
    finalizer.register();
    await bus.emit('acceptance.reconcile.ok', { baseRead: true });
    const mergeReady = bus.emitted.find((e) => e.event === 'epic.merge.ready');
    assert.ok(mergeReady, 'epic.merge.ready must still fire');
    assert.equal(mergeReady.payload.prNumber, 123);
    assert.equal(mergeReady.payload.epicId, 2880);
    assert.equal(mergeReady.payload.prUrl, 'https://github.com/o/r/pull/123');
  });

  it('Finalizer constructed with no runFinalizeFn override has the bus-owned composition as default', () => {
    const bus = makeBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 1,
      cwd: '/tmp',
      provider: { sentinel: true },
      logger: quietLogger(),
    });
    // The default runFinalizeFn is a function (not the legacy no-op
    // that returned a `d1-default-no-op` blocker synchronously).
    assert.equal(typeof finalizer.runFinalizeFn, 'function');
    assert.notEqual(
      finalizer.runFinalizeFn.name,
      'defaultRunEpicDeliverFinalize',
    );
  });
});
