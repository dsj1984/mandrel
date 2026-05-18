/**
 * git-branch-cleanup — local + remote deletion helpers with idempotent
 * "branch not found" handling.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import {
  deleteBranchBoth,
  deleteBranchesBatched,
  deleteBranchLocal,
  deleteBranchRemote,
} from '../../.agents/scripts/lib/git-branch-cleanup.js';
import { __setGitRunners } from '../../.agents/scripts/lib/git-utils.js';

after(() => {
  __setGitRunners(execFileSync, spawnSync);
});

/**
 * Install a scripted spawn mock that returns `results[callIndex]` on each
 * call and records the args. Fails if the suite runs more git calls than
 * scripted results.
 */
function installScriptedSpawn(results) {
  const calls = [];
  __setGitRunners(
    () => '',
    (_cmd, args) => {
      calls.push(args);
      if (calls.length > results.length) {
        throw new Error(`Unexpected extra git call: ${args.join(' ')}`);
      }
      return results[calls.length - 1];
    },
  );
  return calls;
}

const OK = { status: 0, stdout: '', stderr: '' };

describe('deleteBranchLocal', () => {
  it('returns deleted when git succeeds (force=true by default)', () => {
    const calls = installScriptedSpawn([OK]);
    const result = deleteBranchLocal('story-1', { cwd: '/repo' });
    assert.deepEqual(result, { deleted: true, reason: 'deleted' });
    assert.deepEqual(calls[0], ['branch', '-D', 'story-1']);
  });

  it('uses -d when force is false', () => {
    const calls = installScriptedSpawn([OK]);
    deleteBranchLocal('story-1', { force: false, cwd: '/repo' });
    assert.deepEqual(calls[0], ['branch', '-d', 'story-1']);
  });

  it('treats branch-not-found as idempotent success', () => {
    installScriptedSpawn([
      {
        status: 1,
        stdout: '',
        stderr: "error: branch 'story-9' not found.",
      },
    ]);
    const result = deleteBranchLocal('story-9', { cwd: '/repo' });
    assert.deepEqual(result, { deleted: true, reason: 'not-found' });
  });

  it('reports unmerged when force=false and branch is not fully merged', () => {
    installScriptedSpawn([
      {
        status: 1,
        stdout: '',
        stderr:
          "error: The branch 'story-2' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D story-2'.",
      },
    ]);
    const result = deleteBranchLocal('story-2', {
      force: false,
      cwd: '/repo',
    });
    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'unmerged');
    assert.match(result.stderr, /not fully merged/);
  });

  it('reports error reason for unrecognized failures', () => {
    installScriptedSpawn([
      { status: 128, stdout: '', stderr: 'fatal: some other error' },
    ]);
    const result = deleteBranchLocal('story-3', { cwd: '/repo' });
    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'error');
    assert.match(result.stderr, /some other error/);
  });

  it('rejects unsafe branch names before invoking git', () => {
    assert.throws(
      () => deleteBranchLocal('foo;rm -rf /', { cwd: '/repo' }),
      /Unsafe branch name/,
    );
  });
});

describe('deleteBranchRemote', () => {
  it('returns deleted when push --delete succeeds', () => {
    const calls = installScriptedSpawn([OK]);
    const result = deleteBranchRemote('story-1', { cwd: '/repo' });
    assert.deepEqual(result, { deleted: true, reason: 'deleted' });
    assert.deepEqual(calls[0], ['push', 'origin', '--delete', 'story-1']);
  });

  it('honors a non-default remote', () => {
    const calls = installScriptedSpawn([OK]);
    deleteBranchRemote('story-1', { remote: 'upstream', cwd: '/repo' });
    assert.deepEqual(calls[0], ['push', 'upstream', '--delete', 'story-1']);
  });

  it('treats remote-ref-does-not-exist as idempotent success', () => {
    installScriptedSpawn([
      {
        status: 1,
        stdout: '',
        stderr: "error: unable to delete 'story-9': remote ref does not exist",
      },
    ]);
    const result = deleteBranchRemote('story-9', { cwd: '/repo' });
    assert.deepEqual(result, { deleted: true, reason: 'not-found' });
  });

  it('reports error for unrecognized failures', () => {
    installScriptedSpawn([
      { status: 128, stdout: '', stderr: 'fatal: network unreachable' },
    ]);
    const result = deleteBranchRemote('story-3', { cwd: '/repo' });
    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'error');
  });

  it('rejects unsafe remote names', () => {
    assert.throws(
      () => deleteBranchRemote('story-1', { remote: 'evil;rm', cwd: '/repo' }),
      /Unsafe remote name/,
    );
  });

  /**
   * Regression guard for the false-positive observed on 2026-05-18 during a
   * `/git-cleanup --execute --remote --yes` run: a child of the pre-push
   * hook (`run-lint.js`) emits Node's DEP0190 `shell: true` deprecation
   * warning to stderr, which bubbles up through `git push --delete`'s
   * stderr. The DEP0190 banner is informational only — when git exits 0
   * the delete succeeded, regardless of what other processes wrote to
   * stderr. Asserting `deleted: true` here pins the contract so a future
   * refactor cannot re-introduce the bug by gating success on a
   * non-empty stderr.
   */
  it('returns deleted when status=0 even if stderr carries a Node DEP0190 warning', () => {
    installScriptedSpawn([
      {
        status: 0,
        stdout: '',
        stderr:
          '(node:65804) [DEP0190] DeprecationWarning: Passing args to a ' +
          'child process with shell option true can lead to security ' +
          'vulnerabilities, as the arguments are not escaped, only ' +
          'concatenated.\n(Use `node --trace-deprecation ...` to show ' +
          'where the warning was created)',
      },
    ]);
    const result = deleteBranchRemote('story-1', { cwd: '/repo' });
    assert.deepEqual(result, { deleted: true, reason: 'deleted' });
  });
});

