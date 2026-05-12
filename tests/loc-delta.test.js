/**
 * Unit tests for `.agents/scripts/loc-delta.js` (Epic #1181 / Story #1441 /
 * Task #1457).
 *
 * Verifies:
 *   - `computeDeltaForPath` parses `git diff --numstat` output for an
 *     in-scope path and returns added / removed / delta.
 *   - `computeLocDelta` aggregates four directories into a signed total
 *     and surfaces a `pass` flag (true iff total < 0).
 *   - The CLI exits 0 when the delta is negative and 1 otherwise. We
 *     exercise the CLI by spawning it against the current HEAD versus
 *     HEAD itself (delta=0 → exit 1) so the test doesn't depend on the
 *     working tree's actual size against `main`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeDeltaForPath,
  computeLocDelta,
} from '../.agents/scripts/loc-delta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, '.agents', 'scripts', 'loc-delta.js');

// CI runners check out only the PR head, so `main` is absent locally
// but `origin/main` is available after the standard fetch. Resolve to
// whichever ref the runtime exposes so the test passes on developer
// machines (where both exist) and on CI (where only the remote ref
// does). Returns `null` when no usable base ref is found — callers
// then skip the assertion rather than fail spuriously.
function resolveBaseRef() {
  for (const ref of ['main', 'origin/main']) {
    const probe = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (probe.status === 0) return ref;
  }
  return null;
}

describe('loc-delta — computeDeltaForPath', () => {
  it('returns an additive shape for HEAD...HEAD (always zero)', () => {
    const result = computeDeltaForPath({
      base: 'HEAD',
      head: 'HEAD',
      path: '.agents/README.md',
    });
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.delta, 0);
  });

  it('returns a numeric delta when the scope has actual changes vs main', (t) => {
    // `.agents/skills/` exists on HEAD but was empty on `main` before
    // the Epic, so the path is guaranteed to have additions. We only
    // assert the shape so the test does not couple to specific counts
    // (which would drift every commit).
    const base = resolveBaseRef();
    if (!base) {
      t.skip('no main / origin/main ref available — skipping diff test');
      return;
    }
    const result = computeDeltaForPath({
      base,
      head: 'HEAD',
      path: '.agents/skills/',
    });
    assert.equal(typeof result.added, 'number');
    assert.equal(typeof result.removed, 'number');
    assert.equal(result.delta, result.added - result.removed);
  });
});

describe('loc-delta — computeLocDelta', () => {
  it('rolls four directories into a signed total with a pass flag', () => {
    const report = computeLocDelta({ base: 'HEAD', head: 'HEAD' });
    assert.equal(report.perPath.length, 4);
    assert.deepEqual(
      report.perPath.map((row) => row.path),
      [
        '.agents/scripts/',
        '.agents/skills/',
        '.agents/workflows/',
        '.agents/README.md',
      ],
    );
    assert.equal(report.total.delta, 0);
    // delta === 0 is NOT a pass — the gate is strictly < 0.
    assert.equal(report.pass, false);
  });

  it('excludes tests/skills/ from the count', (t) => {
    // The current epic/1181 branch contains tests/skills files. Verify
    // they are excluded from the .agents/scripts/ scope (which does not
    // contain them anyway) and that the total exists.
    const base = resolveBaseRef();
    if (!base) {
      t.skip('no main / origin/main ref available — skipping diff test');
      return;
    }
    const report = computeLocDelta({ base, head: 'HEAD' });
    assert.equal(report.excludes.includes('tests/skills/'), true);
    assert.equal(typeof report.total.delta, 'number');
  });
});

describe('loc-delta — CLI exit codes', () => {
  it('exits 1 when total delta is zero (HEAD...HEAD)', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--base', 'HEAD', '--head', 'HEAD'],
      { encoding: 'utf8' },
    );
    assert.equal(
      result.status,
      1,
      `stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stdout, /loc-delta/);
  });

  it('emits a per-directory table on stdout', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--base', 'HEAD', '--head', 'HEAD'],
      { encoding: 'utf8' },
    );
    assert.match(result.stdout, /\.agents\/scripts\//);
    assert.match(result.stdout, /\.agents\/skills\//);
    assert.match(result.stdout, /\.agents\/workflows\//);
    assert.match(result.stdout, /\.agents\/README\.md/);
  });

  it('emits a parseable JSON report when --json is set', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--base', 'HEAD', '--head', 'HEAD', '--json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.base, 'HEAD');
    assert.equal(parsed.head, 'HEAD');
    assert.equal(parsed.pass, false);
    assert.equal(parsed.perPath.length, 4);
  });
});
