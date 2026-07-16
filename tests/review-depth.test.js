// tests/review-depth.test.js
//
// Unit tier (Story #3938, re-based on a derived signal by Story #4542):
// `review-depth.js` owns two pieces of pure control flow —
//
//   - `deriveChangeLevel` turns an observable changed-file set into a level by
//     intersecting it with the registered sensitive-path classes;
//   - `resolveDepth` folds that level and the mechanical changed-file count
//     into one tier (`light` / `standard` / `deep`).
//
// These tests pin the full tier matrix, the derivation's fail-safe (an
// underivable signal must never buy LESS review), and the operator-tunable
// `diffWidth` thresholds.
//
// No I/O — `resolveDepth` is pure, and `deriveChangeLevel`'s single manifest
// read is driven through its injected seam.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  DEFAULT_DIFF_WIDTH,
  deriveChangeLevel,
  resolveDepth,
} from '../.agents/scripts/lib/orchestration/review-depth.js';

const { softFiles, hardFiles } = DEFAULT_DIFF_WIDTH;

/** A stand-in manifest: one sensitive class, one glob. */
const RULES = {
  sensitivePaths: {
    security: { filePatterns: ['**/auth/**'] },
    billing: { filePatterns: ['**/billing/**'] },
  },
};

describe('deriveChangeLevel — the level comes from the diff, not a claim', () => {
  test('a change set touching a sensitive path derives high + names the class', () => {
    const { level, classes } = deriveChangeLevel({
      changedFiles: ['src/auth/session.js'],
      injectedRules: RULES,
    });
    assert.equal(level, 'high');
    assert.deepEqual(classes, ['security']);
  });

  test('a change set touching no sensitive path derives low', () => {
    const { level, classes } = deriveChangeLevel({
      changedFiles: ['README.md', 'src/widgets/list.js'],
      injectedRules: RULES,
    });
    assert.equal(level, 'low');
    assert.deepEqual(classes, []);
  });

  test('every matched class is reported, in manifest order', () => {
    const { level, classes } = deriveChangeLevel({
      changedFiles: ['src/billing/invoice.js', 'src/auth/token.js'],
      injectedRules: RULES,
    });
    assert.equal(level, 'high');
    assert.deepEqual(classes, ['security', 'billing']);
  });

  test('an empty / absent / non-array change set derives the null fail-safe', () => {
    for (const changedFiles of [[], null, undefined, 'src/auth/x.js']) {
      const { level, classes } = deriveChangeLevel({
        changedFiles,
        injectedRules: RULES,
      });
      assert.equal(
        level,
        null,
        `expected the null fail-safe for ${JSON.stringify(changedFiles)}`,
      );
      assert.deepEqual(classes, []);
    }
    assert.equal(deriveChangeLevel().level, null);
  });

  test('an unreadable manifest degrades to the null fail-safe, never to low', () => {
    // A throwing matcher must not be read as "nothing sensitive was touched" —
    // that would buy a change LESS review on a failure.
    const { level, classes } = deriveChangeLevel({
      changedFiles: ['src/auth/session.js'],
      selectSensitivePathClassesFn: () => {
        throw new Error('manifest unreadable');
      },
    });
    assert.equal(level, null);
    assert.deepEqual(classes, []);
  });

  test('a manifest with no sensitivePaths block makes nothing sensitive', () => {
    const { level } = deriveChangeLevel({
      changedFiles: ['src/auth/session.js'],
      injectedRules: { audits: {} },
    });
    assert.equal(level, 'low');
  });
});

describe('resolveDepth — deep tier', () => {
  test('a NARROW diff touching a sensitive path → deep (the level alone)', () => {
    // The load-bearing case: width says "trivial", the sensitive path says
    // otherwise, and the sensitive path wins.
    assert.equal(
      resolveDepth({ derivedLevel: 'high', changedFileCount: 1 }),
      'deep',
    );
  });

  test('a sensitive path with no diff width → deep', () => {
    assert.equal(resolveDepth({ derivedLevel: 'high' }), 'deep');
  });

  test('a wide diff (> hardFiles) touching nothing sensitive → deep (width alone)', () => {
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: hardFiles + 1 }),
      'deep',
    );
  });

  test('an underivable level with a wide diff → deep (width alone)', () => {
    assert.equal(resolveDepth({ changedFileCount: hardFiles + 1 }), 'deep');
  });
});

