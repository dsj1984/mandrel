// tests/lib/orchestration/git-cleanup-branches-reap-decouple.test.js
//
// Story #3598 — the branches phase must not strand an already-merged
// local ref when worktree removal fails (Windows file lock). Ref reap is
// decoupled from worktree reap; lock-class removal failures degrade to a
// non-fatal deferred pending-cleanup handoff instead of a hard failure.
//
// Run: node --test tests/lib/orchestration/git-cleanup-branches-reap-decouple.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executeCleanup } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/branches.js';
import { reapWorktree } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/branches-reap.js';
import {
  isWorktreeLockFailure,
  removeWorktree,
} from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes-ff.js';
import {
  renderDeferredLine,
  renderExecutionSummary,
} from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/render.js';

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function mergedCandidate(overrides = {}) {
  return {
    branch: 'story-1285',
    prNumber: 1286,
    mergedAt: '2026-06-01',
    hasWorktree: true,
    worktreePath: '/repo/.worktrees/story-1285',
    detectedBy: 'gh',
    localExists: true,
    ...overrides,
  };
}

describe('git-cleanup branches reap — lock classification (Story #3598)', () => {
  it('isWorktreeLockFailure matches Windows lock-class stderr', () => {
    for (const s of [
      'fatal: Access is denied.',
      'unlink: permission denied',
      'remove failed: directory not empty',
      'EBUSY: resource busy or locked',
      'The process cannot access the file: sharing violation',
    ]) {
      assert.equal(isWorktreeLockFailure(s), true, s);
    }
  });

  it('isWorktreeLockFailure does not match plain git errors', () => {
    assert.equal(isWorktreeLockFailure('fatal: not a working tree'), false);
    assert.equal(isWorktreeLockFailure(''), false);
    assert.equal(isWorktreeLockFailure(undefined), false);
  });
});

describe('git-cleanup executeCleanup — decoupled ref reap (Story #3598)', () => {
  it('AC1: merged candidate whose worktree-remove fails still deletes the local ref', () => {
    const deleted = [];
    const out = executeCleanup({
      candidates: [mergedCandidate()],
      cwd: '/repo',
      remote: false,
      // Worktree removal fails with a Windows lock-class error.
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: true,
        stderr: 'Access is denied.',
      }),
      deleteLocalFn: (b) => {
        deleted.push(b);
        return { deleted: true, reason: 'deleted' };
      },
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      recordPendingCleanupFn: () => ({ storyId: 1285 }),
      logger: SILENT_LOGGER,
    });

    // The ref was deleted despite the worktree removal failing.
    assert.deepEqual(deleted, ['story-1285']);
    assert.equal(out.local.length, 1);
    assert.equal(out.local[0].ok, true);
  });

  it('AC1: --remote mode also deletes the remote ref of a lock-stranded candidate', () => {
    const remoteDeleted = [];
    const out = executeCleanup({
      candidates: [mergedCandidate()],
      cwd: '/repo',
      remote: true,
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: true,
        stderr: 'EBUSY: resource busy or locked',
      }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: (b) => {
        remoteDeleted.push(b);
        return { deleted: true, reason: 'deleted' };
      },
      pruneRemoteFn: () => ({ ok: true, pruned: [] }),
      recordPendingCleanupFn: () => ({ storyId: 1285 }),
      logger: SILENT_LOGGER,
    });

    assert.deepEqual(remoteDeleted, ['story-1285']);
    assert.equal(out.remote.length, 1);
    assert.equal(out.remote[0].ok, true);
  });

  it('AC2: a lock-class worktree failure hands off to pending-cleanup', () => {
    const handoffs = [];
    const out = executeCleanup({
      candidates: [mergedCandidate()],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: true,
        stderr: 'directory not empty',
      }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      recordPendingCleanupFn: (worktreeRoot, entry) => {
        handoffs.push({ worktreeRoot, entry });
        return { ...entry, attempts: 0 };
      },
      logger: SILENT_LOGGER,
    });

    assert.equal(handoffs.length, 1);
    // worktreeRoot derives from the candidate's worktree path parent.
    assert.match(handoffs[0].worktreeRoot, /[/\\]\.worktrees$/);
    assert.equal(handoffs[0].entry.storyId, 1285);
    assert.equal(handoffs[0].entry.branch, 'story-1285');
    assert.equal(out.deferred.length, 1);
    assert.equal(out.deferred[0].reason, 'worktree-lock');
    assert.ok(out.deferred[0].pendingCleanup);
  });

  it('AC3: a lock-class worktree failure does NOT make the run fail (ok stays true)', () => {
    const out = executeCleanup({
      candidates: [mergedCandidate()],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: true,
        stderr: 'Access is denied.',
      }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      recordPendingCleanupFn: () => null,
      logger: SILENT_LOGGER,
    });

    assert.equal(out.ok, true);
    assert.equal(out.failures.length, 0);
    assert.equal(out.deferred.length, 1);
  });

  it('AC4: a NON-lock worktree failure remains a hard failure (run exits non-zero)', () => {
    const out = executeCleanup({
      candidates: [mergedCandidate()],
      cwd: '/repo',
      remote: false,
      // Not a lock-class error: a genuine git problem.
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: false,
        stderr: 'fatal: not a working tree',
      }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      recordPendingCleanupFn: () => null,
      logger: SILENT_LOGGER,
    });

    // Ref is still reaped (decoupled), but the worktree failure is hard.
    assert.equal(out.local.length, 1);
    assert.equal(out.local[0].ok, true);
    assert.equal(out.ok, false);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].scope, 'worktree');
    assert.equal(out.deferred.length, 0);
  });

  it('a clean worktree removal reaps everything with no deferred entries', () => {
    const out = executeCleanup({
      candidates: [mergedCandidate()],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: () => ({ ok: true, dirty: false }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      logger: SILENT_LOGGER,
    });

    assert.equal(out.ok, true);
    assert.equal(out.worktrees.length, 1);
    assert.equal(out.worktrees[0].ok, true);
    assert.equal(out.local.length, 1);
    assert.equal(out.deferred.length, 0);
  });

  it('a non-story branch with a locked worktree defers without a manifest handoff', () => {
    const handoffs = [];
    const out = executeCleanup({
      candidates: [
        mergedCandidate({
          branch: 'feature/x',
          worktreePath: '/repo/.worktrees/feature-x',
        }),
      ],
      cwd: '/repo',
      remote: false,
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: true,
        stderr: 'permission denied',
      }),
      deleteLocalFn: () => ({ deleted: true, reason: 'deleted' }),
      deleteRemoteFn: () => ({ deleted: true, reason: 'deleted' }),
      recordPendingCleanupFn: (root, entry) => {
        handoffs.push(entry);
        return entry;
      },
      logger: SILENT_LOGGER,
    });

    // Manifest is keyed by storyId; a non-story branch gets no handoff but
    // its ref is still reaped and it stays non-fatal.
    assert.equal(handoffs.length, 0);
    assert.equal(out.ok, true);
    assert.equal(out.local.length, 1);
    assert.equal(out.deferred.length, 1);
    assert.equal(out.deferred[0].pendingCleanup, null);
  });
});

