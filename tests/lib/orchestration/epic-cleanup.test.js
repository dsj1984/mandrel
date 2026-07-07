import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  armCleanupIfMerged,
  deleteWtBranchIfPresent,
  detectMergedUncleanedEpic,
  epicBranchHasOpenPr,
  epicPrMergeState,
  fastForwardBaseBranch,
  findWorktreePathForBranch,
  getCheckedOutBranch,
  listEpicBranchesFromState,
  localRefExists,
  pruneRemoteTrackingRefs,
  reapBranch,
  reapEpicBranches,
  switchCheckoutOffBranch,
} from '../../../.agents/scripts/lib/orchestration/epic-cleanup.js';

describe('listEpicBranchesFromState', () => {
  it('extracts epic + story branches from the per-Story status map', () => {
    const state = {
      epicId: 1178,
      stories: {
        1191: { status: 'done' },
        1194: { status: 'done' },
        1197: { status: 'pending' },
        1192: { status: 'done' },
        1193: { status: 'blocked' },
        1198: { status: 'done' },
      },
    };
    const out = listEpicBranchesFromState(state);
    assert.equal(out.epicBranch, 'epic/1178');
    assert.deepEqual(out.storyBranches, [
      'story-1191',
      'story-1192',
      'story-1193',
      'story-1194',
      'story-1197',
      'story-1198',
    ]);
  });

  it('returns null epicBranch when state is empty / missing', () => {
    assert.deepEqual(listEpicBranchesFromState(null), {
      epicBranch: null,
      storyBranches: [],
    });
    assert.deepEqual(listEpicBranchesFromState({}), {
      epicBranch: null,
      storyBranches: [],
    });
  });

  it('ignores non-positive story ids', () => {
    const out = listEpicBranchesFromState({
      epicId: 1,
      stories: { 0: { status: 'pending' }, 5: { status: 'pending' } },
    });
    assert.deepEqual(out.storyBranches, ['story-5']);
  });
});

describe('findWorktreePathForBranch', () => {
  it('returns the matching worktree path', () => {
    const wts = [
      { path: '/a', branch: 'main' },
      { path: '/b', branch: 'story-9' },
    ];
    assert.equal(findWorktreePathForBranch('story-9', wts), '/b');
    assert.equal(findWorktreePathForBranch('story-42', wts), null);
  });
});

