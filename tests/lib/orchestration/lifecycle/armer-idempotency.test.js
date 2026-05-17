// tests/lib/orchestration/lifecycle/armer-idempotency.test.js
/**
 * Contract test for the AutomergeArmer's two-layer idempotency
 * guarantee (Story #2256 / Task #2262 / Acceptance Spec AC-10).
 *
 * Two defences must compose:
 *
 *   1. Per-instance `(event, seqId)` Set — defeats bus-level replays
 *      within the same process.
 *
 *   2. `gh pr view --json autoMergeRequest` probe — defeats
 *      cross-process re-runs (`/epic-deliver` restarted on the same
 *      PR after a crash between `gh pr merge --auto` and the
 *      `epic.merge.armed` emit).
 *
 * The contract: regardless of how many times the armer is invoked
 * against an already-armed PR, `gh pr merge` MUST be called at most
 * once, and `epic.merge.armed` MUST be emitted exactly once per
 * unique `(event, seqId)`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AutomergeArmer } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

describe('AutomergeArmer — idempotency contract (AC-10)', () => {
  it('twice-invoked with the same (event, seqId) on an UN-armed PR — gh pr merge called exactly once', async () => {
    const bus = new Bus();
    const armedEmits = [];
    bus.on('epic.merge.armed', async (ctx) =>
      armedEmits.push({ seqId: ctx.seqId, prUrl: ctx.payload.prUrl }),
    );

    let mergeCalls = 0;
    // Probe: first invocation sees not-armed; second invocation (after
    // the listener guard fires) is never actually issued because the
    // seqId guard short-circuits before any probe.
    const probeStdouts = [
      '{"autoMergeRequest":null}',
      '{"autoMergeRequest":{"mergeMethod":"SQUASH"}}',
    ];
    let probeIdx = 0;
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout: probeStdouts[Math.min(probeIdx++, probeStdouts.length - 1)],
        stderr: '',
      }),
      ghPrMergeAutoFn: () => {
        mergeCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    const ctx = {
      event: 'epic.merge.ready',
      seqId: 400,
      payload: {
        prUrl: 'https://github.com/o/r/pull/9',
        reason: 'clean',
      },
    };
    await armer.handle(ctx);
    await armer.handle(ctx);
    await armer.handle(ctx);
    assert.equal(
      mergeCalls,
      1,
      'gh pr merge --auto MUST be called exactly once',
    );
    assert.equal(armedEmits.length, 1, 'epic.merge.armed emitted exactly once');
  });

  it('cross-process replay: distinct seqIds on an ALREADY-armed PR — gh pr merge NEVER called, armed emitted per seqId', async () => {
    // Simulates two separate process invocations:
    //   - First process: PR was armed in a prior run (the probe sees
    //     it armed before this seqId fires).
    //   - Second process: bus is fresh, brand new seqId, but the PR
    //     is still armed on GitHub.
    //
    // The probe defends both invocations from re-issuing the merge.
    const bus = new Bus();
    const armedEmits = [];
    bus.on('epic.merge.armed', async (ctx) =>
      armedEmits.push({ seqId: ctx.seqId }),
    );

    let mergeCalls = 0;
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout: '{"autoMergeRequest":{"mergeMethod":"SQUASH"}}',
        stderr: '',
      }),
      ghPrMergeAutoFn: () => {
        mergeCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    // Two distinct (event, seqId) pairs — listener-level guard does
    // NOT fire, so the probe defence is what we're verifying.
    await armer.handle({
      event: 'epic.merge.ready',
      seqId: 1,
      payload: { prUrl: 'https://github.com/o/r/pull/9', reason: 'clean' },
    });
    await armer.handle({
      event: 'epic.merge.ready',
      seqId: 2,
      payload: { prUrl: 'https://github.com/o/r/pull/9', reason: 'clean' },
    });
    assert.equal(
      mergeCalls,
      0,
      'gh pr merge MUST NOT be called when probe confirms already-armed',
    );
    assert.equal(armedEmits.length, 2, 'armed emitted per seqId (no dedupe)');
    // Both classifications must be `existing` (not `armed`).
    const existings = armer.classifications.filter(
      (c) => c.outcome === 'existing',
    );
    assert.equal(existings.length, 2);
  });

  it('first arms, then replays on already-armed PR — gh pr merge called exactly once', async () => {
    // Mixed scenario: first seqId arms, second seqId observes the
    // PR is now armed (probe returns armed JSON).
    const bus = new Bus();
    const armedEmits = [];
    bus.on('epic.merge.armed', async (ctx) =>
      armedEmits.push({ seqId: ctx.seqId }),
    );

    const probeResponses = [
      // First seqId — not yet armed.
      { status: 0, stdout: '{"autoMergeRequest":null}', stderr: '' },
      // Second seqId — armed by first run.
      {
        status: 0,
        stdout: '{"autoMergeRequest":{"mergeMethod":"SQUASH"}}',
        stderr: '',
      },
    ];
    let probeIdx = 0;
    let mergeCalls = 0;
    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () =>
        probeResponses[Math.min(probeIdx++, probeResponses.length - 1)],
      ghPrMergeAutoFn: () => {
        mergeCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    await armer.handle({
      event: 'epic.merge.ready',
      seqId: 10,
      payload: { prUrl: 'https://github.com/o/r/pull/9', reason: 'clean' },
    });
    await armer.handle({
      event: 'epic.merge.ready',
      seqId: 11,
      payload: { prUrl: 'https://github.com/o/r/pull/9', reason: 'clean' },
    });
    assert.equal(mergeCalls, 1, 'gh pr merge invoked exactly once');
    assert.equal(armedEmits.length, 2);
    const outcomes = armer.classifications.map((c) => c.outcome);
    assert.deepEqual(outcomes, ['armed', 'existing']);
  });
});
