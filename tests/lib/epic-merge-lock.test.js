import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  acquireEpicMergeLock,
  releaseEpicMergeLock,
  resolveGitCommonDir,
} from '../../.agents/scripts/lib/epic-merge-lock.js';

describe('epic-merge-lock', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-lock-'));
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('acquires and releases a lock file', async () => {
    const handle = await acquireEpicMergeLock(42, { repoRoot, timeoutMs: 500 });
    assert.ok(fs.existsSync(handle.filePath), 'lock file should exist');
    const meta = JSON.parse(fs.readFileSync(handle.filePath, 'utf8'));
    assert.equal(meta.pid, process.pid);
    releaseEpicMergeLock(handle);
    assert.equal(
      fs.existsSync(handle.filePath),
      false,
      'lock file should be removed',
    );
  });

  it('blocks a second acquire until the holder releases (no real-clock wait)', async () => {
    const first = await acquireEpicMergeLock(7, { repoRoot, timeoutMs: 5000 });

    // Drive the poll loop with an injected sleepFn and a monotonic clock
    // that never advances past the deadline. The contender stays blocked
    // (EEXIST) until the holder's lock is released on the third poll, at
    // which point the next `openSync('wx')` succeeds. No wall-clock waits.
    const sleepCalls = [];
    let pollCount = 0;
    const sleepFn = (ms) => {
      sleepCalls.push(ms);
      pollCount += 1;
      if (pollCount === 3) releaseEpicMergeLock(first);
      return Promise.resolve();
    };

    const second = await acquireEpicMergeLock(7, {
      repoRoot,
      timeoutMs: 5000,
      // Clock pinned well inside the deadline so the loop never times out;
      // the only exit is the holder's release.
      nowFn: () => 1000,
      sleepFn,
    });

    assert.equal(sleepCalls.length, 3, 'polled three times before acquiring');
    assert.deepEqual(sleepCalls, [250, 250, 250], 'used the poll interval');
    assert.ok(fs.existsSync(second.filePath));
    const meta = JSON.parse(fs.readFileSync(second.filePath, 'utf8'));
    assert.equal(meta.pid, process.pid, 'contender now owns the lock');
    releaseEpicMergeLock(second);
  });

  it('steals a stale lock whose PID is reported dead by killFn', async () => {
    const filePath = path.join(repoRoot, '.git', 'epic-99.merge.lock');
    fs.writeFileSync(filePath, JSON.stringify({ pid: 4321, acquiredAt: 1000 }));

    // killFn throws ESRCH → the lock's PID is treated as dead → steal.
    // nowFn pinned so the (mtime) age branch is irrelevant; the steal is
    // attributable solely to the injected pid-dead signal.
    const killFn = () => {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    };

    const handle = await acquireEpicMergeLock(99, {
      repoRoot,
      timeoutMs: 1000,
      nowFn: () => 2000,
      killFn,
    });
    assert.ok(fs.existsSync(handle.filePath));
    const meta = JSON.parse(fs.readFileSync(handle.filePath, 'utf8'));
    assert.equal(meta.pid, process.pid, 'stolen lock should be re-owned');
    releaseEpicMergeLock(handle);
  });

  it('steals an ancient lock even when killFn reports the PID alive', async () => {
    const filePath = path.join(repoRoot, '.git', 'epic-101.merge.lock');
    fs.writeFileSync(filePath, JSON.stringify({ pid: 4321, acquiredAt: 0 }));
    // mtime fixed at epoch 0; the injected clock returns a "now" far past
    // timeoutMs*2, so the ancient branch fires regardless of killFn.
    const past = new Date(0);
    fs.utimesSync(filePath, past, past);

    let killCalls = 0;
    const killFn = () => {
      killCalls += 1; // alive: no throw
    };

    const handle = await acquireEpicMergeLock(101, {
      repoRoot,
      timeoutMs: 1000, // stale threshold = 2000ms
      nowFn: () => 1_000_000, // age = 1_000_000ms ≫ 2000ms
      killFn,
    });
    assert.ok(fs.existsSync(handle.filePath));
    assert.ok(killCalls >= 1, 'pid liveness was probed via killFn');
    releaseEpicMergeLock(handle);
  });

  it('throws on timeout using an injected clock, with no real wait', async () => {
    const first = await acquireEpicMergeLock(55, { repoRoot, timeoutMs: 2000 });

    // The clock jumps past the deadline on the second reading: first call
    // seeds `started`, the deadline check then sees elapsed >= timeoutMs.
    // The holder's PID is reported alive so no steal masks the timeout.
    let tick = 0;
    const clock = [1000, 1000, 9999];
    const nowFn = () => clock[Math.min(tick++, clock.length - 1)];
    const killFn = () => {}; // holder alive → no steal

    await assert.rejects(
      acquireEpicMergeLock(55, {
        repoRoot,
        timeoutMs: 300,
        nowFn,
        killFn,
        sleepFn: () => Promise.resolve(),
      }),
      /timed out after 300ms for epic 55/,
    );

    releaseEpicMergeLock(first);
  });

  it('handles a corrupted JSON lock file when constructing the timeout error', async () => {
    const filePath = path.join(repoRoot, '.git', 'epic-66.merge.lock');
    fs.writeFileSync(filePath, '{ corrupted_json');

    // Corrupted meta is never stolen (null meta → held); the loop times
    // out and must not crash while reading meta for the error message.
    let tick = 0;
    const clock = [1000, 1000, 9999];
    const nowFn = () => clock[Math.min(tick++, clock.length - 1)];

    await assert.rejects(
      acquireEpicMergeLock(66, {
        repoRoot,
        timeoutMs: 300,
        nowFn,
        sleepFn: () => Promise.resolve(),
      }),
      /timed out after 300ms for epic 66/,
    );
  });

  it('acquires a lock from inside a linked worktree (gitlink, not directory)', async () => {
    // Build a real main-repo + linked worktree pair so `git rev-parse
    // --git-common-dir` returns the parent's .git/. This is the scenario
    // that previously crashed with EEXIST: cwd is the worktree, .git there
    // is a gitlink file, and the legacy lockPathFor tried to mkdir on it.
    // Canonicalize through realpathSync.native so the path is in the
    // long-name form even when os.tmpdir() returned the 8.3 short form
    // (Windows GH Actions runners surface either, depending on which
    // API populated TEMP). The native variant calls Windows'
    // GetFinalPathNameByHandle, which expands short-name segments;
    // the JS realpathSync does not.
    const mainRepo = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'epic-lock-main-')),
    );
    try {
      const run = (args, cwd = mainRepo) =>
        execFileSync('git', args, { cwd, stdio: 'ignore' });
      run(['init', '--initial-branch=main']);
      run(['config', 'user.email', 'test@example.com']);
      run(['config', 'user.name', 'Test']);
      run(['commit', '--allow-empty', '-m', 'init']);

      const worktreeRoot = path.join(
        path.dirname(mainRepo),
        `${path.basename(mainRepo)}-wt`,
      );
      run(['worktree', 'add', '-b', 'wt-branch', worktreeRoot]);

      try {
        // Sanity: .git in the worktree is a file, not a directory.
        const gitlinkStat = fs.statSync(path.join(worktreeRoot, '.git'));
        assert.equal(
          gitlinkStat.isFile(),
          true,
          'precondition: worktree .git must be a gitlink file',
        );

        // The fix: lock acquisition resolves to the *common* gitdir.
        // git rev-parse emits forward slashes on Windows; normalize both
        // sides before comparing. We use `fs.realpathSync.native` (which
        // calls Windows' GetFinalPathNameByHandle) rather than the JS
        // `fs.realpathSync` because only the native variant expands 8.3
        // short-name segments. On GH Actions Windows runners os.tmpdir()
        // can return either the long form (C:\Users\runneradmin\…) or
        // the short form (C:\Users\RUNNER~1\…) depending on which API
        // populated TEMP, and `git rev-parse --git-common-dir` may
        // emit the opposite form. realpathSync.native canonicalizes
        // both to the long form. Lower-cased to neutralize drive-letter
        // and any residual segment-case differences.
        const norm = (p) =>
          fs.realpathSync.native(path.resolve(p)).toLowerCase();
        const expectedGitDir = norm(path.join(mainRepo, '.git'));
        assert.equal(
          norm(resolveGitCommonDir(worktreeRoot)),
          expectedGitDir,
          'common gitdir resolves to the parent repo',
        );

        const handle = await acquireEpicMergeLock(123, {
          repoRoot: worktreeRoot,
          timeoutMs: 1000,
        });
        try {
          assert.equal(
            norm(path.dirname(handle.filePath)),
            expectedGitDir,
            'lock file lands in the parent repo .git/, not the worktree gitlink',
          );
          assert.ok(fs.existsSync(handle.filePath));
        } finally {
          releaseEpicMergeLock(handle);
        }
      } finally {
        run(['worktree', 'remove', '--force', worktreeRoot]);
      }
    } finally {
      fs.rmSync(mainRepo, { recursive: true, force: true });
    }
  });
});
