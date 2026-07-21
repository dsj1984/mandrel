/**
 * tests/single-story-close-second-delivery.test.js — regression coverage for
 * Story #4682: a change-request delivery into a repo that already contains a
 * previously merged Story must land its PR as reliably as the first delivery.
 *
 * ## Root cause (the specific failing step)
 *
 * The v2.0.0 Story-only cutover's `enableAutoMergeWith`
 * (`single-story-close/phases/auto-merge.js`) dropped the direct-merge
 * fallback the retired `AutomergeArmer` carried (PR #4480 / Story #4472).
 * GitHub native auto-merge (`gh pr merge --auto`) can only be QUEUED on a repo
 * with "Allow auto-merge" enabled — which in practice needs branch protection.
 * A repo with no required checks and no branch protection (every mandrel-bench
 * sandbox) refuses the `--auto` arm two ways:
 *
 *   - "auto-merge is not allowed for this repository" — a repo-level refusal,
 *     constant per repo;
 *   - "Pull request is in clean status" — the `enablePullRequestAutoMerge`
 *     mutation refusing to queue on an already-immediately-mergeable PR. This
 *     is the second-delivery wedge: the first delivery into a COLD sandbox
 *     arms while GitHub is still computing the fresh PR's mergeability (arm
 *     queues, then merges); the second delivery into the now-WARM repo hits an
 *     instantly-clean PR, so the arm is refused and — without the fallback —
 *     the PR is left open, unmerged, `origin/main` unchanged.
 *
 * These tests pin the restored fallback at the unit/contract level (no live
 * sandbox): the arm classifier, the direct-merge retry, the phase report, and
 * the fact that a directly-merged PR reaches the `landed` terminal — while a
 * genuine (non-fallback) arm failure still blocks, never silently succeeds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enableAutoMergeWith,
  isAutoMergeUnavailable,
  runAutoMergePhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/auto-merge.js';
import { runConfirmMergePhase } from '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js';

const NOOP_PROGRESS = () => {};

/**
 * A scripted `gh pr merge` runner. Each element of `responses` answers the
 * next call; the args of every call are captured so tests can assert whether a
 * `--auto` arm or a direct (no-`--auto`) merge was issued.
 */
function scriptedRunner(responses) {
  const calls = [];
  const runner = (args, opts) => {
    calls.push({ args, opts });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected gh call #${calls.length}`);
    return next;
  };
  runner.calls = calls;
  return runner;
}

describe('isAutoMergeUnavailable — the fallback classifier', () => {
  it('matches a repo without native auto-merge', () => {
    assert.equal(
      isAutoMergeUnavailable(
        'failed to run git: Auto-merge is not allowed for this repository',
      ),
      true,
    );
    assert.equal(
      isAutoMergeUnavailable('GraphQL: Auto merge is not allowed for ...'),
      true,
    );
  });

  it('matches the already-clean-PR refusal (the second-delivery wedge)', () => {
    assert.equal(
      isAutoMergeUnavailable('GraphQL: Pull request is in clean status'),
      true,
    );
    assert.equal(
      isAutoMergeUnavailable(
        'Something something enablePullRequestAutoMerge failed',
      ),
      true,
    );
  });

  it('does NOT match a genuine arm failure (conflict / red required check)', () => {
    assert.equal(
      isAutoMergeUnavailable('Pull request is not mergeable'),
      false,
    );
    assert.equal(
      isAutoMergeUnavailable('merge conflict between base and head'),
      false,
    );
    assert.equal(isAutoMergeUnavailable(''), false);
    assert.equal(isAutoMergeUnavailable(null), false);
  });
});

