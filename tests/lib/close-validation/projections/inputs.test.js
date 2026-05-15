// tests/lib/close-validation/projections/inputs.test.js
/**
 * Story #1850 / Task #1872 — unit tests for the shared projection input
 * predicate.
 *
 * The predicate is the engine behind the guard cascade in
 * `projections/maintainability.js` (and any future projection helper that
 * accepts the same `{ cwd, epicBranch, storyBranch, baselinePath }` shape).
 * The tests exercise every reason branch in isolation so a regression at
 * the predicate level surfaces here rather than in a downstream consumer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MISSING_ARG_REASONS,
  validateProjectionInputs,
} from '../../../../.agents/scripts/lib/close-validation/projections/inputs.js';

const goodInputs = {
  cwd: '/repo',
  epicBranch: 'epic/1831',
  storyBranch: 'story-1850',
  baselinePath: '/repo/baselines/maintainability.json',
};

describe('validateProjectionInputs — missing-arg branches', () => {
  it('returns missing-cwd when cwd is absent', () => {
    const result = validateProjectionInputs({ ...goodInputs, cwd: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-cwd');
  });

  it('returns missing-epic-branch when epicBranch is empty', () => {
    const result = validateProjectionInputs({ ...goodInputs, epicBranch: '' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-epic-branch');
  });

  it('returns missing-story-branch when storyBranch is null', () => {
    const result = validateProjectionInputs({
      ...goodInputs,
      storyBranch: null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-story-branch');
  });

  it('returns missing-baseline-path when baselinePath is undefined', () => {
    const result = validateProjectionInputs({
      ...goodInputs,
      baselinePath: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-baseline-path');
  });

  it('returns missing-cwd when no inputs object is supplied at all', () => {
    const result = validateProjectionInputs();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-cwd');
  });
});

describe('validateProjectionInputs — baseline check', () => {
  it('returns no-baseline when loadBaseline returns an empty object', () => {
    const result = validateProjectionInputs(goodInputs, {
      loadBaseline: () => ({}),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-baseline');
  });

  it('returns no-baseline when loadBaseline returns null', () => {
    const result = validateProjectionInputs(goodInputs, {
      loadBaseline: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-baseline');
  });

  it('forwards the parsed baseline on success when loadBaseline is supplied', () => {
    const baseline = { 'lib/foo.js': 80, 'lib/bar.js': 90 };
    const result = validateProjectionInputs(goodInputs, {
      loadBaseline: () => baseline,
    });
    assert.equal(result.ok, true);
    assert.equal(result.baseline, baseline);
  });

  it('skips the baseline check when no loadBaseline is supplied', () => {
    const result = validateProjectionInputs(goodInputs);
    assert.equal(result.ok, true);
    assert.equal(result.baseline, undefined);
  });
});

describe('MISSING_ARG_REASONS', () => {
  it('lists every missing-* reason branch the predicate can emit', () => {
    assert.ok(MISSING_ARG_REASONS.has('missing-cwd'));
    assert.ok(MISSING_ARG_REASONS.has('missing-epic-branch'));
    assert.ok(MISSING_ARG_REASONS.has('missing-story-branch'));
    assert.ok(MISSING_ARG_REASONS.has('missing-baseline-path'));
    assert.equal(MISSING_ARG_REASONS.size, 4);
  });

  it('does not include the no-baseline reason', () => {
    assert.equal(MISSING_ARG_REASONS.has('no-baseline'), false);
  });
});