describe('reapBranch', () => {
  function fakeGitSpawnSequence(sequence) {
    const calls = [];
    const responses = [...sequence];
    return {
      calls,
      gitSpawn: (_cwd, ...args) => {
        calls.push(args.join(' '));
        return responses.shift() ?? { status: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('removes worktree on first try then deletes branch', () => {
    const { gitSpawn, calls } = fakeGitSpawnSequence([
      { status: 0, stdout: '', stderr: '' }, // worktree remove
      { status: 0, stdout: '', stderr: '' }, // worktree prune
      { status: 0, stdout: '', stderr: '' }, // branch -D
    ]);
    const out = reapBranch({
      branch: 'story-1',
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-1',
      gitSpawn,
    });
    assert.equal(out.worktreeReaped, true);
    assert.equal(out.branchDeleted, true);
    assert.equal(out.method, 'worktree-remove');
    assert.ok(calls[0].startsWith('worktree remove '));
  });

  it('falls back to --force when standard remove fails', () => {
    const { gitSpawn } = fakeGitSpawnSequence([
      { status: 1, stdout: '', stderr: 'locked' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: '', stderr: '' },
    ]);
    const out = reapBranch({
      branch: 'story-2',
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-2',
      gitSpawn,
    });
    assert.equal(out.method, 'worktree-remove-force');
    assert.equal(out.worktreeReaped, true);
    assert.equal(out.branchDeleted, true);
  });

  it('falls back to fs-rm when even --force fails', () => {
    const { gitSpawn } = fakeGitSpawnSequence([
      { status: 1, stdout: '', stderr: 'locked' },
      { status: 1, stdout: '', stderr: 'still locked' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: '', stderr: '' },
    ]);
    let rmCalled = false;
    const out = reapBranch({
      branch: 'story-3',
      cwd: '/repo',
      worktreePath: '/repo/.worktrees/story-3',
      gitSpawn,
      rmSyncFn: () => {
        rmCalled = true;
      },
    });
    assert.equal(rmCalled, true);
    assert.equal(out.method, 'fs-rm-fallback');
    assert.equal(out.worktreeReaped, true);
  });

  it('records branch-delete failures in stderr', () => {
    const { gitSpawn } = fakeGitSpawnSequence([
      { status: 0, stdout: '', stderr: '' }, // worktree remove
      { status: 0, stdout: '', stderr: '' }, // prune
      { status: 1, stdout: '', stderr: 'branch is checked out somewhere' },
    ]);
    const out = reapBranch({
      branch: 'story-4',
      cwd: '/repo',
      worktreePath: '/wt',
      gitSpawn,
    });
    assert.equal(out.branchDeleted, false);
    assert.match(out.stderr, /checked out/);
  });

  it('skips worktree steps when no path is given', () => {
    const { gitSpawn, calls } = fakeGitSpawnSequence([
      { status: 0, stdout: '', stderr: '' }, // branch -D only
    ]);
    const out = reapBranch({
      branch: 'story-5',
      cwd: '/repo',
      worktreePath: null,
      gitSpawn,
    });
    assert.equal(out.method, 'no-worktree');
    assert.equal(out.branchDeleted, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^branch -D/);
  });
});

describe('reapEpicBranches', () => {
  it('reaps every story branch + epic branch in order', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          status: 0,
          stdout: [
            'worktree /repo/.worktrees/story-1',
            'branch refs/heads/story-1',
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: {
        epicId: 100,
        stories: { 1: { status: 'done' }, 2: { status: 'done' } },
      },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => false,
    });
    assert.equal(out.ok, true);
    assert.equal(out.reaped.length, 3);
    const branches = out.reaped.map((r) => r.branch);
    assert.deepEqual(branches, ['story-1', 'story-2', 'epic/100']);
    assert.equal(out.epicBranchKept, false);
  });

  it('returns ok=true with no work when state is null', () => {
    const out = reapEpicBranches({
      state: null,
      cwd: '/repo',
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.epicId, null);
    assert.equal(out.reaped.length, 0);
  });

  it('aggregates failures', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'branch' && args[1] === '-D' && args[2] === 'story-99') {
        return { status: 1, stdout: '', stderr: 'still checked out' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 9, stories: { 99: { status: 'pending' } } },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => false,
    });
    assert.equal(out.ok, false);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].branch, 'story-99');
  });

  it('switches main checkout off epic/<id> before deleting it', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'epic/77', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 77, stories: { 1: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn,
      baseBranch: 'develop',
      epicBranchHasOpenPrFn: () => false,
    });
    assert.equal(out.switched.switched, true);
    assert.equal(out.switched.from, 'epic/77');
    assert.equal(out.switched.to, 'develop');
    // The checkout call must precede the epic/77 branch -D call.
    const idxCheckout = calls.indexOf('checkout develop');
    const idxDelEpic = calls.indexOf('branch -D epic/77');
    assert.ok(idxCheckout >= 0 && idxDelEpic > idxCheckout);
  });

  it('does not switch when the checkout is already off the epic branch', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'main', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 78, stories: { 1: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => false,
    });
    assert.equal(out.switched.switched, false);
    assert.equal(out.switched.from, 'main');
  });

  it('reports pruned tracking refs and a deleted wt-branch', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'main', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'remote' && args[1] === 'prune') {
        return {
          status: 0,
          stdout:
            'Pruning origin\nURL: https://example/repo.git\n * [pruned] origin/epic/100\n * [pruned] origin/story-1',
          stderr: '',
        };
      }
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 100, stories: { 1: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => false,
    });
    assert.deepEqual(out.pruned.pruned, ['origin/epic/100', 'origin/story-1']);
    assert.equal(out.wtBranch.deleted, true);
    assert.equal(out.wtBranch.present, true);
  });

  // Story #3367 — defense-in-depth: never reap an epic branch whose PR
  // is still open and unmerged.
  it('keeps epic/<id> (+ skips switch + skips remote prune) when an open PR exists', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'epic/100', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: {
        epicId: 100,
        stories: { 1: { status: 'done' }, 2: { status: 'done' } },
      },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => true,
    });
    // Epic branch kept; only story branches reaped.
    assert.equal(out.epicBranchKept, true);
    const branches = out.reaped.map((r) => r.branch);
    assert.deepEqual(branches, ['story-1', 'story-2']);
    // The destructive epic/100 delete MUST NOT have run.
    assert.ok(
      !calls.includes('branch -D epic/100'),
      'epic/100 must not be force-deleted while its PR is open',
    );
    // The checkout-off-branch switch is skipped (no epic delete to unblock).
    assert.equal(out.switched.switched, false);
    assert.ok(
      !calls.some((c) => c.startsWith('checkout ')),
      'checkout-off-branch switch must be skipped when the epic branch is kept',
    );
    // The remote prune (which would drop origin/epic/100) is skipped.
    assert.deepEqual(out.pruned.pruned, []);
    assert.ok(
      !calls.some((c) => c.startsWith('remote prune')),
      'remote prune must be skipped when the epic branch is kept',
    );
  });

  it('still reaps the epic branch when the probe reports no open PR', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 100, stories: { 1: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => false,
    });
    assert.equal(out.epicBranchKept, false);
    assert.ok(calls.includes('branch -D epic/100'));
  });
});

