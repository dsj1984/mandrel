/**
 * tests/single-story-close-worktree-reap.test.js — Story #4539.
 *
 * These tests drive `reapWorktreePhase` against the REAL `WorktreeManager`
 * (only `git` is faked), because the two bugs this Story fixes both hid in
 * the seam between the phase and the manager:
 *
 *   1. A v2-era precondition refused every `story-<id>` worktree unless an
 *      Epic integration branch was supplied — which the v2 close path never
 *      does. So no close ever reaped.
 *   2. The phase set `worktreeReaped = true` on any non-throwing call
 *      without reading the returned envelope. `reap` signals refusal by
 *      RETURNING `{ removed: false, reason }`, so the refusal was invisible
 *      and every close claimed a reap it never performed.
 *
 * A unit test that calls `wm.reap(id)` directly cannot catch either bug —
 * the first fix was initially defeated at the call site while such a test
 * stayed green. Exercise the phase's own call shape.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { reapWorktreePhase } from '../.agents/scripts/lib/orchestration/single-story-close/phases/worktree-reap.js';
import { WorktreeManager } from '../.agents/scripts/lib/worktree-manager.js';

const NOOP_PROGRESS = () => {};

/**
 * Fake git for a clean `story-<id>` worktree whose branch is pushed but
 * NOT yet merged into the base — the exact state at close time, since the
 * reap phase runs before the merge confirms.
 */
function makeGit({ dirty = false, wtPath, removeStatus = 0 }) {
  const calls = [];
  return {
    calls,
    gitSpawn: (_cwd, ...args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key.startsWith('worktree list')) {
        return {
          status: 0,
          stdout: `worktree ${wtPath}\nHEAD abc1234\nbranch refs/heads/story-4539\n`,
          stderr: '',
        };
      }
      if (key.startsWith('status --porcelain')) {
        return { status: 0, stdout: dirty ? ' M src/a.js\n' : '', stderr: '' };
      }
      if (key.startsWith('rev-parse --abbrev-ref')) {
        return { status: 0, stdout: 'story-4539\n', stderr: '' };
      }
      if (key.startsWith('rev-parse HEAD')) {
        return { status: 0, stdout: 'abc1234\n', stderr: '' };
      }
      // Not merged into the base — true for every close, which reaps
      // before the PR lands.
      if (key.startsWith('merge-base --is-ancestor')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (key.startsWith('cherry')) {
        return { status: 0, stdout: '+ abc1234\n', stderr: '' };
      }
      if (key.startsWith('log')) return { status: 0, stdout: '', stderr: '' };
      if (key.startsWith('worktree remove')) {
        return { status: removeStatus, stdout: '', stderr: 'busy' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function withWorktree(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-phase-'));
  const wtPath = path.join(tmp, '.worktrees', 'story-4539');
  fs.mkdirSync(wtPath, { recursive: true });
  try {
    return fn({ tmp, wtPath });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('reapWorktreePhase — the close-path call shape (Story #4539)', () => {
  it('reaps a clean, pushed-but-unmerged story worktree — the state every close is actually in', async () => {
    await withWorktree(async ({ tmp, wtPath }) => {
      const git = makeGit({ wtPath });
      const reaped = await reapWorktreePhase({
        cwd: tmp,
        storyId: 4539,
        worktreePath: wtPath,
        wtIsolation: {},
        progress: NOOP_PROGRESS,
        WorktreeManager: class extends WorktreeManager {
          constructor(args) {
            super({ ...args, git, platform: 'linux' });
          }
        },
      });
      assert.equal(
        reaped,
        true,
        'a clean worktree must reap at close time; the work is already on origin',
      );
      assert.ok(
        git.calls.some((c) => c.startsWith('worktree remove')),
        'the removal actually ran',
      );
    });
  });

  it('does not gate on merge reachability — that question is unanswerable before the PR lands', async () => {
    await withWorktree(async ({ tmp, wtPath }) => {
      const git = makeGit({ wtPath });
      await reapWorktreePhase({
        cwd: tmp,
        storyId: 4539,
        worktreePath: wtPath,
        wtIsolation: {},
        progress: NOOP_PROGRESS,
        WorktreeManager: class extends WorktreeManager {
          constructor(args) {
            super({ ...args, git, platform: 'linux' });
          }
        },
      });
      // Supplying a base ref here would activate isSafeToRemove's
      // reachability gate and refuse every reap with `unmerged-commits` —
      // swapping one always-refuse precondition for another.
      assert.equal(
        git.calls.some((c) => c.startsWith('merge-base --is-ancestor')),
        false,
        'the close-path reap must not probe merge reachability',
      );
    });
  });

  it('reports false — not a phantom success — when the removal is refused', async () => {
    await withWorktree(async ({ tmp, wtPath }) => {
      const messages = [];
      const git = makeGit({ dirty: true, wtPath });
      const reaped = await reapWorktreePhase({
        cwd: tmp,
        storyId: 4539,
        worktreePath: wtPath,
        wtIsolation: {},
        progress: (_tag, msg) => messages.push(msg),
        WorktreeManager: class extends WorktreeManager {
          constructor(args) {
            super({ ...args, git, platform: 'linux' });
          }
        },
      });
      assert.equal(reaped, false, 'a dirty tree is refused, and says so');
      assert.ok(
        messages.some((m) => /not reaped/.test(m) && /uncommitted/.test(m)),
        `the refusal reason is surfaced; got: ${JSON.stringify(messages)}`,
      );
      assert.equal(
        messages.some((m) => /🧹 Reaped/.test(m)),
        false,
        'must never claim a reap it did not perform',
      );
    });
  });

  it('honours reapOnSuccess:false without touching git', async () => {
    await withWorktree(async ({ tmp, wtPath }) => {
      const git = makeGit({ wtPath });
      const reaped = await reapWorktreePhase({
        cwd: tmp,
        storyId: 4539,
        worktreePath: wtPath,
        wtIsolation: { reapOnSuccess: false },
        progress: NOOP_PROGRESS,
        WorktreeManager: class extends WorktreeManager {
          constructor(args) {
            super({ ...args, git, platform: 'linux' });
          }
        },
      });
      assert.equal(reaped, false);
      assert.equal(git.calls.length, 0);
    });
  });
});
