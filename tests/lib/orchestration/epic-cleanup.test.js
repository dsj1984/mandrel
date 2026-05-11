import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findWorktreePathForBranch,
  listEpicBranchesFromState,
  parseWorktreeList,
  reapBranch,
  reapEpicBranches,
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
});