describe('getCheckedOutBranch', () => {
  it('returns the branch name when symbolic-ref succeeds', () => {
    const gitSpawn = () => ({ status: 0, stdout: 'epic/42\n', stderr: '' });
    assert.equal(getCheckedOutBranch({ cwd: '/repo', gitSpawn }), 'epic/42');
  });

  it('returns null on detached HEAD (symbolic-ref non-zero)', () => {
    const gitSpawn = () => ({ status: 1, stdout: '', stderr: '' });
    assert.equal(getCheckedOutBranch({ cwd: '/repo', gitSpawn }), null);
  });

  it('returns null when symbolic-ref prints whitespace', () => {
    const gitSpawn = () => ({ status: 0, stdout: '   \n', stderr: '' });
    assert.equal(getCheckedOutBranch({ cwd: '/repo', gitSpawn }), null);
  });
});

describe('switchCheckoutOffBranch', () => {
  it('checks out the target when the checkout is on the from-branch', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'epic/9', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = switchCheckoutOffBranch({
      fromBranch: 'epic/9',
      toBranch: 'main',
      cwd: '/repo',
      gitSpawn,
    });
    assert.equal(out.switched, true);
    assert.ok(calls.includes('checkout main'));
  });

  it('no-ops when the checkout is on a different branch', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'main', stderr: '' };
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const out = switchCheckoutOffBranch({
      fromBranch: 'epic/9',
      toBranch: 'main',
      cwd: '/repo',
      gitSpawn,
    });
    assert.equal(out.switched, false);
  });

  it('returns early when fromBranch or toBranch is missing', () => {
    const gitSpawn = () => {
      throw new Error('gitSpawn should not be called');
    };
    const out = switchCheckoutOffBranch({
      fromBranch: '',
      toBranch: 'main',
      cwd: '/repo',
      gitSpawn,
    });
    assert.equal(out.switched, false);
    assert.equal(out.from, null);
    assert.equal(out.to, null);
  });

  it('surfaces stderr when the checkout call fails', () => {
    const warnings = [];
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'epic/9', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'working tree dirty' };
    };
    const out = switchCheckoutOffBranch({
      fromBranch: 'epic/9',
      toBranch: 'main',
      cwd: '/repo',
      gitSpawn,
      logger: { warn: (m) => warnings.push(m) },
    });
    assert.equal(out.switched, false);
    assert.equal(out.stderr, 'working tree dirty');
    assert.ok(warnings.some((w) => /could not switch/.test(w)));
  });
});

