/**
 * tests/lib/worktree/lifecycle/merge-reachability.test.js
 *
 * Direct branch coverage for the merge-reachability half of
 * `isSafeToRemove`. Fakes `ctx.git.gitSpawn` so every ancestor / grep
 * branch is exercised without spinning up a git repo — the end-to-end
 * happy paths stay covered by `post-rebase-reap.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkHeadAncestor,
  checkMergeReachability,
  hasMergeCommitForStory,
  hasRebasedEquivalents,
  resolveHeadSha,
} from '../../../../.agents/scripts/lib/worktree/lifecycle/merge-reachability.js';

function fakeCtx(responses) {
  const calls = [];
  const queue = responses.slice();
  return {
    calls,
    repoRoot: '/repo',
    git: {
      gitSpawn(cwd, ...args) {
        calls.push({ cwd, args });
        const next = queue.shift();
        if (!next) {
          throw new Error(
            `unexpected gitSpawn call: cwd=${cwd} argv=${args.join(' ')}`,
          );
        }
        return {
          status: next.status,
          stdout: next.stdout ?? '',
          stderr: next.stderr ?? '',
        };
      },
    },
  };
}

describe('resolveHeadSha', () => {
  it('returns sha + short slice on success', () => {
    const ctx = fakeCtx([{ status: 0, stdout: 'abc1234deadbeef' }]);
    assert.deepEqual(resolveHeadSha(ctx, '/wt'), {
      ok: true,
      sha: 'abc1234deadbeef',
      short: 'abc1234',
    });
  });

  it('returns ok: false with stderr-bearing reason on failure', () => {
    const ctx = fakeCtx([{ status: 128, stderr: 'fatal: bad object HEAD' }]);
    assert.deepEqual(resolveHeadSha(ctx, '/wt'), {
      ok: false,
      reason: 'rev-parse-failed: fatal: bad object HEAD',
    });
  });

  it('substitutes "HEAD" placeholder when stderr is empty', () => {
    const ctx = fakeCtx([{ status: 128, stderr: '' }]);
    assert.deepEqual(resolveHeadSha(ctx, '/wt'), {
      ok: false,
      reason: 'rev-parse-failed: HEAD',
    });
  });

  it('handles short SHAs by leaving the short field as-is', () => {
    const ctx = fakeCtx([{ status: 0, stdout: 'abc' }]);
    const out = resolveHeadSha(ctx, '/wt');
    assert.equal(out.sha, 'abc');
    assert.equal(out.short, 'abc');
  });
});

describe('checkHeadAncestor', () => {
  it('returns ancestor on exit 0', () => {
    const ctx = fakeCtx([{ status: 0 }]);
    assert.deepEqual(checkHeadAncestor(ctx, 'sha', 'epic/1'), {
      outcome: 'ancestor',
    });
  });

  it('returns not-ancestor on exit 1', () => {
    const ctx = fakeCtx([{ status: 1 }]);
    assert.deepEqual(checkHeadAncestor(ctx, 'sha', 'epic/1'), {
      outcome: 'not-ancestor',
    });
  });

  it('returns error envelope (with stderr) on any other exit', () => {
    const ctx = fakeCtx([{ status: 128, stderr: 'fatal: bad ref' }]);
    assert.deepEqual(checkHeadAncestor(ctx, 'sha', 'epic/1'), {
      outcome: 'error',
      reason: 'fatal: bad ref',
    });
  });

  it('falls back to stdout when stderr is empty on error', () => {
    const ctx = fakeCtx([{ status: 128, stderr: '', stdout: 'something' }]);
    assert.deepEqual(checkHeadAncestor(ctx, 'sha', 'epic/1'), {
      outcome: 'error',
      reason: 'something',
    });
  });

  it('falls back to "unknown" when both streams are empty on error', () => {
    const ctx = fakeCtx([{ status: 2 }]);
    assert.deepEqual(checkHeadAncestor(ctx, 'sha', 'epic/1'), {
      outcome: 'error',
      reason: 'unknown',
    });
  });
});

describe('hasMergeCommitForStory', () => {
  it('returns false (no spawn) for a branch that does not match story-<id>', () => {
    const ctx = fakeCtx([]);
    assert.equal(hasMergeCommitForStory(ctx, 'feature/foo', 'epic/1'), false);
    assert.equal(ctx.calls.length, 0);
  });

  it('returns true when the grep finds a matching merge commit', () => {
    const ctx = fakeCtx([{ status: 0, stdout: 'deadbeef\n' }]);
    assert.equal(hasMergeCommitForStory(ctx, 'story-42', 'epic/1'), true);
    assert.deepEqual(ctx.calls[0].args, [
      'log',
      'epic/1',
      '--merges',
      '-n',
      '1',
      '--pretty=%H',
      '-E',
      '--grep=resolves #42( |\\)|$)',
    ]);
  });

  it('returns false when the grep returns empty stdout', () => {
    const ctx = fakeCtx([{ status: 0, stdout: '' }]);
    assert.equal(hasMergeCommitForStory(ctx, 'story-42', 'epic/1'), false);
  });

  it('returns false when the grep exits non-zero', () => {
    const ctx = fakeCtx([{ status: 1, stdout: '' }]);
    assert.equal(hasMergeCommitForStory(ctx, 'story-42', 'epic/1'), false);
  });
});

describe('hasRebasedEquivalents', () => {
  it('returns true when every cherry line starts with "- " (all patch-equivalent)', () => {
    const ctx = fakeCtx([
      { status: 0, stdout: '- aaaa1111\n- bbbb2222\n- cccc3333\n' },
    ]);
    assert.equal(hasRebasedEquivalents(ctx, 'story-42', 'origin/epic/1'), true);
    assert.deepEqual(ctx.calls[0].args, [
      'cherry',
      'origin/epic/1',
      'story-42',
    ]);
  });

  it('returns false when any line starts with "+ " (unintegrated commit)', () => {
    const ctx = fakeCtx([{ status: 0, stdout: '- aaaa1111\n+ dddd4444\n' }]);
    assert.equal(
      hasRebasedEquivalents(ctx, 'story-42', 'origin/epic/1'),
      false,
    );
  });

  it('returns false when cherry stdout is empty (trivial-ancestor case handled elsewhere)', () => {
    const ctx = fakeCtx([{ status: 0, stdout: '' }]);
    assert.equal(
      hasRebasedEquivalents(ctx, 'story-42', 'origin/epic/1'),
      false,
    );
  });

  it('returns false when cherry exits non-zero', () => {
    const ctx = fakeCtx([{ status: 128, stderr: 'fatal: bad revision' }]);
    assert.equal(
      hasRebasedEquivalents(ctx, 'story-42', 'origin/epic/1'),
      false,
    );
  });
});

describe('checkMergeReachability', () => {
  it('propagates resolveHeadSha failure as safe:false', async () => {
    const ctx = fakeCtx([{ status: 128, stderr: 'fatal: HEAD missing' }]);
    const out = await checkMergeReachability(ctx, '/wt', 'story-42', 'epic/1');
    assert.deepEqual(out, {
      safe: false,
      reason: 'rev-parse-failed: fatal: HEAD missing',
    });
  });

  it('reports safe (head-reachable-from-epic) when ancestry passes', async () => {
    const ctx = fakeCtx([
      { status: 0, stdout: 'abc1234' }, // rev-parse HEAD
      { status: 0 }, // merge-base --is-ancestor
    ]);
    const out = await checkMergeReachability(ctx, '/wt', 'story-42', 'epic/1');
    assert.deepEqual(out, {
      safe: true,
      reason: 'head-reachable-from-epic',
    });
  });

  it('surfaces merge-check-failed when ancestor spawn errors', async () => {
    const ctx = fakeCtx([
      { status: 0, stdout: 'abc1234' },
      { status: 128, stderr: 'fatal: bad ref' },
    ]);
    const out = await checkMergeReachability(ctx, '/wt', 'story-42', 'epic/1');
    assert.equal(out.safe, false);
    assert.match(out.reason, /^merge-check-failed: head=abc1234 epic=epic\/1/);
    assert.match(out.reason, /fatal: bad ref/);
  });

  it('falls back to merge-commit-reachable when grep finds the commit', async () => {
    const ctx = fakeCtx([
      { status: 0, stdout: 'abc1234' }, // rev-parse HEAD
      { status: 1 }, // ancestor: not ancestor
      { status: 0, stdout: 'deadbeef' }, // grep hits
    ]);
    const out = await checkMergeReachability(ctx, '/wt', 'story-42', 'epic/1');
    assert.deepEqual(out, {
      safe: true,
      reason: 'merge-commit-reachable',
    });
  });

  it('falls back to rebased-equivalents when grep misses but cherry shows all patch-equivalent (Story #3161)', async () => {
    const ctx = fakeCtx([
      { status: 0, stdout: 'abc1234' }, // rev-parse HEAD
      { status: 1 }, // ancestor: not ancestor
      { status: 0, stdout: '' }, // grep: no match
      { status: 0, stdout: '- aaaa1111\n- bbbb2222\n' }, // cherry: all upstream
    ]);
    const out = await checkMergeReachability(ctx, '/wt', 'story-42', 'epic/1');
    assert.deepEqual(out, {
      safe: true,
      reason: 'rebased-equivalents',
    });
  });

  it('reports unmerged-commits when all three gates fail', async () => {
    const ctx = fakeCtx([
      { status: 0, stdout: 'abc1234' }, // rev-parse HEAD
      { status: 1 }, // ancestor: not ancestor
      { status: 0, stdout: '' }, // grep: no match
      { status: 0, stdout: '- aaaa1111\n+ bbbb2222\n' }, // cherry: + present
    ]);
    const out = await checkMergeReachability(ctx, '/wt', 'story-42', 'epic/1');
    assert.deepEqual(out, {
      safe: false,
      reason: 'unmerged-commits: head=abc1234 epic=epic/1',
    });
  });

  it('reports unmerged-commits without spawning grep for non-story branches (cherry still runs)', async () => {
    const ctx = fakeCtx([
      { status: 0, stdout: 'abc1234' },
      { status: 1 },
      { status: 0, stdout: '' }, // cherry: empty (no equivalents)
    ]);
    const out = await checkMergeReachability(
      ctx,
      '/wt',
      'feature/bar',
      'epic/1',
    );
    assert.deepEqual(out, {
      safe: false,
      reason: 'unmerged-commits: head=abc1234 epic=epic/1',
    });
  });
});
