/**
 * update-baseline-flags.test.js — Story #1974 / Task #1986, Epic #1943.
 *
 * Acceptance:
 *   - `--diff-scope <ref>` parser handles `--flag value` and `--flag=value`
 *     forms; throws when value is missing.
 *   - `resolveDiffScopeFiles` invokes `git diff --name-only <ref>...HEAD`
 *     against the cwd and returns a forward-slash-normalised Set.
 *   - `--diff-scope main` narrows writes to files changed since main —
 *     `resolveDiffScope` returns the scope ready to pass into the writer.
 *   - Coverage `writeBaseline` accepts `opts.scope` / `opts.epsilon` and
 *     forwards them through to the per-kind writer (proves the wiring
 *     reaches the writer; the writer's own tests cover the merge math).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  parseDiffScopeFlag,
  resolveDiffScope,
  resolveDiffScopeFiles,
} from '../.agents/scripts/lib/baselines/diff-scope-cli.js';
import { writeBaseline } from '../.agents/scripts/lib/coverage-baseline.js';

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

describe('parseDiffScopeFlag', () => {
  it('returns null when the flag is absent', () => {
    assert.equal(parseDiffScopeFlag([]), null);
    assert.equal(parseDiffScopeFlag(['--baseline', 'x']), null);
  });

  it('parses `--diff-scope <ref>`', () => {
    assert.equal(parseDiffScopeFlag(['--diff-scope', 'main']), 'main');
    assert.equal(
      parseDiffScopeFlag(['--baseline', 'x', '--diff-scope', 'origin/epic/123']),
      'origin/epic/123',
    );
  });

  it('parses `--diff-scope=<ref>` (equals form)', () => {
    assert.equal(parseDiffScopeFlag(['--diff-scope=main']), 'main');
    assert.equal(
      parseDiffScopeFlag(['--diff-scope=origin/epic/123']),
      'origin/epic/123',
    );
  });

  it('throws when --diff-scope has no value', () => {
    assert.throws(
      () => parseDiffScopeFlag(['--diff-scope']),
      /requires a non-empty <ref> argument/,
    );
    assert.throws(
      () => parseDiffScopeFlag(['--diff-scope', '']),
      /requires a non-empty <ref> argument/,
    );
    assert.throws(
      () => parseDiffScopeFlag(['--diff-scope=']),
      /requires a non-empty <ref> value/,
    );
  });
});

// ---------------------------------------------------------------------------
// File resolver
// ---------------------------------------------------------------------------

describe('resolveDiffScopeFiles', () => {
  it('returns an empty Set when ref is missing', () => {
    const out = resolveDiffScopeFiles({ ref: '' });
    assert.equal(out.size, 0);
  });

  it('returns an empty Set when git exits non-zero', () => {
    const spawnImpl = () => ({ status: 1, stdout: '', stderr: 'bad ref' });
    const out = resolveDiffScopeFiles({ ref: 'main', spawnImpl });
    assert.equal(out.size, 0);
  });

  it('parses `git diff --name-only` stdout into a forward-slash Set', () => {
    const spawnImpl = (cmd, args) => {
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['diff', '--name-only', 'main...HEAD']);
      return {
        status: 0,
        stdout: 'src\\a.js\nsrc/b.js\n\nsrc/c.js\n',
        stderr: '',
      };
    };
    const out = resolveDiffScopeFiles({ ref: 'main', spawnImpl });
    assert.deepEqual([...out].sort(), ['src/a.js', 'src/b.js', 'src/c.js']);
  });
});

// ---------------------------------------------------------------------------
// resolveDiffScope (one-call helper)
// ---------------------------------------------------------------------------

describe('resolveDiffScope', () => {
  it('returns null when --diff-scope is absent', () => {
    const out = resolveDiffScope({ argv: ['--baseline', 'x'] });
    assert.equal(out, null);
  });

  it('AC: --diff-scope main narrows writes to files changed since main', () => {
    const spawnImpl = (cmd, args) => {
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['diff', '--name-only', 'main...HEAD']);
      return { status: 0, stdout: 'src/changed.js\n', stderr: '' };
    };
    const out = resolveDiffScope({
      argv: ['--diff-scope', 'main'],
      spawnImpl,
    });
    assert.equal(out.ref, 'main');
    assert.equal(out.scope.mode, 'diff');
    assert.deepEqual([...out.scope.files], ['src/changed.js']);
  });
});

// ---------------------------------------------------------------------------
// Coverage writeBaseline forwards opts.scope / opts.epsilon
// ---------------------------------------------------------------------------

describe('coverage writeBaseline — scope + epsilon wiring', () => {
  function makeFsShim(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      readFileSync(p) {
        if (!store.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        return store.get(p);
      },
      writeFileSync(p, bytes) {
        store.set(p, bytes);
      },
      existsSync(p) {
        return store.has(p);
      },
      mkdirSync() {},
    };
  }

  it('AC: --diff-scope narrows writes — out-of-scope rows preserved verbatim', () => {
    const cwd = path.resolve('/tmp/repo-1974');
    const baselineAbs = path.resolve(cwd, 'baselines/coverage.json');

    const priorEnvelope = {
      $schema: '.agents/schemas/coverage-baseline.schema.json',
      kernelVersion: '1.0.0',
      generatedAt: '2026-05-15T00:00:00Z',
      rollup: { '*': { lines: 0, branches: 0, functions: 0 } },
      rows: [
        { path: 'src/a.js', lines: 90, branches: 80, functions: 100 },
        { path: 'src/b.js', lines: 85, branches: 80, functions: 90 },
      ],
    };
    const fsImpl = makeFsShim({
      [baselineAbs]: JSON.stringify(priorEnvelope),
    });

    // Regen scores (current run): a.js drifts down, b.js drifts down.
    // With --diff-scope narrowing to only a.js, b.js's prior row must
    // survive verbatim.
    const newScores = {
      'src/a.js': { lines: 70, branches: 70, functions: 70 },
      'src/b.js': { lines: 10, branches: 10, functions: 10 },
    };

    writeBaseline(cwd, newScores, fsImpl, {
      epsilon: 0,
      scope: { mode: 'diff', files: new Set(['src/a.js']) },
    });

    const written = JSON.parse(fsImpl.store.get(baselineAbs));
    const byPath = Object.fromEntries(written.rows.map((r) => [r.path, r]));
    // src/a.js: in-scope → regen wins (70/70/70).
    assert.equal(byPath['src/a.js'].lines, 70);
    // src/b.js: out-of-scope → prior preserved (85/80/90).
    assert.equal(byPath['src/b.js'].lines, 85);
    assert.equal(byPath['src/b.js'].branches, 80);
    assert.equal(byPath['src/b.js'].functions, 90);
  });

  it('AC: epsilon by default — sub-epsilon perturbation produces zero-row diff', () => {
    const cwd = path.resolve('/tmp/repo-1974b');
    const baselineAbs = path.resolve(cwd, 'baselines/coverage.json');

    const priorEnvelope = {
      $schema: '.agents/schemas/coverage-baseline.schema.json',
      kernelVersion: '1.0.0',
      generatedAt: '2026-05-15T00:00:00Z',
      rollup: { '*': { lines: 0, branches: 0, functions: 0 } },
      rows: [
        { path: 'src/a.js', lines: 90, branches: 80, functions: 100 },
      ],
    };
    const fsImpl = makeFsShim({
      [baselineAbs]: JSON.stringify(priorEnvelope),
    });

    // Sub-epsilon perturbation (within ±0.05 of the prior).
    const newScores = {
      'src/a.js': { lines: 90.03, branches: 80.02, functions: 100 },
    };

    writeBaseline(cwd, newScores, fsImpl, { epsilon: 0.1 });

    const written = JSON.parse(fsImpl.store.get(baselineAbs));
    const row = written.rows.find((r) => r.path === 'src/a.js');
    // Sub-epsilon → prior bytes preserved (90/80/100), not the perturbed
    // values.
    assert.equal(row.lines, 90);
    assert.equal(row.branches, 80);
    assert.equal(row.functions, 100);
  });

  it('AC: running on unchanged code with stale env produces a zero-row diff', () => {
    // Simulates: `--diff-scope main` on a branch with NO changed files
    // (CI ran on a doc-only commit; baseline regen still ran). Every
    // regen row is out-of-scope → every prior row preserved → on-disk
    // bytes unchanged.
    const cwd = path.resolve('/tmp/repo-1974c');
    const baselineAbs = path.resolve(cwd, 'baselines/coverage.json');
    const priorEnvelope = {
      $schema: '.agents/schemas/coverage-baseline.schema.json',
      kernelVersion: '1.0.0',
      generatedAt: '2026-05-15T00:00:00Z',
      rollup: { '*': { lines: 0, branches: 0, functions: 0 } },
      rows: [
        { path: 'src/a.js', lines: 90, branches: 80, functions: 100 },
        { path: 'src/b.js', lines: 85, branches: 80, functions: 90 },
      ],
    };
    const fsImpl = makeFsShim({
      [baselineAbs]: JSON.stringify(priorEnvelope),
    });
    const newScores = {
      // Stale-env perturbations on every file.
      'src/a.js': { lines: 89.7, branches: 80.2, functions: 99.9 },
      'src/b.js': { lines: 84.8, branches: 79.7, functions: 90.3 },
    };
    writeBaseline(cwd, newScores, fsImpl, {
      epsilon: 0.1,
      // Empty scope.files = no in-scope files → every row preserved.
      scope: { mode: 'diff', files: new Set() },
    });
    const written = JSON.parse(fsImpl.store.get(baselineAbs));
    const byPath = Object.fromEntries(written.rows.map((r) => [r.path, r]));
    assert.equal(byPath['src/a.js'].lines, 90);
    assert.equal(byPath['src/a.js'].branches, 80);
    assert.equal(byPath['src/a.js'].functions, 100);
    assert.equal(byPath['src/b.js'].lines, 85);
    assert.equal(byPath['src/b.js'].branches, 80);
    assert.equal(byPath['src/b.js'].functions, 90);
  });
});
