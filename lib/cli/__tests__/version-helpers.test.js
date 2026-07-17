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
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  compareVersions,
  crossesMajor,
  parseVersion,
  resolveConsumerPinSpec,
  resolveConsumerPinVersion,
  satisfiesPinSpec,
} from '../version-helpers.js';

/** Minimal readFileSync-only fs fake keyed by absolute path. */
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
}

const ROOT = path.join(path.sep, 'proj');
const PKG_JSON = path.join(ROOT, 'package.json');

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

// ---------------------------------------------------------------------------
// resolveConsumerPinVersion (Story #4530)
// ---------------------------------------------------------------------------

describe('resolveConsumerPinVersion', () => {
  it('resolves a caret-ranged dependencies entry to its base version', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: '^1.87.0' } }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), '1.87.0');
  });

  it('resolves a tilde-ranged devDependencies entry', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ devDependencies: { mandrel: '~2.0.0' } }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), '2.0.0');
  });

  it('resolves an exact (unranged) pin', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: '1.87.0' } }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), '1.87.0');
  });

  it('prefers dependencies over devDependencies when both are present', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({
        dependencies: { mandrel: '^1.87.0' },
        devDependencies: { mandrel: '^0.1.0' },
      }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), '1.87.0');
  });

  it('returns null when there is no package.json at all', () => {
    const fs = makeFs({});
    assert.equal(resolveConsumerPinVersion(ROOT, fs), null);
  });

  it('returns null when neither dependency block has a mandrel entry (e.g. mandrel own repo)', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({
        name: 'mandrel',
        dependencies: { 'some-other-pkg': '^1.0.0' },
      }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), null);
  });

  it('returns null for a workspace: protocol specifier', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: 'workspace:*' } }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), null);
  });

  it('returns null for a git+ specifier', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({
        dependencies: { mandrel: 'git+https://example.test/mandrel.git' },
      }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), null);
  });

  it('returns null for a bare "latest" or "*" specifier', () => {
    const fsLatest = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: 'latest' } }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fsLatest), null);
    const fsStar = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: '*' } }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fsStar), null);
  });

  it('returns null for a comparator range it cannot reduce to one base version', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({
        dependencies: { mandrel: '>=1.0.0 <2.0.0' },
      }),
    });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), null);
  });

  it('returns null for malformed JSON instead of throwing', () => {
    const fs = makeFs({ [PKG_JSON]: '{not json' });
    assert.equal(resolveConsumerPinVersion(ROOT, fs), null);
  });
});

// ---------------------------------------------------------------------------
// resolveConsumerPinSpec — the operator-preserving sibling
// ---------------------------------------------------------------------------

describe('resolveConsumerPinSpec', () => {
  it('preserves a caret operator alongside the base version', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: '^2.1.0' } }),
    });
    assert.deepEqual(resolveConsumerPinSpec(ROOT, fs), {
      operator: '^',
      version: '2.1.0',
    });
  });

  it('preserves a tilde operator alongside the base version', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ devDependencies: { mandrel: '~2.1.0' } }),
    });
    assert.deepEqual(resolveConsumerPinSpec(ROOT, fs), {
      operator: '~',
      version: '2.1.0',
    });
  });

  it('reports an empty operator for an exact pin', () => {
    const fs = makeFs({
      [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: '2.1.0' } }),
    });
    assert.deepEqual(resolveConsumerPinSpec(ROOT, fs), {
      operator: '',
      version: '2.1.0',
    });
  });

  it('shares resolveConsumerPinVersion’s null contract for unresolvable specifiers', () => {
    for (const spec of ['workspace:*', 'latest', '*', '>=1.0.0 <2.0.0']) {
      const fs = makeFs({
        [PKG_JSON]: JSON.stringify({ dependencies: { mandrel: spec } }),
      });
      assert.equal(resolveConsumerPinSpec(ROOT, fs), null, `spec: ${spec}`);
    }
  });
});

// ---------------------------------------------------------------------------
// satisfiesPinSpec — minimal caret/tilde/exact range satisfaction
// ---------------------------------------------------------------------------

describe('satisfiesPinSpec', () => {
  const spec = (operator, version) => ({ operator, version });

  it('treats an exact pin as equality', () => {
    assert.equal(satisfiesPinSpec('2.1.0', spec('', '2.1.0')), true);
    assert.equal(satisfiesPinSpec('2.1.1', spec('', '2.1.0')), false);
    assert.equal(satisfiesPinSpec('2.0.9', spec('', '2.1.0')), false);
  });

  it('admits any same-major version at or above the base for a caret pin', () => {
    assert.equal(satisfiesPinSpec('2.1.0', spec('^', '2.1.0')), true);
    assert.equal(satisfiesPinSpec('2.4.0', spec('^', '2.1.0')), true);
    assert.equal(satisfiesPinSpec('2.99.99', spec('^', '2.1.0')), true);
    assert.equal(satisfiesPinSpec('3.0.0', spec('^', '2.1.0')), false);
    assert.equal(satisfiesPinSpec('2.0.9', spec('^', '2.1.0')), false);
  });

  it('admits only same-minor patches at or above the base for a tilde pin', () => {
    assert.equal(satisfiesPinSpec('2.1.0', spec('~', '2.1.0')), true);
    assert.equal(satisfiesPinSpec('2.1.9', spec('~', '2.1.0')), true);
    assert.equal(satisfiesPinSpec('2.2.0', spec('~', '2.1.0')), false);
    assert.equal(satisfiesPinSpec('2.0.9', spec('~', '2.1.0')), false);
  });

  it('pins a caret to the minor axis below 1.0.0 (^0.2.3 → >=0.2.3 <0.3.0)', () => {
    assert.equal(satisfiesPinSpec('0.2.3', spec('^', '0.2.3')), true);
    assert.equal(satisfiesPinSpec('0.2.9', spec('^', '0.2.3')), true);
    assert.equal(satisfiesPinSpec('0.3.0', spec('^', '0.2.3')), false);
    assert.equal(satisfiesPinSpec('1.0.0', spec('^', '0.2.3')), false);
  });

  it('pins a caret to the patch axis below 0.1.0 (^0.0.3 → >=0.0.3 <0.0.4)', () => {
    assert.equal(satisfiesPinSpec('0.0.3', spec('^', '0.0.3')), true);
    assert.equal(satisfiesPinSpec('0.0.4', spec('^', '0.0.3')), false);
    assert.equal(satisfiesPinSpec('0.1.0', spec('^', '0.0.3')), false);
  });
});
