// tests/lib/orchestration/lifecycle/activation/acceptance-reconciler-activation.test.js
/**
 * Activation contract: AcceptanceReconciler fires exactly once per
 * `epic.close.end` and emits `acceptance.reconcile.start` in the same
 * tick the umbrella event dispatches. Story #2315 / Task #2318 — the
 * runtime half of the High-2 fix from Epic #2306: with the listener
 * now wired by the close-tail registrar (Task #2322), an
 * `epic.close.end` emit MUST drive a `.start` → outcome pair on the
 * bus before control returns to the emitter.
 *
 * The companion file `listener-registration.test.js` pins the
 * registration site itself (factory exposes the instance, imports the
 * module exactly once). This file pins the *behavior* contract: the
 * subscription is correctly wired and the failure cascade still
 * emits `epic.blocked` after a thrown reconciler.
 *
 * Uses the same `Bus` test harness from the bus-cutover work
 * (#2172/#2253) — a `Bus` instance plus a tap that records every emit
 * in arrival order with its seqId.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AcceptanceReconciler } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Build a bus that captures every emit across the events this listener
 * touches. Mirrors the recorder used in `listener-reconciler.test.js`
 * but is duplicated here so the activation suite stands alone — a
 * future refactor that moves the listener should not have to also
 * fish through the original listener-unit tests to find the harness.
 */
function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('acceptance.reconcile.start', record('acceptance.reconcile.start'));
  bus.on('acceptance.reconcile.ok', record('acceptance.reconcile.ok'));
  bus.on(
    'acceptance.reconcile.skipped',
    record('acceptance.reconcile.skipped'),
  );
  bus.on('acceptance.reconcile.failed', record('acceptance.reconcile.failed'));
  bus.on('epic.blocked', record('epic.blocked'));
  return { bus, emits };
}

describe('AcceptanceReconciler activation (epic.close.end → reconcile fires)', () => {
  it('emits acceptance.reconcile.start in the same tick epic.close.end is dispatched', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2306,
      reconcileAcceptanceSpecFn: async () => ({ status: 'ok' }),
      logger: quietLogger(),
    });
    reconciler.register();

    // The bus is a sequential awaited mediator — `await bus.emit()`
    // resolves only after every listener has settled. So any emit
    // recorded in `emits` after this await is by definition "in the
    // same tick the umbrella was dispatched", before control returned
    // to the caller. That is the activation invariant the AC pins.
    await bus.emit('epic.close.end', { epicId: 2306 });

    const events = emits.map((e) => e.event);
    assert.ok(
      events.includes('acceptance.reconcile.start'),
      'acceptance.reconcile.start fired on epic.close.end',
    );
    const startIdx = events.indexOf('acceptance.reconcile.start');
    assert.equal(
      startIdx,
      0,
      'acceptance.reconcile.start is the first downstream emit',
    );
  });

  it('fires the reconciler exactly once per epic.close.end emission (no double-handle)', async () => {
    const { bus } = recordingBus();
    let calls = 0;
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2306,
      reconcileAcceptanceSpecFn: async () => {
        calls += 1;
        return { status: 'ok' };
      },
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2306 });

    assert.equal(
      calls,
      1,
      'reconcileAcceptanceSpec invoked exactly once per epic.close.end',
    );
    assert.equal(
      reconciler.classifications.length,
      1,
      'one classification recorded',
    );
    assert.equal(reconciler.classifications[0].event, 'epic.close.end');
  });

  it('emits epic.blocked after acceptance.reconcile.failed when the reconciler throws', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2306,
      reconcileAcceptanceSpecFn: async () => {
        throw new Error('spec-link-missing');
      },
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2306 });

    const ordered = emits.map((e) => e.event);
    const failedIdx = ordered.indexOf('acceptance.reconcile.failed');
    const blockedIdx = ordered.indexOf('epic.blocked');
    assert.notEqual(
      failedIdx,
      -1,
      'acceptance.reconcile.failed emitted on reconciler throw',
    );
    assert.notEqual(blockedIdx, -1, 'epic.blocked emitted on reconciler throw');
    assert.ok(
      failedIdx < blockedIdx,
      'acceptance.reconcile.failed precedes epic.blocked',
    );
    assert.ok(
      !ordered.includes('acceptance.reconcile.ok'),
      'no .ok emit on the failure path',
    );

    const failedEmit = emits[failedIdx];
    assert.match(
      failedEmit.payload.reason,
      /reconcile-threw/,
      'failure reason carries the throw classification',
    );
  });

  it('emits epic.blocked after acceptance.reconcile.failed on a gap classification', async () => {
    // The reconciler returning `status: 'gap'` is the more common
    // failure mode in production (the helper does not throw — it
    // surfaces missing/pending AC IDs in the result envelope). Pin
    // the cascade contract for that path too.
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2306,
      reconcileAcceptanceSpecFn: async () => ({
        status: 'gap',
        missing: ['AC-12'],
        pending: ['AC-9'],
      }),
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2306 });

    const ordered = emits.map((e) => e.event);
    const failedIdx = ordered.indexOf('acceptance.reconcile.failed');
    const blockedIdx = ordered.indexOf('epic.blocked');
    assert.ok(failedIdx >= 0 && blockedIdx >= 0);
    assert.ok(failedIdx < blockedIdx);

    const blockedEmit = emits[blockedIdx];
    assert.match(blockedEmit.payload.reason, /acceptance-reconcile:gap/);
  });
});
