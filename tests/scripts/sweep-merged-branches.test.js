import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sweepMergedBranches } from '../../.agents/scripts/lib/single-story-sweep.js';

/**
 * Build a `planCleanup` fake that returns the supplied candidates after
 * applying the same `filter` the real implementation uses — lets a test
 * assert the scope-agnostic include/exclude globs partition candidates.
 */
function makePlanFake(candidatePool) {
  return ({ filter = () => true } = {}) => ({
    candidates: candidatePool.filter((c) => filter(c.branch)),
    skipped: candidatePool
      .filter((c) => !filter(c.branch))
      .map((c) => ({ branch: c.branch, reason: 'filtered' })),
  });
}

function makeExecuteFake() {
  return ({ candidates }) => ({
    worktrees: [],
    local: candidates.map((c) => ({ branch: c.branch, ok: true })),
    remote: candidates.map((c) => ({ branch: c.branch, ok: true })),
    prune: { attempted: true, ok: true, remote: 'origin', pruned: [] },
    failures: [],
    ok: true,
  });
}

describe('sweepMergedBranches (scope-agnostic engine)', () => {
  it('sweeps an arbitrary include glob (not just story-*)', async () => {
    const candidates = [
      { branch: 'feat/foo', detectedBy: 'gh' },
      { branch: 'story-7', detectedBy: 'gh' },
      { branch: 'chore/bar', detectedBy: 'gh' },
    ];
    const executedAgainst = [];
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['feat/*'],
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: ({ candidates: c }) => {
        executedAgainst.push(...c.map((x) => x.branch));
        return makeExecuteFake()({ candidates: c });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.candidates, 1);
    assert.equal(result.localDeleted, 1);
    assert.deepEqual(executedAgainst, ['feat/foo']);
  });

  it('honours the exclude glob', async () => {
    const candidates = [
      { branch: 'story-1', detectedBy: 'gh' },
      { branch: 'story-2', detectedBy: 'gh' },
    ];
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['story-*'],
      exclude: ['story-2'],
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(result.candidates, 1);
    assert.equal(result.localDeleted, 1);
  });

  it('does NOT include a fastForward field when fastForward is off', async () => {
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['story-*'],
      planCleanupFn: () => ({ candidates: [], skipped: [] }),
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result, 'fastForward'), false);
  });

  it('runs the fast-forward step through the phase library when enabled', async () => {
    let ffCalls = 0;
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['story-*'],
      fastForward: true,
      planCleanupFn: () => ({ candidates: [], skipped: [] }),
      executeCleanupFn: makeExecuteFake(),
      planFastForwardFn: () => ({ runnable: true, behind: 2 }),
      executeFastForwardFn: () => {
        ffCalls += 1;
        return { ok: true, applied: true, skipped: false, behind: 2 };
      },
    });
    assert.equal(ffCalls, 1);
    assert.equal(result.fastForward.applied, true);
    assert.equal(result.fastForward.behind, 2);
  });

  it('treats a fast-forward failure as best-effort — the sweep still succeeds', async () => {
    const candidates = [{ branch: 'story-1', detectedBy: 'gh' }];
    const warns = [];
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['story-*'],
      fastForward: true,
      logger: { warn: (m) => warns.push(m) },
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake(),
      planFastForwardFn: () => ({ runnable: true, behind: 1 }),
      executeFastForwardFn: () => {
        throw new Error('checkout blocked');
      },
    });
    // Reap succeeded even though the fast-forward threw.
    assert.equal(result.ok, true);
    assert.equal(result.localDeleted, 1);
    assert.equal(result.fastForward.ok, false);
    assert.match(result.fastForward.error, /checkout blocked/);
    assert.equal(
      warns.some((w) => /fast-forward failed/.test(w)),
      true,
    );
  });

  it('applies the protection partition generically', async () => {
    const candidates = [
      { branch: 'story-1', prNumber: 1, detectedBy: 'gh' },
      { branch: 'story-2', prNumber: 2, detectedBy: 'gh' },
    ];
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['story-*'],
      planCleanupFn: makePlanFake(candidates),
      executeCleanupFn: makeExecuteFake(),
      protectionFn: ({ candidate }) =>
        candidate.branch === 'story-1'
          ? { protected: true, reason: 'ticket-not-done' }
          : { protected: false },
      protectionCtx: { repoRoot: '/tmp/repo' },
    });
    assert.equal(result.localDeleted, 1);
    assert.equal(result.protected.length, 1);
    assert.equal(result.protected[0].reason, 'ticket-not-done');
  });

  it('never touches the stash stack (no stash port is consulted)', async () => {
    // The engine has no stash seam at all; assert the envelope carries no
    // stash key so a future regression that folds stashes in is caught.
    const result = await sweepMergedBranches({
      cwd: '/tmp/repo',
      baseBranch: 'main',
      include: ['story-*'],
      planCleanupFn: () => ({ candidates: [], skipped: [] }),
      executeCleanupFn: makeExecuteFake(),
    });
    assert.equal(Object.hasOwn(result, 'stashes'), false);
  });

  describe('content-merged candidates (Story #4396, report-only)', () => {
    it('never reach executeCleanup and are reported under contentMerged', async () => {
      const candidates = [
        { branch: 'story-1', detectedBy: 'gh' },
        {
          branch: 'story-2',
          detectedBy: 'content-merged',
          worktreePath: '/tmp/repo/.worktrees/story-2',
        },
      ];
      const executedAgainst = [];
      const result = await sweepMergedBranches({
        cwd: '/tmp/repo',
        baseBranch: 'main',
        include: ['story-*'],
        planCleanupFn: makePlanFake(candidates),
        executeCleanupFn: ({ candidates: c }) => {
          executedAgainst.push(...c.map((x) => x.branch));
          return makeExecuteFake()({ candidates: c });
        },
      });
      assert.deepEqual(executedAgainst, ['story-1']);
      assert.equal(
        result.candidates,
        1,
        'content-merged excluded from the reap count',
      );
      assert.equal(result.localDeleted, 1);
      assert.deepEqual(result.contentMerged, [
        { branch: 'story-2', worktreePath: '/tmp/repo/.worktrees/story-2' },
      ]);
    });

    it('defaults worktreePath to null when the candidate has none', async () => {
      const candidates = [{ branch: 'story-9', detectedBy: 'content-merged' }];
      const result = await sweepMergedBranches({
        cwd: '/tmp/repo',
        baseBranch: 'main',
        include: ['story-*'],
        planCleanupFn: makePlanFake(candidates),
        executeCleanupFn: makeExecuteFake(),
      });
      assert.deepEqual(result.contentMerged, [
        { branch: 'story-9', worktreePath: null },
      ]);
    });

    it('surfaces contentMerged even when every other candidate is protected', async () => {
      const candidates = [
        { branch: 'story-1', detectedBy: 'gh' },
        { branch: 'story-2', detectedBy: 'content-merged' },
      ];
      const result = await sweepMergedBranches({
        cwd: '/tmp/repo',
        baseBranch: 'main',
        include: ['story-*'],
        planCleanupFn: makePlanFake(candidates),
        executeCleanupFn: makeExecuteFake(),
        protectionFn: () => ({ protected: true, reason: 'ticket-not-done' }),
        protectionCtx: { repoRoot: '/tmp/repo' },
      });
      assert.equal(result.localDeleted, 0);
      assert.equal(result.protected.length, 1);
      assert.equal(result.contentMerged.length, 1);
      assert.equal(result.contentMerged[0].branch, 'story-2');
    });

    it('returns a zero envelope with an empty contentMerged when nothing is reapable', async () => {
      const candidates = [{ branch: 'story-2', detectedBy: 'content-merged' }];
      let executeCalled = false;
      const result = await sweepMergedBranches({
        cwd: '/tmp/repo',
        baseBranch: 'main',
        include: ['story-*'],
        planCleanupFn: makePlanFake(candidates),
        executeCleanupFn: () => {
          executeCalled = true;
          return makeExecuteFake()({ candidates: [] });
        },
      });
      assert.equal(executeCalled, false);
      assert.equal(result.candidates, 0);
      assert.equal(result.localDeleted, 0);
      assert.deepEqual(result.contentMerged, [
        { branch: 'story-2', worktreePath: null },
      ]);
    });
  });
});
