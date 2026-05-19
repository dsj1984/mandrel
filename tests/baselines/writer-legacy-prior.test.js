/**
 * writer-legacy-prior.test.js — Story #2574.
 *
 * `writer.write({ prior, scope })` previously contracted prior rows as
 * "already canonical". That contract was false for any v1 baseline written
 * before the per-kind `field` → `path` rename (CRAP being the motivating
 * case). The first `update-crap-baseline.js` run against a pre-v2
 * `baselines/crap.json` threw at `assertEnvelope` because legacy `file:`
 * rows survived `scopeMergeRows` unprojected.
 *
 * The writer now funnels `prior` through `mod.projectRow` at entry. These
 * tests pin both shapes of the failure mode:
 *
 *   1. A legacy `file:`-keyed prior is merged + rewritten cleanly under
 *      diff-scope. The post-regen envelope contains canonical `path:` rows
 *      for both prior-only (preserved) and overlapping (regenerated) rows.
 *   2. The same scenario without `scope` (epsilon-only) also passes —
 *      `applyEpsilon` matches by the canonical composite key and the
 *      sub-epsilon prior bytes land verbatim with `path:`, not `file:`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { write } from '../../.agents/scripts/lib/baselines/writer.js';

const FIXED = '2026-05-15T00:00:00Z';

describe('writer.write — legacy v1 prior canonicalisation (Story #2574)', () => {
  it('AC: CRAP v1 file:-keyed prior + diff-scope merges to v2 path: rows', () => {
    // Legacy on-disk shape: rows carry `file:` and no `path:`.
    const legacyPrior = [
      { file: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 },
      { file: 'src/b.js', method: 'baz', startLine: 1, crap: 1 },
    ];
    // Regenerated scan emits the new canonical `path:` shape.
    const regen = [
      { path: 'src/a.js', method: 'foo', startLine: 10, crap: 6.5 },
    ];
    const env = write({
      kind: 'crap',
      rows: regen,
      prior: legacyPrior,
      scope: { mode: 'diff', files: new Set(['src/a.js']) },
      generatedAt: FIXED,
    });
    // Every row in the merged envelope MUST be canonical (no `file:`).
    for (const row of env.rows) {
      assert.equal(typeof row.path, 'string', 'row.path is required');
      assert.equal(row.file, undefined, 'legacy `file:` must not survive');
    }
    const byKey = Object.fromEntries(
      env.rows.map((r) => [`${r.path}::${r.method}@${r.startLine}`, r.crap]),
    );
    // In-scope: regenerated row wins.
    assert.equal(byKey['src/a.js::foo@10'], 6.5);
    // Out-of-scope: prior preserved with canonical key.
    assert.equal(byKey['src/b.js::baz@1'], 1);
  });

  it('AC: CRAP v1 prior + epsilon (no scope) folds sub-epsilon deltas to canonical prior', () => {
    const legacyPrior = [
      { file: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 },
    ];
    const regen = [
      // Sub-epsilon drift vs prior — epsilon stabiliser should keep prior bytes.
      { path: 'src/a.js', method: 'foo', startLine: 10, crap: 4.3 },
    ];
    const env = write({
      kind: 'crap',
      rows: regen,
      prior: legacyPrior,
      epsilon: 0.5,
      generatedAt: FIXED,
    });
    assert.equal(env.rows.length, 1);
    const [row] = env.rows;
    assert.equal(row.path, 'src/a.js');
    assert.equal(row.file, undefined);
    // Sub-epsilon resolved to prior crap (4.2), not regen (4.3).
    assert.equal(row.crap, 4.2);
  });

  it('omitting scope + epsilon on a legacy prior still produces a valid envelope', () => {
    // Pure regression: even when neither scope nor epsilon engages the
    // prior, projecting prior at entry must not break the existing
    // "regenerated wins everywhere" contract.
    const legacyPrior = [
      { file: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 },
    ];
    const regen = [{ path: 'src/a.js', method: 'foo', startLine: 10, crap: 9 }];
    const env = write({
      kind: 'crap',
      rows: regen,
      prior: legacyPrior,
      generatedAt: FIXED,
    });
    assert.equal(env.rows.length, 1);
    assert.equal(env.rows[0].path, 'src/a.js');
    assert.equal(env.rows[0].crap, 9);
  });
});
