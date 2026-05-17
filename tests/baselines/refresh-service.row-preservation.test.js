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

import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';
import { refreshBaseline } from '../../lib/baselines/refresh-service.js';

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
