/**
 * Story #4622 — the post-land tail serializes its local-checkout git
 * mutations (`stepRefCleanup` + `stepBaseFastForward`) behind a best-effort
 * cross-process lock keyed on the main checkout.
 *
 * Under concurrent delivery (multiple story-workers closing against one
 * shared checkout with per-Story worktrees), an unserialized tail races on
 * the `main` ref and the worktree registry — the swarm-os friction #579
 * signature (`refCleanup:false` "used by worktree" / `baseFastForward:false`
 * "not-fast-forward"). These tests pin three properties:
 *
 *   1. The lock wraps ONLY the two git mutations; the GitHub-touching
 *      follow-up-capture and status-resync steps run outside it.
 *   2. The lock is never load-bearing: a failed acquire still runs the
 *      mutations (proceeding is the same best-effort contract every tail
 *      step has).
 *   3. Two concurrent tails against one real lockfile never interleave their
 *      critical sections.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runPostLandTail } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js';
import { reapWorktreePhase } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/worktree-reap.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

/** A gitSpawn stub: story-branch exists, deletes cleanly. */
function fakeGitSpawn(trace) {
  return (_cwd, ...args) => {
    if (args[0] === 'show-ref') return { status: 0 };
    if (args[0] === 'branch' && args[1] === '-D') {
      trace?.push('refCleanup');
      return { status: 0 };
    }
    return { status: 0 };
  };
}

/** Base seams that let both git mutations run to a clean success. */
function baseSeams(trace) {
  return {
    // Stubbed deliberately: the real emit takes its tempRoot from `config`,
    // which these tests do not pass, so an unstubbed call would append a
    // `close-failed` record to the MAIN checkout's signals stream for a real
    // Story id. Test isolation, not convenience.
    emitCloseRecoveredFrictionFn: async () => {
      trace?.push('closeRecovered');
      return true;
    },
    captureStoryFollowUpsFn: async () => {
      trace?.push('followUps');
      return { ok: true };
    },
    reassertStatusColumnFn: async () => {
      trace?.push('statusResync');
      return { status: 'synced' };
    },
    gitSpawnFn: fakeGitSpawn(trace),
    planFastForwardFn: () => ({ runnable: true, reason: null }),
    executeFastForwardFn: () => {
      trace?.push('baseFastForward');
      return { applied: true, behind: 1 };
    },
    // Stubbed for the same isolation reason as the friction emit above
    // (Story #4794): the real purge resolves its tempRoot from `config`,
    // which these tests do not pass, so an unstubbed call would scan a temp
    // tree this suite does not own. The engine has its own suite.
    purgeStoryTempArtifactsFn: async () => {
      trace?.push('tempPurge');
      return { skipped: null, purged: [], errors: [], bytesReclaimed: 0 };
    },
    // Stubbed for the same isolation reason (Story #4860): the real release
    // resolves an operator handle from `config` and PATCHes a live ticket's
    // assignees, so an unstubbed call would reach GitHub for a real Story id.
    releaseStoryLeaseFn: async () => {
      trace?.push('leaseRelease');
      return { released: true, owner: 'tester', reason: 'released' };
    },
    // Stubbed for the same isolation reason (Story #5205): the real rollup
    // lists open Epics and PATCHes a container, so an unstubbed call would
    // reach GitHub. Its own engine suite is `epic-rollup.test.js`.
    rollUpEpicForStoryFn: async () => {
      trace?.push('epicRollup');
      return { epics: [], closed: [], pending: [], reason: null };
    },
    // Stubbed so no test reaches a real `git worktree remove` (Story #5533).
    reapWorktreePhaseFn: async () => {
      trace?.push('worktreeReap');
      return { removed: true, skipped: false, reason: null };
    },
  };
}

