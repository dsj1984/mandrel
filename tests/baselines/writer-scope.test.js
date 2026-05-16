/**
 * writer-scope.test.js — wires per-kind mergeRows into writer.write
 * (Story #1974 / Task #1988, Epic #1943).
 *
 * Acceptance:
 *   - writer.write({prior, scope:{mode:'diff', files:Set(['a.js'])}, ...})
 *     preserves rows whose `path !== 'a.js'` verbatim.
 *   - Two simulated concurrent Story scopes touching disjoint files
 *     produce non-overlapping baseline diffs (the moral equivalent of
 *     "git merge --no-ff with zero conflicts" — each Story's writer
 *     output keeps the other Story's rows untouched).
 *   - Omitting scope preserves current behaviour (regression-fail-safe).
 *   - Scope is composed BEFORE epsilon: out-of-scope rows are preserved
 *     verbatim regardless of epsilon, while in-scope rows still go through
 *     the stabilizer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { write } from '../../.agents/scripts/lib/baselines/writer.js';

const FIXED = '2026-05-15T00:00:00Z';

const PRIOR_MI_ROWS = [
  { path: 'src/a.js', mi: 70 },
  { path: 'src/b.js', mi: 80 },
  { path: 'src/c.js', mi: 65 },
];

describe('writer.write — scope parameter (Story #1974)', () => {
  it('AC: preserves rows whose path !== scope.files entry verbatim', () => {
    const regen = [
      { path: 'src/a.js', mi: 90 }, // in-scope: regen wins
      { path: 'src/b.js', mi: 10 }, // out-of-scope: prior preserved
      { path: 'src/c.js', mi: 10 }, // out-of-scope: prior preserved
    ];
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      scope: { mode: 'diff', files: new Set(['src/a.js']) },
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    assert.equal(byPath['src/a.js'], 90, 'in-scope row should be regenerated');
    assert.equal(
      byPath['src/b.js'],
      80,
      'out-of-scope row preserved from prior',
    );
    assert.equal(
      byPath['src/c.js'],
      65,
      'out-of-scope row preserved from prior',
    );
  });

  it('AC: omitting scope preserves current behaviour (regression-fail-safe)', () => {
    const regen = [
      { path: 'src/a.js', mi: 90 },
      { path: 'src/b.js', mi: 10 },
      { path: 'src/c.js', mi: 10 },
    ];
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    // Without scope, prior is irrelevant for merge — regen wins everywhere.
    assert.equal(byPath['src/a.js'], 90);
    assert.equal(byPath['src/b.js'], 10);
    assert.equal(byPath['src/c.js'], 10);
  });

  it('full-mode scope: regen wins everywhere (same as no scope)', () => {
    const regen = [
      { path: 'src/a.js', mi: 90 },
      { path: 'src/b.js', mi: 10 },
    ];
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      scope: { mode: 'full', files: new Set() },
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    assert.equal(byPath['src/a.js'], 90);
    assert.equal(byPath['src/b.js'], 10);
  });

  it('AC: two concurrent stories on disjoint files produce non-overlapping baseline diffs', () => {
    // Both stories see PRIOR_MI_ROWS as their baseline starting point.
    // Story A touches src/a.js only; Story B touches src/b.js only.
    // The resulting envelopes must each preserve the OTHER story's rows
    // verbatim — this is the in-process moral equivalent of "git merge
    // --no-ff with zero conflicts on baselines/maintainability.json".
    const storyARegen = [
      { path: 'src/a.js', mi: 90 },
      // Story A's regen path may include rows from outside its scope (the
      // regen helper rewrites the whole file). The writer is responsible
      // for filtering them out via mergeRows.
      { path: 'src/b.js', mi: 100 },
      { path: 'src/c.js', mi: 100 },
    ];
    const storyBRegen = [
      { path: 'src/a.js', mi: 100 },
      { path: 'src/b.js', mi: 95 },
      { path: 'src/c.js', mi: 100 },
    ];
    const envA = write({
      kind: 'maintainability',
      rows: storyARegen,
      prior: PRIOR_MI_ROWS,
      scope: { mode: 'diff', files: new Set(['src/a.js']) },
      generatedAt: FIXED,
    });
    const envB = write({
      kind: 'maintainability',
      rows: storyBRegen,
      prior: PRIOR_MI_ROWS,
      scope: { mode: 'diff', files: new Set(['src/b.js']) },
      generatedAt: FIXED,
    });

    const aByPath = Object.fromEntries(envA.rows.map((r) => [r.path, r.mi]));
    const bByPath = Object.fromEntries(envB.rows.map((r) => [r.path, r.mi]));

    // Story A: only src/a.js drifts; src/b.js + src/c.js identical to PRIOR.
    assert.equal(aByPath['src/a.js'], 90);
    assert.equal(aByPath['src/b.js'], 80);
    assert.equal(aByPath['src/c.js'], 65);

    // Story B: only src/b.js drifts; src/a.js + src/c.js identical to PRIOR.
    assert.equal(bByPath['src/a.js'], 70);
    assert.equal(bByPath['src/b.js'], 95);
    assert.equal(bByPath['src/c.js'], 65);

    // The "diffs" against PRIOR are non-overlapping by row identity:
    //   Story A's drifted set: { src/a.js }
    //   Story B's drifted set: { src/b.js }
    // No row identity appears in both drifted sets → a textual three-way
    // merge of the two envelopes against PRIOR collides on zero rows.
    const driftedA = envA.rows
      .filter((r) => {
        const prior = PRIOR_MI_ROWS.find((p) => p.path === r.path);
        return !prior || prior.mi !== r.mi;
      })
      .map((r) => r.path);
    const driftedB = envB.rows
      .filter((r) => {
        const prior = PRIOR_MI_ROWS.find((p) => p.path === r.path);
        return !prior || prior.mi !== r.mi;
      })
      .map((r) => r.path);
    assert.deepEqual(driftedA, ['src/a.js']);
    assert.deepEqual(driftedB, ['src/b.js']);
    const overlap = driftedA.filter((p) => driftedB.includes(p));
    assert.deepEqual(overlap, [], 'drifted row sets must be disjoint');
  });

  it('scope is composed BEFORE epsilon: out-of-scope rows ignore epsilon entirely', () => {
    // Story scope is { src/a.js }. The regenerated value for src/b.js is
    // 100 — far over any reasonable epsilon. Without scope+merge, epsilon
    // would not save us. With scope-merge first, src/b.js never reaches
    // applyEpsilon — the prior row (mi=80) lands verbatim.
    const regen = [
      { path: 'src/a.js', mi: 70.3 }, // in-scope, sub-epsilon vs prior
      { path: 'src/b.js', mi: 100 }, // out-of-scope, would-be regression
    ];
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      scope: { mode: 'diff', files: new Set(['src/a.js']) },
      epsilon: 0.5,
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    // src/a.js: in-scope, sub-epsilon → prior bytes (mi=70).
    assert.equal(byPath['src/a.js'], 70);
    // src/b.js: out-of-scope → prior bytes (mi=80), never reaches epsilon.
    assert.equal(byPath['src/b.js'], 80);
    // src/c.js: prior preserved (regen omitted it; the merge backfills).
    assert.equal(byPath['src/c.js'], 65);
  });

  it('null scope: behaves identically to omitted scope', () => {
    const regen = [{ path: 'src/a.js', mi: 90 }];
    const env = write({
      kind: 'maintainability',
      rows: regen,
      prior: PRIOR_MI_ROWS,
      scope: null,
      generatedAt: FIXED,
    });
    const byPath = Object.fromEntries(env.rows.map((r) => [r.path, r.mi]));
    assert.equal(byPath['src/a.js'], 90);
    // Without scope, the merger does not run — out-of-scope prior rows are
    // NOT backfilled. (Same contract as pre-#1974.)
    assert.equal(byPath['src/b.js'], undefined);
  });
});
