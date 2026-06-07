/**
 * refresh-service.row-preservation.test.js — out-of-scope row preservation
 * (Story #2197, Task #2209). This is the load-bearing assertion for
 * Epic #2173's AC-4 ("finalize never rewrites rows outside the Epic diff
 * unless explicitly --full-scope").
 *
 * Acceptance:
 *   - 10 baseline rows, scope of 3: the 7 out-of-scope rows are byte-
 *     identical pre/post (the row object — every field — matches the
 *     prior on-disk row exactly).
 *   - When no in-scope rows changed value either, the envelope-level
 *     `generatedAt` is preserved byte-for-byte (the writer's structural-
 *     equality short-circuit). This is the proxy for "row updatedAt
 *     fields are unchanged" until per-row timestamps land in a future
 *     schema bump.
 *   - In-scope rows reflect fresh scores.
 *   - Out-of-scope rows whose paths are absent from the new score input
 *     are still preserved (the scorer doesn't have to enumerate them).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';

const FIXED_PRIOR = '2024-01-01T00:00:00Z';
const FIXED_NOW = '2026-05-15T00:00:00Z';

// 10-row prior baseline; scope of 3 in-scope (a, b, c); 7 untouched.
const TEN_ROW_PRIOR_ROWS = [
  { path: 'src/a.js', mi: 50 },
  { path: 'src/b.js', mi: 55 },
  { path: 'src/c.js', mi: 60 },
  { path: 'src/d.js', mi: 65 },
  { path: 'src/e.js', mi: 70 },
  { path: 'src/f.js', mi: 75 },
  { path: 'src/g.js', mi: 80 },
  { path: 'src/h.js', mi: 85 },
  { path: 'src/i.js', mi: 90 },
  { path: 'src/j.js', mi: 95 },
];

function makeScorer(rows) {
  return (_files, _opts) => rows;
}

function seedPriorBaseline(writePath, rows, generatedAt) {
  mkdirSync(path.dirname(writePath), { recursive: true });
  // Round-trip through the writer so the rollup math matches what the
  // service will compute on the next refresh. Hand-rolled rollups would
  // diverge from the writer's deterministic aggregation and defeat the
  // structural-equality short-circuit assertions below.
  const envelope = writeEnvelope({
    kind: 'maintainability',
    rows,
    generatedAt,
  });
  writeEnvelopeFile(writePath, envelope);
  return envelope;
}

describe('refreshBaseline — out-of-scope row preservation (Task #2209, AC-4)', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-refresh-rows-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC: 10 rows, scope of 3, the 7 out-of-scope rows are byte-identical pre/post', async () => {
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    const priorEnvelope = seedPriorBaseline(
      writePath,
      TEN_ROW_PRIOR_ROWS,
      FIXED_PRIOR,
    );
    const priorByPath = new Map(priorEnvelope.rows.map((r) => [r.path, r]));

    // Scorer produces NEW scores for the 3 in-scope files only. The
    // service must merge these in and leave d–j untouched.
    const inScope = ['src/a.js', 'src/b.js', 'src/c.js'];
    const freshRows = [
      { path: 'src/a.js', mi: 99 },
      { path: 'src/b.js', mi: 11 },
      { path: 'src/c.js', mi: 22 },
    ];

    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: inScope,
      generatedAt: FIXED_NOW,
      scorer: makeScorer(freshRows),
    });

    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    const byPath = new Map(parsed.rows.map((r) => [r.path, r]));

    // 7 out-of-scope rows preserved verbatim (deep-equal to prior).
    for (const p of [
      'src/d.js',
      'src/e.js',
      'src/f.js',
      'src/g.js',
      'src/h.js',
      'src/i.js',
      'src/j.js',
    ]) {
      assert.deepEqual(
        byPath.get(p),
        priorByPath.get(p),
        `out-of-scope row ${p} must be byte-identical to prior`,
      );
    }
    // 3 in-scope rows reflect fresh scores.
    assert.equal(byPath.get('src/a.js').mi, 99);
    assert.equal(byPath.get('src/b.js').mi, 11);
    assert.equal(byPath.get('src/c.js').mi, 22);
  });

  it('AC: out-of-scope rows whose paths are absent from the scorer are still preserved', async () => {
    // The scorer only knows about in-scope files — it has no responsibility
    // to enumerate out-of-scope rows. The service must surface them from
    // the prior on its own. This is the explicit guarantee that ends
    // finalize-introduces-unrelated-rows.
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    seedPriorBaseline(writePath, TEN_ROW_PRIOR_ROWS, FIXED_PRIOR);
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: ['src/a.js'],
      generatedAt: FIXED_NOW,
      scorer: makeScorer([{ path: 'src/a.js', mi: 100 }]),
    });
    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    // 10 rows in, 10 rows out — scorer only emitted 1 but service kept 9.
    assert.equal(parsed.rows.length, 10);
    const paths = parsed.rows.map((r) => r.path);
    assert.deepEqual(paths, [
      'src/a.js',
      'src/b.js',
      'src/c.js',
      'src/d.js',
      'src/e.js',
      'src/f.js',
      'src/g.js',
      'src/h.js',
      'src/i.js',
      'src/j.js',
    ]);
  });

  it('AC: when no in-scope row changed value, the envelope generatedAt is preserved byte-for-byte', async () => {
    // Proxy for "out-of-scope updatedAt fields are unchanged": when the
    // structurally-equivalent rows + rollup produce the same envelope,
    // the writer's structural-equality short-circuit MUST return the
    // prior envelope unchanged (same `generatedAt`, same on-disk bytes).
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    const priorBytes = (() => {
      seedPriorBaseline(writePath, TEN_ROW_PRIOR_ROWS, FIXED_PRIOR);
      return readFileSync(writePath);
    })();

    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: ['src/a.js'],
      generatedAt: FIXED_NOW, // fresh timestamp — must be ignored on no-op
      scorer: makeScorer([{ path: 'src/a.js', mi: 50 }]), // same as prior
    });

    const afterBytes = readFileSync(writePath);
    assert.equal(
      afterBytes.equals(priorBytes),
      true,
      'no-op refresh must preserve the prior envelope bytes (including generatedAt)',
    );
    assert.equal(result.wrote, false);
    assert.equal(result.envelope.generatedAt, FIXED_PRIOR);
  });

  it('explicit empty scope: no rows are re-scored; the entire prior is preserved verbatim', async () => {
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    const priorBytes = (() => {
      seedPriorBaseline(writePath, TEN_ROW_PRIOR_ROWS, FIXED_PRIOR);
      return readFileSync(writePath);
    })();
    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: [],
      generatedAt: FIXED_NOW,
      scorer: makeScorer([]),
    });
    assert.equal(result.wrote, false);
    assert.equal(readFileSync(writePath).equals(priorBytes), true);
  });

  it('full-scope: out-of-scope preservation is INTENTIONALLY bypassed (only --full-scope=true)', async () => {
    // The contract is explicit: fullScope=true regenerates everything.
    // Out-of-scope preservation only applies in diff / explicit scope.
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    seedPriorBaseline(writePath, TEN_ROW_PRIOR_ROWS, FIXED_PRIOR);
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: FIXED_NOW,
      scorer: makeScorer([{ path: 'src/only-this-one.js', mi: 42 }]),
    });
    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].path, 'src/only-this-one.js');
    assert.equal(parsed.rows[0].mi, 42);
  });

  it('diff-scope path: out-of-scope rows survive the same as explicit scope', async () => {
    // Same guarantee in the diff-derived path (the default mode). The
    // service feeds gitDiff-derived files into the scope and the writer
    // merges them with the prior.
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    const priorEnvelope = seedPriorBaseline(
      writePath,
      TEN_ROW_PRIOR_ROWS,
      FIXED_PRIOR,
    );
    const priorByPath = new Map(priorEnvelope.rows.map((r) => [r.path, r]));

    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: null,
      fullScope: false,
      baseRef: 'origin/main',
      headRef: 'HEAD',
      generatedAt: FIXED_NOW,
      gitDiff: async () => ['src/a.js'], // only src/a.js diffed
      scorer: makeScorer([{ path: 'src/a.js', mi: 99 }]),
    });

    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    const byPath = new Map(parsed.rows.map((r) => [r.path, r]));
    for (const p of [
      'src/b.js',
      'src/c.js',
      'src/d.js',
      'src/e.js',
      'src/f.js',
      'src/g.js',
      'src/h.js',
      'src/i.js',
      'src/j.js',
    ]) {
      assert.deepEqual(byPath.get(p), priorByPath.get(p));
    }
    assert.equal(byPath.get('src/a.js').mi, 99);
  });
});

// ---------------------------------------------------------------------------
// Story #3695 — scoped refresh must INCLUDE the change set's own new files.
//
// Regression class: when a scoped refresh (explicit `scopeFiles` or
// diff-scope `baseRef..headRef`) includes a brand-new file (no prior baseline
// row), the scorer scores it but the scope-aware merge dropped it — the new
// file never got a row. The root cause was a path-format mismatch between the
// scored row path (`canonicalise()` strips the `.worktrees/<workspace>/`
// prefix) and the `scope.files` membership set (the permissive coercer
// `canonicalizeBaselinePath()` did NOT strip it), so a worktree-rooted run
// could never match a new file's row against its scope entry. The fix makes
// both canonicalisers strip the prefix consistently.
// ---------------------------------------------------------------------------

describe('refreshBaseline — scoped refresh includes new files (Story #3695)', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-refresh-new-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC-1 (explicit scope, maintainability): a new file in scope lands in the baseline; out-of-scope rows untouched', async () => {
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    // Prior has one existing in-scope file and one out-of-scope file.
    const priorEnvelope = seedPriorBaseline(
      writePath,
      [
        { path: 'src/existing.js', mi: 50 },
        { path: 'src/untouched.js', mi: 72 },
      ],
      FIXED_PRIOR,
    );
    const priorByPath = new Map(priorEnvelope.rows.map((r) => [r.path, r]));

    // Scope = [existing.js, brandNew.js]; the scorer scores both, but
    // brandNew.js has no prior row.
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: ['src/existing.js', 'src/brandNew.js'],
      generatedAt: FIXED_NOW,
      scorer: makeScorer([
        { path: 'src/existing.js', mi: 61 },
        { path: 'src/brandNew.js', mi: 83 },
      ]),
    });

    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    const byPath = new Map(parsed.rows.map((r) => [r.path, r]));

    // The new file's row is present (this is the bug fix).
    assert.ok(
      byPath.has('src/brandNew.js'),
      "new in-scope file 'src/brandNew.js' must get a baseline row",
    );
    assert.equal(byPath.get('src/brandNew.js').mi, 83);
    // The existing in-scope file reflects the fresh score.
    assert.equal(byPath.get('src/existing.js').mi, 61);
    // The out-of-scope row is preserved verbatim.
    assert.deepEqual(
      byPath.get('src/untouched.js'),
      priorByPath.get('src/untouched.js'),
    );
  });

  it('AC-2 (explicit scope, crap): a new covered file in scope lands in the CRAP baseline', async () => {
    const writePath = path.join(workDir, 'baselines', 'crap.json');
    const priorEnvelope = (() => {
      mkdirSync(path.dirname(writePath), { recursive: true });
      const env = writeEnvelope({
        kind: 'crap',
        rows: [
          { path: 'src/existing.js', method: 'f', startLine: 1, crap: 5 },
          { path: 'src/untouched.js', method: 'g', startLine: 9, crap: 7 },
        ],
        generatedAt: FIXED_PRIOR,
      });
      writeEnvelopeFile(writePath, env);
      return env;
    })();
    const priorByKey = new Map(
      priorEnvelope.rows.map((r) => [
        `${r.path}::${r.method}@${r.startLine}`,
        r,
      ]),
    );

    await refreshBaseline({
      kind: 'crap',
      writePath,
      scopeFiles: ['src/existing.js', 'src/brandNew.js'],
      generatedAt: FIXED_NOW,
      scorer: makeScorer([
        { path: 'src/existing.js', method: 'f', startLine: 1, crap: 6 },
        { path: 'src/brandNew.js', method: 'h', startLine: 3, crap: 8 },
      ]),
    });

    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    const paths = parsed.rows.map((r) => r.path);
    // The new file's method row is present.
    assert.ok(
      paths.includes('src/brandNew.js'),
      "new in-scope file 'src/brandNew.js' must get a CRAP row",
    );
    const newRow = parsed.rows.find((r) => r.path === 'src/brandNew.js');
    assert.equal(newRow.crap, 8);
    assert.equal(newRow.method, 'h');
    // The out-of-scope row survives verbatim.
    const untouched = parsed.rows.find((r) => r.path === 'src/untouched.js');
    assert.deepEqual(untouched, priorByKey.get('src/untouched.js::g@9'));
  });

  it('AC-1+AC-4 (diff-scope, worktree-rooted): new file lands and out-of-scope rows are preserved', async () => {
    // The exact #3685 reproduction shape: the diff and the scorer both emit
    // `.worktrees/<workspace>/...` paths (a refresh run from inside a
    // worktree). Before the fix, the new file's row was dropped because its
    // canonicalised row path (`src/brandNew.js`) never matched its
    // worktree-prefixed scope entry, AND the existing file kept its STALE
    // prior score because the in-scope regen row was discarded.
    const writePath = path.join(workDir, 'baselines', 'maintainability.json');
    const priorEnvelope = seedPriorBaseline(
      writePath,
      [
        { path: 'src/existing.js', mi: 50 },
        { path: 'src/untouched.js', mi: 88 },
      ],
      FIXED_PRIOR,
    );
    const priorByPath = new Map(priorEnvelope.rows.map((r) => [r.path, r]));

    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: null,
      fullScope: false,
      baseRef: 'origin/main',
      headRef: 'HEAD',
      generatedAt: FIXED_NOW,
      gitDiff: async () => [
        '.worktrees/story-3695/src/existing.js',
        '.worktrees/story-3695/src/brandNew.js',
      ],
      scorer: makeScorer([
        { path: '.worktrees/story-3695/src/existing.js', mi: 60 },
        { path: '.worktrees/story-3695/src/brandNew.js', mi: 80 },
      ]),
    });

    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    const byPath = new Map(parsed.rows.map((r) => [r.path, r]));

    // New file lands under its repo-relative key (prefix stripped).
    assert.ok(
      byPath.has('src/brandNew.js'),
      'worktree-rooted new file must land under its repo-relative key',
    );
    assert.equal(byPath.get('src/brandNew.js').mi, 80);
    // Existing in-scope file reflects the FRESH score, not the stale prior.
    assert.equal(byPath.get('src/existing.js').mi, 60);
    // Out-of-scope row preserved verbatim.
    assert.deepEqual(
      byPath.get('src/untouched.js'),
      priorByPath.get('src/untouched.js'),
    );
    // No worktree-prefixed key leaked into the baseline.
    assert.ok(
      !parsed.rows.some((r) => r.path.startsWith('.worktrees/')),
      'no row may carry a .worktrees/ prefix',
    );
  });
});
