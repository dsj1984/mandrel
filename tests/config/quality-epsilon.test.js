/**
 * quality-epsilon.test.js — per-kind baseline epsilon (Story #1964 /
 * Task #1978), folded into the fixed `BASELINE_EPSILON` constant by
 * Story #5382.
 *
 * Covers:
 *   - The constant carries the Story #1964 acceptance values for every
 *     surviving kind, and none for the removed `lint` / `lighthouse` kinds.
 *   - `getQuality` surfaces the constant whatever a leftover
 *     `delivery.quality.baselineEpsilon` block says (the schema now rejects
 *     that block, and the upgrade migration strips it).
 *   - `getBaselineEpsilon(kind)` returns the constant and throws on an
 *     unknown kind.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getBaselineEpsilon,
  getQuality,
} from '../../.agents/scripts/lib/config/quality.js';

/** The fixed per-kind epsilon, read back through the resolver. */
const BASELINE_EPSILON = getQuality({}).baselineEpsilon;

describe('BASELINE_EPSILON — the fixed per-kind epsilon', () => {
  it('AC: carries the Story #1964 acceptance values', () => {
    assert.equal(BASELINE_EPSILON.maintainability, 0.5);
    assert.equal(BASELINE_EPSILON.crap, 0.5);
    assert.equal(BASELINE_EPSILON.coverage, 0.1);
    assert.equal(BASELINE_EPSILON.mutation, 0.5);
    assert.equal(BASELINE_EPSILON['bundle-size'], 1024);
    assert.equal(BASELINE_EPSILON.duplication, 0.5);
  });

  it('carries no epsilon for the removed lint and lighthouse kinds', () => {
    assert.equal('lint' in BASELINE_EPSILON, false);
    assert.equal('lighthouse' in BASELINE_EPSILON, false);
  });
});

describe('getQuality — baselineEpsilon is the constant', () => {
  it('AC: getQuality with no project override surfaces crap epsilon = 0.5', () => {
    assert.equal(getQuality({}).baselineEpsilon.crap, 0.5);
  });

  it('a leftover baselineEpsilon override tunes nothing', () => {
    const q = getQuality({
      delivery: { quality: { baselineEpsilon: { crap: 0.05, coverage: -1 } } },
    });
    assert.deepEqual(q.baselineEpsilon, { ...BASELINE_EPSILON });
  });
});

describe('getBaselineEpsilon', () => {
  it('returns the constant for every surviving kind', () => {
    for (const kind of Object.keys(BASELINE_EPSILON)) {
      assert.equal(getBaselineEpsilon(kind), BASELINE_EPSILON[kind], kind);
    }
  });

  it('throws on an unknown or removed kind', () => {
    assert.throws(() => getBaselineEpsilon('not-a-kind'), /unknown kind/);
    assert.throws(() => getBaselineEpsilon('lint'), /unknown kind/);
  });
});
