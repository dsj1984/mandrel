/**
 * Regression test for Story #1815: `story-init.js` must never produce a
 * commit on the epic ref that touches `temp/`. Previously the
 * `forkAndCommitEpicSnapshot` path baked `temp/epic-<id>/baselines/*.json`
 * blobs into a `chore(baseline-snapshot):` commit on `epic/<id>` that was
 * never pushed to origin. Subsequent sub-agents on the same Epic saw
 * "local ahead of origin" at preflight and reset, wiping legitimate work.
 *
 * The fix removed the call from `bootstrapWorktree`. This test guards
 * against re-introduction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as branchInitializer from '../../../.agents/scripts/lib/story-init/branch-initializer.js';

test('branch-initializer no longer exports maybeForkSnapshot', () => {
  assert.equal(
    branchInitializer.maybeForkSnapshot,
    undefined,
    'maybeForkSnapshot must not be re-introduced — it commits temp/ files to epic/<id>',
  );
});

test('branch-initializer no longer exports reportSnapshotFork', () => {
  assert.equal(
    branchInitializer.reportSnapshotFork,
    undefined,
    'reportSnapshotFork was the friend-helper of the removed snapshot fork',
  );
});

test('bootstrapWorktree signature does not accept forkAndCommitEpicSnapshot dep', async () => {
  // The function still exists for the worktree-isolated branch path;
  // assert that callers cannot inject the snapshot helper anymore.
  // We probe by calling with a tracker — if the dep is honoured we'd see
  // a side effect; we expect it to be ignored entirely.
  const calls = [];
  let threw = null;
  try {
    await branchInitializer.bootstrapWorktree({
      epicBranch: 'epic/9999',
      storyBranch: 'story-9999',
      storyId: 9999,
      baseBranch: 'main',
      mainCwd: '/nonexistent-path-for-test',
      wtConfig: { enabled: false },
      progress: () => {},
      // This key used to be honoured; assert it's a no-op now.
      forkAndCommitEpicSnapshot: () => {
        calls.push('fork');
        return { commit: { committed: true, sha: 'deadbeef' } };
      },
    });
  } catch (err) {
    // We expect a real failure because mainCwd doesn't exist; that's fine —
    // the only thing under test is whether the snapshot helper was called.
    threw = err;
  }
  assert.equal(
    calls.length,
    0,
    'forkAndCommitEpicSnapshot must not be invoked from bootstrapWorktree',
  );
  // Sanity: we did exercise the function (or hit an early error before any
  // call site that could have invoked the helper).
  assert.ok(
    threw !== null,
    'bootstrapWorktree should have raised against the non-existent mainCwd',
  );
});
