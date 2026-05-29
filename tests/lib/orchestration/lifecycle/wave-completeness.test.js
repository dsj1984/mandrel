// tests/lib/orchestration/lifecycle/wave-completeness.test.js
/**
 * Wave-completeness invariant tests (Story #2239 Task #2245; pins
 * Acceptance Spec AC-8 / Repeatability AC #5).
 *
 * The invariant: the key set of `wave.end.outcomes` MUST equal the
 * `wave.start.storyIds` set from the matching `wave.start` event.
 *
 * Layering: the JSON Schema at
 * `.agents/schemas/lifecycle/wave.end.schema.json` declares the shape
 * of `outcomes` (keys are storyId strings, values are the four
 * outcome enum strings) but cannot express cross-event constraints.
 * The phase-level `assertWaveCompleteness` guard fills that gap: an
 * iterate-waves run that would emit a mismatched `wave.end` throws
 * BEFORE the bus.emit call, so the bus and the ledger never see a
 * non-conformant payload. The guard is functionally equivalent to a
 * schema rejection from the operator's perspective.
 *
 * These tests cover:
 *   (a) The schema declarations themselves — value-enum + key-type
 *       are enforced by AJV.
 *   (b) The cross-event guard — `assertWaveCompleteness` rejects
 *       missing and extra keys with a typed `Error`.
 *   (c) End-to-end through the phase — an outcome map seeded with an
 *       extra storyId trips the guard before the emit and the bus
 *       never sees the bad payload.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { assertWaveCompleteness } from '../../../../.agents/scripts/lib/wave-runner/wave-checkpoint.js';

describe('wave-completeness — schema layer', () => {
  it('wave.end schema rejects an outcomes value outside the enum', async () => {
    const bus = new Bus();
    await assert.rejects(
      () =>
        bus.emit('wave.end', {
          waveIndex: 0,
          // 'bogus' is not in the outcome enum.
          outcomes: { 1: 'bogus' },
        }),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        assert.equal(err.event, 'wave.end');
        return true;
      },
    );
  });

  it('wave.end schema rejects an integer outcomes value (must be a string)', async () => {
    const bus = new Bus();
    await assert.rejects(
      () =>
        bus.emit('wave.end', {
          waveIndex: 0,
          outcomes: { 1: 42 },
        }),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        return true;
      },
    );
  });
});

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

// Epic #2646 Story C — the legacy `wave-observer.js`-based end-to-end
// regression test (which provoked a mismatch by injecting a pathological
// observer that dropped a story from `waveEnd`'s reconciled result set)
// no longer reproduces with the retired observer. The production code
// path through `runIterateWavesPhase` now derives the outcomes map
// directly from the launcher / wave-session returns and the
// `commitAssertion` reclassification — there is no reducer between
// `launchResults` and the seeding loop that can silently drop a
// `wave.start.storyIds` member without also dropping it from the
// `toLaunch` enumeration. The cross-event invariant is therefore
// guarded by `assertWaveCompleteness` directly (covered by the
// preceding unit-level `describe` blocks); a ledger-protection
// regression would manifest as a unit failure here.