describe('pruneRemoteTrackingRefs', () => {
  it('parses pruned refs from `git remote prune` output', () => {
    const gitSpawn = () => ({
      status: 0,
      stdout:
        'Pruning origin\nURL: https://example/repo.git\n * [pruned] origin/epic/1\n * [pruned] origin/story-2',
      stderr: '',
    });
    const out = pruneRemoteTrackingRefs({ cwd: '/repo', gitSpawn });
    assert.deepEqual(out.pruned, ['origin/epic/1', 'origin/story-2']);
  });

  it('returns an empty list with stderr when prune fails', () => {
    const gitSpawn = () => ({
      status: 1,
      stdout: '',
      stderr: 'no such remote',
    });
    const out = pruneRemoteTrackingRefs({ cwd: '/repo', gitSpawn });
    assert.deepEqual(out.pruned, []);
    assert.equal(out.stderr, 'no such remote');
  });

  it('returns an empty list when prune output has no [pruned] lines', () => {
    const gitSpawn = () => ({
      status: 0,
      stdout: 'Pruning origin\nURL: https://example/repo.git\n',
      stderr: '',
    });
    const out = pruneRemoteTrackingRefs({ cwd: '/repo', gitSpawn });
    assert.deepEqual(out.pruned, []);
  });
});

describe('deleteWtBranchIfPresent', () => {
  it('deletes wt-branch when the ref exists and is not checked out', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = deleteWtBranchIfPresent({ cwd: '/repo', gitSpawn });
    assert.equal(out.deleted, true);
    assert.equal(out.present, true);
    assert.ok(calls.includes('branch -D wt-branch'));
  });

  it('skips deletion when wt-branch is checked out in a worktree', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123', stderr: '' };
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const out = deleteWtBranchIfPresent({
      cwd: '/repo',
      gitSpawn,
      worktrees: [{ path: '/elsewhere', branch: 'wt-branch' }],
    });
    assert.equal(out.deleted, false);
    assert.equal(out.present, true);
    assert.equal(out.reason, 'checked-out');
  });

  it('no-ops when the ref does not exist', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const out = deleteWtBranchIfPresent({ cwd: '/repo', gitSpawn });
    assert.equal(out.deleted, false);
    assert.equal(out.present, false);
  });

  it('surfaces stderr when the branch -D call fails', () => {
    const warnings = [];
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unmerged commits' };
    };
    const out = deleteWtBranchIfPresent({
      cwd: '/repo',
      gitSpawn,
      logger: { warn: (m) => warnings.push(m) },
    });
    assert.equal(out.deleted, false);
    assert.equal(out.present, true);
    assert.equal(out.stderr, 'unmerged commits');
    assert.ok(warnings.some((w) => /could not delete wt-branch/.test(w)));
  });
});

describe('epicBranchHasOpenPr (Story #3367 guard)', () => {
  it('returns true when gh reports one or more open PRs on the head', () => {
    const spawnFn = () => ({ status: 0, stdout: '1\n', stderr: '' });
    assert.equal(
      epicBranchHasOpenPr({ epicBranch: 'epic/100', cwd: '/repo', spawnFn }),
      true,
    );
  });

  it('returns false when gh reports zero open PRs on the head', () => {
    const spawnFn = () => ({ status: 0, stdout: '0\n', stderr: '' });
    assert.equal(
      epicBranchHasOpenPr({ epicBranch: 'epic/100', cwd: '/repo', spawnFn }),
      false,
    );
  });

  it('fails closed (returns true) when the gh probe exits non-zero', () => {
    const warnings = [];
    const spawnFn = () => ({ status: 1, stdout: '', stderr: 'gh: not found' });
    assert.equal(
      epicBranchHasOpenPr({
        epicBranch: 'epic/100',
        cwd: '/repo',
        spawnFn,
        logger: { warn: (m) => warnings.push(m) },
      }),
      true,
    );
    assert.ok(warnings.some((w) => /open-PR probe failed/.test(w)));
  });

  it('fails closed (returns true) when the spawn throws', () => {
    const spawnFn = () => {
      throw new Error('ENOENT');
    };
    assert.equal(
      epicBranchHasOpenPr({ epicBranch: 'epic/100', cwd: '/repo', spawnFn }),
      true,
    );
  });

  it('fails closed (returns true) on unparseable stdout', () => {
    const spawnFn = () => ({ status: 0, stdout: 'not-a-number', stderr: '' });
    assert.equal(
      epicBranchHasOpenPr({ epicBranch: 'epic/100', cwd: '/repo', spawnFn }),
      true,
    );
  });

  it('returns false for an empty epicBranch (no branch to protect)', () => {
    const spawnFn = () => {
      throw new Error('must not be called');
    };
    assert.equal(
      epicBranchHasOpenPr({ epicBranch: '', cwd: '/repo', spawnFn }),
      false,
    );
  });
});

