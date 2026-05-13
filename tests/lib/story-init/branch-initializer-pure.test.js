/**
 * Pure-helper tests for `branch-initializer`. The impure orchestration
 * (`bootstrapWorktree`) is exercised end-to-end by `story-init.js`
 * smoke runs; here we lock down the small predicates it composes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maybeForkSnapshot,
  planStoryBranchSeed,
  reportSnapshotFork,
} from '../../../.agents/scripts/lib/story-init/branch-initializer.js';

test('planStoryBranchSeed: local branch present → no-op', () => {
  assert.equal(
    planStoryBranchSeed({ localHas: true, remoteHas: false }),
    'none',
  );
  assert.equal(
    planStoryBranchSeed({ localHas: true, remoteHas: true }),
    'none',
  );
});

test('planStoryBranchSeed: only remote → fetch into local', () => {
  assert.equal(
    planStoryBranchSeed({ localHas: false, remoteHas: true }),
    'fetch',
  );
});

test('planStoryBranchSeed: neither side has it → create from epic', () => {
  assert.equal(
    planStoryBranchSeed({ localHas: false, remoteHas: false }),
    'create',
  );
});

test('reportSnapshotFork: logs commit SHA when committed', () => {
  const calls = [];
  const progress = (kind, msg) => calls.push({ kind, msg });
  reportSnapshotFork(
    { commit: { committed: true, sha: 'abc1234deadbeef' } },
    'epic/42',
    progress,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].msg, /Forked main baselines → epic\/42/);
  assert.match(calls[0].msg, /abc1234/);
});

test('reportSnapshotFork: logs skip reason when not committed', () => {
  const calls = [];
  reportSnapshotFork(
    { commit: { committed: false, reason: 'no-change' } },
    'epic/42',
    (k, m) => calls.push(m),
  );
  assert.match(calls[0], /Snapshot fork skipped: no-change/);
});

test('reportSnapshotFork: defaults to no-files when reason is absent', () => {
  const calls = [];
  reportSnapshotFork(null, 'epic/42', (k, m) => calls.push(m));
  assert.match(calls[0], /Snapshot fork skipped: no-files/);
});

test('maybeForkSnapshot: skips entirely when epicId is null', () => {
  let called = false;
  maybeForkSnapshot({
    epicId: null,
    epicBranch: 'epic/42',
    mainCwd: '/repo',
    forkAndCommitEpicSnapshot: () => {
      called = true;
      return { commit: { committed: true } };
    },
    progress: () => {},
  });
  assert.equal(called, false);
});

test('maybeForkSnapshot: invokes fork helper and reports outcome', () => {
  const calls = [];
  maybeForkSnapshot({
    epicId: 42,
    epicBranch: 'epic/42',
    mainCwd: '/repo',
    forkAndCommitEpicSnapshot: () => ({
      commit: { committed: true, sha: 'cafef00d' },
    }),
    progress: (_, m) => calls.push(m),
  });
  assert.match(calls[0], /Forked main baselines/);
});

test('maybeForkSnapshot: swallows fork failures and warns', () => {
  const calls = [];
  maybeForkSnapshot({
    epicId: 42,
    epicBranch: 'epic/42',
    mainCwd: '/repo',
    forkAndCommitEpicSnapshot: () => {
      throw new Error('boom');
    },
    progress: (_, m) => calls.push(m),
  });
  assert.match(calls[0], /snapshot fork failed/);
  assert.match(calls[0], /boom/);
});
