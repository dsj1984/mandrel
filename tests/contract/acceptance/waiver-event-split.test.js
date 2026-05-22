// tests/contract/acceptance/waiver-event-split.test.js
/**
 * Contract: AcceptanceReconciler — waiver vs empty-spec event split
 * (Story #2893 / Task #2913, Epic #2880).
 *
 * The reconciler MUST emit a distinct `acceptance.reconcile.waived`
 * event when the Epic carries `acceptance::n-a`, and `acceptance.
 * reconcile.skipped` only when the linked Acceptance Spec declares
 * zero AC IDs ('empty-spec'). The split is the load-bearing contract
 * that lets the Finalizer subscribe to `.waived` (Task #2902) and
 * route waived Epics through to PR creation while empty-spec Epics
 * still terminate without a PR.
 *
 * This is a contract test rather than a unit test because the assertion
 * surface is the **wire-shape of the lifecycle event** flowing across
 * the bus boundary — the event name and the schema-validated payload —
 * not the internal `classifyReconcileResult` return value (which has
 * its own pure-function unit coverage in
 * `tests/lib/orchestration/lifecycle/listener-reconciler.test.js`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AcceptanceReconciler } from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js';

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

describe('contract: acceptance.reconcile.waived (Story #2893)', () => {
  it('acceptance::n-a Epic emits exactly acceptance.reconcile.waived with reason=waiver', async () => {
    // Arrange.
    const bus = new Bus();
    const seen = recordEmits(bus, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.ok',
      'acceptance.reconcile.waived',
      'acceptance.reconcile.skipped',
      'acceptance.reconcile.failed',
    ]);
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2880,
      reconcileAcceptanceSpecFn: async () => ({ status: 'waived' }),
      logger: quietLogger(),
    });
    reconciler.register();

    // Act.
    await bus.emit('epic.close.end', { epicId: 2880 });

    // Assert: the wire shape is precisely .start → .waived, nothing else.
    const ordered = seen.map((e) => e.event);
    assert.deepEqual(ordered, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.waived',
    ]);
    const waived = seen.find((e) => e.event === 'acceptance.reconcile.waived');
    assert.equal(waived.payload.reason, 'waiver');
    assert.equal(typeof waived.payload.baseRead, 'boolean');
  });

  it('empty-spec Epic emits acceptance.reconcile.skipped with reason=empty-spec (no .waived)', async () => {
    const bus = new Bus();
    const seen = recordEmits(bus, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.ok',
      'acceptance.reconcile.waived',
      'acceptance.reconcile.skipped',
      'acceptance.reconcile.failed',
    ]);
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2880,
      reconcileAcceptanceSpecFn: async () => ({ status: 'empty-spec' }),
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2880 });

    const ordered = seen.map((e) => e.event);
    assert.deepEqual(ordered, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.skipped',
    ]);
    const skipped = seen.find(
      (e) => e.event === 'acceptance.reconcile.skipped',
    );
    assert.equal(skipped.payload.reason, 'empty-spec');
    assert.ok(
      !ordered.includes('acceptance.reconcile.waived'),
      'empty-spec must not emit the .waived event',
    );
  });

  it('waived payload conforms to the .waived schema (reason pinned to "waiver")', async () => {
    // The bus validates payloads against the JSON schema BEFORE
    // fanning out to listeners. If the schema rejects the payload,
    // emit() throws. Asserting that emit does NOT throw on a well-
    // formed waiver payload pins the schema contract directly.
    const bus = new Bus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2880,
      reconcileAcceptanceSpecFn: async () => ({ status: 'waived' }),
      logger: quietLogger(),
    });
    reconciler.register();

    await assert.doesNotReject(
      bus.emit('epic.close.end', { epicId: 2880 }),
      'reconciler emit chain must pass schema validation for the .waived payload',
    );
  });

  it('schema rejects a .waived payload with a non-waiver reason', async () => {
    // Defence in depth: confirm the schema's `const: 'waiver'` pin is
    // actually enforced by the bus. A drift-y caller passing
    // reason='something-else' must be rejected at emit time.
    const bus = new Bus();
    await assert.rejects(
      () => bus.emit('acceptance.reconcile.waived', {
        baseRead: true,
        reason: 'not-a-waiver',
      }),
      /schema validation failed/i,
      'bus must reject .waived payloads whose reason is not "waiver"',
    );
  });
});
