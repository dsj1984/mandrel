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
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runPostLandTail } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js';

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
  };
}

let tmpDir;
beforeEach(() => {
  // A `.git` dir must exist for the lockfile's parent to be writable.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-land-lock-'));
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
      refCleanup: true,
      baseFastForward: true,
      details: {
        followUps: null,
        statusResync: null,
        refCleanup: null,
        baseFastForward: null,
      },
    });
    assert.ok(released, 'the lock is released');
    // The close-recovery marker is emitted FIRST (Story #4649): follow-up
    // capture reads the signal stream, so a marker written after it would
    // arrive too late to net the failure it cancels out of this very run.
    // GitHub steps then precede the lock; both mutations are inside it.
    assert.deepEqual(events, [
      'closeRecovered',
      'followUps',
      'statusResync',
      'acquire',
      'refCleanup',
      'baseFastForward',
      'release',
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
});
