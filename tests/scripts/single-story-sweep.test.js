import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sweepMergedStoryBranches } from '../../.agents/scripts/lib/single-story-sweep.js';

/**
 * Build a `planCleanup` fake that returns the supplied candidates after
 * applying the same `filter` the real implementation uses. Lets the test
 * assert that the current-story branch is excluded by the include/exclude
 * filter even when the underlying lister would have surfaced it.
 */
function makePlanFake(candidatePool) {
  return ({ filter = () => true } = {}) => ({
    candidates: candidatePool.filter((c) => filter(c.branch)),
    skipped: candidatePool
      .filter((c) => !filter(c.branch))
      .map((c) => ({ branch: c.branch, reason: 'filtered' })),
  });
}

function makeExecuteFake({ failures = [], extraLocalDropped = 0 } = {}) {
  return ({ candidates }) => {
    const local = candidates.map((c) => ({ branch: c.branch, ok: true }));
    const remote = candidates.map((c) => ({ branch: c.branch, ok: true }));
    // Allow simulating partial failures via injected `failures`.
    for (let i = 0; i < extraLocalDropped && local.length > 0; i += 1) {
      local[local.length - 1 - i].ok = false;
    }
    return {
      worktrees: [],
      local,
      remote,
      prune: { attempted: true, ok: true, remote: 'origin', pruned: [] },
      failures,
      ok: failures.length === 0,
    };
  };
}

