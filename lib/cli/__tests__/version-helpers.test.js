// lib/cli/__tests__/version-helpers.test.js
/**
 * Unit tests for the shared version-parse/compare helpers (Story #4048 B3).
 *
 * Prior to this story, `parseVersion` / `compareVersions` / `crossesMajor`
 * were independently defined in `lib/cli/update.js` (named `parseVersion`,
 * `compareVersions`, `crossesMajor`) and `lib/cli/registry.js` (named
 * `parseVersionTuple` / `compareSemver`). The two copies had semantically
 * identical implementations; this suite exercises the unified module and
 * explicitly covers the edge cases that differed between copies:
 *
 *   - Non-numeric segments coerce to 0 (both copies, same behaviour).
 *   - Missing segments coerce to 0 (both copies, same behaviour).
 *   - Three-part `MAJOR.MINOR.PATCH` and two-part `MAJOR.MINOR` strings.
 *
 * All assertions are on pure return values; no I/O.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareVersions,
  crossesMajor,
  parseVersion,
} from '../version-helpers.js';

describe('parseVersion', () => {
  it('parses a full MAJOR.MINOR.PATCH triple', () => {
    assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  });

  it('parses a two-part MAJOR.MINOR string (patch coerces to 0)', () => {
    assert.deepEqual(parseVersion('1.60'), [1, 60, 0]);
  });

  it('parses a single-segment string (minor + patch coerce to 0)', () => {
    assert.deepEqual(parseVersion('2'), [2, 0, 0]);
  });

  it('coerces non-numeric segments to 0', () => {
    assert.deepEqual(parseVersion('1.alpha.3'), [1, 0, 3]);
  });

  it('coerces missing segments to 0', () => {
    assert.deepEqual(parseVersion(''), [0, 0, 0]);
  });

  it('accepts the leading-zero edge case (parseInt strips leading zeros)', () => {
    assert.deepEqual(parseVersion('1.09.3'), [1, 9, 3]);
  });
});

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('returns negative when a < b', () => {
    assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
    assert.ok(compareVersions('1.2.3', '1.3.0') < 0);
    assert.ok(compareVersions('1.59.0', '1.60.0') < 0);
    assert.ok(compareVersions('0.9.9', '1.0.0') < 0);
  });

  it('returns positive when a > b', () => {
    assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  });

  it('compares two-part versions by padding the missing patch to 0', () => {
    assert.equal(compareVersions('1.60', '1.60.0'), 0);
    assert.ok(compareVersions('1.60', '1.59.0') > 0);
  });

  it('is usable as an Array.sort comparator', () => {
    const versions = ['1.10.0', '1.9.0', '1.0.0', '2.0.0'];
    const sorted = [...versions].sort(compareVersions);
    assert.deepEqual(sorted, ['1.0.0', '1.9.0', '1.10.0', '2.0.0']);
  });
});

describe('crossesMajor', () => {
  it('returns true when target major is strictly greater than current major', () => {
    assert.equal(crossesMajor('1.59.0', '2.0.0'), true);
    assert.equal(crossesMajor('1.0.0', '3.0.0'), true);
  });

  it('returns false when they share the same major', () => {
    assert.equal(crossesMajor('1.2.3', '1.60.0'), false);
    assert.equal(crossesMajor('2.0.0', '2.1.0'), false);
  });

  it('returns false when target major is less than current (downgrade path)', () => {
    assert.equal(crossesMajor('2.0.0', '1.99.99'), false);
  });

  it('returns false for equal versions', () => {
    assert.equal(crossesMajor('1.0.0', '1.0.0'), false);
  });
});
