/**
 * tests/contract/finalize/story-close-final-label-assertion.test.js
 *
 * Story #2961 — `story-close.js` must never return `success: true` when
 * the Story ticket has not actually reached `agent::done` after the
 * post-merge cascade. Mirrors the runner-side `verifyWaveResults`
 * downgrade so the discrepancy fires at the close boundary instead of
 * one phase later.
 *
 * Covers the two new exports in `phases/close.js`:
 *   - `verifyFinalStoryLabel` (the GitHub readback)
 *   - `buildCloseEnvelope`    (the envelope shape decision)
 */

import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  buildCloseEnvelope,
  verifyFinalStoryLabel,
} from '../../../.agents/scripts/lib/orchestration/story-close/phases/close.js';

const baseResult = () => ({
  storyId: 100,
  epicId: 1,
  action: 'merged',
  merged: true,
  ticketsClosed: [100],
  cascadedTo: [],
  cascadeFailed: [],
});

describe('verifyFinalStoryLabel — Story #2961', () => {
  it('returns ok=true when the ticket carries agent::done', async () => {
    const provider = {
      getTicket: mock.fn(async () => ({ labels: ['agent::done'] })),
    };
    const verdict = await verifyFinalStoryLabel({ provider, storyId: 100 });
    assert.deepEqual(verdict, { ok: true });
  });

  it('returns ok=true when the ticket is closed even without the label', async () => {
    const provider = {
      getTicket: mock.fn(async () => ({ labels: [], state: 'closed' })),
    };
    const verdict = await verifyFinalStoryLabel({ provider, storyId: 100 });
    assert.deepEqual(verdict, { ok: true });
  });

  it('returns ok=false with actualLabels when the cascade left agent::closing sticky', async () => {
    const provider = {
      getTicket: mock.fn(async () => ({ labels: ['agent::closing'] })),
    };
    const verdict = await verifyFinalStoryLabel({ provider, storyId: 100 });
    assert.deepEqual(verdict, {
      ok: false,
      actualLabels: ['agent::closing'],
    });
  });

  it('downgrades to skipped + warning when getTicket throws', async () => {
    const provider = {
      getTicket: mock.fn(async () => {
        throw new Error('rate-limited');
      }),
    };
    const verdict = await verifyFinalStoryLabel({ provider, storyId: 100 });
    assert.equal(verdict.ok, 'skipped');
    assert.match(verdict.warning, /label-verification-skipped: rate-limited/);
  });

  it('downgrades to skipped when provider.getTicket is missing', async () => {
    const verdict = await verifyFinalStoryLabel({
      provider: {},
      storyId: 100,
    });
    assert.equal(verdict.ok, 'skipped');
    assert.match(verdict.warning, /getTicket unavailable/);
  });
});

describe('buildCloseEnvelope — Story #2961', () => {
  it('returns the pristine success envelope when the verdict is ok=true', () => {
    const result = baseResult();
    const envelope = buildCloseEnvelope({
      result,
      verdict: { ok: true },
      storyId: 100,
    });
    assert.deepEqual(envelope, { success: true, result });
    assert.equal(envelope.result.status, undefined);
    assert.equal(envelope.result.warnings, undefined);
  });

  it('downgrades to success:false with the failure shape when the verdict is ok=false', () => {
    const result = baseResult();
    const envelope = buildCloseEnvelope({
      result,
      verdict: { ok: false, actualLabels: ['agent::closing'] },
      storyId: 100,
    });
    assert.equal(envelope.success, false);
    assert.equal(envelope.result.status, 'failed');
    assert.equal(envelope.result.phase, 'closing');
    assert.equal(envelope.result.reason, 'label-transition-failed');
    assert.deepEqual(envelope.result.actualLabels, ['agent::closing']);
    // The underlying merged-state fields are preserved so an operator
    // can still tell that the merge itself succeeded.
    assert.equal(envelope.result.merged, true);
    assert.deepEqual(envelope.result.ticketsClosed, [100]);
  });

  it('returns success:true with a warnings entry when verification was skipped', () => {
    const result = baseResult();
    const envelope = buildCloseEnvelope({
      result,
      verdict: {
        ok: 'skipped',
        warning: 'label-verification-skipped: 503 from upstream',
      },
      storyId: 100,
    });
    assert.equal(envelope.success, true);
    assert.deepEqual(envelope.result.warnings, [
      'label-verification-skipped: 503 from upstream',
    ]);
    assert.equal(envelope.result.merged, true);
    assert.equal(envelope.result.status, undefined);
  });

  it('simulated transient agent::closing → agent::done flip failure exits via the failure shape', () => {
    // Acceptance criterion phrasing: "Contract test simulating a
    // transient `agent::closing → agent::done` label flip failure
    // exits via the new failure shape, not the success shape."
    const verdict = { ok: false, actualLabels: ['agent::closing'] };
    const envelope = buildCloseEnvelope({
      result: baseResult(),
      verdict,
      storyId: 100,
    });
    assert.notEqual(
      envelope.success,
      true,
      'success:true would mask the discrepancy that Story #2894 hit',
    );
    assert.equal(envelope.result.reason, 'label-transition-failed');
  });
});
