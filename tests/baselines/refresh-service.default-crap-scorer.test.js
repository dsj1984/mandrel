/**
 * refresh-service.default-crap-scorer.test.js — Story #3694.
 *
 * Regression contract: a config-less `refreshBaseline({ kind: 'crap',
 * scopeFiles, writePath, cwd })` call (no explicit `opts.scorer`) MUST
 * produce the **same** row set as a direct `scanAndScore` run over the same
 * scope, honouring the resolved project `crap.targetDirs` / `crap.ignoreGlobs`
 * / `crap.requireCoverage`.
 *
 * The bug (discovered during Story #3685 / PR #3692): the default CRAP scorer
 * was built once at module-load via a frozen `KIND_SCORERS` table with no
 * `config`, so it ran with empty `targetDirs` / `ignoreGlobs` and `scanAndScore`
 * silently dropped every valid method row. The fix builds the default scorer
 * **lazily** with the project config resolved against the call's `cwd`
 * (`resolveDefaultScorer`), so the default and the explicit
 * `update-crap-baseline.js` scorer agree.
 *
 * Hermetic by construction: the test materializes a tiny standalone project
 * (its own schema-valid `.agentrc.json`, source tree, and Istanbul
 * `coverage-final.json`) under a tmp dir, then drives the service against that
 * `cwd`. No mocking of the boundary under test — the config resolver and the
 * crap scorer both run for real.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';
import { loadCoverage } from '../../.agents/scripts/lib/coverage-utils.js';
import { scanAndScore } from '../../.agents/scripts/lib/crap-utils.js';

// A function with a single decision point so escomplex yields a cyclomatic
// complexity > 1 and `scanAndScore` produces a deterministic CRAP row.
const SOURCE =
  'export function f(x) {\n  if (x > 1) {\n    return x;\n  }\n  return 0;\n}\n';

// Minimal-but-valid Istanbul coverage entry whose fnMap.loc.start.line (1)
// matches the escomplex method lineStart, so per-method coverage resolves.
function makeCoverageEntry(absPath) {
  return {
    path: absPath,
    statementMap: {
      0: { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
      1: { start: { line: 3, column: 0 }, end: { line: 3, column: 12 } },
      2: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
    },
    s: { 0: 1, 1: 1, 2: 0 },
    fnMap: {
      0: {
        name: 'f',
        decl: { start: { line: 1, column: 16 }, end: { line: 1, column: 17 } },
        loc: { start: { line: 1, column: 0 }, end: { line: 6, column: 1 } },
      },
    },
    f: { 0: 1 },
    branchMap: {},
    b: {},
  };
}

function rowKey(row) {
  return `${row.file ?? row.path}::${row.method}@${row.startLine}`;
}

describe('refreshBaseline — default CRAP scorer honours config (Story #3694)', () => {
  let projectDir;
  let writePath;
  const scopeFiles = ['src/a.js', 'src/ignored.js'];

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'mandrel-3694-crap-'));
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    mkdirSync(path.join(projectDir, 'coverage'), { recursive: true });
    mkdirSync(path.join(projectDir, 'baselines'), { recursive: true });

    // Two scored files; `src/ignored.js` is excluded via crap.ignoreGlobs so
    // it must NOT appear in either the default-scorer rows or the source-of-
    // truth scanAndScore rows.
    writeFileSync(path.join(projectDir, 'src', 'a.js'), SOURCE);
    writeFileSync(path.join(projectDir, 'src', 'ignored.js'), SOURCE);

    const absA = path.join(projectDir, 'src', 'a.js').split(path.sep).join('/');
    const absIgnored = path
      .join(projectDir, 'src', 'ignored.js')
      .split(path.sep)
      .join('/');
    writeFileSync(
      path.join(projectDir, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [absA]: makeCoverageEntry(absA),
        [absIgnored]: makeCoverageEntry(absIgnored),
      }),
    );

    // Schema-valid .agentrc.json scoping crap to `src` and ignoring one file.
    writeFileSync(
      path.join(projectDir, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: { owner: 'o', repo: 'r', operatorHandle: '@x' },
        delivery: {
          quality: {
            gates: {
              crap: { targetDirs: ['src'], ignoreGlobs: ['src/ignored.js'] },
            },
          },
        },
      }),
    );

    writePath = path.join(projectDir, 'baselines', 'crap.json');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('AC: config-less default scorer matches a direct scanAndScore over the same scope', async () => {
    // Act — drive the service with NO explicit scorer. The default scorer must
    // resolve the project config from `cwd` and score the same rows the CLI
    // would. Pre-fix this returned an empty row set (the footgun).
    const result = await refreshBaseline({
      kind: 'crap',
      scopeFiles,
      writePath,
      cwd: projectDir,
    });

    // Source of truth — the exact scorer shape update-crap-baseline.js builds.
    const coverage = loadCoverage(
      path.join(projectDir, 'coverage', 'coverage-final.json'),
    );
    const { rows: expectedRows } = await scanAndScore({
      targetDirs: ['src'],
      coverage,
      requireCoverage: true,
      cwd: projectDir,
      ignoreGlobs: ['src/ignored.js'],
      scopeFiles,
    });

    // The default scorer must produce a non-empty row set (the regression
    // signal: an empty set means the config-less default dropped the rows).
    assert.ok(
      result.envelope.rows.length > 0,
      'default crap scorer produced zero rows — config (targetDirs) was not honoured',
    );
    assert.ok(
      expectedRows.length > 0,
      'fixture sanity: scanAndScore must produce at least one row',
    );

    // Row sets must match by (file, method, startLine) — no silently dropped
    // methods, no extra rows.
    const actualKeys = result.envelope.rows.map(rowKey).sort();
    const expectedKeys = expectedRows.map(rowKey).sort();
    assert.deepEqual(actualKeys, expectedKeys);

    // ignoreGlobs honoured: the excluded file never appears.
    assert.equal(
      result.envelope.rows.some((r) => (r.file ?? r.path) === 'src/ignored.js'),
      false,
      'crap.ignoreGlobs was not honoured — src/ignored.js leaked into the baseline',
    );
  });
});
