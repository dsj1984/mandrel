import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deleteWtBranchIfPresent,
  findWorktreePathForBranch,
  getCheckedOutBranch,
  listEpicBranchesFromState,
  parseWorktreeList,
  pruneRemoteTrackingRefs,
  reapBranch,
  reapEpicBranches,
  switchCheckoutOffBranch,
} from '../../../.agents/scripts/lib/orchestration/epic-cleanup.js';

describe('listEpicBranchesFromState', () => {
  it('extracts epic + story branches from the run-state', () => {
    const state = {
      epicId: 1178,
      waves: [
        { stories: [{ id: 1191 }, { id: 1194 }, { id: 1197 }] },
        { stories: [{ id: 1192 }, { id: 1193 }] },
        { stories: [{ id: 1198 }] },
      ],
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

  it('dedupes story ids across waves', () => {
    const state = {
      epicId: 9,
      waves: [{ stories: [{ id: 1 }] }, { stories: [{ id: 1 }, { id: 2 }] }],
    };
    const out = listEpicBranchesFromState(state);
    assert.deepEqual(out.storyBranches, ['story-1', 'story-2']);
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
      waves: [{ stories: [{ id: 0 }, { id: -3 }, { id: 5 }] }],
    });
    assert.deepEqual(out.storyBranches, ['story-5']);
  });
});

describe('parseWorktreeList', () => {
  it('parses a porcelain stream into path/branch records', () => {
    const raw = [
      'worktree /repo',
      'HEAD abcd',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/story-1191',
      'HEAD efgh',
      'branch refs/heads/story-1191',
      '',
      'worktree /repo/.worktrees/story-1194',
      'HEAD ijkl',
      'detached',
      '',
    ].join('\n');
    const out = parseWorktreeList(raw);
    assert.equal(out.length, 3);
    assert.equal(out[1].path, '/repo/.worktrees/story-1191');
    assert.equal(out[1].branch, 'story-1191');
    assert.equal(out[2].branch, null);
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(parseWorktreeList(''), []);
    assert.deepEqual(parseWorktreeList(null), []);
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
        waves: [{ stories: [{ id: 1 }, { id: 2 }] }],
      },
      cwd: '/repo',
      gitSpawn,
    });
    assert.equal(out.ok, true);
    assert.equal(out.reaped.length, 3);
    const branches = out.reaped.map((r) => r.branch);
    assert.deepEqual(branches, ['story-1', 'story-2', 'epic/100']);
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
      state: { epicId: 9, waves: [{ stories: [{ id: 99 }] }] },
      cwd: '/repo',
      gitSpawn,
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
      state: { epicId: 77, waves: [{ stories: [{ id: 1 }] }] },
      cwd: '/repo',
      gitSpawn,
      baseBranch: 'develop',
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
      state: { epicId: 78, waves: [{ stories: [{ id: 1 }] }] },
      cwd: '/repo',
      gitSpawn,
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
      state: { epicId: 100, waves: [{ stories: [{ id: 1 }] }] },
      cwd: '/repo',
      gitSpawn,
    });
    assert.deepEqual(out.pruned.pruned, ['origin/epic/100', 'origin/story-1']);
    assert.equal(out.wtBranch.deleted, true);
    assert.equal(out.wtBranch.present, true);
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