describe('deleteBranchBoth', () => {
  it('returns deleted when both local and remote succeed', () => {
    const calls = installScriptedSpawn([OK, OK]);
    const result = deleteBranchBoth('story-1', { cwd: '/repo' });
    assert.equal(result.deleted, true);
    assert.equal(result.reason, 'deleted');
    assert.equal(result.local.deleted, true);
    assert.equal(result.remote.deleted, true);
    assert.deepEqual(calls[0], ['branch', '-D', 'story-1']);
    assert.deepEqual(calls[1], ['push', 'origin', '--delete', 'story-1']);
  });

  it('always attempts remote even when local fails', () => {
    const calls = installScriptedSpawn([
      { status: 128, stdout: '', stderr: 'fatal: weird local failure' },
      OK,
    ]);
    const result = deleteBranchBoth('story-1', { cwd: '/repo' });
    assert.equal(calls.length, 2, 'remote attempted despite local failure');
    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'partial');
    assert.equal(result.local.deleted, false);
    assert.equal(result.remote.deleted, true);
  });

  it('reports error when both sides fail', () => {
    installScriptedSpawn([
      { status: 128, stdout: '', stderr: 'fatal: local boom' },
      { status: 128, stdout: '', stderr: 'fatal: remote boom' },
    ]);
    const result = deleteBranchBoth('story-1', { cwd: '/repo' });
    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'error');
  });

  it('treats both-sides-not-found as fully deleted (idempotent)', () => {
    installScriptedSpawn([
      { status: 1, stdout: '', stderr: "error: branch 'x' not found." },
      { status: 1, stdout: '', stderr: 'remote ref does not exist' },
    ]);
    const result = deleteBranchBoth('story-9', { cwd: '/repo' });
    assert.equal(result.deleted, true);
    assert.equal(result.reason, 'deleted');
    assert.equal(result.local.reason, 'not-found');
    assert.equal(result.remote.reason, 'not-found');
  });
});

describe('deleteBranchesBatched', () => {
  it('returns empty result for an empty list (no git calls)', () => {
    const calls = installScriptedSpawn([]);
    const r = deleteBranchesBatched([], { scope: 'local', cwd: '/repo' });
    assert.deepEqual(r, { deleted: [], failed: [] });
    assert.equal(calls.length, 0);
  });

  it('rejects an unknown scope', () => {
    installScriptedSpawn([]);
    assert.throws(
      () => deleteBranchesBatched(['story-1'], { scope: 'wat', cwd: '/repo' }),
      /scope must be "local" or "remote"/,
    );
  });

  it('local: batched delete succeeds in a single call', () => {
    const calls = installScriptedSpawn([OK]);
    const r = deleteBranchesBatched(['story-1', 'story-2'], {
      scope: 'local',
      cwd: '/repo',
    });
    assert.deepEqual(r.deleted, ['story-1', 'story-2']);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(calls[0], ['branch', '-D', 'story-1', 'story-2']);
  });

  it('local: falls back per-ref when the batched call fails', () => {
    // First call: batched fails. Per-ref: story-1 OK, story-2 fails.
    const calls = installScriptedSpawn([
      { status: 128, stdout: '', stderr: 'one ref unknown' },
      OK,
      { status: 128, stdout: '', stderr: 'fatal: boom' },
    ]);
    const r = deleteBranchesBatched(['story-1', 'story-2'], {
      scope: 'local',
      cwd: '/repo',
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(r.deleted, ['story-1']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].name, 'story-2');
  });

  it('local: honours force=false (uses -d)', () => {
    const calls = installScriptedSpawn([OK]);
    deleteBranchesBatched(['story-1'], {
      scope: 'local',
      cwd: '/repo',
      force: false,
    });
    assert.deepEqual(calls[0], ['branch', '-d', 'story-1']);
  });

  it('remote: batched delete succeeds via push --delete', () => {
    const calls = installScriptedSpawn([OK]);
    const r = deleteBranchesBatched(['story-1', 'story-2'], {
      scope: 'remote',
      cwd: '/repo',
    });
    assert.deepEqual(r.deleted, ['story-1', 'story-2']);
    assert.deepEqual(calls[0], [
      'push',
      'origin',
      '--delete',
      'story-1',
      'story-2',
    ]);
  });

  it('remote: honours noVerify=true', () => {
    const calls = installScriptedSpawn([OK]);
    deleteBranchesBatched(['story-1'], {
      scope: 'remote',
      cwd: '/repo',
      noVerify: true,
    });
    assert.deepEqual(calls[0], [
      'push',
      '--no-verify',
      'origin',
      '--delete',
      'story-1',
    ]);
  });

  it('remote: rejects unsafe remote name', () => {
    installScriptedSpawn([]);
    assert.throws(
      () =>
        deleteBranchesBatched(['story-1'], {
          scope: 'remote',
          cwd: '/repo',
          remote: 'bad name!',
        }),
      /Unsafe remote name/,
    );
  });
});
