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
import path from 'node:path';
import { describe, it } from 'node:test';

import { reapWorktreePhase } from '../.agents/scripts/lib/orchestration/single-story-close/phases/worktree-reap.js';
import { resolveStoryWorktree } from '../.agents/scripts/lib/orchestration/single-story-close/phases/worktree-restore.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import { WorktreeManager } from '../.agents/scripts/lib/worktree-manager.js';

const NOOP_PROGRESS = () => {};

/**
 * Fake git for a clean `story-<id>` worktree whose branch is NOT reachable
 * from the base — the state after a squash merge, which never makes the
 * branch an ancestor of the base, so the reap must not gate on it.
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
      // Not reachable from the base — true after every squash merge.
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
  const tmp = makeTempDir('reap-phase-');
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
        reaped.removed,
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
      assert.equal(
        reaped.removed,
        false,
        'a dirty tree is refused, and says so',
      );
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

  it('refuses to delete the tree the running script was loaded from', async () => {
    // The #4784 failure. `node .agents/scripts/single-story-close.js` invoked
    // with the shell cwd inside the Story worktree resolves to the
    // WORKTREE's copy of the script — so the reap deleted the running
    // program. Node had already loaded the static module graph, so nothing
    // died at the reap; the run died later, at the first lazy read, in the
    // terminal-envelope writer. Result: a Story whose PR had merged, whose
    // label was `agent::done`, and whose post-land tail was green exited
    // non-zero with no envelope, recoverable only by a second close run from
    // the main checkout.
    //
    // The tree surviving one extra cycle costs nothing — the next boot sweep
    // takes it. Reaping it costs the run's return contract.
    await withWorktree(async ({ tmp, wtPath }) => {
      const messages = [];
      const git = makeGit({ wtPath });
      const realArgv1 = process.argv[1];
      process.argv[1] = path.join(
        wtPath,
        '.agents',
        'scripts',
        'single-story-close.js',
      );
      try {
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
        assert.equal(
          reaped.removed,
          false,
          'the reap is refused, not performed',
        );
        assert.equal(
          git.calls.some((c) => c.startsWith('worktree remove')),
          false,
          'no removal may run against the tree holding the running script',
        );
        assert.ok(
          messages.some((m) => /running-from-target-tree/.test(m)),
          `the refusal names its reason; got: ${JSON.stringify(messages)}`,
        );
        assert.ok(
          messages.some((m) => /not reaped/.test(m)),
          'the phase reports the refusal rather than claiming a reap',
        );
      } finally {
        process.argv[1] = realArgv1;
      }
    });
  });

  it('reaps normally when the running script lives outside the tree', async () => {
    // The guard must be scoped to the actual hazard: a close driven from the
    // main checkout — the normal case — still reaps.
    await withWorktree(async ({ tmp, wtPath }) => {
      const git = makeGit({ wtPath });
      const realArgv1 = process.argv[1];
      process.argv[1] = path.join(tmp, 'main-checkout', 'close.js');
      try {
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
        assert.equal(reaped.removed, true);
      } finally {
        process.argv[1] = realArgv1;
      }
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
      assert.deepEqual(reaped, {
        removed: false,
        skipped: true,
        reason: 'reap-disabled',
      });
      assert.equal(git.calls.length, 0);
    });
  });
});

/**
 * Story #5533 AC-3 — a close (or `--wait` resume) whose Story worktree is
 * missing recreates it from `story-<id>` before any git operation, and never
 * falls back to the main checkout while isolation is enabled.
 */
describe('resolveStoryWorktree — the working copy close runs in (Story #5533)', () => {
  const ENABLED = {
    delivery: { worktreeIsolation: { enabled: true, root: '.worktrees' } },
  };

  function harness({ localRef = true, fetchStatus = 0, ensured } = {}) {
    const calls = [];
    return {
      calls,
      gitSpawn: (_cwd, ...args) => {
        calls.push(args.join(' '));
        if (args[0] === 'show-ref') return { status: localRef ? 0 : 1 };
        if (args[0] === 'fetch') {
          return { status: fetchStatus, stderr: 'fatal: no such ref' };
        }
        return { status: 0 };
      },
      WorktreeManager: class {
        constructor(opts) {
          calls.push(`new WorktreeManager root=${opts.config?.root}`);
        }
        async ensure(id, branch) {
          calls.push(`ensure ${id} ${branch}`);
          return (
            ensured ?? { path: `/repo/.worktrees/story-${id}`, created: true }
          );
        }
      },
    };
  }

  function resolve(h, { config = ENABLED, exists = false } = {}) {
    return resolveStoryWorktree({
      cwd: '/repo',
      config,
      storyId: 5533,
      storyBranch: 'story-5533',
      progress: NOOP_PROGRESS,
      gitSpawn: h.gitSpawn,
      WorktreeManager: h.WorktreeManager,
      existsSync: () => exists,
      env: {},
    });
  }

  it('returns a live worktree untouched — no git, no ensure', async () => {
    const h = harness();
    const wt = await resolve(h, { exists: true });
    assert.equal(wt, path.resolve('/repo', '.worktrees', 'story-5533'));
    assert.deepEqual(h.calls, []);
  });

  it('recreates a missing worktree from the local story ref', async () => {
    const h = harness();
    const wt = await resolve(h);
    assert.equal(wt, '/repo/.worktrees/story-5533');
    assert.ok(h.calls.includes('ensure 5533 story-5533'));
    assert.equal(
      h.calls.some((c) => c.startsWith('fetch')),
      false,
      'a local ref needs no fetch',
    );
  });

  it('fetches origin story-<id> first when no local ref exists', async () => {
    const h = harness({ localRef: false });
    await resolve(h);
    const fetchAt = h.calls.indexOf('fetch origin story-5533:story-5533');
    assert.ok(fetchAt >= 0, `fetched the remote ref; got ${h.calls}`);
    assert.ok(fetchAt < h.calls.indexOf('ensure 5533 story-5533'));
  });

  it('refuses rather than falling back to the main checkout', async () => {
    await assert.rejects(
      () => resolve(harness({ localRef: false, fetchStatus: 128 })),
      /cannot recreate the story-5533 worktree.*no such ref/,
    );
    await assert.rejects(
      () => resolve(harness({ ensured: { path: null, reason: 'boom' } })),
      /refusing to run in the main checkout/,
    );
  });

  it('with isolation off and no worktree, the main checkout is the working tree', async () => {
    const h = harness();
    const wt = await resolve(h, {
      config: { delivery: { worktreeIsolation: { enabled: false } } },
    });
    assert.equal(wt, null);
    assert.deepEqual(h.calls, []);
  });
});