let tmpDir;
beforeEach(() => {
  // A `.git` dir must exist for the lockfile's parent to be writable.
  tmpDir = makeTempDir('post-land-lock-');
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runPostLandTail — lock scope (Story #4622)', () => {
  it('acquires before the git mutations and releases after, with GitHub steps outside', async () => {
    const events = [];
    let released = false;
    const acquireLockWithWaitFn = async () => {
      events.push('acquire');
      return {
        acquired: true,
        release: () => {
          released = true;
          events.push('release');
        },
        ownerId: 'test',
      };
    };

    const tail = await runPostLandTail({
      storyId: 4622,
      storyBranch: 'story-4622',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      ...baseSeams(events),
      acquireLockWithWaitFn,
    });

    assert.deepEqual(tail, {
      followUps: true,
      statusResync: true,
      worktreeReap: true,
      refCleanup: true,
      baseFastForward: true,
      tempPurge: true,
      leaseRelease: true,
      epicRollup: true,
      details: {
        followUps: null,
        statusResync: null,
        worktreeReap: null,
        refCleanup: null,
        baseFastForward: null,
        tempPurge: null,
        leaseRelease: null,
        epicRollup: null,
      },
    });
    assert.ok(released, 'the lock is released');
    // The close-recovery marker is emitted FIRST (Story #4649): follow-up
    // capture reads the signal stream, so a marker written after it would
    // arrive too late to net the failure it cancels out of this very run.
    // Story #5417: the GitHub steps and the locked mutations then run
    // concurrently (this order is their start order); both mutations stay
    // inside the lock. The temp purge (Story #4794) is outside the lock: it touches only the
    // temp tree, so it contends with nothing, and running it after every
    // other step means no step can still be reading what it deletes. The
    // lease release (Story #4860) is last and also outside — it is a pure
    // GitHub write, and running it after every step means the claim outlives
    // everything that could still fail.
    assert.deepEqual(events, [
      'closeRecovered',
      'followUps',
      'statusResync',
      'epicRollup',
      'acquire',
      'worktreeReap',
      'refCleanup',
      'baseFastForward',
      'release',
      'tempPurge',
      'leaseRelease',
    ]);
  });

  it('keys the lockfile on the main checkout .git dir', async () => {
    let seenLockPath = null;
    await runPostLandTail({
      storyId: 4622,
      storyBranch: 'story-4622',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      ...baseSeams(),
      acquireLockWithWaitFn: async ({ lockPath }) => {
        seenLockPath = lockPath;
        return { acquired: true, release: () => {}, ownerId: 't' };
      },
    });
    assert.equal(
      seenLockPath,
      path.join(tmpDir, '.git', 'mandrel-post-land-tail.lock'),
    );
  });

  it('still runs both mutations when the lock is never acquired (not load-bearing)', async () => {
    const trace = [];
    const tail = await runPostLandTail({
      storyId: 4622,
      storyBranch: 'story-4622',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      ...baseSeams(trace),
      acquireLockWithWaitFn: async () => ({
        acquired: false,
        reason: 'contended-after-wait',
      }),
    });
    assert.equal(tail.refCleanup, true, 'ref cleanup still ran');
    assert.equal(tail.baseFastForward, true, 'fast-forward still ran');
    assert.ok(
      trace.includes('refCleanup') && trace.includes('baseFastForward'),
    );
  });

  it('releases the lock even when a git mutation throws', async () => {
    let released = false;
    const seams = baseSeams();
    seams.gitSpawnFn = () => {
      throw new Error('git exploded');
    };
    const tail = await runPostLandTail({
      storyId: 4622,
      storyBranch: 'story-4622',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      ...seams,
      acquireLockWithWaitFn: async () => ({
        acquired: true,
        release: () => {
          released = true;
        },
        ownerId: 't',
      }),
    });
    // The step wrapper converts the throw to a degraded boolean (never
    // throws), and the `finally` still releases the lock.
    assert.equal(tail.refCleanup, false);
    assert.ok(released, 'the lock is released despite the throw');
  });
});

describe('runPostLandTail — real cross-process serialization (Story #4622)', () => {
  it('two concurrent tails never interleave their critical sections', async () => {
    // Real lock (default acquireLockWithWaitFn). The critical section spans
    // an `await step()` boundary between the ref-delete (enter) and the
    // fast-forward (leave), so without the lock two concurrent tails DO
    // interleave — verified separately to reach maxConcurrent 2. The lock
    // must pin it at 1.
    let inside = 0;
    let maxConcurrent = 0;
    const yieldTick = () => new Promise((r) => setImmediate(r));

    const seams = () => ({
      // Same isolation contract as `baseSeams` — an unstubbed emit takes its
      // tempRoot from `config`, which this test does not pass, and would
      // append to the MAIN checkout's stream for these fixture ids.
      emitCloseRecoveredFrictionFn: async () => true,
      captureStoryFollowUpsFn: async () => ({ ok: true }),
      reassertStatusColumnFn: async () => ({ status: 'synced' }),
      gitSpawnFn: (_cwd, ...args) => {
        if (args[0] === 'show-ref') return { status: 0 };
        if (args[0] === 'branch' && args[1] === '-D') {
          inside += 1;
          maxConcurrent = Math.max(maxConcurrent, inside);
          return { status: 0 };
        }
        return { status: 0 };
      },
      planFastForwardFn: () => ({ runnable: true, reason: null }),
      executeFastForwardFn: () => {
        inside -= 1;
        return { applied: true, behind: 1 };
      },
      // Same isolation contract (Story #4860): the real release would PATCH a
      // live ticket's assignees for these fixture ids.
      releaseStoryLeaseFn: async () => ({
        released: true,
        owner: 'tester',
        reason: 'released',
      }),
    });

    const run = (storyId) =>
      runPostLandTail({
        storyId,
        storyBranch: `story-${storyId}`,
        baseBranch: 'main',
        cwd: tmpDir,
        provider: {},
        ...seams(),
      });

    await Promise.all([
      run(1),
      yieldTick().then(() => run(2)),
      run(3),
      yieldTick().then(() => run(4)),
    ]);

    assert.equal(
      maxConcurrent,
      1,
      'the lock kept every critical section mutually exclusive',
    );
  });

  it('Story #5417: GitHub steps run concurrently; purge and lease release wait for all of them', async () => {
    const events = [];
    let inFlight = 0;
    let peak = 0;
    const slow = (name, value) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      events.push(name);
      return value;
    };
    await runPostLandTail({
      storyId: 5417,
      storyBranch: 'story-5417',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      ...baseSeams(events),
      captureStoryFollowUpsFn: slow('followUps', { ok: true }),
      reassertStatusColumnFn: slow('statusResync', { status: 'synced' }),
      rollUpEpicForStoryFn: slow('epicRollup', { epics: [], closed: [] }),
      reapPlanRunLabelsForStoryFn: slow('reap', { deleted: [], failed: [] }),
    });
    assert.equal(peak, 4, 'all four GitHub steps were in flight at once');
    assert.equal(events.at(-1), 'leaseRelease', 'lease release runs last');
    assert.equal(events.at(-2), 'tempPurge', 'purge follows every reader');
  });

  it('Story #5417: a throwing concurrent step degrades only its own boolean', async () => {
    const tail = await runPostLandTail({
      storyId: 5417,
      storyBranch: 'story-5417',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      ...baseSeams([]),
      reassertStatusColumnFn: async () => {
        throw new Error('boom');
      },
      reapPlanRunLabelsForStoryFn: async () => ({ deleted: [], failed: [] }),
    });
    assert.equal(tail.statusResync, false);
    assert.equal(tail.details.statusResync, 'boom');
    for (const key of [
      'followUps',
      'refCleanup',
      'baseFastForward',
      'tempPurge',
      'leaseRelease',
      'epicRollup',
    ]) {
      assert.equal(tail[key], true, key);
    }
  });
});

