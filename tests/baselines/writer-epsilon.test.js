/**
 * writer-epsilon.test.js — wires per-kind applyEpsilon into writer.write
 * (Story #1964 / Task #1979).
 *
 * Acceptance:
 *   - writer.write({...}) without epsilon retains current behavior
 *     (regression-fail-safe — the rows pass through unchanged).
 *   - Writer epsilon test exits 0 with zero-row diff on the ±0.3
 *     perturbation against an MI baseline (epsilon = 0.5).
 *   - Negative or non-finite epsilon is rejected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { write } from '../../.agents/scripts/lib/baselines/writer.js';

const FIXED = '2026-05-15T00:00:00Z';

const PRIOR_MI_ROWS = [
  { path: 'src/a.js', mi: 72 },
  { path: 'src/b.js', mi: 88 },
  { path: 'src/c.js', mi: 65.5 },
];

function perturbMi(rows, deltas) {
  return rows.map((r, i) => ({ ...r, mi: r.mi + deltas[i] }));
}

describe('writer.write — epsilon parameter (Story #1964)', () => {
  it('AC: omitting epsilon preserves current behaviour (regression-fail-safe)', () => {
    const regen = perturbMi(PRIOR_MI_ROWS, [0.3, -0.3, 0.3]);
    const env = write({
      kind: 'maintainability',
      rows: regen,
      generatedAt: FIXED,
    });
    // Without epsilon, the writer must NOT consult prior — the regenerated
    // rows land verbatim (modulo projection + sort).
    assert.equal(env.rows.length, 3);
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    assert.equal(byPath['src/a.js'], 72.3);
    assert.equal(byPath['src/b.js'], 87.7);
    assert.equal(byPath['src/c.js'], 65.8);
  });

  it('AC: ±0.3 perturbation with epsilon=0.5 produces zero-row diff vs prior', () => {
    const regen = perturbMi(PRIOR_MI_ROWS, [0.3, -0.3, 0.3]);
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      epsilon: 0.5,
      generatedAt: FIXED,
    });
    // Every row's delta is within epsilon, so the writer must fold each
    // back to its prior bytes — the on-disk envelope is byte-stable.
    const sortedPrior = [...PRIOR_MI_ROWS].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    assert.deepEqual(env.rows, sortedPrior);
  });

  it('over-epsilon perturbation surfaces regenerated rows', () => {
    const regen = perturbMi(PRIOR_MI_ROWS, [2.0, -0.3, 0.3]);
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      epsilon: 0.5,
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    // src/a.js shifted by 2.0 (over epsilon) — regenerated wins.
    assert.equal(byPath['src/a.js'], 74);
    // src/b.js and src/c.js shifted within epsilon — prior bytes preserved.
    assert.equal(byPath['src/b.js'], 88);
    assert.equal(byPath['src/c.js'], 65.5);
  });

  it('missing-prior rows fall through to the regenerated row', () => {
    const regen = [
      ...perturbMi(PRIOR_MI_ROWS, [0.3, -0.3, 0.3]),
      { path: 'src/new.js', mi: 95 },
    ];
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      epsilon: 0.5,
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    assert.equal(byPath['src/new.js'], 95);
    // Pre-existing rows still stabilised.
    assert.equal(byPath['src/a.js'], 72);
  });

  it('rejects non-numeric epsilon', () => {
    assert.throws(
      () =>
        write({
          kind: 'maintainability',
          rows: PRIOR_MI_ROWS,
          prior: PRIOR_MI_ROWS,
          epsilon: 'oops',
          generatedAt: FIXED,
        }),
      /epsilon must be a non-negative finite number/,
    );
  });

  it('rejects negative epsilon', () => {
    assert.throws(
      () =>
        write({
          kind: 'maintainability',
          rows: PRIOR_MI_ROWS,
          prior: PRIOR_MI_ROWS,
          epsilon: -0.1,
          generatedAt: FIXED,
        }),
      /epsilon must be a non-negative finite number/,
    );
  });

  it('rejects non-array prior', () => {
    assert.throws(
      () =>
        write({
          kind: 'maintainability',
          rows: PRIOR_MI_ROWS,
          prior: 'not-an-array',
          epsilon: 0.5,
          generatedAt: FIXED,
        }),
      /prior must be an array/,
    );
  });

  it('passing only prior (no epsilon) is a no-op — regenerated rows pass through', () => {
    const regen = perturbMi(PRIOR_MI_ROWS, [0.3, -0.3, 0.3]);
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    assert.equal(byPath['src/a.js'], 72.3);
  });

  it('cross-kind smoke: coverage with epsilon stabilises sub-epsilon delta', () => {
    const prior = [
      { path: 'src/a.js', lines: 90, branches: 80, functions: 100 },
    ];
    const regen = [
      { path: 'src/a.js', lines: 90.05, branches: 80, functions: 100 },
    ];
    const env = write({
      kind: 'coverage',
      rows: regen,
      prior,
      epsilon: 0.1,
      generatedAt: FIXED,
    });
    assert.deepEqual(env.rows, prior);
  });
});
