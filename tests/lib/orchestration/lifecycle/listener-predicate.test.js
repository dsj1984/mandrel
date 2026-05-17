// tests/lib/orchestration/lifecycle/listener-predicate.test.js
/**
 * Unit tests for the lifecycle AutomergePredicate listener
 * (Story #2256 / Task #2260).
 *
 * Acceptance contract:
 *   - Subscribes to `epic.watch.end` (and ONLY that event).
 *   - Verdict for clean inputs is IDENTICAL to the legacy
 *     `lib/orchestration/automerge-predicate.js` `evaluateAutoMergePredicate`
 *     — the listener wraps it.
 *   - Required-check failures short-circuit to `epic.merge.blocked`
 *     BEFORE the legacy evaluator is consulted.
 *   - `epic.merge.blocked` always carries a non-empty `reason`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  AutomergePredicate,
  formatCheckFailureReason,
  listFailingChecks,
  NON_FAILING_CHECK_OUTCOMES,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.merge.ready', record('epic.merge.ready'));
  bus.on('epic.merge.blocked', record('epic.merge.blocked'));
  return { bus, emits };
}

const fakeProvider = { __tag: 'fake-provider' };

describe('NON_FAILING_CHECK_OUTCOMES', () => {
  it('includes success, neutral, skipped', () => {
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('success'), true);
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('neutral'), true);
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('skipped'), true);
  });

  it('excludes failure, timed_out, cancelled, action_required', () => {
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('failure'), false);
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('timed_out'), false);
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('cancelled'), false);
    assert.equal(NON_FAILING_CHECK_OUTCOMES.has('action_required'), false);
  });
});

describe('listFailingChecks', () => {
  it('returns [] for an all-green map', () => {
    assert.deepEqual(
      listFailingChecks({ lint: 'success', test: 'neutral', a: 'skipped' }),
      [],
    );
  });

  it('returns entries that are not success/neutral/skipped', () => {
    const out = listFailingChecks({
      lint: 'success',
      test: 'failure',
      build: 'timed_out',
    });
    assert.deepEqual(out, [
      { name: 'test', outcome: 'failure' },
      { name: 'build', outcome: 'timed_out' },
    ]);
  });
});

describe('formatCheckFailureReason', () => {
  it('formats a short list inline', () => {
    const reason = formatCheckFailureReason([
      { name: 'test', outcome: 'failure' },
    ]);
    assert.match(reason, /test=failure/);
  });

  it('truncates beyond 5 entries with a +N suffix', () => {
    const fails = Array.from({ length: 7 }, (_, i) => ({
      name: `c${i}`,
      outcome: 'failure',
    }));
    const reason = formatCheckFailureReason(fails);
    assert.match(reason, /\+2 more/);
  });
});

describe('AutomergePredicate (bus integration)', () => {
  it('subscribes ONLY to epic.watch.end', () => {
    const predicate = new AutomergePredicate({
      bus: new Bus(),
      epicId: 2172,
      provider: fakeProvider,
      evaluatePredicateFn: async () => ({
        clean: true,
        reasons: [],
        signals: {},
      }),
      logger: quietLogger(),
    });
    assert.deepEqual([...predicate.events], ['epic.watch.end']);
  });

  it('emits epic.merge.ready when every check is green and verdict.clean', async () => {
    const { bus, emits } = recordingBus();
    let evalCalls = 0;
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2172,
      provider: fakeProvider,
      evaluatePredicateFn: async () => {
        evalCalls += 1;
        return { clean: true, reasons: [], signals: {} };
      },
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      checkOutcomes: { lint: 'success', test: 'success' },
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.ready');
    assert.equal(evalCalls, 1, 'legacy evaluator consulted exactly once');
  });

  it('emits epic.merge.blocked with non-empty reason when a check fails — BEFORE consulting legacy evaluator', async () => {
    const { bus, emits } = recordingBus();
    let evalCalls = 0;
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2172,
      provider: fakeProvider,
      evaluatePredicateFn: async () => {
        evalCalls += 1;
        return { clean: true, reasons: [], signals: {} };
      },
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      checkOutcomes: { lint: 'success', test: 'failure' },
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.ok(emits[0].payload.reason.length > 0, 'reason is non-empty');
    assert.match(emits[0].payload.reason, /test=failure/);
    assert.equal(
      evalCalls,
      0,
      'legacy evaluator NOT consulted when a required check failed',
    );
  });

  it('emits epic.merge.blocked when verdict.clean is false', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2172,
      provider: fakeProvider,
      evaluatePredicateFn: async () => ({
        clean: false,
        reasons: [
          'manual interventions recorded (2): foo; bar',
          'code-review has 1 🔴 Critical Blocker(s)',
        ],
        signals: {},
      }),
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/owner/repo/pull/9',
      checkOutcomes: { lint: 'success' },
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.match(emits[0].payload.reason, /manual interventions/);
  });

  it('verdict for clean inputs is IDENTICAL to legacy evaluator (parity)', async () => {
    // Drive the listener with the same { clean, reasons, signals }
    // envelope the legacy evaluator would produce; verify the listener
    // routes verbatim. This is the parity contract: if the legacy
    // evaluator says clean, we emit ready; if it says dirty, we emit
    // blocked with the same reasons.
    const cleanVerdict = {
      clean: true,
      reasons: [],
      signals: { manualInterventions: 0, retroCompact: true },
    };
    const dirtyVerdict = {
      clean: false,
      reasons: ['retro is not compact'],
      signals: { retroCompact: false },
    };

    for (const [verdict, expected] of [
      [cleanVerdict, 'epic.merge.ready'],
      [dirtyVerdict, 'epic.merge.blocked'],
    ]) {
      const { bus, emits } = recordingBus();
      const predicate = new AutomergePredicate({
        bus,
        epicId: 2172,
        provider: fakeProvider,
        evaluatePredicateFn: async () => verdict,
        logger: quietLogger(),
      });
      predicate.register();
      await bus.emit('epic.watch.end', {
        prUrl: 'https://github.com/o/r/pull/9',
        checkOutcomes: { lint: 'success' },
      });
      assert.equal(emits[0].event, expected);
    }
  });

  it('evaluator throw is conservatively treated as blocked', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2172,
      provider: fakeProvider,
      evaluatePredicateFn: async () => {
        throw new Error('checkpoint corruption');
      },
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/o/r/pull/9',
      checkOutcomes: { lint: 'success' },
    });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.match(emits[0].payload.reason, /predicate-threw/);
  });

  it('listener is idempotent on repeat (event, seqId)', async () => {
    const bus = new Bus();
    const emits = [];
    bus.on('epic.merge.ready', async (ctx) => emits.push(ctx));
    bus.on('epic.merge.blocked', async (ctx) => emits.push(ctx));

    let evalCalls = 0;
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2172,
      provider: fakeProvider,
      evaluatePredicateFn: async () => {
        evalCalls += 1;
        return { clean: true, reasons: [], signals: {} };
      },
      logger: quietLogger(),
    });
    predicate.register();

    const ctx = {
      event: 'epic.watch.end',
      seqId: 200,
      payload: {
        prUrl: 'https://github.com/o/r/pull/1',
        checkOutcomes: { lint: 'success' },
      },
    };
    await predicate.handle(ctx);
    await predicate.handle(ctx);
    assert.equal(emits.length, 1, 'emitted exactly once');
    assert.equal(evalCalls, 1, 'evaluator invoked exactly once');
    const dup = predicate.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup);
  });
});
