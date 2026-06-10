// tests/lib/orchestration/lifecycle/wave-completeness.test.js
/**
 * Wave-completeness invariant tests (Story #2239 Task #2245; pins
 * Acceptance Spec AC-8 / Repeatability AC #5).
 *
 * The invariant: the key set of a wave's reconciled `outcomes` map MUST
 * equal the `storyIds` set dispatched for that wave.
 *
 * Layering note (Story #3908): the in-process runner's dotted
 * `wave.start` / `wave.end` lifecycle events — and their JSON Schemas —
 * were deleted in the dead-runner-stratum cutover. The production wave
 * loop (`tick.js`) ledgers `story.dispatch.*` + hyphenated `wave-*`
 * signals instead. The cross-event completeness guard survives as the
 * pure `assertWaveCompleteness({ waveIndex, storyIds, outcomes })`
 * checkpoint helper in `wave-runner/wave-checkpoint.js`: a wave whose
 * reconciled `outcomes` key set diverges from its `storyIds` set throws
 * a typed `WAVE_COMPLETENESS_VIOLATION` Error.
 *
 * These tests cover the cross-event guard — `assertWaveCompleteness`
 * rejects missing and extra keys with a typed `Error`, and passes when
 * keys exactly cover `storyIds`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertWaveCompleteness } from '../../../../.agents/scripts/lib/wave-runner/wave-checkpoint.js';

describe('wave-completeness — cross-event invariant guard', () => {
  it('rejects an emit attempt where outcomes is missing a storyId from wave.start.storyIds', () => {
    assert.throws(
      () =>
        assertWaveCompleteness({
          waveIndex: 0,
          storyIds: [1, 2, 3],
          outcomes: { 1: 'done', 2: 'done' },
        }),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.deepEqual(err.missing, [3]);
        return true;
      },
    );
  });

  it('rejects an emit attempt where outcomes carries an extra storyId', () => {
    assert.throws(
      () =>
        assertWaveCompleteness({
          waveIndex: 0,
          storyIds: [1, 2],
          outcomes: { 1: 'done', 2: 'done', 99: 'done' },
        }),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.deepEqual(err.extra, [99]);
        return true;
      },
    );
  });

  it('passes when keys exactly cover storyIds', () => {
    // Should not throw.
    assertWaveCompleteness({
      waveIndex: 0,
      storyIds: [1, 2, 3],
      outcomes: { 1: 'done', 2: 'failed', 3: 'skipped' },
    });
  });
});

// Story #3908 — the legacy in-process-runner end-to-end regression test
// (which provoked a mismatch by injecting a pathological observer into
// the deleted `wave-session.js` reducer) no longer has a code path to
// reproduce: the in-process runner stratum was deleted in the
// dead-stratum cutover. The production wave loop (`tick.js`) derives the
// outcomes map from the per-Story sub-agent returns directly, with no
// reducer between dispatch and the outcomes map that could silently drop
// a dispatched storyId. The cross-event invariant is therefore guarded
// by `assertWaveCompleteness` directly (covered by the preceding
// unit-level `describe` block).
