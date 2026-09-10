/**
 * tests/single-story-close-auto-merge.test.js — unit tests for the
 * auto-merge helpers added to `single-story-close.js` (Story #1815).
 *
 * Covers:
 *   - `parsePrNumber` parses well-formed PR URLs and rejects junk.
 *   - `enableAutoMerge` returns `{ enabled: true }` on `gh` exit 0 and
 *     `{ enabled: false, reason }` on non-zero / spawn errors.
 *   - Spawn args wire `--auto --squash --delete-branch` so GitHub merges
 *     the PR when required checks pass and deletes the source branch.
 *   - Story #4282: the arm runs from the primary (base-branch) worktree
 *     root so `gh`'s `--delete-branch` local checkout cannot collide with
 *     the base branch occupied by the primary worktree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  disarmAutoMerge,
  enableAutoMergeWith,
  runAutoMergePhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/auto-merge.js';
import {
  enableAutoMerge,
  parsePrNumber,
} from '../.agents/scripts/single-story-close.js';

describe('parsePrNumber', () => {
  it('extracts the numeric id from a canonical GitHub PR URL', () => {
    assert.equal(
      parsePrNumber('https://github.com/dsj1984/mandrel/pull/1815'),
      1815,
    );
  });

  it('handles trailing slashes', () => {
    assert.equal(
      parsePrNumber('https://github.com/dsj1984/mandrel/pull/1815/'),
      1815,
    );
  });

  it('handles query strings and fragments', () => {
    assert.equal(
      parsePrNumber('https://github.com/owner/repo/pull/42?diff=split#diff-1'),
      42,
    );
  });

  it('returns null for URLs without /pull/<n>', () => {
    assert.equal(
      parsePrNumber('https://github.com/dsj1984/mandrel/issues/1815'),
      null,
    );
    assert.equal(parsePrNumber('https://github.com/dsj1984/mandrel'), null);
  });

  it('returns null for non-string inputs', () => {
    assert.equal(parsePrNumber(null), null);
    assert.equal(parsePrNumber(undefined), null);
    assert.equal(parsePrNumber(42), null);
  });
});

describe('enableAutoMerge', () => {
  it('passes --auto --squash --delete-branch to gh and reports enabled on exit 0', async () => {
    let capturedArgs = null;
    let capturedOpts = null;
    const runner = (args, opts) => {
      capturedArgs = args;
      capturedOpts = opts;
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.deepEqual(result, { enabled: true });
    assert.deepEqual(capturedArgs, [
      'pr',
      'merge',
      '123',
      '--auto',
      '--squash',
      '--delete-branch',
    ]);
    assert.deepEqual(capturedOpts, { cwd: '/repo' });
  });

  it('reports enabled:false with reason when gh exits non-zero', async () => {
    const runner = () => ({
      status: 22,
      stdout: '',
      stderr: 'Pull request not in a state allowing auto-merge.',
    });
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.equal(result.enabled, false);
    assert.match(result.reason, /gh-exit-22/);
    assert.match(result.reason, /allowing auto-merge/);
  });

  it('reports enabled:false on spawn errors', async () => {
    const runner = () => {
      throw new Error('ENOENT: gh not installed');
    };
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.equal(result.enabled, false);
    assert.match(result.reason, /gh-spawn-error/);
    assert.match(result.reason, /ENOENT/);
  });

  it('truncates very long stderr to keep the reason field readable', async () => {
    const longStderr = 'x'.repeat(500);
    const runner = () => ({ status: 1, stderr: longStderr });
    const result = await enableAutoMerge({
      cwd: '/repo',
      prNumber: 123,
      runner,
    });
    assert.ok(result.reason.length < 250);
  });
});

describe('enableAutoMergeWith — worktree-occupied-base-branch robustness (Story #4282)', () => {
  // The primary worktree holds the base branch (`main`); the close runs
  // from the per-Story worktree (`story-4282`). `git checkout main` from
  // that worktree collides with the primary worktree's checkout.
  const PORCELAIN = [
    'worktree /repo/primary',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/story-4282',
    'branch refs/heads/story-4282',
    '',
  ].join('\n');

  // Models `gh pr merge --delete-branch`: succeeds when run from the
  // base-branch (primary) worktree; reproduces the consumer's
  // `gh-exit-1: fatal: 'main' is already used by worktree` failure when
  // run from the head-branch worktree (because gh's local `git checkout
  // main` collides there).
  function worktreeAwareRunner(capture) {
    return (_args, opts) => {
      capture.cwd = opts.cwd;
      if (opts.cwd === '/repo/.worktrees/story-4282') {
        return {
          status: 1,
          stdout: '',
          stderr:
            "failed to run git: fatal: 'main' is already used by worktree at '/repo/primary'",
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
  }

  it('with the resolver re-pointing to the primary worktree, the arm succeeds and queues without the worktree error', async () => {
    const capture = {};
    const result = await enableAutoMergeWith({
      cwd: '/repo/.worktrees/story-4282',
      prNumber: 88,
      runner: worktreeAwareRunner(capture),
      resolveArmCwd: () => '/repo/primary',
    });
    assert.deepEqual(result, { enabled: true });
    assert.equal(
      capture.cwd,
      '/repo/primary',
      'arm must run from the base-branch worktree, not the head-branch worktree',
    );
  });

  it('end-to-end with the real resolver (gitSpawn injected) avoids the worktree collision', async () => {
    const capture = {};
    // Real resolveAutoMergeArmCwd is the default; feed it a fake gitSpawn
    // by importing the module-level helper through resolveArmCwd binding.
    const { resolveAutoMergeArmCwd } = await import(
      '../.agents/scripts/lib/orchestration/auto-merge-cwd.js'
    );
    const resolveArmCwd = (cwd) =>
      resolveAutoMergeArmCwd(cwd, {
        gitSpawn: () => ({ status: 0, stdout: PORCELAIN, stderr: '' }),
      });
    const result = await enableAutoMergeWith({
      cwd: '/repo/.worktrees/story-4282',
      prNumber: 88,
      runner: worktreeAwareRunner(capture),
      resolveArmCwd,
    });
    assert.deepEqual(result, { enabled: true });
    assert.equal(capture.cwd, '/repo/primary');
    assert.doesNotMatch(
      String(result.reason ?? ''),
      /already used by worktree/,
      'the worktree-occupied-base-branch failure must not surface',
    );
  });

  it('regression baseline: arming from the head-branch worktree still emits the gh-exit-1 worktree error', async () => {
    const capture = {};
    const result = await enableAutoMergeWith({
      cwd: '/repo/.worktrees/story-4282',
      prNumber: 88,
      runner: worktreeAwareRunner(capture),
      // Pin the cwd to the (buggy) head-branch worktree to prove the test
      // double actually reproduces the failure the fix prevents.
      resolveArmCwd: (cwd) => cwd,
    });
    assert.equal(result.enabled, false);
    assert.match(result.reason, /already used by worktree/);
  });
});

// ---------------------------------------------------------------------------
// Story #5096 — the pre-arm advisory-gate refusal.
//
// This gate covers the narrow shape: the advisory gate is ALREADY red when
// close runs (a re-close, or a gate carried over from an earlier push). The
// common shape — the gate reddening AFTER the arm — belongs to the merge
// wait, and is covered in tests/single-story-close-confirm-merge.test.js.
// ---------------------------------------------------------------------------

describe('runAutoMergePhase — advisory gate (Story #5096)', () => {
  const prNumber = 1850;

  /** A runner that fails the test if the arm is ever attempted. */
  function armMustNotRun() {
    return () => {
      assert.fail('auto-merge was armed over a red advisory gate');
    };
  }

  function probeReturning(probe) {
    return async () => probe;
  }

  const redProbe = {
    state: 'OPEN',
    mergeStateStatus: 'UNSTABLE',
    redHeadRuns: [{ name: 'Bundle-size ratchet', conclusion: 'FAILURE' }],
  };

  it('refuses to arm over a red advisory gate, with the advisory attribution', async () => {
    const result = await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      progress: () => {},
      readPrWaitProbeFn: probeReturning(redProbe),
      gh: { pr: { merge: armMustNotRun() } },
    });
    assert.equal(result.autoMergeEnabled, false);
    assert.equal(result.autoMergeReason, 'advisory-gate-red');
    assert.deepEqual(result.advisoryGate.blockingRuns, redProbe.redHeadRuns);
    assert.match(result.advisoryGate.reason, /Bundle-size ratchet/);
  });

  it('classifies the refusal, so a rollup that says the scan timed out is not reported as a violation (Story #5266)', async () => {
    const result = await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      progress: () => {},
      readPrWaitProbeFn: probeReturning({
        ...redProbe,
        redHeadRuns: [
          {
            name: 'a11y scan',
            conclusion: 'FAILURE',
            summary: 'Navigation timeout of 30000 ms exceeded',
          },
        ],
      }),
      gh: { pr: { merge: armMustNotRun() } },
    });
    // The arm phase still reports `advisory-gate-red` as its REASON (the
    // reason is the arm outcome, not the block class); the class it carries
    // on `advisoryGate` is what the merge wait records on the terminal.
    assert.equal(result.autoMergeReason, 'advisory-gate-red');
    assert.equal(result.advisoryGate.blockClass, 'advisory-gate-inconclusive');
    assert.match(result.advisoryGate.reason, /FAILED WITHOUT FINISHING/);
  });

  it('keeps the red class when the rollup text reports a violation (Story #5266)', async () => {
    const result = await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      progress: () => {},
      readPrWaitProbeFn: probeReturning(redProbe),
      gh: { pr: { merge: armMustNotRun() } },
    });
    assert.equal(result.advisoryGate.blockClass, 'advisory-gate-red');
  });

  it('does NOT fall through to the direct-merge fallback when it refuses', async () => {
    // The #4682 fallback is the other way a PR lands from this phase. A
    // refusal that still reached it would be a way to land red without the
    // check — `armMustNotRun` covers both call sites, since both go through
    // the same runner.
    const result = await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      progress: () => {},
      readPrWaitProbeFn: probeReturning(redProbe),
      gh: { pr: { merge: armMustNotRun() } },
    });
    assert.equal(result.autoMergeEnabled, false);
    assert.equal(result.directMerged, undefined);
  });

  it('arms normally when the red run is allowlisted', async () => {
    let armed = false;
    const result = await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      advisoryAllowlist: ['Bundle-size ratchet'],
      progress: () => {},
      readPrWaitProbeFn: probeReturning(redProbe),
      gh: {
        pr: {
          merge: async () => {
            armed = true;
            return { stdout: '', stderr: '' };
          },
        },
      },
    });
    assert.equal(armed, true);
    assert.equal(result.autoMergeEnabled, true);
  });

  it('arms normally when the knob is disabled — pre-#5096 behaviour verbatim', async () => {
    let armed = false;
    const result = await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      blockOnAdvisoryFailure: false,
      progress: () => {},
      readPrWaitProbeFn: () => assert.fail('probe must not run when disabled'),
      gh: {
        pr: {
          merge: async () => {
            armed = true;
            return { stdout: '', stderr: '' };
          },
        },
      },
    });
    assert.equal(armed, true);
    assert.equal(result.autoMergeEnabled, true);
  });

  it('fails OPEN on a probe error or an UNKNOWN merge state', async () => {
    for (const probe of [
      { error: 'PR probe failed: boom' },
      {
        state: 'OPEN',
        mergeStateStatus: 'UNKNOWN',
        redHeadRuns: redProbe.redHeadRuns,
      },
      {
        state: 'OPEN',
        mergeStateStatus: 'BLOCKED',
        redHeadRuns: redProbe.redHeadRuns,
      },
    ]) {
      let armed = false;
      const result = await runAutoMergePhase({
        cwd: '/tmp',
        prNumber,
        prUrl: `https://github.com/o/r/pull/${prNumber}`,
        noAutoMerge: false,
        progress: () => {},
        readPrWaitProbeFn: probeReturning(probe),
        gh: {
          pr: {
            merge: async () => {
              armed = true;
              return { stdout: '', stderr: '' };
            },
          },
        },
      });
      assert.equal(armed, true, `expected an arm for ${JSON.stringify(probe)}`);
      assert.equal(result.autoMergeEnabled, true);
    }
  });

  it('fails OPEN when the probe itself throws', async () => {
    let armed = false;
    await runAutoMergePhase({
      cwd: '/tmp',
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      noAutoMerge: false,
      progress: () => {},
      readPrWaitProbeFn: async () => {
        throw new Error('gh exploded');
      },
      gh: {
        pr: {
          merge: async () => {
            armed = true;
            return { stdout: '', stderr: '' };
          },
        },
      },
    });
    assert.equal(armed, true);
  });
});

