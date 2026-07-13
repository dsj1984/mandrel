// tests/lib/orchestration/lifecycle/listener-reconciler.test.js
/**
 * Unit tests for the lifecycle AcceptanceReconciler listener
 * (Story #2253 / Task #2257; Story #2893 split `.waived` out of
 * `.skipped`).
 *
 * Acceptance contract:
 *   - An Epic with the `acceptance::n-a` waiver emits
 *     `acceptance.reconcile.waived` with reason `'waiver'` and
 *     proceeds — no `epic.blocked` cascade. The Finalizer subscribes
 *     to `.waived` so waived Epics still flow through to PR creation.
 *   - An Epic with an empty Acceptance Spec emits
 *     `acceptance.reconcile.skipped` with reason `'empty-spec'`. The
 *     Finalizer does NOT subscribe to `.skipped`, so empty-spec Epics
 *     terminate without a PR.
 *   - A reconciliation failure emits
 *     `acceptance.reconcile.failed` AND `epic.blocked` in that order;
 *     no downstream `pr.created` is ever emitted in the same run
 *     (Finalizer subscribes only to `.ok` and `.waived`, so its
 *     absence is the load-bearing contract; the test asserts the emit
 *     order here and
 *     `tests/lib/orchestration/lifecycle/reconcile-ordering.test.js`
 *     pins it across the wider ledger).
 *   - Listener idempotency: a repeat `(event, seqId)` does not re-run
 *     reconciliation and does not re-emit any outcome event.
 *   - `classifyReconcileResult` is the pure decision surface — every
 *     reconciler `status` value maps to exactly one outcome.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { write as writeEpicRunState } from '../../../../.agents/scripts/lib/orchestration/epic-run-state-store.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  AcceptanceReconciler,
  classifyReconcileResult,
  defaultResolveSingle,
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
  bus.on('acceptance.reconcile.waived', record('acceptance.reconcile.waived'));
  bus.on(
    'acceptance.reconcile.skipped',
    record('acceptance.reconcile.skipped'),
  );
  bus.on('acceptance.reconcile.failed', record('acceptance.reconcile.failed'));
  bus.on('epic.blocked', record('epic.blocked'));
  return { bus, emits };
}

describe('classifyReconcileResult', () => {
  it('maps waived to waived(reason=waiver)', () => {
    assert.deepEqual(classifyReconcileResult({ status: 'waived' }), {
      outcome: 'waived',
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

  // Epic #4475 (M4-B, §2c): the non-waivable epic reconcile back gate.
  it('waived → waived on the fan-out route (single omitted / false)', () => {
    assert.equal(
      classifyReconcileResult({ status: 'waived' }).outcome,
      'waived',
    );
    assert.equal(
      classifyReconcileResult({ status: 'waived' }, { single: false }).outcome,
      'waived',
    );
  });

  it('waived → FAILED under single delivery (non-waivable)', () => {
    const out = classifyReconcileResult({ status: 'waived' }, { single: true });
    assert.equal(out.outcome, 'failed');
    assert.match(out.reason, /single-delivery-non-waivable/);
  });

  it('single: true does not change ok / gap / empty-spec classification', () => {
    assert.equal(
      classifyReconcileResult({ status: 'ok' }, { single: true }).outcome,
      'ok',
    );
    assert.equal(
      classifyReconcileResult({ status: 'empty-spec' }, { single: true })
        .outcome,
      'skipped',
    );
    assert.equal(
      classifyReconcileResult(
        { status: 'gap', missing: ['AC-1'] },
        {
          single: true,
        },
      ).outcome,
      'failed',
    );
  });
});

describe('AcceptanceReconciler (bus integration)', () => {
  it('waiver path emits .start then .waived(reason=waiver); no epic.blocked', async () => {
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
      'acceptance.reconcile.waived',
    ]);
    const waived = emits.find((e) => e.event === 'acceptance.reconcile.waived');
    assert.equal(waived.payload.reason, 'waiver');
    assert.equal(waived.payload.baseRead, true);
    assert.ok(
      !ordered.includes('acceptance.reconcile.skipped'),
      'waiver path must not also emit .skipped (Story #2893 split)',
    );
  });

  it('empty-spec path emits .start then .skipped(reason=empty-spec); no .waived', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'empty-spec' }),
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
    assert.equal(skipped.payload.reason, 'empty-spec');
    assert.ok(
      !ordered.includes('acceptance.reconcile.waived'),
      'empty-spec path must not emit .waived (Story #2893 split)',
    );
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

  it('single delivery: a waived reconcile emits .failed + epic.blocked, never .waived', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 4475,
      reconcileAcceptanceSpecFn: async () => ({ status: 'waived' }),
      resolveSingleFn: async () => true, // single-delivery Epic
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 4475 });

    const ordered = emits.map((e) => e.event);
    assert.ok(
      !ordered.includes('acceptance.reconcile.waived'),
      'single delivery must NOT pass a waived reconcile through',
    );
    const failedIdx = ordered.indexOf('acceptance.reconcile.failed');
    const blockedIdx = ordered.indexOf('epic.blocked');
    assert.ok(failedIdx !== -1 && blockedIdx !== -1);
    assert.ok(failedIdx < blockedIdx, '.failed precedes epic.blocked');
    const failed = emits.find((e) => e.event === 'acceptance.reconcile.failed');
    assert.match(failed.payload.reason, /single-delivery-non-waivable/);
  });

  it('fan-out: a waived reconcile still passes through to .waived (no regression)', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'waived' }),
      resolveSingleFn: async () => false, // fan-out Epic
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, [
      'acceptance.reconcile.start',
      'acceptance.reconcile.waived',
    ]);
    assert.ok(!ordered.includes('epic.blocked'));
  });

  it('a resolveSingleFn that throws degrades to fan-out (never invents a block)', async () => {
    const { bus, emits } = recordingBus();
    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'waived' }),
      resolveSingleFn: async () => {
        throw new Error('probe failed');
      },
      logger: quietLogger(),
    });
    reconciler.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const ordered = emits.map((e) => e.event);
    assert.ok(ordered.includes('acceptance.reconcile.waived'));
    assert.ok(!ordered.includes('epic.blocked'));
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
    assert.deepEqual(outcomes, ['ok', 'waived', 'failed']);
  });
});

describe('defaultResolveSingle — delivery-shape probe (Epic #4475)', () => {
  function commentProvider({ labels = [] } = {}) {
    let autoId = 1;
    const comments = new Map();
    return {
      async getTicket() {
        return { labels };
      },
      async getTicketComments(ticketId) {
        return comments.get(ticketId) ?? [];
      },
      async postComment(ticketId, payload) {
        const list = comments.get(ticketId) ?? [];
        const c = { id: autoId++, body: payload.body };
        list.push(c);
        comments.set(ticketId, list);
        return c;
      },
      async deleteComment(commentId) {
        for (const [, list] of comments) {
          const idx = list.findIndex((c) => c.id === commentId);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
    };
  }

  it('null provider degrades to false (fan-out)', async () => {
    assert.equal(
      await defaultResolveSingle({ provider: null, epicId: 4475 }),
      false,
    );
  });

  it('true when the epic-run-state checkpoint deliveryShape is "single"', async () => {
    const provider = commentProvider({ labels: [] });
    await writeEpicRunState({
      provider,
      epicId: 4475,
      state: { epicId: 4475, deliveryShape: 'single', slices: {} },
    });
    assert.equal(await defaultResolveSingle({ provider, epicId: 4475 }), true);
  });

  it('true off the delivery::single label when the checkpoint is not single', async () => {
    const provider = commentProvider({
      labels: ['type::epic', 'delivery::single'],
    });
    // No checkpoint written → falls through to the label probe.
    assert.equal(await defaultResolveSingle({ provider, epicId: 4475 }), true);
  });

  it('false for a fan-out Epic (no checkpoint shape, no label)', async () => {
    const provider = commentProvider({ labels: ['type::epic'] });
    assert.equal(await defaultResolveSingle({ provider, epicId: 4475 }), false);
  });
});
