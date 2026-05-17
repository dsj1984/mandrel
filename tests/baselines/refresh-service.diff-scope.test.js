/**
 * refresh-service.diff-scope.test.js — wire the default-mode contract for
 * the Unified Baseline Refresh Service (Story #2197, Task #2207).
 *
 * Acceptance:
 *   - scopeFiles=null && fullScope=false triggers git diff invocation,
 *     and only files matching the kind's predicate enter scope.
 *   - fullScope=true bypasses diff entirely and regenerates every row
 *     (the gitDiff seam is never invoked).
 *   - An explicit scopeFiles array is used verbatim — no diff, no
 *     predicate filtering.
 *   - The diff invocation uses `execFile`-style ({ baseRef, headRef, cwd })
 *     not shell-string concatenation (regression-fail-safe against shell
 *     injection through ref names).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  deriveScopeFromDiff,
  fileFilterFor,
  refreshBaseline,
} from '../../lib/baselines/refresh-service.js';

const FIXED = '2026-05-15T00:00:00Z';

function makeRecordingGitDiff(filesByRange) {
  const calls = [];
  const fn = async ({ baseRef, headRef, cwd }) => {
    calls.push({ baseRef, headRef, cwd });
    return filesByRange;
  };
  fn.calls = calls;
  return fn;
}

// Scorer used in the dispatch path. Records the file list the service
// hands it so tests can assert the scope reached the scorer intact.
function makeRecordingScorer(staticRows) {
  const seen = [];
  const scorer = (files, opts) => {
    seen.push({ files: [...files], opts });
    return staticRows;
  };
  scorer.calls = seen;
  return scorer;
}

describe('refreshBaseline — diff-scope default (Task #2207)', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-refresh-diff-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC: scopeFiles=null + fullScope=false triggers git diff invocation', async () => {
    const gitDiff = makeRecordingGitDiff([
      'src/alpha.js',
      'docs/README.md', // filtered out by maintainability predicate
      'src/beta.ts',
    ]);
    const scorer = makeRecordingScorer([
      { path: 'src/alpha.js', mi: 80 },
      { path: 'src/beta.ts', mi: 85 },
    ]);
    const writePath = path.join(workDir, 'maintainability.json');
    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      baseRef: 'origin/main',
      headRef: 'HEAD',
      scopeFiles: null,
      fullScope: false,
      generatedAt: FIXED,
      gitDiff,
      scorer,
    });
    assert.equal(
      gitDiff.calls.length,
      1,
      'git diff must be invoked exactly once',
    );
    assert.deepEqual(gitDiff.calls[0], {
      baseRef: 'origin/main',
      headRef: 'HEAD',
      cwd: process.cwd(),
    });
    assert.equal(result.scope.mode, 'diff');
    assert.equal(result.scope.ref, 'origin/main..HEAD');
    // README filtered out by the maintainability extension predicate.
    assert.deepEqual(result.scope.files, ['src/alpha.js', 'src/beta.ts']);
  });

  it('AC: fullScope=true bypasses diff and regenerates every row', async () => {
    const gitDiff = makeRecordingGitDiff(['should/not/be/seen.js']);
    const scorer = makeRecordingScorer([{ path: 'src/everything.js', mi: 95 }]);
    const writePath = path.join(workDir, 'maintainability.json');
    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: FIXED,
      gitDiff,
      scorer,
    });
    assert.equal(
      gitDiff.calls.length,
      0,
      'git diff MUST NOT be invoked when fullScope=true',
    );
    assert.equal(result.scope.mode, 'full');
    assert.deepEqual(result.scope.files, []);
    // The scorer should still receive an empty file list (full-scope owns
    // its own directory walk).
    assert.equal(scorer.calls.length, 1);
    assert.deepEqual(scorer.calls[0].files, []);
    assert.equal(scorer.calls[0].opts.fullScope, true);
  });

  it('AC: explicit scopeFiles array is used verbatim', async () => {
    const gitDiff = makeRecordingGitDiff(['unused.js']);
    const scorer = makeRecordingScorer([
      { path: 'lib/x.js', mi: 70 },
      { path: 'lib/y.js', mi: 75 },
    ]);
    const writePath = path.join(workDir, 'maintainability.json');
    const explicit = ['lib/x.js', 'lib/y.js'];
    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: explicit,
      generatedAt: FIXED,
      gitDiff,
      scorer,
    });
    assert.equal(
      gitDiff.calls.length,
      0,
      'git diff MUST NOT be invoked with explicit scopeFiles',
    );
    assert.equal(result.scope.mode, 'explicit');
    assert.deepEqual(result.scope.files, ['lib/x.js', 'lib/y.js']);
    assert.deepEqual(scorer.calls[0].files, ['lib/x.js', 'lib/y.js']);
  });

  it('diff-scope uses execFile-style argument shape (no shell concatenation)', async () => {
    // The gitDiff seam receives a structured object — never a shell
    // string. If anything ever changes to pass a shell-concatenated
    // command, this test will fail because the seam's signature is
    // statically typed to `{ baseRef, headRef, cwd }`.
    const writePath = path.join(workDir, 'maintainability.json');
    const gitDiff = async (args) => {
      assert.equal(typeof args, 'object');
      assert.equal(typeof args.baseRef, 'string');
      assert.equal(typeof args.headRef, 'string');
      // No shell metacharacters should leak through (we pass them
      // through here just to prove the seam is structured, not stringified).
      assert.equal(args.baseRef.includes(';'), false);
      assert.equal(args.headRef.includes(';'), false);
      return [];
    };
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      scopeFiles: null,
      fullScope: false,
      baseRef: 'origin/main',
      headRef: 'HEAD',
      generatedAt: FIXED,
      gitDiff,
      scorer: makeRecordingScorer([]),
    });
  });
});

describe('deriveScopeFromDiff — direct invocation', () => {
  it('canonicalises raw paths before applying the predicate', async () => {
    const files = await deriveScopeFromDiff({
      baseRef: 'origin/main',
      headRef: 'HEAD',
      predicate: fileFilterFor('maintainability'),
      gitDiff: async () => [
        'src\\windows.js',
        './src/dotrel.ts',
        'docs/README.md',
        '',
      ],
    });
    assert.deepEqual(files, ['src/windows.js', 'src/dotrel.ts']);
  });

  it('throws when predicate is not a function', async () => {
    await assert.rejects(
      () =>
        deriveScopeFromDiff({
          baseRef: 'a',
          headRef: 'b',
          predicate: 'not-a-fn',
          gitDiff: async () => [],
        }),
      /predicate must be a function/,
    );
  });
});

describe('fileFilterFor — per-kind predicate registry', () => {
  it('accepts .js / .ts / .mjs / .tsx for the JS-family kinds', () => {
    for (const kind of ['maintainability', 'crap', 'coverage']) {
      const pred = fileFilterFor(kind);
      assert.equal(pred('src/a.js'), true);
      assert.equal(pred('src/a.ts'), true);
      assert.equal(pred('src/a.mjs'), true);
      assert.equal(pred('src/a.tsx'), true);
      assert.equal(pred('docs/README.md'), false);
      assert.equal(pred('package.json'), false);
    }
  });

  it('throws on unknown kind', () => {
    assert.throws(() => fileFilterFor('bogus'), /no predicate registered/);
  });
});