// ---------------------------------------------------------------------------
// `disarmAutoMerge` — the reversal the advisory gate depends on (Story #5266
// gave it its first direct coverage). It lives here, beside the arm, because
// lifecycle-lint confines every merge invocation to that one module.
// ---------------------------------------------------------------------------

describe('disarmAutoMerge', () => {
  it('reports the disarm and says the PR stays hand-mergeable', async () => {
    const calls = [];
    const lines = [];
    const disarmed = await disarmAutoMerge({
      prNumber: 1850,
      gh: {
        pr: {
          merge: async (ref, args) => {
            calls.push([ref, args]);
          },
        },
      },
      progress: (tag, msg) => lines.push(`${tag} ${msg}`),
    });
    assert.equal(disarmed, true);
    assert.deepEqual(calls, [['1850', ['--disable-auto']]]);
    assert.match(lines.join('\n'), /DISARMED/);
  });

  it('is best-effort: a failed disarm reports false and warns that GitHub may still land it', async () => {
    // The one thing it cannot do is stop GitHub, so the caller blocks either
    // way — a throw here would turn a degraded report into a lost block.
    const lines = [];
    const disarmed = await disarmAutoMerge({
      prNumber: 1850,
      gh: {
        pr: {
          merge: async () => {
            throw new Error('gh exploded');
          },
        },
      },
      progress: (tag, msg) => lines.push(`${tag} ${msg}`),
    });
    assert.equal(disarmed, false);
    assert.match(lines.join('\n'), /Disarm by hand/);
  });
});