describe('sweepMergedStoryBranches', () => {
  it('reaps every merged story-* candidate the planner surfaces', async () => {
    const candidates = [
      { branch: 'story-100', detectedBy: 'gh' },
      { branch: 'story-101', detectedBy: 'gh' },
    ];
    const logs = [];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      logger: { info: (m) => logs.push(['info', m]) },
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidates, 2);
    assert.equal(result.localDeleted, 2);
    assert.equal(result.remoteDeleted, 2);
    assert.deepEqual(result.failures, []);
  });

  it('excludes the current story branch even when merged', async () => {
    // Planner pool includes the run's own branch — the filter must drop it.
    const candidates = [
      { branch: 'story-200', detectedBy: 'gh' }, // current
      { branch: 'story-100', detectedBy: 'gh' },
    ];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(result.candidates, 1, 'current story not a candidate');
    assert.equal(result.localDeleted, 1);
  });

  it('also excludes non-story branches via the include glob', async () => {
    const candidates = [
      { branch: 'feat/foo', detectedBy: 'gh' },
      { branch: 'epic/123', detectedBy: 'gh' },
      { branch: 'story-7', detectedBy: 'gh' },
    ];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-9',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(result.candidates, 1);
    assert.equal(
      result.localDeleted,
      1,
      'only story-* branches are reaped — feat/* and epic/* pass through',
    );
  });

  it('returns a zero envelope (no execute call) when there are no candidates', async () => {
    let executeCalled = false;
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-1',
      planCleanupFn: () => ({ candidates: [], skipped: [] }),
      executeCleanupFn: () => {
        executeCalled = true;
        return { local: [], remote: [], failures: [], ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidates, 0);
    assert.equal(executeCalled, false, 'execute skipped on empty plan');
  });

  it('captures plan-time errors and never throws', async () => {
    const warns = [];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-1',
      logger: { warn: (m) => warns.push(m) },
      planCleanupFn: () => {
        throw new Error('git not available');
      },
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error ?? '', /plan: git not available/);
    assert.equal(warns.length, 1);
  });

  it('captures execute-time errors and reports them in the envelope', async () => {
    const candidates = [{ branch: 'story-100', detectedBy: 'gh' }];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: () => {
        throw new Error('worktree busy');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.candidates, 1);
    assert.match(result.error ?? '', /execute: worktree busy/);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].scope, 'execute');
  });

  it('surfaces partial reap failures without throwing', async () => {
    const candidates = [
      { branch: 'story-100', detectedBy: 'gh' },
      { branch: 'story-101', detectedBy: 'gh' },
    ];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake({
        extraLocalDropped: 1,
        failures: [{ branch: 'story-101', scope: 'local', stderr: 'pinned' }],
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.candidates, 2);
    assert.equal(result.localDeleted, 1, 'one local succeeded, one failed');
    assert.equal(result.failures.length, 1);
  });

  it('filters protected candidates out of executeCleanup and surfaces them in result.protected', async () => {
    const candidates = [
      {
        branch: 'story-100',
        prNumber: 100,
        hasWorktree: false,
        detectedBy: 'gh',
      },
      {
        branch: 'story-101',
        prNumber: 101,
        hasWorktree: false,
        detectedBy: 'gh',
      },
    ];
    const executedAgainst = [];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: ({ candidates: c }) => {
        executedAgainst.push(...c.map((x) => x.branch));
        return makeExecuteFake()({ candidates: c });
      },
      protectionFn: ({ candidate }) =>
        candidate.branch === 'story-100'
          ? { protected: true, reason: 'unpushed-work' }
          : { protected: false },
      protectionCtx: { repoRoot: '/tmp/repo' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidates, 2);
    assert.equal(result.localDeleted, 1);
    assert.deepEqual(executedAgainst, ['story-101']);
    assert.equal(result.protected.length, 1);
    assert.equal(result.protected[0].branch, 'story-100');
    assert.equal(result.protected[0].reason, 'unpushed-work');
  });

  it('skips executeCleanup entirely when every candidate is protected', async () => {
    const candidates = [
      {
        branch: 'story-100',
        prNumber: 100,
        hasWorktree: false,
        detectedBy: 'gh',
      },
      {
        branch: 'story-101',
        prNumber: 101,
        hasWorktree: false,
        detectedBy: 'gh',
      },
    ];
    let executeCalled = false;
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: () => {
        executeCalled = true;
        return { local: [], remote: [], failures: [], ok: true };
      },
      protectionFn: () => ({ protected: true, reason: 'ticket-not-done' }),
      protectionCtx: { repoRoot: '/tmp/repo' },
    });
    assert.equal(executeCalled, false, 'execute skipped when nothing reapable');
    assert.equal(result.ok, true);
    assert.equal(result.candidates, 2);
    assert.equal(result.localDeleted, 0);
    assert.equal(result.protected.length, 2);
  });

  it('reports lock contention by skipping the sweep and emitting a warn log', async () => {
    const warns = [];
    let executeCalled = false;
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      logger: { warn: (m) => warns.push(m) },
      planCleanupFn: () => {
        throw new Error('plan should not run when lock is contended');
      },
      executeCleanupFn: () => {
        executeCalled = true;
        return { local: [], remote: [], failures: [], ok: true };
      },
      acquireLockFn: () => ({ acquired: false, reason: 'contended' }),
      lockPath: '/tmp/repo/sweep.lock',
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'lock-contended');
    assert.equal(executeCalled, false);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /lock not acquired/);
  });

  it('releases the lock even when executeCleanup throws', async () => {
    let released = false;
    const candidates = [
      {
        branch: 'story-100',
        prNumber: 100,
        hasWorktree: false,
        detectedBy: 'gh',
      },
    ];
    const result = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      currentStoryBranch: 'story-200',
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: () => {
        throw new Error('worktree busy');
      },
      acquireLockFn: () => ({
        acquired: true,
        release: () => {
          released = true;
        },
        ownerId: 'test',
      }),
      lockPath: '/tmp/repo/sweep.lock',
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /worktree busy/);
    assert.equal(released, true, 'lock release must run on failure path');
  });

  it('rejects malformed inputs (cwd / baseBranch) without throwing', async () => {
    const noCwd = await sweepMergedStoryBranches({
      baseBranch: 'main',
      currentStoryBranch: 'story-1',
    });
    assert.equal(noCwd.ok, false);
    assert.equal(noCwd.skipped, true);
    assert.match(noCwd.error ?? '', /cwd is required/);

    const noBase = await sweepMergedStoryBranches({
      cwd: '/tmp/repo',
      currentStoryBranch: 'story-1',
    });
    assert.equal(noBase.ok, false);
    assert.match(noBase.error ?? '', /baseBranch is required/);
  });
});
