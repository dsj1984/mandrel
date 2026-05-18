// tests/lib/orchestration/lifecycle/activation/automerge-predicate-activation.test.js
/**
 * Activation contract: AutomergePredicate routes `epic.watch.end` to
 * `epic.merge.ready` on a clean verdict and to `epic.merge.blocked`
 * when the legacy evaluator reports a manual-intervention / blocker /
 * review-finding flag. Story #2333 / Task #2335 — proves the predicate's
 * two-branch routing wiring before Task #2337 registers the listener in
 * the production factory's close-tail chain.
 *
 * Both branches share the same surface (the `epic.watch.end` payload
 * carries `prUrl` plus an all-green `checkOutcomes` map), so the legacy
 * structured-signal verdict is the discriminator. The clean-state
 * branch returns `{ clean: true }` from the injected evaluator; the
 * blocker-state branch returns `{ clean: false, reasons: […] }`.
 *
 * Side-effect firewall (mirrors the listener's contract): the
 * recording bus is the only side-effect surface — no GitHub labels,
 * comments, or notify hooks are touched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AutomergePredicate } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Build a bus that captures every emit on the two outcome channels the
 * AC pins (`epic.merge.ready`, `epic.merge.blocked`) plus the umbrella
 * `epic.watch.end` so the test can assert ordering.
 */
function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.watch.end', record('epic.watch.end'));
  bus.on('epic.merge.ready', record('epic.merge.ready'));
  bus.on('epic.merge.blocked', record('epic.merge.blocked'));
  return { bus, emits };
}

const STUB_PROVIDER = Object.freeze({
  // Listener never calls into the provider directly — the injected
  // evaluator owns all GitHub reads. Freezing an empty object is enough
  // to satisfy the constructor's truthy-provider guard.
});

describe('AutomergePredicate activation (epic.watch.end → ready|blocked)', () => {
  it('emits exactly one epic.merge.ready on a clean verdict', async () => {
    const { bus, emits } = recordingBus();
    let evaluatorCalls = 0;
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2306,
      provider: STUB_PROVIDER,
      evaluatePredicateFn: async () => {
        evaluatorCalls += 1;
        return {
          clean: true,
          reasons: [],
          signals: {
            manualInterventions: 0,
            waveStatuses: ['complete'],
            storyBlockers: 0,
          },
        };
      },
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/dsj1984/mandrel/pull/9999',
      checkOutcomes: { lint: 'success', test: 'success' },
    });

    const ready = emits.filter((e) => e.event === 'epic.merge.ready');
    const blocked = emits.filter((e) => e.event === 'epic.merge.blocked');
    assert.equal(
      ready.length,
      1,
      'exactly one epic.merge.ready emission on a clean verdict',
    );
    assert.equal(
      blocked.length,
      0,
      'no epic.merge.blocked emissions on a clean verdict',
    );
    assert.equal(evaluatorCalls, 1, 'legacy evaluator consulted exactly once');
    assert.equal(
      predicate.classifications.length,
      1,
      'predicate classified exactly one epic.watch.end',
    );
    assert.equal(predicate.classifications[0].outcome, 'ready');
    assert.equal(
      ready[0].payload.prUrl,
      'https://github.com/dsj1984/mandrel/pull/9999',
    );
  });

  it('emits exactly one epic.merge.blocked when the predicate flags a blocker', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 2306,
      provider: STUB_PROVIDER,
      evaluatePredicateFn: async () => ({
        clean: false,
        reasons: [
          'manual intervention required (1 entry)',
          'story #1234 still blocked',
          'code-review: 2 critical blockers',
        ],
        signals: {
          manualInterventions: 1,
          storyBlockers: 1,
          severity: { critical: 2, high: 0, medium: 0, suggestion: 0 },
        },
      }),
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/dsj1984/mandrel/pull/9999',
      checkOutcomes: { lint: 'success', test: 'success' },
    });

    const ready = emits.filter((e) => e.event === 'epic.merge.ready');
    const blocked = emits.filter((e) => e.event === 'epic.merge.blocked');
    assert.equal(
      blocked.length,
      1,
      'exactly one epic.merge.blocked emission on a blocker verdict',
    );
    assert.equal(
      ready.length,
      0,
      'no epic.merge.ready emissions when the predicate is dirty',
    );
    assert.equal(predicate.classifications.length, 1);
    assert.equal(predicate.classifications[0].outcome, 'blocked');
    assert.match(
      blocked[0].payload.reason,
      /manual intervention required/,
      'blocker reason surfaces the first predicate reason verbatim',
    );
    assert.equal(
      blocked[0].payload.prUrl,
      'https://github.com/dsj1984/mandrel/pull/9999',
    );
  });
});
