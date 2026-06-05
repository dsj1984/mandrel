/**
 * build-kind-scorer-diff-scope.test.js — Story #3647
 *
 * Pins the diff-scope behaviour introduced in Story #3647: when the
 * refresh-service passes `opts.fullScope !== true`, both the maintainability
 * and crap scorers built by `buildKindScorer` must score only the in-scope
 * files (filtered to configured target dirs) rather than rescanning the
 * entire repo.
 *
 * Symmetrically, when `opts.fullScope === true` the scorers fall back to
 * the full-scan path.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildKindScorer } from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution/phases/refresh-commit.js';

const FAKE_CWD = '/repo';

// ---------------------------------------------------------------------------
// Maintainability scorer
// ---------------------------------------------------------------------------

describe('buildKindScorer — maintainability — diff-scope path (Story #3647)', () => {
  it('scores only in-scope files when opts.fullScope is falsy', async () => {
    const scanned = [];
    // Track which absolute paths were passed to calculateAll.
    const calculateAll = async (absPaths) => {
      scanned.push(...absPaths);
      return Object.fromEntries(absPaths.map((p) => [p, 80]));
    };
    const scanDirectory = () => {
      throw new Error('scanDirectory must not be called in diff-scope mode');
    };

    const scorer = buildKindScorer({
      kind: 'maintainability',
      cwd: FAKE_CWD,
      config: null,
      getQuality: () => ({
        maintainability: { targetDirs: ['.agents/scripts'] },
      }),
      scanDirectory,
      calculateAll,
    });

    // Two in-scope files, one outside the target dir.
    const inScope = [
      '.agents/scripts/lib/foo.js',
      '.agents/scripts/lib/bar.js',
    ];
    const outOfScope = ['docs/CHANGELOG.md'];
    const rows = await scorer([...inScope, ...outOfScope], {
      fullScope: false,
      cwd: FAKE_CWD,
    });

    // Only the two in-scope files should have been scored.
    assert.equal(scanned.length, 2, 'must score exactly the 2 in-scope files');
    for (const rel of inScope) {
      assert.ok(
        scanned.includes(path.resolve(FAKE_CWD, rel)),
        `expected ${rel} to be scored`,
      );
    }
    // docs/CHANGELOG.md is outside the target dir and must be absent.
    assert.ok(
      !scanned.includes(path.resolve(FAKE_CWD, 'docs/CHANGELOG.md')),
      'out-of-scope file must not be scored',
    );
    assert.equal(rows.length, 2);
  });

  it('scans the full target dirs when opts.fullScope is true', async () => {
    let scanCalled = false;
    const scanDirectory = (_abs, list) => {
      scanCalled = true;
      list.push('/repo/.agents/scripts/lib/foo.js');
    };
    const calculateAll = async (absPaths) =>
      Object.fromEntries(absPaths.map((p) => [p, 75]));

    const scorer = buildKindScorer({
      kind: 'maintainability',
      cwd: FAKE_CWD,
      config: null,
      getQuality: () => ({
        maintainability: { targetDirs: ['.agents/scripts'] },
      }),
      scanDirectory,
      calculateAll,
    });

    const rows = await scorer([], { fullScope: true, cwd: FAKE_CWD });
    assert.ok(scanCalled, 'scanDirectory must be called for full-scope');
    assert.equal(rows.length, 1);
  });

  it('returns empty rows when files list is empty in diff-scope mode', async () => {
    const calculateAll = async (absPaths) =>
      Object.fromEntries(absPaths.map((p) => [p, 80]));
    const scanDirectory = () => {
      throw new Error('scanDirectory must not be called');
    };

    const scorer = buildKindScorer({
      kind: 'maintainability',
      cwd: FAKE_CWD,
      config: null,
      getQuality: () => ({
        maintainability: { targetDirs: ['.agents/scripts'] },
      }),
      scanDirectory,
      calculateAll,
    });

    const rows = await scorer([], { fullScope: false, cwd: FAKE_CWD });
    assert.equal(rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Crap scorer
// ---------------------------------------------------------------------------

describe('buildKindScorer — crap — diff-scope path (Story #3647)', () => {
  it('passes the in-scope file list to scanAndScore as scopeFiles when fullScope is falsy', async () => {
    let capturedScopeFiles;
    const scanAndScore = async ({ scopeFiles }) => {
      capturedScopeFiles = scopeFiles;
      return { rows: [] };
    };
    const loadCoverage = () => ({
      /* non-null to skip requireCoverage bail */
    });

    const scorer = buildKindScorer({
      kind: 'crap',
      cwd: FAKE_CWD,
      config: null,
      getQuality: () => ({
        crap: {
          targetDirs: ['.agents/scripts'],
          requireCoverage: false,
        },
      }),
      loadCoverage,
      scanAndScore,
      resolveEscomplexVersion: () => {},
      resolveTsTranspilerVersion: () => {},
    });

    const inScope = [
      '.agents/scripts/lib/foo.js',
      '.agents/scripts/lib/bar.js',
    ];
    await scorer(inScope, { fullScope: false, cwd: FAKE_CWD });

    // scopeFiles must be the exact diff-scope array passed in.
    assert.deepEqual(capturedScopeFiles, inScope);
  });

  it('passes scopeFiles=null (full scan) to scanAndScore when opts.fullScope is true', async () => {
    let capturedScopeFiles = 'sentinel';
    const scanAndScore = async ({ scopeFiles }) => {
      capturedScopeFiles = scopeFiles;
      return { rows: [] };
    };
    const loadCoverage = () => ({});

    const scorer = buildKindScorer({
      kind: 'crap',
      cwd: FAKE_CWD,
      config: null,
      getQuality: () => ({
        crap: { targetDirs: ['.agents/scripts'], requireCoverage: false },
      }),
      loadCoverage,
      scanAndScore,
      resolveEscomplexVersion: () => {},
      resolveTsTranspilerVersion: () => {},
    });

    await scorer([], { fullScope: true, cwd: FAKE_CWD });
    assert.equal(
      capturedScopeFiles,
      null,
      'full-scope must pass null scopeFiles',
    );
  });

  it('passes scopeFiles=null when files is null in diff-scope mode', async () => {
    let capturedScopeFiles = 'sentinel';
    const scanAndScore = async ({ scopeFiles }) => {
      capturedScopeFiles = scopeFiles;
      return { rows: [] };
    };
    const loadCoverage = () => ({});

    const scorer = buildKindScorer({
      kind: 'crap',
      cwd: FAKE_CWD,
      config: null,
      getQuality: () => ({
        crap: { targetDirs: ['.agents/scripts'], requireCoverage: false },
      }),
      loadCoverage,
      scanAndScore,
      resolveEscomplexVersion: () => {},
      resolveTsTranspilerVersion: () => {},
    });

    await scorer(null, { fullScope: false, cwd: FAKE_CWD });
    assert.equal(capturedScopeFiles, null);
  });
});
