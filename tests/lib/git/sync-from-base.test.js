/**
 * tests/lib/git/sync-from-base.test.js — unit coverage for the pure
 * sync helper (Story #2580).
 *
 * The helper shells out to git via injected `gitFetchWithRetry` and
 * `gitSpawn` runners. All tests inject fakes so no real git process
 * runs — the suite is safe to execute in parallel and outside a git
 * worktree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { syncBranchFromBase } from '../../../.agents/scripts/lib/git/sync-from-base.js';

function makeFakeRunners({
  fetchStatus = 0,
  fetchStderr = '',
  originAlreadyMergedStatus = 1,
  headBehindOriginStatus = 0,
  mergeStatus = 0,
  mergeStderr = '',
  unmergedStdout = '',
} = {}) {
  const calls = [];
  const gitFetchWithRetry = async (cwd, ...args) => {
    calls.push({ tool: 'fetch', cwd, args });
    return {
      status: fetchStatus,
      stdout: '',
      stderr: fetchStderr,
      attempts: 1,
    };
  };
  const gitSpawn = (cwd, ...args) => {
    calls.push({ tool: 'spawn', cwd, args });
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      const isOriginAlreadyMergedProbe = args[2].startsWith('origin/');
      const status = isOriginAlreadyMergedProbe
        ? originAlreadyMergedStatus
        : headBehindOriginStatus;
      return { status, stdout: '', stderr: '' };
    }
    if (args[0] === 'merge' && args[1] === '--no-edit') {
      return { status: mergeStatus, stdout: '', stderr: mergeStderr };
    }
    if (args[0] === 'merge' && args[1] === '--abort') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'diff' && args[1] === '--name-only') {
      return { status: 0, stdout: unmergedStdout, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { gitFetchWithRetry, gitSpawn, calls };
}

test('syncBranchFromBase: throws on missing cwd', async () => {
  await assert.rejects(
    () => syncBranchFromBase({ baseBranch: 'main' }),
    /cwd must be a non-empty string/,
  );
});

test('syncBranchFromBase: throws on missing baseBranch', async () => {
  await assert.rejects(
    () => syncBranchFromBase({ cwd: '/repo' }),
    /baseBranch must be a non-empty string/,
  );
});

test('syncBranchFromBase: no-op when origin already merged into HEAD', async () => {
  const runners = makeFakeRunners({ originAlreadyMergedStatus: 0 });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, true);
  assert.equal(out.kind, 'noop-already-current');
  // Never invokes `git merge` when the no-op probe returns true.
  assert.equal(
    runners.calls.find((c) => c.args[0] === 'merge'),
    undefined,
  );
});

test('syncBranchFromBase: fast-forward when HEAD is an ancestor of origin', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 0,
    mergeStatus: 0,
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, true);
  assert.equal(out.kind, 'fast-forward');
});

test('syncBranchFromBase: merge-commit when neither side is an ancestor', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 0,
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, true);
  assert.equal(out.kind, 'merge-commit');
});

test('syncBranchFromBase: fetch failure surfaces as fetch-failed', async () => {
  const runners = makeFakeRunners({
    fetchStatus: 1,
    fetchStderr: 'fatal: unable to access',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, false);
  assert.equal(out.kind, 'fetch-failed');
  assert.match(out.stderr, /unable to access/);
  // No merge probes or merge attempts when the fetch failed.
  assert.equal(
    runners.calls.find((c) => c.args[0] === 'merge-base'),
    undefined,
  );
});

test('syncBranchFromBase: conflict produces conflict envelope and aborts merge', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 1,
    mergeStderr: 'CONFLICT (content): Merge conflict in src/foo.js',
    unmergedStdout: 'src/foo.js\nsrc/bar.js\n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, false);
  assert.equal(out.kind, 'conflict');
  assert.deepEqual(out.conflictFiles, ['src/foo.js', 'src/bar.js']);
  // Abort was issued.
  const abort = runners.calls.find(
    (c) => c.args[0] === 'merge' && c.args[1] === '--abort',
  );
  assert.ok(abort, 'merge --abort must be invoked on conflict');
});

test('syncBranchFromBase: merge-failed when non-zero merge has no parseable conflict list', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 1,
    mergeStderr: 'error: something else broke',
    unmergedStdout: '',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, false);
  assert.equal(out.kind, 'merge-failed');
  assert.match(out.stderr, /something else broke/);
});

test('syncBranchFromBase: log callback is invoked with (tag, message)', async () => {
  const runners = makeFakeRunners({ originAlreadyMergedStatus: 0 });
  const logs = [];
  await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    log: (tag, msg) => logs.push({ tag, msg }),
    ...runners,
  });
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].tag, 'SYNC');
});
