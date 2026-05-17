import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { canonicalizeBaselinePath } from '../../lib/baselines/canonicalize-path.js';

// ---------------------------------------------------------------------------
// canonicalize-path-fixture.test.js — cross-platform determinism snapshot
// test for Story #2192 (Epic #2173, Unified Baseline Refresh Service).
//
// Walks the fixture corpus at tests/fixtures/baselines/cross-platform/,
// feeds every .js file's repo-relative path through
// canonicalizeBaselinePath(), and asserts the emitted POSIX key list
// matches the pinned snapshot. The point is: when this suite runs on
// Linux CI and on a Windows developer machine, the same key list emerges
// byte-for-byte. If a future change to the canonicalizer breaks that
// property, this test fails on one platform first.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_ROOT = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'baselines',
  'cross-platform',
);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED = [
  'tests/fixtures/baselines/cross-platform/deep/nested/module-c.js',
  'tests/fixtures/baselines/cross-platform/module-a.js',
  'tests/fixtures/baselines/cross-platform/nested/module-b.js',
];

/**
 * Walk `dir` recursively and return every `.js` file's path (relative to
 * `dir`). Sorted alphabetically for deterministic ordering across
 * filesystems whose readdir order is not guaranteed.
 */
function listJsFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...listJsFiles(abs, rel));
    } else if (entry.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

describe('canonicalize-path-fixture (cross-platform determinism)', () => {
  it('the fixture corpus contains at least 3 source files', () => {
    const files = listJsFiles(FIXTURE_ROOT);
    assert.ok(
      files.length >= 3,
      `expected >=3 fixture files, found ${files.length}: ${files.join(', ')}`,
    );
  });

  it('canonicalized path list matches the pinned snapshot', () => {
    const files = listJsFiles(FIXTURE_ROOT);
    // Reconstruct each entry as the repo-relative path using the host
    // platform's separator (Windows ships `\`, Linux ships `/`) so that
    // canonicalizeBaselinePath() exercises its separator-normalisation
    // rule on Windows.
    const actual = files
      .map((rel) => {
        const absFromRepoRoot = path.join(FIXTURE_ROOT, rel);
        const repoRel = path.relative(REPO_ROOT, absFromRepoRoot);
        return canonicalizeBaselinePath(repoRel);
      })
      .sort();

    assert.deepEqual(actual, EXPECTED);
  });
});