// Story #4374 — fast-forward-main step of the epic-cleanup runner.
describe('fastForwardBaseBranch', () => {
  // Deterministic gitSpawn keyed off the git subcommand so the FF planner
  // (status/fetch/symbolic-ref/rev-list) and executor (checkout/merge) can
  // be driven through the injected port without touching real git.
  function ffGitSpawn({ status = '', behind = '0 0', merge = 0, checkout = 0 }) {
    const calls = [];
    return {
      calls,
      gitSpawn: (_cwd, ...args) => {
        calls.push(args.join(' '));
        if (args[0] === 'status') return { status: 0, stdout: status, stderr: '' };
        if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'symbolic-ref') {
          return { status: 0, stdout: 'main', stderr: '' };
        }
        if (args[0] === 'rev-list') {
          return { status: 0, stdout: behind, stderr: '' };
        }
        if (args[0] === 'checkout') {
          return { status: checkout, stdout: '', stderr: 'co-fail' };
        }
        if (args[0] === 'merge') {
          return { status: merge, stdout: '', stderr: 'merge-fail' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('applies the merge --ff-only when the base is behind origin', () => {
    const { gitSpawn, calls } = ffGitSpawn({ behind: '0 3' });
    const out = fastForwardBaseBranch({ cwd: '/repo', gitSpawn });
    assert.equal(out.ok, true);
    assert.equal(out.applied, true);
    assert.equal(out.skipped, false);
    assert.equal(out.behind, 3);
    assert.ok(calls.includes('merge --ff-only origin/main'));
  });

  it('skips when already up to date (behind 0)', () => {
    const { gitSpawn, calls } = ffGitSpawn({ behind: '0 0' });
    const out = fastForwardBaseBranch({ cwd: '/repo', gitSpawn });
    assert.equal(out.applied, false);
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'already-up-to-date');
    assert.ok(!calls.includes('merge --ff-only origin/main'));
  });

  it('skips a dirty working tree without fetching', () => {
    const { gitSpawn, calls } = ffGitSpawn({ status: ' M file.js' });
    const out = fastForwardBaseBranch({ cwd: '/repo', gitSpawn });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'dirty-tree');
    assert.ok(!calls.some((c) => c.startsWith('fetch')));
  });

  it('refuses a diverged (non-fast-forward) base', () => {
    const { gitSpawn } = ffGitSpawn({ behind: '2 3' });
    const out = fastForwardBaseBranch({ cwd: '/repo', gitSpawn });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'not-fast-forward');
  });

  it('surfaces a merge failure on the envelope (ok:false)', () => {
    const { gitSpawn } = ffGitSpawn({ behind: '0 2', merge: 1 });
    const out = fastForwardBaseBranch({ cwd: '/repo', gitSpawn });
    assert.equal(out.ok, false);
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'merge-failed');
  });

  it('honours a non-default base + remote', () => {
    const { gitSpawn, calls } = ffGitSpawn({ behind: '0 1' });
    const out = fastForwardBaseBranch({
      cwd: '/repo',
      baseBranch: 'develop',
      remoteName: 'upstream',
      gitSpawn,
    });
    assert.equal(out.applied, true);
    assert.ok(calls.includes('merge --ff-only upstream/develop'));
  });
});

