import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareCrap,
  filterRowsByFileScope,
  parseArgv,
} from '../.agents/scripts/check-crap.js';
import { scanAndScore } from '../.agents/scripts/lib/crap-utils.js';

/**
 * Fixture tests for the `--changed-since <ref>` diff-scoped mode on
 * check-crap.js. Covers the three acceptance conditions:
 *
 *   1. A PR touching 2 files in a larger repo scans exactly 2 files.
 *   2. A regression in an untouched file does NOT fail a --changed-since run,
 *      but DOES fail a full-repo scan.
 *   3. A bad ref exits non-zero with a clear message (integration via CLI).
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `crap-changed-since-${label}-`));
}

function writeJsFile(dir, relPath, contents) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf-8');
  return abs;
}

function makeCoverageMap(dir, relPaths) {
  const entry = (absPath) => ({
    path: absPath,
    fnMap: {},
    f: {},
  });
  const map = {};
  for (const rel of relPaths) {
    const abs = path.join(dir, rel);
    map[abs] = entry(abs);
  }
  return map;
}

describe('parseArgv — --changed-since', () => {
  it('captures an explicit ref argument', () => {
    const out = parseArgv(['--changed-since', 'origin/main']);
    assert.equal(out.changedSinceRef, 'origin/main');
  });

  it('falls back to "main" when no ref follows the flag', () => {
    const out = parseArgv(['--changed-since']);
    assert.equal(out.changedSinceRef, 'main');
  });

  it('does not consume the next flag as a ref', () => {
    const out = parseArgv(['--changed-since', '--story', '42']);
    assert.equal(out.changedSinceRef, 'main');
    assert.equal(out.storyId, 42);
  });

  it('leaves ref null when flag is absent', () => {
    const out = parseArgv(['--story', '7']);
    assert.equal(out.changedSinceRef, null);
    assert.equal(out.storyId, 7);
  });
});

describe('filterRowsByFileScope', () => {
  it('narrows rows to the scoped file set', () => {
    const rows = [
      { file: 'a.js', method: 'x', startLine: 1, crap: 5 },
      { file: 'b.js', method: 'y', startLine: 1, crap: 6 },
      { file: 'c.js', method: 'z', startLine: 1, crap: 7 },
    ];
    const out = filterRowsByFileScope(rows, new Set(['a.js', 'c.js']));
    assert.deepEqual(
      out.map((r) => r.file),
      ['a.js', 'c.js'],
    );
  });

  it('returns input unchanged when scopeSet is null', () => {
    const rows = [{ file: 'a.js' }, { file: 'b.js' }];
    assert.equal(filterRowsByFileScope(rows, null), rows);
  });

  it('handles an empty rows array safely', () => {
    assert.deepEqual(filterRowsByFileScope([], new Set(['a.js'])), []);
  });
});

describe('scanAndScore — scopeFiles narrowing (PR touching 2 files)', () => {
  it('scans only files in scopeFiles even when more files are on disk', async () => {
    // Fixture: a "repo" with 4 JS files under src/. The simulated PR touched
    // only 2 of them — scanAndScore must touch those 2 and leave the others
    // entirely unread so the performance win of --changed-since is realized
    // on large consumer codebases.
    //
    // We prove "unread" with a canary file containing syntactically invalid
    // JS: if scope filtering fails the canary would get parsed and surface
    // as a scan error downstream. Scope-filtered, it's inert.
    const tmp = makeTmpDir('scope-narrow');
    try {
      const validBody = `
        export function doWork(n) {
          if (n > 0) return n * 2;
          return 0;
        }
      `;
      const relPaths = ['src/a.js', 'src/b.js', 'src/sub/c.js', 'src/sub/d.js'];
      for (const rel of relPaths) writeJsFile(tmp, rel, validBody);
      // Canary — would blow up if the scope filter let it through to the
      // scorer. Intentionally garbage.
      writeJsFile(tmp, 'src/canary.js', '((((NOT VALID JS))))');

      const coverage = makeCoverageMap(tmp, relPaths);
      const scoped = ['src/a.js', 'src/sub/c.js'];

      const result = await scanAndScore({
        targetDirs: ['src'],
        coverage,
        requireCoverage: false,
        cwd: tmp,
        scopeFiles: new Set(scoped),
      });

      assert.equal(
        result.scannedFiles,
        2,
        'scannedFiles should reflect scoped count, not the on-disk count',
      );
      // Any rows that did surface must be within scope — never a leak from
      // the unscoped half of the repo.
      for (const row of result.rows) {
        assert.ok(
          scoped.includes(row.file),
          `unexpected row for ${row.file} outside the scoped set`,
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('null scopeFiles falls back to full-repo scan (default behavior unchanged)', async () => {
    const tmp = makeTmpDir('scope-null');
    try {
      const relPaths = ['src/a.js', 'src/b.js'];
      const body = 'export function x() { return 1; }';
      for (const rel of relPaths) writeJsFile(tmp, rel, body);
      const coverage = makeCoverageMap(tmp, relPaths);

      const full = await scanAndScore({
        targetDirs: ['src'],
        coverage,
        requireCoverage: false,
        cwd: tmp,
        scopeFiles: null,
      });
      assert.equal(full.scannedFiles, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('diff-scoped vs full-repo divergence (AC13)', () => {
  it('regression in an untouched file does NOT fail --changed-since but DOES fail full-repo scan', () => {
    // Baseline: 3 methods across 3 files with low CRAP.
    const baselineRows = [
      { file: 'src/touched-a.js', method: 'one', startLine: 10, crap: 2.0 },
      { file: 'src/touched-b.js', method: 'two', startLine: 10, crap: 2.0 },
      { file: 'src/untouched.js', method: 'three', startLine: 10, crap: 2.0 },
    ];

    // Current state: touched-* unchanged, untouched.js regressed hard.
    const currentRowsFullScan = [
      {
        file: 'src/touched-a.js',
        method: 'one',
        startLine: 10,
        cyclomatic: 2,
        coverage: 1.0,
        crap: 2.0,
      },
      {
        file: 'src/touched-b.js',
        method: 'two',
        startLine: 10,
        cyclomatic: 2,
        coverage: 1.0,
        crap: 2.0,
      },
      {
        file: 'src/untouched.js',
        method: 'three',
        startLine: 10,
        cyclomatic: 5,
        coverage: 0.1,
        crap: 23.2,
      },
    ];

    // Full-repo scan (no --changed-since): the untouched regression is caught.
    const fullResult = compareCrap({
      currentRows: currentRowsFullScan,
      baselineRows,
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(
      fullResult.regressions,
      1,
      'full-repo scan must fail on a regression in any file',
    );

    // --changed-since mode: scope narrows both sides to touched files only.
    const scopeSet = new Set(['src/touched-a.js', 'src/touched-b.js']);
    const scopedResult = compareCrap({
      currentRows: filterRowsByFileScope(currentRowsFullScan, scopeSet),
      baselineRows: filterRowsByFileScope(baselineRows, scopeSet),
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(
      scopedResult.regressions,
      0,
      '--changed-since run must not fail on a regression in an untouched file',
    );
    assert.equal(
      scopedResult.removed,
      0,
      'scoping baseline too prevents spurious "removed" entries for untouched files',
    );
  });

  it('--changed-since still catches a regression in a touched file', () => {
    const baselineRows = [
      { file: 'src/touched-a.js', method: 'one', startLine: 10, crap: 2.0 },
      { file: 'src/untouched.js', method: 'three', startLine: 10, crap: 2.0 },
    ];
    const currentRows = [
      {
        file: 'src/touched-a.js',
        method: 'one',
        startLine: 10,
        cyclomatic: 5,
        coverage: 0.1,
        crap: 23.2,
      },
    ];
    const scopeSet = new Set(['src/touched-a.js']);
    const scopedResult = compareCrap({
      currentRows: filterRowsByFileScope(currentRows, scopeSet),
      baselineRows: filterRowsByFileScope(baselineRows, scopeSet),
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.equal(scopedResult.regressions, 1);
  });
});

describe('CLI integration — bad ref fails closed (AC14)', () => {
  it('exits non-zero with "unable to resolve" when --changed-since points at an unresolvable ref', () => {
    // Spawn the real CLI. We cannot mock the git subprocess here, so we point
    // at a ref that is virtually guaranteed not to exist in any checkout.
    // The CLI must never silently degrade to "no regressions found" — see AC14.
    const badRef = 'refs/heads/__never_exists_crap_changed_since_test_9f3c1a__';
    const script = path.join(REPO_ROOT, '.agents', 'scripts', 'check-crap.js');
    const result = spawnSync(
      process.execPath,
      [script, '--changed-since', badRef],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, FRICTION_STORY_ID: '' },
      },
    );

    assert.notEqual(
      result.status,
      0,
      `CLI must exit non-zero on bad --changed-since ref (status=${result.status}, stderr=${result.stderr})`,
    );
    const combined = `${result.stderr}\n${result.stdout}`;
    assert.match(
      combined,
      /unable to resolve ref/i,
      'error output must name the unresolvable-ref failure mode',
    );
    assert.match(
      combined,
      new RegExp(badRef.replace(/[$^*()+?.|[\]{}\\]/g, '\\$&')),
      'error output should quote the offending ref so operators see what to fix',
    );
  });
});
