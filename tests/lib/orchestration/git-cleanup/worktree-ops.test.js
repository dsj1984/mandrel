// tests/lib/orchestration/git-cleanup/worktree-ops.test.js
/**
 * Unit tests for the destructive git-cleanup wrappers built by
 * `makeWorktreeOps`: `removeWorktree`'s plain → force → lock-class decision
 * table, `pruneRemoteTracking`'s parse hand-off and `dropStash`. Each branch
 * is pinned against an injected spawn — no real git process is started.
 * The real-git force escalation is covered by
 * `tests/integration/remove-worktree-dirty.integration.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeWorktreeOps } from '../../../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes-ff.js';

/**
 * A spawn that answers each call from a queue of results, recording argv.
 *
 * @param {Array<{ status?: number, stdout?: string, stderr?: string }>} results
 */
function queuedSpawn(results) {
  const calls = [];
  const spawn = (cwd, ...args) => {
    calls.push([cwd, ...args]);
    const next = results[calls.length - 1] ?? {};
    return { status: 0, stdout: '', stderr: '', ...next };
  };
  return { ops: makeWorktreeOps(spawn), calls };
}

describe('makeWorktreeOps — removeWorktree', () => {
  it('returns clean success when the plain remove succeeds, without forcing', () => {
    const { ops, calls } = queuedSpawn([{ status: 0 }]);

    const res = ops.removeWorktree('/repo/.worktrees/story-1', '/repo');

    assert.deepEqual(res, { ok: true, dirty: false });
    assert.deepEqual(calls, [
      ['/repo', 'worktree', 'remove', '/repo/.worktrees/story-1'],
    ]);
  });

  it('escalates to --force and reports dirty:true when the plain remove fails', () => {
    const { ops, calls } = queuedSpawn([
      { status: 128, stderr: 'contains modified or untracked files' },
      { status: 0 },
    ]);

    const res = ops.removeWorktree('/repo/.worktrees/story-2', '/repo');

    assert.deepEqual(res, {
      ok: true,
      dirty: true,
      stderr: 'contains modified or untracked files',
    });
    assert.deepEqual(calls[1], [
      '/repo',
      'worktree',
      'remove',
      '--force',
      '/repo/.worktrees/story-2',
    ]);
  });

  it('classifies a lock-signature failure of the forced remove as lockClass', () => {
    const { ops } = queuedSpawn([
      { status: 128, stderr: 'dirty' },
      { status: 1, stderr: 'error: Permission denied' },
    ]);

    const res = ops.removeWorktree('/w', '/repo');

    assert.deepEqual(res, {
      ok: false,
      dirty: true,
      lockClass: true,
      stderr: 'error: Permission denied',
    });
  });

  it('reports a non-lock failure with lockClass:false, falling back to the plain stderr', () => {
    const { ops } = queuedSpawn([
      { status: 128, stderr: 'fatal: not a working tree' },
      { status: 128, stderr: '' },
    ]);

    const res = ops.removeWorktree('/w', '/repo');

    assert.equal(res.ok, false);
    assert.equal(res.lockClass, false);
    assert.equal(res.stderr, 'fatal: not a working tree');
  });
});

describe('makeWorktreeOps — pruneRemoteTracking', () => {
  it('runs a non-quiet fetch --prune and hands stderr to the parser', () => {
    const { ops, calls } = queuedSpawn([
      { status: 0, stderr: ' - [deleted] (none) -> origin/old' },
    ]);
    const seen = [];
    const parse = (out, remote) => {
      seen.push([out, remote]);
      return ['old'];
    };

    const res = ops.pruneRemoteTracking('/repo', 'origin', parse);

    assert.deepEqual(res, { ok: true, pruned: ['old'] });
    assert.deepEqual(calls[0], ['/repo', 'fetch', '--prune', 'origin']);
    assert.deepEqual(seen, [[' - [deleted] (none) -> origin/old', 'origin']]);
  });

  it('returns ok:false with no pruned refs when the fetch fails', () => {
    const { ops } = queuedSpawn([{ status: 1, stderr: 'no remote' }]);

    const res = ops.pruneRemoteTracking('/repo', 'origin', () => {
      throw new Error('parser must not run on a failed fetch');
    });

    assert.deepEqual(res, { ok: false, pruned: [], stderr: 'no remote' });
  });
});

describe('makeWorktreeOps — dropStash', () => {
  it('drops the named stash ref', () => {
    const { ops, calls } = queuedSpawn([{ status: 0 }]);

    assert.deepEqual(ops.dropStash('stash@{1}', '/repo'), { ok: true });
    assert.deepEqual(calls[0], ['/repo', 'stash', 'drop', 'stash@{1}']);
  });

  it('surfaces stderr when the drop fails', () => {
    const { ops } = queuedSpawn([{ status: 1, stderr: 'not a stash' }]);

    assert.deepEqual(ops.dropStash('stash@{9}', '/repo'), {
      ok: false,
      stderr: 'not a stash',
    });
  });
});