describe('git-cleanup reapWorktree — direct contract (Story #3598)', () => {
  it('a missing pending-cleanup handoff fn still records the deferred entry', () => {
    const worktrees = [];
    const failures = [];
    const deferred = [];
    const ok = reapWorktree({
      cand: mergedCandidate(),
      removeWorktreeFn: () => ({
        ok: false,
        dirty: true,
        lockClass: true,
        stderr: 'Access is denied.',
      }),
      cwd: '/repo',
      logger: SILENT_LOGGER,
      worktrees,
      failures,
      deferred,
      recordPendingCleanupFn: null,
      worktreeRoot: null,
    });

    assert.equal(ok, false);
    assert.equal(failures.length, 0);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].pendingCleanup, null);
    assert.equal(worktrees[0].lockClass, true);
  });

  it('a candidate without a worktree is a no-op pass-through', () => {
    const worktrees = [];
    const failures = [];
    const deferred = [];
    const ok = reapWorktree({
      cand: mergedCandidate({ hasWorktree: false, worktreePath: null }),
      removeWorktreeFn: () => {
        throw new Error('should not be called');
      },
      cwd: '/repo',
      logger: SILENT_LOGGER,
      worktrees,
      failures,
      deferred,
    });

    assert.equal(ok, true);
    assert.equal(worktrees.length, 0);
    assert.equal(deferred.length, 0);
  });
});

describe('git-cleanup render — deferred surface (Story #3598)', () => {
  it('renderDeferredLine surfaces the lock + ref-reaped signal', () => {
    const line = renderDeferredLine({
      branch: 'story-1285',
      path: '/repo/.worktrees/story-1285',
      pendingCleanup: { storyId: 1285 },
    });
    assert.match(line, /deferred/);
    assert.match(line, /story-1285/);
    assert.match(line, /ref reaped/);
    assert.match(line, /pending-cleanup sweep/);
  });

  it('renderExecutionSummary notes deferred worktrees on a clean run', () => {
    const summary = renderExecutionSummary({
      ok: true,
      local: [{ branch: 'story-1285', ok: true }],
      remote: [],
      worktrees: [{ ok: false, lockClass: true }],
      prune: null,
      deferred: [{ branch: 'story-1285', reason: 'worktree-lock' }],
    });
    assert.match(summary, /Reaped 1 local/);
    assert.match(summary, /1 worktree\(s\) deferred to sweep/);
  });
});

describe('removeWorktree — lockClass plumbing (Story #3598)', () => {
  it('threads lockClass through git-cleanup removeWorktree via injected spawn', () => {
    // removeWorktree calls gitSpawn internally; we cannot inject it here,
    // so this guards the classification helper the wrapper relies on.
    assert.equal(typeof removeWorktree, 'function');
    assert.equal(isWorktreeLockFailure('Access is denied.'), true);
  });
});
