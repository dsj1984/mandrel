// tests/lib/orchestration/lifecycle/listener-finalizer.test.js
/**
 * Unit tests for the lifecycle Finalizer listener
 * (Story #2253 / Task #2254).
 *
 * Acceptance contract:
 *   - Subscribes to `acceptance.reconcile.ok` and `.waived` (Story
 *     #2893 added `.waived`); does NOT subscribe to `.skipped` /
 *     `.failed`.
 *   - Emits `epic.finalize.start` before any side effect.
 *   - On a fresh run with no existing PR, calls `runEpicDeliverFinalize`
 *     and emits `pr.created` then `epic.finalize.end` carrying the new
 *     PR URL.
 *   - Listener-level idempotency: a repeat `(event, seqId)` is recorded
 *     as `skipped:duplicate-seqId` and emits nothing.
 *   - Failure modes (legacy CLI threw, returned blocker, or returned no
 *     PR URL) are logged into the classification surface and do NOT
 *     emit `pr.created`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  extractPrUrl,
  Finalizer,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

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

describe('extractPrUrl', () => {
  it('parses a raw URL line', () => {
    assert.equal(
      extractPrUrl('https://github.com/owner/repo/pull/42\n'),
      'https://github.com/owner/repo/pull/42',
    );
  });

  it('parses the JSON-array form `[{"url":"…"}]`', () => {
    const raw = '[{"url":"https://github.com/owner/repo/pull/7"}]';
    assert.equal(extractPrUrl(raw), 'https://github.com/owner/repo/pull/7');
  });

  it('returns null for empty stdout', () => {
    assert.equal(extractPrUrl(''), null);
    assert.equal(extractPrUrl('   \n'), null);
  });

  it('returns null for malformed JSON', () => {
    assert.equal(extractPrUrl('[not json'), null);
  });
});

describe('Finalizer (bus integration)', () => {
  it('emits start → pr.created → finalize.end on a fresh open', async () => {
    const { bus, emits } = recordingBus();
    let finalizeCalls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      cwd: '/tmp',
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => {
        finalizeCalls += 1;
        return {
          epicId: 2172,
          ffOk: true,
          pushed: true,
          prUrl: 'https://github.com/owner/repo/pull/99',
          prNumber: 99,
          postedHandoff: true,
        };
      },
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.ok', { baseRead: true });

    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, [
      'epic.finalize.start',
      'pr.created',
      'epic.finalize.end',
    ]);
    const prCreated = emits.find((e) => e.event === 'pr.created');
    assert.equal(
      prCreated.payload.prUrl,
      'https://github.com/owner/repo/pull/99',
    );
    assert.equal(prCreated.payload.head, 'epic/2172');
    assert.equal(prCreated.payload.base, 'main');
    assert.equal(finalizeCalls, 1);
  });

  it('subscribes to acceptance.reconcile.{ok,waived} and NOT to .skipped/.failed', () => {
    const { bus } = recordingBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({ prUrl: 'x' }),
      logger: quietLogger(),
    });
    assert.deepEqual(
      [...finalizer.events],
      ['acceptance.reconcile.ok', 'acceptance.reconcile.waived'],
    );
  });

  it('listener is idempotent on repeat (event, seqId)', async () => {
    const { bus, emits } = recordingBus();
    let calls = 0;
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => {
        calls += 1;
        return { prUrl: 'https://github.com/o/r/pull/1' };
      },
      logger: quietLogger(),
    });
    finalizer.register();

    const ctx = {
      event: 'acceptance.reconcile.ok',
      seqId: 100,
      payload: { baseRead: true },
    };
    await finalizer.handle(ctx);
    await finalizer.handle(ctx);

    assert.equal(calls, 1, 'runFinalize invoked exactly once');
    const prEmits = emits.filter((e) => e.event === 'pr.created');
    assert.equal(prEmits.length, 1, 'pr.created emitted exactly once');
    const dup = finalizer.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup, 'duplicate seqId logged');
  });

  it('finalize blocker classifies as failed and emits no pr.created', async () => {
    const { bus, emits } = recordingBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({
        epicId: 2172,
        ffOk: false,
        blocker: { reason: 'main-ahead', detail: 'rebase needed' },
      }),
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.ok', { baseRead: true });

    assert.ok(
      !emits.some((e) => e.event === 'pr.created'),
      'no pr.created on blocker',
    );
    const failed = finalizer.classifications.find(
      (c) => c.outcome === 'failed',
    );
    assert.ok(failed, 'classification logged failed');
    assert.match(failed.reason, /blocker:main-ahead/);
  });

  it('legacy CLI throw is swallowed; no pr.created', async () => {
    const { bus, emits } = recordingBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => {
        throw new Error('boom');
      },
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.ok', { baseRead: true });

    assert.ok(
      !emits.some((e) => e.event === 'pr.created'),
      'no pr.created on throw',
    );
    const failed = finalizer.classifications.find(
      (c) => c.outcome === 'failed',
    );
    assert.ok(failed);
    assert.match(failed.reason, /finalize-threw/);
  });

  it('missing PR url is classified as failed:no-pr-url', async () => {
    const { bus, emits } = recordingBus();
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({ epicId: 2172, ffOk: true, prUrl: null }),
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('acceptance.reconcile.ok', { baseRead: true });

    assert.ok(!emits.some((e) => e.event === 'pr.created'));
    const failed = finalizer.classifications.find(
      (c) => c.outcome === 'failed',
    );
    assert.ok(failed);
    assert.equal(failed.reason, 'no-pr-url');
  });
});
