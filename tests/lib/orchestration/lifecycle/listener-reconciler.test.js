// tests/lib/orchestration/lifecycle/listener-reconciler.test.js
/**
 * Unit tests for the lifecycle AcceptanceReconciler listener
 * (Story #2253 / Task #2257).
 *
 * Acceptance contract:
 *   - An Epic with the `acceptance::n-a` waiver emits
 *     `acceptance.reconcile.skipped` with reason `'waiver'` and
 *     proceeds — no `epic.blocked` cascade.
 *   - A reconciliation failure emits
 *     `acceptance.reconcile.failed` AND `epic.blocked` in that order;
 *     no downstream `pr.created` is ever emitted in the same run
 *     (Finalizer subscribes only to `.ok`, so its absence is the
 *     load-bearing contract; the test asserts the emit order here and
 *     `tests/lib/orchestration/lifecycle/reconcile-ordering.test.js`
 *     pins it across the wider ledger).
 *   - Listener idempotency: a repeat `(event, seqId)` does not re-run
 *     reconciliation and does not re-emit any outcome event.
 *   - `classifyReconcileResult` is the pure decision surface — every
 *     reconciler `status` value maps to exactly one outcome.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  AcceptanceReconciler,
  classifyReconcileResult,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a bus that records every outcome / start / blocked emit so
 * tests can assert order + payload shape without a live ledger.
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

describe('classifyReconcileResult', () => {
  it('maps waived to skipped(reason=waiver)', () => {
    assert.deepEqual(classifyReconcileResult({ status: 'waived' }), {
      outcome: 'skipped',
      reason: 'waiver',
    });
  });

  it('maps empty-spec to skipped(reason=empty-spec)', () => {
    assert.deepEqual(classifyReconcileResult({ status: 'empty-spec' }), {
      outcome: 'skipped',
      reason: 'empty-spec',
    });
  });

  it('maps ok to ok', () => {
    assert.deepEqual(classifyReconcileResult({ status: 'ok' }), {
      outcome: 'ok',
    });
  });

  it('maps gap to failed with reason summary', () => {
    const out = classifyReconcileResult({
      status: 'gap',
      missing: ['AC-3'],
      pending: ['AC-2'],
    });
    assert.equal(out.outcome, 'failed');
    assert.match(out.reason, /missing=AC-3/);
    assert.match(out.reason, /pending=AC-2/);
  });

  it('maps absent result to failed', () => {
    assert.equal(classifyReconcileResult(null).outcome, 'failed');
    assert.equal(classifyReconcileResult(undefined).outcome, 'failed');
  });

  it('fails closed on unknown status', () => {
    const out = classifyReconcileResult({ status: 'mystery' });
    assert.equal(out.outcome, 'failed');
    assert.match(out.reason, /unknown-status/);
  });
});

describe('AcceptanceReconciler (bus integration)', () => {
  it('waiver path emits .start then .skipped(reason=waiver); no epic.blocked', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'waived' }),
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.skipped',
    ]);
    const skipped = emits.find(
      (e) => e.event === 'acceptance.reconcile.skipped',
    );
    assert.equal(skipped.payload.reason, 'waiver');
    assert.equal(skipped.payload.baseRead, true);
  });

  it('failure path emits .failed then epic.blocked in that order', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({
        status: 'gap',
        missing: ['AC-7'],
        pending: [],
      }),
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const ordered = emits.map((e) => e.event);
    const failedIdx = ordered.indexOf('acceptance.reconcile.failed');
    const blockedIdx = ordered.indexOf('epic.blocked');
    assert.notEqual(failedIdx, -1, 'reconcile.failed was emitted');
    assert.notEqual(blockedIdx, -1, 'epic.blocked was emitted');
    assert.ok(failedIdx < blockedIdx, 'reconcile.failed precedes epic.blocked');
    assert.ok(
      !ordered.includes('acceptance.reconcile.ok'),
      'no .ok emitted on failure',
    );
  });

  it('failure path when reconciler throws still emits .failed + epic.blocked', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => {
        throw new Error('boom-no-spec');
      },
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const failed = emits.find((e) => e.event === 'acceptance.reconcile.failed');
    assert.ok(failed, 'reconcile.failed was emitted on throw');
    assert.match(failed.payload.reason, /reconcile-threw/);
    assert.equal(failed.payload.baseRead, false);
    assert.ok(
      emits.some((e) => e.event === 'epic.blocked'),
      'epic.blocked emitted after reconciler throw',
    );
  });

  it('ok path emits .start then .ok; no epic.blocked', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'ok' }),
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.ok',
    ]);
  });

  it('listener is idempotent on repeat (event, seqId)', async () => {
    const { bus, emits } = recordingBus();
    let calls = 0;
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => {
        calls += 1;
        return { status: 'ok' };
      },
      logger: quietLogger(),
    });
    reconciler.register();

    // Drive `handle` twice with the same ctx (simulating a replay).
    const ctx = {
      event: 'epic.close.end',
      seqId: 42,
      payload: { epicId: 2172 },
    };
    await reconciler.handle(ctx);
    await reconciler.handle(ctx);

    assert.equal(calls, 1, 'reconciler invoked exactly once');
    const okEmits = emits.filter((e) => e.event === 'acceptance.reconcile.ok');
    assert.equal(okEmits.length, 1, 'one .ok emit only');
    const dup = reconciler.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup, 'duplicate seqId logged as skipped');
  });

  it('records a classification entry for every observed event (no silent skip)', async () => {
    const { bus } = recordingBus();
    let toggle = 'ok';
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: toggle }),
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });
    toggle = 'waived';
    await bus.emit('epic.close.end', { epicId: 2172 });
    toggle = 'gap';
    await bus.emit('epic.close.end', { epicId: 2172 });

    assert.equal(reconciler.classifications.length, 3);
    const outcomes = reconciler.classifications.map((c) => c.outcome);
    assert.deepEqual(outcomes, ['ok', 'skipped', 'failed']);
  });
});
