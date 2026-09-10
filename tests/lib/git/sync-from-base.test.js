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
  revParseStatus = 0,
  revParseStdout = 'pre1234\n',
  changedStatus = 0,
  changedStdout = '',
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
    if (args[0] === 'rev-parse') {
      return { status: revParseStatus, stdout: revParseStdout, stderr: '' };
    }
    if (args[0] === 'diff' && args[1] === '--name-only') {
      // Two distinct probes share this verb: the conflict list
      // (`--diff-filter=U`) and the Story #5267 "what did the sync bring in"
      // range diff (`<preMergeHead> HEAD`).
      return args.includes('--diff-filter=U')
        ? { status: 0, stdout: unmergedStdout, stderr: '' }
        : { status: changedStatus, stdout: changedStdout, stderr: '' };
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

test('syncBranchFromBase: noop reports an empty changedPaths', async () => {
  const runners = makeFakeRunners({ originAlreadyMergedStatus: 0 });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.deepEqual(out.changedPaths, []);
  // A no-op never touched the tree, so it never even asks what changed.
  assert.equal(
    runners.calls.find((c) => c.args[0] === 'rev-parse'),
    undefined,
  );
});

test('syncBranchFromBase: a merge-commit reports the tracked paths it brought in', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 0,
    changedStdout: 'lib/a.js\nbaselines/crap.json\n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.kind, 'merge-commit');
  assert.deepEqual(out.changedPaths, ['lib/a.js', 'baselines/crap.json']);
  // The range is pinned to the PRE-merge HEAD, read before `git merge` ran.
  const rangeDiff = runners.calls.find(
    (c) => c.args[0] === 'diff' && c.args.includes('pre1234'),
  );
  assert.ok(rangeDiff, 'diffs against the pre-merge HEAD');
  assert.deepEqual(rangeDiff.args, ['diff', '--name-only', 'pre1234', 'HEAD']);
});

test('syncBranchFromBase: a fast-forward reports its paths too', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 0,
    mergeStatus: 0,
    changedStdout: 'docs/CHANGELOG.md\n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.kind, 'fast-forward');
  assert.deepEqual(out.changedPaths, ['docs/CHANGELOG.md']);
});

test('syncBranchFromBase: a mutating sync that changed nothing tracked reports []', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 0,
    changedStdout: '\n  \n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.kind, 'merge-commit');
  assert.deepEqual(out.changedPaths, []);
});

test('syncBranchFromBase: an unreadable pre-merge HEAD degrades to [] and never diffs', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 0,
    revParseStatus: 1,
    revParseStdout: '',
    changedStdout: 'lib/a.js\n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.equal(out.synced, true);
  assert.deepEqual(out.changedPaths, []);
  assert.equal(
    runners.calls.find((c) => c.args[0] === 'diff'),
    undefined,
  );
});

test('syncBranchFromBase: an empty rev-parse answer is treated as unreadable', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 0,
    revParseStdout: '   \n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.deepEqual(out.changedPaths, []);
});

test('syncBranchFromBase: a failing range diff degrades to [] rather than guessing', async () => {
  const runners = makeFakeRunners({
    originAlreadyMergedStatus: 1,
    headBehindOriginStatus: 1,
    mergeStatus: 0,
    changedStatus: 128,
    changedStdout: 'lib/a.js\n',
  });
  const out = await syncBranchFromBase({
    cwd: '/repo',
    baseBranch: 'main',
    ...runners,
  });
  assert.deepEqual(out.changedPaths, []);
});
