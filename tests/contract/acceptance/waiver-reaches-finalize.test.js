// tests/contract/acceptance/waiver-reaches-finalize.test.js
/**
 * Contract: Finalizer subscribes to acceptance.reconcile.waived
 * (Story #2893 / Task #2902, Epic #2880).
 *
 * Story #2893 split `acceptance::n-a` waivers out of the catch-all
 * `acceptance.reconcile.skipped` event into a distinct
 * `acceptance.reconcile.waived` event so that the Finalizer can route
 * waived Epics through to PR creation. Before this split, the Finalizer
 * subscribed only to `.ok`, meaning waived Epics terminated without a
 * PR. The contract this test pins:
 *
 *   1. `Finalizer.events` exposes BOTH `acceptance.reconcile.ok` and
 *      `acceptance.reconcile.waived`.
 *   2. Emitting `acceptance.reconcile.waived` on the bus drives the
 *      Finalizer's `openOrLocatePr` flow exactly as `.ok` does — the
 *      injected `runFinalizeFn` (the PR-create collaborator) is called,
 *      and `pr.created` + `epic.finalize.end` are emitted in order.
 *   3. Emitting `acceptance.reconcile.skipped` does NOT trigger the
 *      Finalizer (it terminates the Epic without a PR — the empty-spec
 *      contract).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { Finalizer } from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordEmits(bus, events) {
  const seen = [];
  for (const event of events) {
    bus.on(event, async (ctx) => {
      seen.push({ event, payload: ctx.payload });
    });
  }
  return seen;
}

describe('contract: Finalizer subscribes to acceptance.reconcile.waived (Story #2893)', () => {
  it('Finalizer.events includes both acceptance.reconcile.ok and .waived', () => {
    const bus = new Bus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2880,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({ prUrl: 'https://example.test/pr/1' }),
      logger: quietLogger(),
    });
    const events = [...finalizer.events];
    assert.ok(
      events.includes('acceptance.reconcile.ok'),
      'Finalizer must still subscribe to .ok',
    );
    assert.ok(
      events.includes('acceptance.reconcile.waived'),
      'Finalizer must now also subscribe to .waived (Story #2893)',
    );
  });

  it('emitting acceptance.reconcile.waived drives Finalizer to invoke openOrLocatePr and emit pr.created', async () => {
    // Arrange.
    const bus = new Bus();
    const seen = recordEmits(bus, [
      'epic.finalize.start',
      'pr.created',
      'epic.finalize.end',
    ]);
    let finalizeCalls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2880,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => {
        finalizeCalls += 1;
        return { prUrl: 'https://github.com/owner/repo/pull/123' };
      },
      logger: quietLogger(),
    });
    finalizer.register();

    // Act — emit the waiver event the AcceptanceReconciler would emit
    // for an `acceptance::n-a` Epic.
    await bus.emit('acceptance.reconcile.waived', {
      baseRead: true,
      reason: 'waiver',
    });

    // Assert.
    assert.equal(
      finalizeCalls,
      1,
      'runFinalizeFn (openOrLocatePr) must be invoked exactly once on .waived',
    );
    const ordered = seen.map((e) => e.event);
    assert.deepEqual(
      ordered,
      ['epic.finalize.start', 'pr.created', 'epic.finalize.end'],
      'Finalizer must emit the canonical finalize sequence on .waived',
    );
    const prCreated = seen.find((e) => e.event === 'pr.created');
    assert.equal(
      prCreated.payload.prUrl,
      'https://github.com/owner/repo/pull/123',
    );
    assert.equal(prCreated.payload.head, 'epic/2880');
    assert.equal(prCreated.payload.base, 'main');
  });

  it('emitting acceptance.reconcile.skipped does NOT trigger the Finalizer (empty-spec terminates without a PR)', async () => {
    const bus = new Bus();
    const seen = recordEmits(bus, [
      'epic.finalize.start',
      'pr.created',
      'epic.finalize.end',
    ]);
    let finalizeCalls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2880,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => {
        finalizeCalls += 1;
        return { prUrl: 'https://example.test/pr/1' };
      },
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.skipped', {
      baseRead: false,
      reason: 'empty-spec',
    });

    assert.equal(
      finalizeCalls,
      0,
      'runFinalizeFn must NOT fire on .skipped (empty-spec path terminates without a PR)',
    );
    assert.equal(seen.length, 0, 'no finalize / pr.created emits on .skipped');
  });
});
