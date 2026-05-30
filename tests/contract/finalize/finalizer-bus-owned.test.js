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
 *   3. On success, Finalizer emits `pr.created` → `epic.finalize.end`
 *      and STOPS — it does NOT emit `epic.merge.ready` (Story #3367).
 *      Emitting `epic.merge.ready` from finalize cascaded
 *      `epic.close.end` synchronously into the auto-merge arm + branch
 *      reap, bypassing the AutomergePredicate gate; the arm now flows
 *      only through the gated watch path.
 *   4. The full emit sequence is start → pr.created →
 *      epic.finalize.end (terminal — no epic.merge.ready).
 *   5. Handoff-comment failures are best-effort: PR creation still
 *      succeeds, and the finalize.end emit still fires.
 *   6. `openOrLocatePr` failures route through the blocker channel —
 *      no `pr.created` / `epic.finalize.end` emit.
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
  it('emits start → pr.created → finalize.end (and NO epic.merge.ready) with no overrides', async () => {
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
    // Story #3367: the Finalizer stops at epic.finalize.end. It MUST NOT
    // emit epic.merge.ready (that is the AutomergePredicate's sole job).
    assert.deepEqual(ordered, [
      'epic.finalize.start',
      'pr.created',
      'epic.finalize.end',
    ]);
    assert.equal(
      bus.emitted.find((e) => e.event === 'epic.merge.ready'),
      undefined,
      'Finalizer MUST NOT emit epic.merge.ready (Story #3367)',
    );
    // The PR URL still reaches the bus via pr.created / epic.finalize.end.
    const finalizeEnd = bus.emitted.find(
      (e) => e.event === 'epic.finalize.end',
    );
    assert.equal(finalizeEnd.payload.epicId, 2880);
    assert.equal(finalizeEnd.payload.prUrl, 'https://github.com/o/r/pull/99');
  });

  it('emits pr.created + finalize.end (no epic.merge.ready) with the existing-PR URL when the probe short-circuits', async () => {
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
    const prCreated = bus.emitted.find((e) => e.event === 'pr.created');
    assert.ok(prCreated, 'pr.created must fire on the short-circuit path');
    assert.equal(prCreated.payload.prUrl, 'https://github.com/o/r/pull/123');
    const finalizeEnd = bus.emitted.find(
      (e) => e.event === 'epic.finalize.end',
    );
    assert.ok(
      finalizeEnd,
      'epic.finalize.end must fire on the short-circuit path',
    );
    assert.equal(finalizeEnd.payload.prUrl, 'https://github.com/o/r/pull/123');
    assert.equal(
      bus.emitted.find((e) => e.event === 'epic.merge.ready'),
      undefined,
      'Finalizer MUST NOT emit epic.merge.ready (Story #3367)',
    );
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
