/**
 * quality-epsilon.test.js — `delivery.quality.baselineEpsilon` resolver
 * (Story #1964 / Task #1978).
 *
 * Covers:
 *   - Framework defaults (no project override).
 *   - Per-kind override merge (only the supplied kind moves; rest fall
 *     through to defaults).
 *   - Negative or non-numeric values throw an EXIT_CONFIG-style error so
 *     a misconfigured project halts at startup.
 *   - `getBaselineEpsilon(kind, config)` traverses the standard config
 *     shapes (`delivery.quality`, `quality`, `agentSettings.quality`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASELINE_EPSILON_DEFAULTS,
  getBaselineEpsilon,
  getQuality,
  resolveBaselineEpsilon,
} from '../../.agents/scripts/lib/config/quality.js';

describe('resolveBaselineEpsilon — defaults', () => {
  it('returns framework defaults when block is undefined', () => {
    const out = resolveBaselineEpsilon(undefined);
    assert.deepEqual(out, { ...BASELINE_EPSILON_DEFAULTS });
  });

  it('returns framework defaults when block is null', () => {
    const out = resolveBaselineEpsilon(null);
    assert.deepEqual(out, { ...BASELINE_EPSILON_DEFAULTS });
  });

  it('AC: defaults match the Story #1964 acceptance values', () => {
    const out = resolveBaselineEpsilon(undefined);
    assert.equal(out.maintainability, 0.5);
    assert.equal(out.crap, 0.5);
    assert.equal(out.coverage, 0.1);
    assert.equal(out.mutation, 0.5);
    assert.equal(out.lint, 0);
    assert.equal(out.lighthouse, 1);
    assert.equal(out['bundle-size'], 1024);
  });
});

describe('resolveBaselineEpsilon — overrides', () => {
  it('AC: resolveBaselineEpsilon override surfaces user value, defaults remain', () => {
    const out = resolveBaselineEpsilon({ crap: 0.25 });
    assert.equal(out.crap, 0.25);
    assert.equal(out.maintainability, 0.5);
    assert.equal(out.coverage, 0.1);
  });

  it('per-kind override accepts 0 as a valid value', () => {
    const out = resolveBaselineEpsilon({ coverage: 0 });
    assert.equal(out.coverage, 0);
  });

  it('AC: getQuality with no project override surfaces crap epsilon = 0.5', () => {
    const q = getQuality({});
    assert.equal(q.baselineEpsilon.crap, 0.5);
  });
});

describe('resolveBaselineEpsilon — invalid values', () => {
  it('AC: negative value throws an EXIT_CONFIG-style error', () => {
    assert.throws(
      () => resolveBaselineEpsilon({ crap: -0.1 }),
      (err) => {
        assert.equal(err.code, 'EXIT_CONFIG');
        assert.equal(err.exitCode, 3);
        assert.match(err.message, /quality\.baselineEpsilon\.crap/);
        return true;
      },
    );
  });

  it('AC: non-numeric value throws an EXIT_CONFIG-style error', () => {
    assert.throws(
      () => resolveBaselineEpsilon({ coverage: 'oops' }),
      (err) => {
        assert.equal(err.code, 'EXIT_CONFIG');
        assert.equal(err.exitCode, 3);
        return true;
      },
    );
  });

  it('Infinity and NaN are rejected', () => {
    assert.throws(() => resolveBaselineEpsilon({ mutation: Infinity }), {
      code: 'EXIT_CONFIG',
    });
    assert.throws(() => resolveBaselineEpsilon({ mutation: Number.NaN }), {
      code: 'EXIT_CONFIG',
    });
  });
});

describe('getBaselineEpsilon — config traversal', () => {
  it('reads from delivery.quality.baselineEpsilon', () => {
    const cfg = {
      delivery: { quality: { baselineEpsilon: { crap: 0.05 } } },
    };
    assert.equal(getBaselineEpsilon('crap', cfg), 0.05);
  });

  it('ignores legacy quality.baselineEpsilon unwrapped shape (hard cutover)', () => {
    const cfg = { quality: { baselineEpsilon: { coverage: 0.2 } } };
    // Falls through to framework default (0.1).
    assert.equal(getBaselineEpsilon('coverage', cfg), 0.1);
  });

  it('falls back to framework default when config is empty', () => {
    assert.equal(getBaselineEpsilon('maintainability', {}), 0.5);
    assert.equal(getBaselineEpsilon('lint', undefined), 0);
  });

  it('throws on unknown kind', () => {
    assert.throws(() => getBaselineEpsilon('not-a-kind', {}), /unknown kind/);
  });
});