describe('resolveDepth — light tier', () => {
  test('a small diff (≤ softFiles) touching nothing sensitive → light', () => {
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: softFiles }),
      'light',
    );
  });

  test('a low level with an unknown diff width → light (width does not block)', () => {
    assert.equal(resolveDepth({ derivedLevel: 'low' }), 'light');
  });

  test('a low level with a zero-file diff → light', () => {
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: 0 }),
      'light',
    );
  });
});

describe('resolveDepth — standard tier (fail toward the middle)', () => {
  test('an underivable level + unknown width → standard, never light', () => {
    // The fail-safe that matters: no evidence the change is safe must not be
    // read as evidence that it is.
    assert.equal(resolveDepth(), 'standard');
    assert.equal(resolveDepth({}), 'standard');
    assert.equal(resolveDepth({ derivedLevel: null }), 'standard');
  });

  test('a low level with a mid-width diff (softFiles < count ≤ hardFiles) → standard', () => {
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: softFiles + 1 }),
      'standard',
    );
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: hardFiles }),
      'standard',
    );
  });

  test('malformed / null / undefined levels → standard', () => {
    for (const derivedLevel of [null, undefined, '', 'bogus', 42, 'medium']) {
      assert.equal(
        resolveDepth({ derivedLevel }),
        'standard',
        `expected standard for derivedLevel=${JSON.stringify(derivedLevel)}`,
      );
    }
  });

  test('a negative or non-numeric changedFileCount is treated as unknown', () => {
    // unknown width → not wide, does not block light; a low level stays light.
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: -3 }),
      'light',
    );
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: Number.NaN }),
      'light',
    );
    // unknown width with an underivable level → standard (no escalation).
    assert.equal(
      resolveDepth({ derivedLevel: null, changedFileCount: 'lots' }),
      'standard',
    );
  });
});

describe('resolveDepth — custom diffWidth override', () => {
  test('a tighter hardFiles makes a previously-standard diff deep', () => {
    // Default: softFiles(15) < 20 ≤ hardFiles(30) → standard for a low level.
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: 20 }),
      'standard',
    );
    // Caller retunes hardFiles down to 5 → the same diff is now wide → deep.
    assert.equal(
      resolveDepth({
        derivedLevel: 'low',
        changedFileCount: 20,
        diffWidth: { hardFiles: 5 },
      }),
      'deep',
    );
  });

  test('a wider softFiles lifts a previously-standard low-level diff to light', () => {
    // Default: softFiles(15) < 18 ≤ hardFiles(30) → standard for a low level.
    assert.equal(
      resolveDepth({ derivedLevel: 'low', changedFileCount: 18 }),
      'standard',
    );
    // Caller retunes softFiles up to 25 → 18 now counts as small → light.
    assert.equal(
      resolveDepth({
        derivedLevel: 'low',
        changedFileCount: 18,
        diffWidth: { softFiles: 25 },
      }),
      'light',
    );
  });

  test('partial diffWidth override merges over DEFAULT_DIFF_WIDTH', () => {
    // Only hardFiles overridden; softFiles still defaults to 15.
    assert.equal(
      resolveDepth({
        derivedLevel: 'low',
        changedFileCount: softFiles,
        diffWidth: { hardFiles: 100 },
      }),
      'light',
    );
  });

  test('a retuned width can never talk a sensitive path down from deep', () => {
    assert.equal(
      resolveDepth({
        derivedLevel: 'high',
        changedFileCount: 1,
        diffWidth: { softFiles: 1000, hardFiles: 1000 },
      }),
      'deep',
    );
  });
});
