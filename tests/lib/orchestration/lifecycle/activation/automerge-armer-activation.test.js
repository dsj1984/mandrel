// tests/lib/orchestration/lifecycle/activation/automerge-armer-activation.test.js
/**
 * Activation contract for the wired AutomergeArmer listener
 * (Story #2336 / Task #2339 / Epic #2306).
 *
 * The unit-level idempotency contract is already covered by
 * `armer-idempotency.test.js` (which drives `armer.handle(...)`
 * directly). This file pins the load-bearing safety invariant at the
 * BUS-DRIVEN activation seam — the same surface the production factory
 * wires:
 *
 *   - Two consecutive `bus.emit('epic.merge.ready', payload)` emissions
 *     for the same PR MUST result in **exactly one** `gh pr merge --auto`
 *     invocation.
 *   - Idempotency is enforced via the cross-process
 *     `gh pr view --json autoMergeRequest` probe: after the first emit
 *     arms auto-merge, the second emit observes the armed PR and
 *     short-circuits without re-issuing the merge command.
 *   - The listener subscribes **only** to `epic.merge.ready` — it MUST
 *     NOT react to `epic.watch.end` or `epic.merge.blocked`, even when
 *     those events carry the same `prUrl`.
 *
 * This is the runtime closure of High-1 from the Epic #2172 review: the
 * legacy `epic-deliver-automerge.js` could fire `gh pr merge` before
 * the predicate ran; with AutomergeArmer wired to `epic.merge.ready`
 * only, the predicate's verdict is the sole gate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AutomergeArmer } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Build an armer wired against a fresh bus with controllable
 * `gh pr view` / `gh pr merge` shell-out stubs. Returns the bus, the
 * armer, and the call counters so tests can drive `bus.emit(...)` and
 * inspect the side-effect tally.
 */
function buildArmedBus({ probeSequence }) {
  const bus = new Bus();
  const armedEmits = [];
  bus.on('epic.merge.armed', async (ctx) =>
    armedEmits.push({ seqId: ctx.seqId, prUrl: ctx.payload?.prUrl }),
  );

  const counters = { probes: 0, merges: 0 };
  let probeIdx = 0;
  const armer = new AutomergeArmer({
    bus,
    ghPrViewAutoMergeFn: () => {
      counters.probes += 1;
      const next = probeSequence[Math.min(probeIdx, probeSequence.length - 1)];
      probeIdx += 1;
      return next;
    },
    ghPrMergeAutoFn: () => {
      counters.merges += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
    logger: quietLogger(),
  });
  armer.register();
  return { bus, armer, armedEmits, counters };
}

describe('AutomergeArmer — bus-driven idempotency via gh pr view --json autoMergeRequest', () => {
  it('two consecutive epic.merge.ready emits ⇒ exactly one gh pr merge --auto invocation', async () => {
    // Probe responses model the production crash-recovery path:
    //   1st emit: probe sees NOT armed → listener calls `gh pr merge`.
    //   2nd emit: probe sees ALREADY armed (the first arm succeeded) →
    //             listener short-circuits without re-issuing the merge.
    const { bus, armedEmits, counters } = buildArmedBus({
      probeSequence: [
        { status: 0, stdout: '{"autoMergeRequest":null}', stderr: '' },
        {
          status: 0,
          stdout: '{"autoMergeRequest":{"mergeMethod":"SQUASH"}}',
          stderr: '',
        },
      ],
    });

    const payload = {
      prUrl: 'https://github.com/dsj1984/mandrel/pull/9999',
      reason: 'clean',
    };

    await bus.emit('epic.merge.ready', payload);
    await bus.emit('epic.merge.ready', payload);

    assert.equal(
      counters.merges,
      1,
      'gh pr merge --auto MUST be called exactly once across two bus-driven ready emits',
    );
    assert.equal(
      counters.probes,
      2,
      'gh pr view probe runs once per emit (no per-instance dedupe by prUrl)',
    );
    assert.equal(
      armedEmits.length,
      2,
      'epic.merge.armed emits once per ready (both branches reach the armed emit)',
    );
    assert.equal(armedEmits[0].prUrl, payload.prUrl);
    assert.equal(armedEmits[1].prUrl, payload.prUrl);
  });

  it('three consecutive emits on an ALREADY-armed PR ⇒ zero gh pr merge calls', async () => {
    // Cross-process recovery: the first run armed the PR before crashing.
    // On restart the probe sees the existing arm for every emit; merge
    // MUST never be re-issued.
    const { bus, armedEmits, counters } = buildArmedBus({
      probeSequence: [
        {
          status: 0,
          stdout: '{"autoMergeRequest":{"mergeMethod":"SQUASH"}}',
          stderr: '',
        },
      ],
    });
    const payload = {
      prUrl: 'https://github.com/dsj1984/mandrel/pull/1234',
      reason: 'clean',
    };
    await bus.emit('epic.merge.ready', payload);
    await bus.emit('epic.merge.ready', payload);
    await bus.emit('epic.merge.ready', payload);
    assert.equal(
      counters.merges,
      0,
      'gh pr merge MUST NOT be called when probe confirms prior arm',
    );
    assert.equal(armedEmits.length, 3);
  });

  it('subscribes ONLY to epic.merge.ready — does not react to epic.watch.end or epic.merge.blocked', async () => {
    const { bus, counters } = buildArmedBus({
      probeSequence: [
        { status: 0, stdout: '{"autoMergeRequest":null}', stderr: '' },
      ],
    });
    // Emit the two adjacent events the armer MUST ignore.
    await bus.emit('epic.watch.end', {
      prUrl: 'https://github.com/dsj1984/mandrel/pull/5678',
      checkOutcomes: { lint: 'success' },
    });
    await bus.emit('epic.merge.blocked', {
      prUrl: 'https://github.com/dsj1984/mandrel/pull/5678',
      reason: 'predicate-dirty',
    });
    assert.equal(
      counters.probes,
      0,
      'no probe runs for epic.watch.end / epic.merge.blocked',
    );
    assert.equal(
      counters.merges,
      0,
      'gh pr merge MUST NOT fire for epic.watch.end / epic.merge.blocked',
    );
  });
});