/**
 * Story #5533 — worktree lifetime is Story lifetime. The close pipeline no
 * longer reaps; the tail does, under the lock and BEFORE the local ref reap,
 * because `git branch -D` refuses a branch a live worktree still holds.
 */
describe('runPostLandTail — the worktree reap (Story #5533)', () => {
  /** A repo where the story branch is held while its worktree exists. */
  function heldBranchRepo({ dirty = false } = {}) {
    const wtPath = path.join(tmpDir, '.worktrees', 'story-5533');
    fs.mkdirSync(wtPath, { recursive: true });
    const removed = [];
    class FakeWorktreeManager {
      reap() {
        if (dirty) {
          return {
            removed: false,
            reason: 'uncommitted-changes',
            path: wtPath,
          };
        }
        fs.rmSync(wtPath, { recursive: true, force: true });
        removed.push(wtPath);
        return { removed: true, path: wtPath };
      }
    }
    const gitSpawnFn = (_cwd, ...args) => {
      if (args[0] === 'show-ref') return { status: 0 };
      if (args[0] === 'branch' && args[1] === '-D') {
        return fs.existsSync(wtPath)
          ? {
              status: 1,
              stderr: `error: cannot delete branch 'story-5533' used by worktree at '${wtPath}'`,
            }
          : { status: 0 };
      }
      return { status: 0 };
    };
    return {
      wtPath,
      removed,
      seams: {
        gitSpawnFn,
        reapWorktreePhaseFn: (args) =>
          reapWorktreePhase({ ...args, WorktreeManager: FakeWorktreeManager }),
      },
    };
  }

  function runTail(seams) {
    return runPostLandTail({
      storyId: 5533,
      storyBranch: 'story-5533',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      config: { delivery: { worktreeIsolation: { root: '.worktrees' } } },
      ...baseSeams([]),
      reapPlanRunLabelsForStoryFn: async () => ({ deleted: [], failed: [] }),
      ...seams,
    });
  }

  it('AC-2: a landed Story with a live worktree ends with both the worktree and the local branch gone', async () => {
    const repo = heldBranchRepo();
    const tail = await runTail(repo.seams);
    assert.equal(fs.existsSync(repo.wtPath), false, 'the worktree is gone');
    assert.deepEqual(repo.removed, [repo.wtPath]);
    assert.equal(tail.worktreeReap, true);
    assert.equal(tail.details.worktreeReap, null);
    assert.equal(
      tail.refCleanup,
      true,
      'the ref reap ran AFTER the worktree let go of the branch',
    );
    assert.equal(tail.details.refCleanup, null);
  });

  it('AC-1: reports a refused reap as its own degraded step — the land stands', async () => {
    const repo = heldBranchRepo({ dirty: true });
    const tail = await runTail(repo.seams);
    assert.equal(fs.existsSync(repo.wtPath), true, 'a dirty tree is kept');
    assert.equal(tail.worktreeReap, false);
    assert.equal(tail.details.worktreeReap, 'uncommitted-changes');
    assert.equal(tail.leaseRelease, true, 'later steps still ran');
  });

  it('a Story with no worktree left reports the reap ok, naming why', async () => {
    const tail = await runTail({
      gitSpawnFn: fakeGitSpawn(),
      reapWorktreePhaseFn: reapWorktreePhase,
    });
    assert.equal(tail.worktreeReap, true);
    assert.equal(tail.details.worktreeReap, 'no-worktree');
    assert.equal(tail.refCleanup, true);
  });

  it('honours reapOnSuccess:false — the operator keeps the tree, the step is ok', async () => {
    const repo = heldBranchRepo();
    const tail = await runPostLandTail({
      storyId: 5533,
      storyBranch: 'story-5533',
      baseBranch: 'main',
      cwd: tmpDir,
      provider: {},
      config: {
        delivery: {
          worktreeIsolation: { root: '.worktrees', reapOnSuccess: false },
        },
      },
      ...baseSeams([]),
      reapPlanRunLabelsForStoryFn: async () => ({ deleted: [], failed: [] }),
      ...repo.seams,
    });
    assert.equal(fs.existsSync(repo.wtPath), true);
    assert.equal(tail.worktreeReap, true);
    assert.equal(tail.details.worktreeReap, 'reap-disabled');
  });
});