describe('reapEpicBranches — fast-forward surfacing (Story #4374)', () => {
  it('surfaces a fast-forward outcome on the result envelope after a confirmed merge', () => {
    const gitSpawn = (_cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'symbolic-ref') {
        return { status: 0, stdout: 'main', stderr: '' };
      }
      if (args[0] === 'rev-list') {
        return { status: 0, stdout: '0 4', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 100, stories: { 1: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => false,
    });
    assert.equal(out.fastForward.applied, true);
    assert.equal(out.fastForward.behind, 4);
  });

  it('skips the fast-forward when the epic branch is kept for an open PR', () => {
    const calls = [];
    const gitSpawn = (_cwd, ...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = reapEpicBranches({
      state: { epicId: 100, stories: { 1: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn,
      epicBranchHasOpenPrFn: () => true,
    });
    assert.equal(out.fastForward.applied, false);
    assert.equal(out.fastForward.skipped, true);
    assert.equal(out.fastForward.reason, 'epic-branch-kept');
    // No merge --ff-only must run against an in-flight PR's base.
    assert.ok(!calls.some((c) => c.startsWith('merge --ff-only')));
  });

  it('carries fastForward: null when there is no epic state', () => {
    const out = reapEpicBranches({
      state: null,
      cwd: '/repo',
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(out.fastForward, null);
  });
});

describe('localRefExists', () => {
  it('returns true when rev-parse --verify succeeds', () => {
    const gitSpawn = (_cwd, ...args) => {
      assert.deepEqual(args, [
        'rev-parse',
        '--verify',
        '--quiet',
        'refs/heads/epic/42',
      ]);
      return { status: 0, stdout: 'abc123', stderr: '' };
    };
    assert.equal(
      localRefExists({ cwd: '/repo', gitSpawn, branch: 'epic/42' }),
      true,
    );
  });

  it('returns false when the ref is absent', () => {
    const gitSpawn = () => ({ status: 1, stdout: '', stderr: '' });
    assert.equal(
      localRefExists({ cwd: '/repo', gitSpawn, branch: 'story-9' }),
      false,
    );
  });
});

describe('epicPrMergeState', () => {
  it('returns merged + prUrl from a merged-PR row', () => {
    const spawnFn = () => ({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          mergedAt: '2026-07-07T00:00:00Z',
        },
      ]),
      stderr: '',
    });
    const out = epicPrMergeState({ epicBranch: 'epic/42', cwd: '/repo', spawnFn });
    assert.equal(out.merged, true);
    assert.equal(out.prUrl, 'https://github.com/o/r/pull/7');
  });

  it('reports not-merged on an empty result set', () => {
    const spawnFn = () => ({ status: 0, stdout: '[]', stderr: '' });
    const out = epicPrMergeState({ epicBranch: 'epic/42', cwd: '/repo', spawnFn });
    assert.equal(out.merged, false);
    assert.equal(out.prUrl, null);
  });

  it('fails closed (not-merged) when the probe exits non-zero', () => {
    const warnings = [];
    const spawnFn = () => ({ status: 1, stdout: '', stderr: 'gh boom' });
    const out = epicPrMergeState({
      epicBranch: 'epic/42',
      cwd: '/repo',
      spawnFn,
      logger: { warn: (m) => warnings.push(m) },
    });
    assert.equal(out.merged, false);
    assert.ok(warnings.some((w) => /merged-PR probe failed/.test(w)));
  });

  it('fails closed when the spawn throws', () => {
    const spawnFn = () => {
      throw new Error('ENOENT');
    };
    const out = epicPrMergeState({ epicBranch: 'epic/42', cwd: '/repo', spawnFn });
    assert.equal(out.merged, false);
    assert.equal(out.prUrl, null);
  });

  it('is not armable when a merged row carries no url', () => {
    const spawnFn = () => ({
      status: 0,
      stdout: JSON.stringify([{ number: 7, mergedAt: '2026-07-07T00:00:00Z' }]),
      stderr: '',
    });
    const out = epicPrMergeState({ epicBranch: 'epic/42', cwd: '/repo', spawnFn });
    assert.equal(out.merged, false);
    assert.equal(out.prUrl, null);
  });
});

describe('detectMergedUncleanedEpic (Story #4374)', () => {
  const state = { epicId: 42, stories: { 9: { status: 'done' } } };

  it('flags shouldArm when the PR merged and local refs linger', () => {
    const gitSpawn = () => ({ status: 0, stdout: 'sha', stderr: '' });
    const out = detectMergedUncleanedEpic({
      state,
      cwd: '/repo',
      gitSpawn,
      prMergeStateFn: () => ({
        merged: true,
        prUrl: 'https://github.com/o/r/pull/7',
      }),
    });
    assert.equal(out.shouldArm, true);
    assert.equal(out.reason, 'merged-uncleaned');
    assert.equal(out.prUrl, 'https://github.com/o/r/pull/7');
    assert.deepEqual(out.presentRefs, ['epic/42', 'story-9']);
  });

  it('does not arm when no local refs remain (idempotent no-op)', () => {
    const gitSpawn = () => ({ status: 1, stdout: '', stderr: '' });
    let probed = false;
    const out = detectMergedUncleanedEpic({
      state,
      cwd: '/repo',
      gitSpawn,
      prMergeStateFn: () => {
        probed = true;
        return { merged: true, prUrl: 'x' };
      },
    });
    assert.equal(out.shouldArm, false);
    assert.equal(out.reason, 'no-local-refs');
    // The gh probe must be skipped once we know there is nothing to reap.
    assert.equal(probed, false);
  });

  it('does not arm when the PR is not merged', () => {
    const gitSpawn = () => ({ status: 0, stdout: 'sha', stderr: '' });
    const out = detectMergedUncleanedEpic({
      state,
      cwd: '/repo',
      gitSpawn,
      prMergeStateFn: () => ({ merged: false, prUrl: null }),
    });
    assert.equal(out.shouldArm, false);
    assert.equal(out.reason, 'not-merged');
  });

  it('returns no-state for an empty checkpoint', () => {
    const out = detectMergedUncleanedEpic({
      state: null,
      cwd: '/repo',
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(out.shouldArm, false);
    assert.equal(out.reason, 'no-state');
  });
});

describe('armCleanupIfMerged (Story #4374 resume auto-fire)', () => {
  it('emits epic.merge.armed on the bus when merged-and-uncleaned', async () => {
    const emitted = [];
    const bus = {
      emit: async (event, payload) => emitted.push({ event, payload }),
    };
    const out = await armCleanupIfMerged({
      state: { epicId: 42, stories: { 9: { status: 'done' } } },
      cwd: '/repo',
      gitSpawn: () => ({ status: 0, stdout: 'sha', stderr: '' }),
      bus,
      detectFn: () => ({
        epicId: 42,
        epicBranch: 'epic/42',
        prUrl: 'https://github.com/o/r/pull/7',
        shouldArm: true,
        reason: 'merged-uncleaned',
      }),
    });
    assert.equal(out.armed, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'epic.merge.armed');
    assert.deepEqual(emitted[0].payload, {
      prUrl: 'https://github.com/o/r/pull/7',
      epicId: 42,
    });
  });

  it('does not emit when detection says do not arm', async () => {
    const emitted = [];
    const bus = { emit: async (e, p) => emitted.push({ e, p }) };
    const out = await armCleanupIfMerged({
      state: { epicId: 42, stories: {} },
      cwd: '/repo',
      gitSpawn: () => ({ status: 1, stdout: '', stderr: '' }),
      bus,
      detectFn: () => ({
        shouldArm: false,
        reason: 'no-local-refs',
        prUrl: null,
      }),
    });
    assert.equal(out.armed, false);
    assert.equal(out.reason, 'no-local-refs');
    assert.equal(emitted.length, 0);
  });

  it('throws when no usable bus is supplied', async () => {
    await assert.rejects(
      () =>
        armCleanupIfMerged({
          state: { epicId: 1, stories: {} },
          cwd: '/repo',
          gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
          bus: null,
        }),
      { name: 'TypeError', message: /bus/ },
    );
  });
});
