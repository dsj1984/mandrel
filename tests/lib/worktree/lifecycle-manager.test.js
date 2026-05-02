import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  pathFor,
  removeWorktreeWithRecovery,
} from '../../../.agents/scripts/lib/worktree/lifecycle-manager.js';

function quietLogger() {
  const sink = { info: [], warn: [], error: [] };
  return {
    sink,
    logger: {
      info: (m) => sink.info.push(m),
      warn: (m) => sink.warn.push(m),
      error: (m) => sink.error.push(m),
    },
  };
}

test('pathFor: rejects invalid storyId', () => {
  assert.throws(
    () => pathFor({ worktreeRoot: '/repo/.worktrees' }, 'nope'),
    /invalid storyId/,
  );
});

test('pathFor: builds worktreeRoot + story-<id>', () => {
  const p = pathFor({ worktreeRoot: '/repo/.worktrees' }, 42);
  assert.ok(p.endsWith('story-42'));
});

test('removeWorktreeWithRecovery: Stage 1 fs-rm-retry recovers from Windows lock-class remove failures', async () => {
  const gitCalls = [];
  const fsRmCalls = [];
  const ctx = {
    repoRoot: '/repo',
    platform: 'win32',
    config: {},
    listCache: { list: null, ts: 0 },
    logger: quietLogger().logger,
    fsRm: async (p, opts) => {
      fsRmCalls.push({ p, opts });
    },
    git: {
      gitSpawn: (_cwd, ...args) => {
        gitCalls.push(args);
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return {
            status: 1,
            stdout: '',
            stderr: 'Access is denied. sharing violation',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  const res = await removeWorktreeWithRecovery(
    ctx,
    '/repo/.worktrees/story-1',
    { storyId: 1, branch: 'story-1', push: false, forceRemoveBackoffMs: 0 },
  );
  assert.equal(res.removed, true);
  assert.equal(res.success, true);
  assert.equal(res.method, 'fs-rm-retry');
  assert.equal(res.branchDeleted, true);
  assert.equal(res.remoteBranchDeleted, false);
  assert.equal(fsRmCalls.length, 1);
  assert.equal(fsRmCalls[0].p, '/repo/.worktrees/story-1');
  assert.equal(fsRmCalls[0].opts.recursive, true);
  assert.equal(fsRmCalls[0].opts.force, true);
  // fsRm must be followed by `worktree prune` and `branch -D story-1`.
  assert.ok(
    gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'prune'),
    'Stage 1 must run `git worktree prune`',
  );
  assert.ok(
    gitCalls.some(
      (a) => a[0] === 'branch' && a[1] === '-D' && a[2] === 'story-1',
    ),
    'Stage 1 must run `git branch -D story-1`',
  );
  // push=false means no `git push --delete` call.
  assert.ok(
    !gitCalls.some((a) => a[0] === 'push'),
    'push=false should not trigger remote branch delete',
  );
});

test('removeWorktreeWithRecovery: Stage 1 fs-rm-retry also recovers from cwd-like Windows remove failures', async () => {
  const gitCalls = [];
  const ctx = {
    repoRoot: '/repo',
    platform: 'win32',
    config: {},
    listCache: { list: null, ts: 0 },
    logger: quietLogger().logger,
    fsRm: async () => {},
    git: {
      gitSpawn: (_cwd, ...args) => {
        gitCalls.push(args);
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return {
            status: 1,
            stdout: '',
            stderr:
              "fatal: cannot remove 'C:/repo/.worktrees/story-566': current working directory is inside the worktree",
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  const res = await removeWorktreeWithRecovery(
    ctx,
    '/repo/.worktrees/story-566',
    {
      storyId: 566,
      branch: 'story-566',
      push: false,
      forceRemoveBackoffMs: 0,
    },
  );
  assert.equal(res.removed, true);
  assert.equal(res.success, true);
  assert.equal(res.method, 'fs-rm-retry');
  assert.equal(res.branchDeleted, true);
  assert.ok(
    gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'prune'),
    'cwd-like recovery must run `git worktree prune`',
  );
  assert.ok(
    gitCalls.some(
      (a) => a[0] === 'branch' && a[1] === '-D' && a[2] === 'story-566',
    ),
    'cwd-like recovery must run `git branch -D story-566`',
  );
});

test('removeWorktreeWithRecovery: Stage 1 retries fs.rm and succeeds on attempt 2/5 when EBUSY clears', async () => {
  let fsRmAttempts = 0;
  const ctx = {
    repoRoot: '/repo',
    platform: 'win32',
    config: {},
    listCache: { list: null, ts: 0 },
    logger: quietLogger().logger,
    fsRm: async () => {
      fsRmAttempts += 1;
      if (fsRmAttempts < 2) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      // EBUSY clears on attempt 2/5 — resolves cleanly.
    },
    git: {
      gitSpawn: (_cwd, ...args) => {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return { status: 1, stdout: '', stderr: 'resource busy' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  const res = await removeWorktreeWithRecovery(
    ctx,
    '/repo/.worktrees/story-7',
    { storyId: 7, branch: 'story-7', push: true, forceRemoveBackoffMs: 0 },
  );
  assert.equal(res.removed, true);
  assert.equal(res.method, 'fs-rm-retry');
  assert.equal(res.attempts, 2);
  assert.equal(fsRmAttempts, 2);
  assert.equal(res.remoteBranchDeleted, true);
});

test('removeWorktreeWithRecovery: Stage 1 defers to sweep and writes pending-cleanup manifest when fs.rm never clears', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pending-'));
  const worktreeRoot = path.join(tmp, '.worktrees');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const wtPath = path.join(worktreeRoot, 'story-9');
  try {
    let fsRmAttempts = 0;
    const ctx = {
      repoRoot: tmp,
      worktreeRoot,
      platform: 'win32',
      config: {},
      listCache: { list: null, ts: 0 },
      logger: quietLogger().logger,
      fsRm: async () => {
        fsRmAttempts += 1;
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      },
      git: {
        gitSpawn: (_cwd, ...args) => {
          if (args[0] === 'worktree' && args[1] === 'remove') {
            return { status: 1, stdout: '', stderr: 'resource busy' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    };
    const res = await removeWorktreeWithRecovery(ctx, wtPath, {
      storyId: 9,
      branch: 'story-9',
      push: false,
      forceRemoveBackoffMs: 0,
    });
    assert.equal(res.removed, false);
    assert.equal(res.method, 'deferred-to-sweep');
    assert.ok(res.pendingCleanup);
    assert.equal(res.pendingCleanup.storyId, 9);
    assert.equal(res.pendingCleanup.branch, 'story-9');
    assert.equal(res.pendingCleanup.attempts, 0);
    // Stage 1 (5 attempts) + Stage 1.5 coverage-leak quiesce (1 extended
    // attempt, win32 only). Stage 1.5 lifts the wall-clock budget so a c8
    // file-handle hold over a `node_modules/.cache` directory has time to
    // release before the sweep takes over.
    assert.equal(fsRmAttempts, 6);
    // Best-effort branch cleanup runs even on the deferred path so operators
    // don't have to follow up with manual `git branch -D`.
    assert.equal(res.branchDeleted, true);

    // Manifest must be on disk with the failed entry.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(worktreeRoot, '.pending-cleanup.json'), 'utf8'),
    );
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].storyId, 9);
    assert.equal(manifest[0].branch, 'story-9');
    assert.equal(manifest[0].path, wtPath);
    assert.ok(manifest[0].firstFailedAt);
    assert.ok(manifest[0].lastFailedAt);
    assert.equal(manifest[0].attempts, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeWorktreeWithRecovery: Stage 1 runs even when stderr matches neither lock-like nor cwd-like regex', async () => {
  // Regression: previously, a `git worktree remove` failure whose stderr
  // didn't match `WINDOWS_LOCK_RE || WINDOWS_CWD_RE` skipped the entire
  // Stage 1 recovery. Localized git messages, generic I/O errors, and the
  // exact combination that left story-562 as `still-registered-after-reap`
  // all fall into that category. Stage 1 now runs universally.
  const gitCalls = [];
  const fsRmCalls = [];
  const ctx = {
    repoRoot: '/repo',
    platform: 'linux',
    config: {},
    listCache: { list: null, ts: 0 },
    logger: quietLogger().logger,
    fsRm: async (p, opts) => {
      fsRmCalls.push({ p, opts });
    },
    git: {
      gitSpawn: (_cwd, ...args) => {
        gitCalls.push(args);
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return {
            status: 1,
            stdout: '',
            stderr: 'fatal: something unrecoverable',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  const res = await removeWorktreeWithRecovery(
    ctx,
    '/repo/.worktrees/story-2',
    { storyId: 2, branch: 'story-2', push: false },
  );
  assert.equal(res.removed, true);
  assert.equal(res.method, 'fs-rm-retry');
  assert.equal(res.branchDeleted, true);
  assert.equal(fsRmCalls.length, 1);
  assert.ok(
    gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'prune'),
    'must prune after fs-rm-retry',
  );
  assert.ok(
    gitCalls.some(
      (a) => a[0] === 'branch' && a[1] === '-D' && a[2] === 'story-2',
    ),
    'must delete branch after fs-rm-retry',
  );
});

test('removeWorktreeWithRecovery: success path prunes residual admin entries', async () => {
  // Regression: `git worktree remove` on Windows can exit 0 while leaving
  // `.git/worktrees/story-<id>/` admin metadata on disk (antivirus /
  // indexer / module-handle lag). Without the follow-up prune, `worktree
  // list` still reports the worktree and the close script lands in
  // `still-registered-after-reap`.
  const gitCalls = [];
  const ctx = {
    repoRoot: '/repo',
    platform: 'win32',
    config: {},
    listCache: { list: null, ts: 0 },
    logger: quietLogger().logger,
    git: {
      gitSpawn: (_cwd, ...args) => {
        gitCalls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  const res = await removeWorktreeWithRecovery(
    ctx,
    '/repo/.worktrees/story-7',
    { storyId: 7, branch: 'story-7', push: false },
  );
  assert.equal(res.removed, true);
  // Every success of `git worktree remove` must be followed by a
  // `git worktree prune` to clear residual admin-dir registrations.
  const removeIdx = gitCalls.findIndex(
    (a) => a[0] === 'worktree' && a[1] === 'remove',
  );
  const pruneIdx = gitCalls.findIndex(
    (a) => a[0] === 'worktree' && a[1] === 'prune',
  );
  assert.ok(removeIdx >= 0, 'must call `git worktree remove`');
  assert.ok(pruneIdx > removeIdx, 'must prune *after* the remove succeeds');
});

test('removeWorktreeWithRecovery: Windows lock failures retry with --force before fs.rm fallback', async () => {
  const gitCalls = [];
  const fsRmCalls = [];
  const ctx = {
    repoRoot: '/repo',
    platform: 'win32',
    config: {},
    listCache: { list: null, ts: 0 },
    logger: quietLogger().logger,
    fsRm: async (p, opts) => {
      fsRmCalls.push({ p, opts });
    },
    git: {
      gitSpawn: (_cwd, ...args) => {
        gitCalls.push(args);
        if (args[0] === 'worktree' && args[1] === 'remove') {
          const force = args[2] === '--force';
          return force
            ? { status: 0, stdout: '', stderr: '' }
            : {
                status: 1,
                stdout: '',
                stderr: 'EBUSY: resource busy or locked',
              };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };

  const res = await removeWorktreeWithRecovery(
    ctx,
    '/repo/.worktrees/story-310',
    {
      storyId: 310,
      branch: 'story-310',
      push: false,
      forceRemoveBackoffMs: 0,
    },
  );

  assert.equal(res.removed, true);
  assert.equal(res.method, 'force-remove-retry');
  assert.equal(fsRmCalls.length, 0, 'force retry should avoid fs.rm fallback');
  const plainRemoveIdx = gitCalls.findIndex(
    (a) => a[0] === 'worktree' && a[1] === 'remove' && a[2] !== '--force',
  );
  const forceRemoveIdx = gitCalls.findIndex(
    (a) =>
      a[0] === 'worktree' &&
      a[1] === 'remove' &&
      a[2] === '--force' &&
      a[3] === '/repo/.worktrees/story-310',
  );
  const pruneIdx = gitCalls.findIndex(
    (a, idx) => idx > forceRemoveIdx && a[0] === 'worktree' && a[1] === 'prune',
  );
  assert.ok(plainRemoveIdx >= 0, 'must attempt plain remove first');
  assert.ok(forceRemoveIdx > plainRemoveIdx, 'must force-remove after retry');
  assert.ok(pruneIdx > forceRemoveIdx, 'must prune after force remove');
});
