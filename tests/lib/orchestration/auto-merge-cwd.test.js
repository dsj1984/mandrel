/**
 * tests/lib/orchestration/auto-merge-cwd.test.js — unit tests for the
 * worktree-collision-safe arm-cwd resolver (Story #4282).
 *
 * The resolver re-points auto-merge arming at the primary worktree root
 * (which holds the base branch) so `gh pr merge --delete-branch`'s local
 * `git checkout <base>` cannot collide with the base branch already
 * checked out by the primary worktree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseWorktreeList,
  pickPrimaryWorktreePath,
  resolveAutoMergeArmCwd,
} from '../../../.agents/scripts/lib/orchestration/auto-merge-cwd.js';

const PORCELAIN = [
  'worktree /repo/primary',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/story-4282',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/story-4282',
  '',
].join('\n');

describe('parseWorktreeList', () => {
  it('parses porcelain stanzas into path + branch records', () => {
    const records = parseWorktreeList(PORCELAIN);
    assert.deepEqual(records, [
      { path: '/repo/primary', branch: 'main' },
      { path: '/repo/.worktrees/story-4282', branch: 'story-4282' },
    ]);
  });

  it('handles a detached-HEAD worktree (no branch line)', () => {
    const records = parseWorktreeList(
      ['worktree /repo/primary', 'HEAD abc', 'detached', ''].join('\n'),
    );
    assert.deepEqual(records, [{ path: '/repo/primary', branch: null }]);
  });

  it('tolerates CRLF line endings', () => {
    const records = parseWorktreeList(
      'worktree /repo/primary\r\nbranch refs/heads/main\r\n',
    );
    assert.deepEqual(records, [{ path: '/repo/primary', branch: 'main' }]);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(parseWorktreeList(''), []);
    assert.deepEqual(parseWorktreeList(null), []);
  });
});

describe('pickPrimaryWorktreePath', () => {
  it('returns the first stanza path (the primary working tree)', () => {
    assert.equal(
      pickPrimaryWorktreePath(parseWorktreeList(PORCELAIN)),
      '/repo/primary',
    );
  });

  it('returns null for an empty / malformed list', () => {
    assert.equal(pickPrimaryWorktreePath([]), null);
    assert.equal(pickPrimaryWorktreePath(null), null);
    assert.equal(pickPrimaryWorktreePath([{ path: '' }]), null);
  });
});

describe('resolveAutoMergeArmCwd', () => {
  it('re-points a per-Story worktree cwd at the primary worktree root', () => {
    const gitSpawn = (cwd, ...args) => {
      assert.equal(cwd, '/repo/.worktrees/story-4282');
      assert.deepEqual(args, ['worktree', 'list', '--porcelain']);
      return { status: 0, stdout: PORCELAIN, stderr: '' };
    };
    const resolved = resolveAutoMergeArmCwd('/repo/.worktrees/story-4282', {
      gitSpawn,
    });
    assert.equal(
      resolved,
      '/repo/primary',
      'arm must run from the base-branch worktree, not the head-branch worktree',
    );
  });

  it('degrades to the original cwd when git worktree list fails', () => {
    const gitSpawn = () => ({ status: 1, stdout: '', stderr: 'not a repo' });
    assert.equal(
      resolveAutoMergeArmCwd('/some/cwd', { gitSpawn }),
      '/some/cwd',
    );
  });

  it('degrades to the original cwd when gitSpawn throws', () => {
    const gitSpawn = () => {
      throw new Error('git missing');
    };
    assert.equal(
      resolveAutoMergeArmCwd('/some/cwd', { gitSpawn }),
      '/some/cwd',
    );
  });

  it('degrades to the original cwd when the list is empty', () => {
    const gitSpawn = () => ({ status: 0, stdout: '', stderr: '' });
    assert.equal(
      resolveAutoMergeArmCwd('/some/cwd', { gitSpawn }),
      '/some/cwd',
    );
  });

  it('returns a non-string cwd unchanged without spawning git', () => {
    let called = false;
    const gitSpawn = () => {
      called = true;
      return { status: 0, stdout: PORCELAIN, stderr: '' };
    };
    assert.equal(resolveAutoMergeArmCwd(undefined, { gitSpawn }), undefined);
    assert.equal(called, false);
  });
});
