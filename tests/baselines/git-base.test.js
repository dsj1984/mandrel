// tests/baselines/git-base.test.js
//
// Story #1962 / Task #1969 — Lock the contract for `readBaseFromGit`:
//
//   - `child_process.spawn`-shaped invocation (no shell).
//   - LRU cache hits skip the subprocess entirely (per-process budget).
//   - Missing path at ref returns `null` rather than throwing.
//
// The "spawn, not exec" assertion uses a mock `spawnSync` so we can
// count invocations and inspect argv. The "real git" leg uses a temp
// repo fixture to prove the cache-miss path actually round-trips
// through git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  __cacheSize,
  __resetForTests,
  __setSpawnRunner,
  readBaseFromGit,
} from '../../.agents/scripts/lib/baselines/git-base.js';

// ---------------------------------------------------------------------------
// Helpers — build a throwaway git repo with one committed file we can
// look up at HEAD. Each test that needs the fixture creates its own
// directory and tears it down in afterEach to keep parallel runs safe.
// ---------------------------------------------------------------------------

function makeGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'git-base-test-'));
  const run = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  run('init', '--initial-branch=main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(
    path.join(dir, 'baseline.json'),
    JSON.stringify({ floor: 40 }, null, 2),
  );
  run('add', 'baseline.json');
  run('commit', '-m', 'seed');
  return dir;
}

describe('readBaseFromGit', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('uses spawn (not exec) and passes ref/file as separate argv tokens', () => {
    let calls = 0;
    let lastArgs = null;
    let lastOpts = null;
    __setSpawnRunner({
      spawn: (cmd, args, opts) => {
        calls += 1;
        lastArgs = [cmd, ...args];
        lastOpts = opts;
        return { status: 0, stdout: '{"floor":40}\n', stderr: '' };
      },
    });

    const out = readBaseFromGit('epic/1943', 'baselines/lint.json');
    assert.equal(out, '{"floor":40}\n');
    assert.equal(calls, 1);
    assert.deepEqual(lastArgs, [
      'git',
      'show',
      'epic/1943:baselines/lint.json',
    ]);
    // Security baseline: shell MUST be false so ref/file cannot be
    // shell-interpolated.
    assert.equal(lastOpts.shell, false);
  });

  it('caches by (ref, file): same key spawns git exactly once', () => {
    let calls = 0;
    __setSpawnRunner({
      spawn: () => {
        calls += 1;
        return { status: 0, stdout: 'cached', stderr: '' };
      },
    });

    const a = readBaseFromGit('main', 'baselines/coverage.json');
    const b = readBaseFromGit('main', 'baselines/coverage.json');
    const c = readBaseFromGit('main', 'baselines/coverage.json');
    assert.equal(a, 'cached');
    assert.equal(b, 'cached');
    assert.equal(c, 'cached');
    assert.equal(calls, 1, 'cache should suppress repeat spawns');
  });

  it('treats different (ref, file) tuples as independent cache entries', () => {
    let calls = 0;
    __setSpawnRunner({
      spawn: (_cmd, args) => {
        calls += 1;
        // Echo back the spec so each entry is distinguishable.
        return { status: 0, stdout: args[1], stderr: '' };
      },
    });

    readBaseFromGit('main', 'baselines/lint.json');
    readBaseFromGit('main', 'baselines/coverage.json');
    readBaseFromGit('epic/1943', 'baselines/lint.json');
    assert.equal(calls, 3);
    // Re-asking for the first key still hits the cache.
    readBaseFromGit('main', 'baselines/lint.json');
    assert.equal(calls, 3);
  });

  it('returns null when git reports the path does not exist at the ref', () => {
    let calls = 0;
    __setSpawnRunner({
      spawn: () => {
        calls += 1;
        return {
          status: 128,
          stdout: '',
          stderr:
            "fatal: path 'baselines/missing.json' does not exist in 'main'",
        };
      },
    });

    const out = readBaseFromGit('main', 'baselines/missing.json');
    assert.equal(out, null);
    assert.equal(calls, 1);
    // Cache hit on missing files too — we should not re-spawn for known nulls.
    const out2 = readBaseFromGit('main', 'baselines/missing.json');
    assert.equal(out2, null);
    assert.equal(calls, 1);
  });

  it('throws on non-128 git failures (bad ref, missing binary, etc.)', () => {
    __setSpawnRunner({
      spawn: () => ({
        status: 1,
        stdout: '',
        stderr: 'fatal: bad revision',
      }),
    });
    assert.throws(
      () => readBaseFromGit('not-a-ref', 'baselines/lint.json'),
      /git show .* failed \(status=1\): fatal: bad revision/,
    );
  });

  it('rejects empty ref or empty file argument', () => {
    assert.throws(
      () => readBaseFromGit('', 'baselines/lint.json'),
      /ref must be a non-empty string/,
    );
    assert.throws(
      () => readBaseFromGit('main', ''),
      /file must be a non-empty string/,
    );
  });

  it('reads from a real temp git repo (acceptance: exits 0 on fixture)', () => {
    const dir = makeGitRepo();
    try {
      __resetForTests(); // restore real spawnSync
      const got = readBaseFromGit('HEAD', 'baseline.json', { cwd: dir });
      assert.ok(got !== null, 'HEAD:baseline.json should exist');
      assert.match(got, /"floor":\s*40/);
      // Second call exercises the real-spawn → cache transition.
      const sizeBefore = __cacheSize();
      const got2 = readBaseFromGit('HEAD', 'baseline.json', { cwd: dir });
      assert.equal(got2, got);
      assert.equal(__cacheSize(), sizeBefore, 'second read must not grow cache');

      // Missing file at HEAD → null.
      const missing = readBaseFromGit('HEAD', 'no-such-file.json', { cwd: dir });
      assert.equal(missing, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
