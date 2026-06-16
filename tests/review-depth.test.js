// tests/review-depth.test.js
//
// Unit tier (Story #3938): the shared `resolveDepth` resolver is pure control
// flow combining the judged risk `overallLevel` and the mechanical
// changed-file count of the diff under review into one tier
// (`light` / `standard` / `deep`). These tests pin the full tier matrix and
// prove the `sizing` thresholds honour an operator override.
//
// No I/O — `resolveDepth` is a pure function (inputs in, tier out).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { resolveDepth } from '../.agents/scripts/lib/orchestration/review-depth.js';
import { DEFAULT_TASK_SIZING } from '../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';

const { softFiles, hardFiles } = DEFAULT_TASK_SIZING;

describe('resolveDepth — deep tier', () => {
  test('high-risk with a small diff → deep (risk alone)', () => {
    assert.equal(
      resolveDepth({ overallLevel: 'high', changedFileCount: 1 }),
      'deep',
    );
  });

  test('high-risk with no diff width → deep', () => {
    assert.equal(resolveDepth({ overallLevel: 'high' }), 'deep');
  });

  test('low-risk with a wide diff (> hardFiles) → deep (width alone)', () => {
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: hardFiles + 1 }),
      'deep',
    );
  });

  test('medium-risk with a wide diff → deep (width alone)', () => {
    assert.equal(
      resolveDepth({
        overallLevel: 'medium',
        changedFileCount: hardFiles + 50,
      }),
      'deep',
    );
  });

  test('absent risk with a wide diff → deep (width alone)', () => {
    assert.equal(resolveDepth({ changedFileCount: hardFiles + 1 }), 'deep');
  });
});

describe('resolveDepth — light tier', () => {
  test('low-risk with a small diff (≤ softFiles) → light', () => {
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: softFiles }),
      'light',
    );
  });

  test('low-risk with an unknown diff width → light (width does not block)', () => {
    assert.equal(resolveDepth({ overallLevel: 'low' }), 'light');
  });

  test('low-risk with a zero-file diff → light', () => {
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: 0 }),
      'light',
    );
  });
});

describe('resolveDepth — standard tier (fail toward the middle)', () => {
  test('medium-risk with any small/unknown width → standard', () => {
    assert.equal(resolveDepth({ overallLevel: 'medium' }), 'standard');
    assert.equal(
      resolveDepth({ overallLevel: 'medium', changedFileCount: 1 }),
      'standard',
    );
    assert.equal(
      resolveDepth({ overallLevel: 'medium', changedFileCount: hardFiles }),
      'standard',
    );
  });

  test('absent envelope + unknown width → standard', () => {
    assert.equal(resolveDepth(), 'standard');
    assert.equal(resolveDepth({}), 'standard');
  });

  test('low-risk with a mid-width diff (softFiles < count ≤ hardFiles) → standard', () => {
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: softFiles + 1 }),
      'standard',
    );
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: hardFiles }),
      'standard',
    );
  });

  test('malformed / null / undefined inputs → standard', () => {
    for (const overallLevel of [null, undefined, '', 'bogus', 42]) {
      assert.equal(
        resolveDepth({ overallLevel }),
        'standard',
        `expected standard for overallLevel=${JSON.stringify(overallLevel)}`,
      );
    }
  });

  test('a negative or non-numeric changedFileCount is treated as unknown', () => {
    // unknown width → not wide, does not block light; low-risk stays light.
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: -3 }),
      'light',
    );
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: Number.NaN }),
      'light',
    );
    // unknown width with medium risk → standard (no escalation to deep).
    assert.equal(
      resolveDepth({ overallLevel: 'medium', changedFileCount: 'lots' }),
      'standard',
    );
  });
});

describe('resolveDepth — custom sizing override (planning.taskSizing)', () => {
  test('a tighter hardFiles makes a previously-standard diff deep', () => {
    // Default: softFiles(15) < 20 ≤ hardFiles(30) → standard for low risk.
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: 20 }),
      'standard',
    );
    // Operator retunes hardFiles down to 5 → the same diff is now wide → deep.
    assert.equal(
      resolveDepth({
        overallLevel: 'low',
        changedFileCount: 20,
        sizing: { hardFiles: 5 },
      }),
      'deep',
    );
  });

  test('a wider softFiles lifts a previously-standard low-risk diff to light', () => {
    // Default: softFiles(15) < 18 ≤ hardFiles(30) → standard for low risk.
    assert.equal(
      resolveDepth({ overallLevel: 'low', changedFileCount: 18 }),
      'standard',
    );
    // Operator retunes softFiles up to 25 → 18 now counts as small → light.
    assert.equal(
      resolveDepth({
        overallLevel: 'low',
        changedFileCount: 18,
        sizing: { softFiles: 25 },
      }),
      'light',
    );
  });

  test('partial sizing override merges over DEFAULT_TASK_SIZING', () => {
    // Only hardFiles overridden; softFiles still defaults to 15.
    assert.equal(
      resolveDepth({
        overallLevel: 'low',
        changedFileCount: softFiles,
        sizing: { hardFiles: 100 },
      }),
      'light',
    );
  });
});
