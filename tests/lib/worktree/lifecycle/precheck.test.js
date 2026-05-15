/**
 * tests/lib/worktree/lifecycle/precheck.test.js
 *
 * Direct branch coverage for the precheck half of `isSafeToRemove`. The
 * helpers here are pure with respect to the `ctx` bag, so the tests fake
 * `ctx.git.gitSpawn` with table-driven outcomes — no tmp repo required.
 * The parent-level reap behaviour stays covered by the sibling
 * `post-rebase-reap.test.js` integration suite.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkLocalSafety,
  checkWorktreeDirty,
  readWorkingBranch,
} from '../../../../.agents/scripts/lib/worktree/lifecycle/precheck.js';

/**
 * Fake `ctx` builder. `responses` is a list whose entries are matched
 * against the spawn call's argv (after the leading `cwd`). Each response
 * is shaped as `{ status, stdout?, stderr? }`. The fake throws if a call
 * has no matching response, so the test fails loud on a spawn it didn't
 * predict.
 */
function fakeCtx(responses) {
  const calls = [];
  const queue = responses.slice();
  return {
    calls,
    git: {
      gitSpawn(cwd, ...args) {
        calls.push({ cwd, args });
        const next = queue.shift();
        if (!next) {
          throw new Error(
            `unexpected gitSpawn call: cwd=${cwd} argv=${args.join(' ')}`,
          );
        }
        return {
          status: next.status,
          stdout: next.stdout ?? '',
          stderr: next.stderr ?? '',
        };
      },
    },
  };
}

describe('checkWorktreeDirty', () => {
  it('safe when status returns exit 0 and empty stdout', () => {
    const ctx = fakeCtx([{ status: 0, stdout: '' }]);
    assert.deepEqual(checkWorktreeDirty(ctx, '/wt'), { safe: true });
  });

  it('unsafe (status-failed) when status spawn exits non-zero', () => {
    const ctx = fakeCtx([{ status: 1, stderr: 'fatal: not a repo' }]);
    assert.deepEqual(checkWorktreeDirty(ctx, '/wt'), {
      safe: false,
      reason: 'status-failed: fatal: not a repo',
    });
  });

  it('unsafe (uncommitted-changes) when status reports dirty entries', () => {
    const ctx = fakeCtx([{ status: 0, stdout: ' M file.txt' }]);
    assert.deepEqual(checkWorktreeDirty(ctx, '/wt'), {
      safe: false,
      reason: 'uncommitted-changes',
    });
  });
});

describe('readWorkingBranch', () => {
  it('returns branch name on clean rev-parse', () => {
    const ctx = fakeCtx([{ status: 0, stdout: 'story-42' }]);
    assert.deepEqual(readWorkingBranch(ctx, '/wt'), {
      safe: true,
      branch: 'story-42',
    });
  });

  it('unsafe (rev-parse-failed) when rev-parse exits non-zero', () => {
    const ctx = fakeCtx([{ status: 128, stderr: 'fatal: bad revision' }]);
    assert.deepEqual(readWorkingBranch(ctx, '/wt'), {
      safe: false,
      reason: 'rev-parse-failed: fatal: bad revision',
    });
  });

  it('unsafe (detached-head) when rev-parse returns the literal HEAD', () => {
    const ctx = fakeCtx([{ status: 0, stdout: 'HEAD' }]);
    assert.deepEqual(readWorkingBranch(ctx, '/wt'), {
      safe: false,
      reason: 'detached-head',
    });
  });
});

describe('checkLocalSafety', () => {
  it('reports path-missing without spawning git when wtPath does not exist', () => {
    const ctx = fakeCtx([]);
    const out = checkLocalSafety(ctx, '/definitely/not/a/path');
    assert.deepEqual(out, { safe: true, reason: 'path-missing' });
    assert.equal(ctx.calls.length, 0);
  });

  it('returns the dirty-tree verdict directly when status reports edits', () => {
    // Use a path that exists (the cwd) so fs.existsSync passes; the spawn
    // chain is intercepted entirely by the fake ctx.
    const ctx = fakeCtx([{ status: 0, stdout: ' M dirty.txt' }]);
    assert.deepEqual(checkLocalSafety(ctx, process.cwd()), {
      safe: false,
      reason: 'uncommitted-changes',
    });
  });

  it('returns the branch-read verdict directly when HEAD is detached', () => {
    const ctx = fakeCtx([
      { status: 0, stdout: '' }, // status clean
      { status: 0, stdout: 'HEAD' }, // detached HEAD
    ]);
    assert.deepEqual(checkLocalSafety(ctx, process.cwd()), {
      safe: false,
      reason: 'detached-head',
    });
  });

  it('returns safe + branch when both status and rev-parse pass', () => {
    const ctx = fakeCtx([
      { status: 0, stdout: '' }, // status clean
      { status: 0, stdout: 'story-1851' }, // branch
    ]);
    assert.deepEqual(checkLocalSafety(ctx, process.cwd()), {
      safe: true,
      branch: 'story-1851',
    });
  });
});
