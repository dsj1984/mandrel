// tests/lib/orchestration/lifecycle/finalize-idempotency.test.js
/**
 * Contract test for the Finalizer listener's `gh pr list --head` short-
 * circuit (Story #2253 / Task #2254 / AC-10).
 *
 * Asserts that a re-run of the Finalizer with the same (event, seqId)
 * AND an existing PR on the head branch:
 *   - Does NOT call `runEpicDeliverFinalize` (no second `gh pr create`).
 *   - Still emits exactly one `pr.created` carrying the EXISTING URL.
 *   - Records the outcome as `'existing'` on the classification log so
 *     operators can see the short-circuit happened (AC-9, no silent
 *     skip).
 *
 * The "same (event, seqId)" guard would already prevent a re-run from
 * within the same bus instance — but cross-process re-runs of
 * `/epic-deliver` after a crash carry fresh seqIds. The probe is the
 * defence for that case. We exercise both:
 *   - Fresh listener instance + existing PR → short-circuit fires.
 *   - Same listener instance + repeat seqId → listener short-circuits
 *     before the probe even runs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { Finalizer } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.finalize.start', record('epic.finalize.start'));
  bus.on('epic.finalize.end', record('epic.finalize.end'));
  bus.on('pr.created', record('pr.created'));
  return { bus, emits };
}

describe('Finalizer idempotency — gh pr list --head short-circuit', () => {
  it('cross-process re-run with existing PR does NOT open a duplicate', async () => {
    const { bus, emits } = recordingBus();
    const existingUrl = 'https://github.com/owner/repo/pull/777';

    let finalizeCalls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      cwd: '/tmp',
      ghPrListHeadFn: ({ epicBranch }) => {
        assert.equal(epicBranch, 'epic/2172');
        return { status: 0, stdout: `${existingUrl}\n`, stderr: '' };
      },
      runFinalizeFn: async () => {
        finalizeCalls += 1;
        throw new Error('runFinalize should NOT be called when PR exists');
      },
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.ok', { baseRead: true });

    assert.equal(finalizeCalls, 0, 'runEpicDeliverFinalize was not called');
    const prEmits = emits.filter((e) => e.event === 'pr.created');
    assert.equal(prEmits.length, 1, 'pr.created emitted exactly once');
    assert.equal(prEmits[0].payload.prUrl, existingUrl);
    const cls = finalizer.classifications.find((c) => c.outcome === 'existing');
    assert.ok(cls, 'classification recorded short-circuit as existing');
  });

  it('twice-invoked same (event, seqId) does NOT open a second PR', async () => {
    const { bus, emits } = recordingBus();
    let probeCalls = 0;
    let finalizeCalls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => {
        probeCalls += 1;
        // No existing PR — force runFinalize to be the one creating it.
        return { status: 0, stdout: '', stderr: '' };
      },
      runFinalizeFn: async () => {
        finalizeCalls += 1;
        return { prUrl: 'https://github.com/o/r/pull/1' };
      },
      logger: quietLogger(),
    });
    finalizer.register();

    // Drive `handle` directly twice with the same ctx. (`bus.emit`
    // would mint a fresh seqId on every call; the goal here is to
    // exercise the listener-level guard, so we bypass the bus to pin
    // seqId=99.)
    const ctx = {
      event: 'acceptance.reconcile.ok',
      seqId: 99,
      payload: { baseRead: true },
    };
    await finalizer.handle(ctx);
    await finalizer.handle(ctx);

    assert.equal(probeCalls, 1, 'gh pr list probe ran once');
    assert.equal(finalizeCalls, 1, 'runFinalize ran once');
    const prEmits = emits.filter((e) => e.event === 'pr.created');
    assert.equal(prEmits.length, 1, 'pr.created emitted exactly once');
    const dup = finalizer.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup, 'duplicate seqId classified');
  });

  it('probe failure falls through to runFinalize (degraded but not broken)', async () => {
    const { bus, emits } = recordingBus();
    let finalizeCalls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({
        status: 1,
        stdout: '',
        stderr: 'auth required',
      }),
      runFinalizeFn: async () => {
        finalizeCalls += 1;
        return { prUrl: 'https://github.com/o/r/pull/9' };
      },
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.ok', { baseRead: true });

    assert.equal(finalizeCalls, 1, 'runFinalize ran despite probe failure');
    assert.equal(
      emits.filter((e) => e.event === 'pr.created').length,
      1,
      'one pr.created emit',
    );
  });
});