describe('enableAutoMergeWith — direct-merge fallback (Story #4682)', () => {
  it('leaves the exit-0 happy path untouched (single --auto call)', async () => {
    const runner = scriptedRunner([{ status: 0, stdout: 'ok', stderr: '' }]);
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 7,
      runner,
      resolveArmCwd: (c) => c,
    });
    assert.deepEqual(result, { enabled: true });
    assert.equal(runner.calls.length, 1, 'no fallback on a clean arm');
    assert.ok(runner.calls[0].args.includes('--auto'));
  });

  it('falls back to a DIRECT squash-merge when native auto-merge is not allowed', async () => {
    const runner = scriptedRunner([
      {
        status: 1,
        stderr: 'Auto-merge is not allowed for this repository',
      },
      { status: 0, stdout: 'Merged', stderr: '' },
    ]);
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 8,
      runner,
      resolveArmCwd: (c) => c,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.directMerged, true);
    assert.equal(runner.calls.length, 2, 'the direct merge was attempted');
    // Second call is a direct merge: squash + delete-branch, but NOT --auto.
    const directArgs = runner.calls[1].args;
    assert.ok(directArgs.includes('--squash'));
    assert.ok(directArgs.includes('--delete-branch'));
    assert.ok(
      !directArgs.includes('--auto'),
      'the fallback merge must be synchronous (no --auto)',
    );
  });

  it('falls back on the already-clean-PR refusal (second-delivery wedge)', async () => {
    const runner = scriptedRunner([
      { status: 1, stderr: 'GraphQL: Pull request is in clean status' },
      { status: 0, stdout: 'Merged', stderr: '' },
    ]);
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 9,
      runner,
      resolveArmCwd: (c) => c,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.directMerged, true);
  });

  it('reports directMerged even when only the LOCAL branch cleanup grumbles', async () => {
    const runner = scriptedRunner([
      { status: 1, stderr: 'Auto-merge is not allowed for this repository' },
      {
        status: 1,
        stderr:
          "Cannot delete branch 'story-9' used by worktree at '/repo/.worktrees/story-9'",
      },
    ]);
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 9,
      runner,
      resolveArmCwd: (c) => c,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.directMerged, true);
    assert.equal(result.localCleanupDeferred, true);
  });

  it('blocks (never silently succeeds) when the direct merge genuinely fails', async () => {
    const runner = scriptedRunner([
      { status: 1, stderr: 'Auto-merge is not allowed for this repository' },
      { status: 1, stderr: 'Pull request is not mergeable' },
    ]);
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 10,
      runner,
      resolveArmCwd: (c) => c,
    });
    assert.equal(result.enabled, false);
    assert.match(result.reason, /direct-merge fallback failed/);
    assert.match(result.reason, /not mergeable/);
  });

  it('does NOT attempt a direct merge for a genuine (non-fallback) arm failure', async () => {
    const runner = scriptedRunner([
      { status: 1, stderr: 'merge conflict between base and head' },
    ]);
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 11,
      runner,
      resolveArmCwd: (c) => c,
    });
    assert.equal(result.enabled, false);
    assert.equal(
      runner.calls.length,
      1,
      'a real conflict must not be force-merged by the fallback',
    );
  });
});

describe('runAutoMergePhase — checks-less repo reporting (AC-3)', () => {
  it('reports autoMergeEnabled + directMerged when the fallback lands the PR', async () => {
    // Inject the runner via a gh facade shim so the phase uses the fallback.
    const responses = [
      { status: 1, stderr: 'Auto-merge is not allowed for this repository' },
      { status: 0, stdout: 'Merged', stderr: '' },
    ];
    let call = 0;
    const gh = {
      pr: {
        merge: async () => {
          const r = responses[call++];
          if (r.status === 0) return { stdout: r.stdout, stderr: r.stderr };
          const err = new Error('gh failed');
          err.code = r.status;
          err.stderr = r.stderr;
          throw err;
        },
      },
    };
    const out = await runAutoMergePhase({
      cwd: '/repo',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      noAutoMerge: false,
      autoMergePolicy: 'trust-ci',
      gh,
      progress: NOOP_PROGRESS,
    });
    assert.equal(out.autoMergeEnabled, true);
    assert.equal(out.directMerged, true);
    assert.equal(out.autoMergeReason, null);
  });

  it('reports autoMergeEnabled:false (→ labeled block, not silent) when the fallback also fails', async () => {
    const gh = {
      pr: {
        merge: async () => {
          const err = new Error('gh failed');
          err.code = 1;
          err.stderr = 'Auto-merge is not allowed for this repository';
          throw err;
        },
      },
    };
    // Both the --auto arm and the direct merge fail with the same stderr; the
    // direct merge's non-cleanup failure => enabled:false.
    const out = await runAutoMergePhase({
      cwd: '/repo',
      prNumber: 13,
      prUrl: 'https://github.com/o/r/pull/13',
      noAutoMerge: false,
      autoMergePolicy: 'trust-ci',
      gh,
      progress: NOOP_PROGRESS,
    });
    assert.equal(out.autoMergeEnabled, false);
    // A false arm on the default path routes confirm-merge to blockOnUnlanded —
    // an explicit `agent::blocked`, never a silent success with an open PR.
    assert.ok(out.autoMergeReason);
  });
});

describe('second delivery reaches the landed state (AC-2)', () => {
  it('a directly-merged PR is confirmed as landed by the confirm phase', async () => {
    // The direct-merge fallback has already landed the PR remotely
    // (autoMergeEnabled:true). The confirm phase's first probe observes
    // MERGED and drives the shared confirmStoryMerged flip + land tail.
    let confirmCalls = 0;
    let tailRan = false;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4682,
      storyBranch: 'story-4682',
      baseBranch: 'main',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider: {
        getTicket: async () => ({ id: 4682, labels: ['agent::closing'] }),
        updateTicket: async () => {},
        postComment: async () => ({ id: 'c1' }),
      },
      config: {},
      progress: NOOP_PROGRESS,
      sleepFn: async () => {},
      nowMsFn: () => 0,
      readPrWaitProbeFn: async () => ({
        state: 'MERGED',
        mergedAt: '2026-07-21T00:00:00Z',
      }),
      confirmStoryMergedFn: async () => {
        confirmCalls += 1;
        return { storyId: 4682, action: 'done', merged: true };
      },
      runPostLandTailFn: async () => {
        tailRan = true;
        return {
          followUps: true,
          statusResync: true,
          refCleanup: true,
          baseFastForward: true,
          details: {},
        };
      },
      emitMergeUnlandedFn: () => {},
      emitMergeFlipFailedFn: () => {},
    });
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.terminal, 'landed');
    assert.equal(confirmCalls, 1);
    assert.equal(tailRan, true);
  });
});
