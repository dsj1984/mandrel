/**
 * tests/single-story-close-auto-merge.test.js — unit tests for the
 * auto-merge helpers added to `single-story-close.js` (Story #1815).
 *
 * Covers:
 *   - `parsePrNumber` parses well-formed PR URLs and rejects junk.
 *   - `enableAutoMergeWith` returns `{ enabled: true }` on `gh` exit 0 and
 *     `{ enabled: false, reason }` on non-zero / spawn errors.
 *   - Spawn args wire `--auto --squash --delete-branch` so GitHub merges
 *     the PR when required checks pass and deletes the source branch.
 *   - Story #4282: the arm runs from the primary (base-branch) worktree
 *     root so `gh`'s `--delete-branch` local checkout cannot collide with
 *     the base branch occupied by the primary worktree.
 *   - Story #5395: a merge-queue base arms with a bare `--auto`, never falls
 *     back to a direct merge, and an enqueued PR is disarmed by dequeueing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readMergeQueueState } from '../.agents/scripts/lib/orchestration/merge-queue.js';
import {
  disarmAutoMerge,
  enableAutoMergeWith,
  runAutoMergePhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/auto-merge.js';
import { parsePrNumber } from '../.agents/scripts/single-story-close.js';

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

describe('enableAutoMergeWith', () => {
  it('passes --auto --squash --delete-branch to gh and reports enabled on exit 0', async () => {
    let capturedArgs = null;
    let capturedOpts = null;
    const runner = (args, opts) => {
      capturedArgs = args;
      capturedOpts = opts;
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const result = await enableAutoMergeWith({
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
    const result = await enableAutoMergeWith({
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
    const result = await enableAutoMergeWith({
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
    const result = await enableAutoMergeWith({
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
// lifecycle-lint confines every merge invocation to that one module. Story
// #5383 folded the recovery watch's raw-spawn twin into it, so it is also the
// disarm `pr-watch-with-update.js` runs on the first red.
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
    assert.deepEqual(disarmed, {
      disarmed: true,
      alreadyUnarmed: false,
      detail: 'disarmed',
    });
    assert.deepEqual(calls, [['1850', ['--disable-auto']]]);
    assert.match(lines.join('\n'), /DISARMED/);
  });

  it('does not require a progress channel', async () => {
    // The merge wait passes one; `deliver-recover` and the resume CLI may not.
    const result = await disarmAutoMerge({
      prNumber: 1850,
      gh: { pr: { merge: async () => {} } },
    });
    assert.equal(result.disarmed, true);
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
    assert.equal(disarmed.disarmed, false);
    assert.equal(disarmed.alreadyUnarmed, false);
    assert.match(disarmed.detail, /gh exploded/);
    assert.match(lines.join('\n'), /Disarm by hand/);
  });

  it('names a non-Error rejection in the warning rather than printing undefined', async () => {
    const lines = [];
    const disarmed = await disarmAutoMerge({
      prNumber: 1850,
      gh: {
        pr: {
          merge: async () => {
            throw 'gh: rate limited';
          },
        },
      },
      progress: (tag, msg) => lines.push(`${tag} ${msg}`),
    });
    assert.equal(disarmed.disarmed, false);
    assert.match(lines.join('\n'), /gh: rate limited/);
  });

  it('separates a never-armed PR from a genuine failure', async () => {
    // The recovery watch treats an un-disarmable armed PR as a blocker, and a
    // never-armed PR as the posture it wanted — so the two must not collapse.
    const notArmedErr = Object.assign(new Error('gh exited with code 1'), {
      stderr: 'auto-merge is not enabled for this pull request\n',
    });
    const notArmed = await disarmAutoMerge({
      prRef: '1',
      gh: {
        pr: {
          merge: async () => {
            throw notArmedErr;
          },
        },
      },
    });
    assert.equal(notArmed.disarmed, true);
    assert.equal(notArmed.alreadyUnarmed, true);
    assert.match(notArmed.detail, /not armed/);

    const forbidden = await disarmAutoMerge({
      prRef: '1',
      gh: {
        pr: {
          merge: async () => {
            throw Object.assign(new Error('gh exited with code 1'), {
              stderr: 'HTTP 403: forbidden',
            });
          },
        },
      },
    });
    assert.equal(forbidden.disarmed, false);
    assert.match(forbidden.detail, /HTTP 403/);
  });

  it('passes a canonical PR URL ref through verbatim', async () => {
    // The watch CLI addresses a cross-repo PR by URL — `gh` has no
    // `<owner/repo>#<n>` form — so the ref must reach `gh` untouched.
    const calls = [];
    await disarmAutoMerge({
      prRef: 'https://github.com/o/r/pull/7',
      prNumber: 7,
      gh: {
        pr: {
          merge: async (ref, args) => {
            calls.push([ref, args]);
          },
        },
      },
    });
    assert.deepEqual(calls, [
      ['https://github.com/o/r/pull/7', ['--disable-auto']],
    ]);
  });
});

/** A `gh` facade answering the merge-queue GraphQL read with `node`. */
function ghWithQueueNode(node, { mutations = [], mergeCalls = [] } = {}) {
  return {
    pr: {
      view: async (_ref, fields) => {
        assert.deepEqual(fields, ['id']);
        return { id: 'PR_node' };
      },
      merge: async (ref, flags) => {
        mergeCalls.push([ref, flags]);
      },
    },
    api: async ({ body }) => {
      if (body.query.startsWith('mutation')) {
        mutations.push(body);
        return { stdout: JSON.stringify({ data: { dequeuePullRequest: {} } }) };
      }
      return { stdout: JSON.stringify({ data: { node } }) };
    },
  };
}

describe('readMergeQueueState (Story #5395)', () => {
  it('reads queue requirement and membership off the PR node', async () => {
    const state = await readMergeQueueState({
      prNumber: 7,
      gh: ghWithQueueNode({ isMergeQueueEnabled: true, isInMergeQueue: false }),
    });
    assert.deepEqual(state, {
      queueRequired: true,
      inQueue: false,
      prNodeId: 'PR_node',
    });
  });

  it('reports a non-queue base as not required', async () => {
    const state = await readMergeQueueState({
      prNumber: 7,
      gh: ghWithQueueNode({
        isMergeQueueEnabled: false,
        isInMergeQueue: false,
      }),
    });
    assert.equal(state.queueRequired, false);
  });

  it('skips the id lookup when handed a node id', async () => {
    const state = await readMergeQueueState({
      prNodeId: 'PR_given',
      gh: {
        pr: {
          view: async () => assert.fail('the node id was already known'),
        },
        api: async ({ body }) => {
          assert.equal(body.variables.id, 'PR_given');
          return {
            stdout: JSON.stringify({
              data: {
                node: { isMergeQueueEnabled: true, isInMergeQueue: true },
              },
            }),
          };
        },
      },
    });
    assert.equal(state.inQueue, true);
  });

  it('never throws: a failed read, GraphQL errors, or absent fields read as unknown', async () => {
    const failures = [
      {
        pr: { view: async () => ({ id: 'X' }) },
        api: async () => {
          throw new Error('HTTP 502');
        },
      },
      {
        pr: { view: async () => ({ id: 'X' }) },
        api: async () => ({
          stdout: JSON.stringify({ errors: [{ message: 'no access' }] }),
        }),
      },
      {
        pr: { view: async () => ({ id: 'X' }) },
        api: async () => ({
          stdout: JSON.stringify({ data: { node: {} } }),
        }),
      },
      { pr: { view: async () => ({}) } },
    ];
    for (const gh of failures) {
      const state = await readMergeQueueState({ prNumber: 7, gh });
      assert.equal(state.queueRequired, null);
      assert.equal(state.inQueue, null);
      assert.equal(typeof state.error, 'string');
    }
  });
});

describe('enableAutoMergeWith — merge-queue base (Story #5395)', () => {
  it('arms with a bare --auto: no strategy, no --delete-branch', async () => {
    const calls = [];
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 42,
      queueRequired: true,
      resolveArmCwd: (cwd) => cwd,
      runner: (args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(result, { enabled: true, mergeQueue: true });
    assert.deepEqual(calls, [['pr', 'merge', '42', '--auto']]);
  });

  it('never falls back to a direct merge that would bypass the queue', async () => {
    const calls = [];
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 42,
      queueRequired: true,
      resolveArmCwd: (cwd) => cwd,
      runner: (args) => {
        calls.push(args);
        return {
          status: 1,
          stdout: '',
          stderr: 'GraphQL: Auto merge is not allowed for this repository',
        };
      },
    });
    assert.equal(result.enabled, false);
    assert.equal(result.mergeQueue, true);
    assert.match(result.reason, /merge-queue arm failed; gh-exit-1/);
    assert.equal(calls.length, 1, 'no direct-merge retry');
  });

  it('retries once in the queued spelling when gh names the queue', async () => {
    const calls = [];
    const result = await enableAutoMergeWith({
      cwd: '/repo',
      prNumber: 42,
      resolveArmCwd: (cwd) => cwd,
      runner: (args) => {
        calls.push(args);
        return calls.length === 1
          ? {
              status: 1,
              stdout: '',
              stderr:
                'X Cannot use `-d` or `--delete-branch` when merge queue enabled',
            }
          : { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(result, { enabled: true, mergeQueue: true });
    assert.deepEqual(calls, [
      ['pr', 'merge', '42', '--auto', '--squash', '--delete-branch'],
      ['pr', 'merge', '42', '--auto'],
    ]);
  });
});

describe('runAutoMergePhase — merge-queue detection (Story #5395)', () => {
  const armArgs = (overrides) => ({
    cwd: '/tmp',
    prNumber: 42,
    prUrl: 'https://github.com/o/r/pull/42',
    noAutoMerge: false,
    blockOnAdvisoryFailure: false,
    progress: () => {},
    ...overrides,
  });

  it('a queue-protected base arms with the queued spelling and says so', async () => {
    const mergeCalls = [];
    const lines = [];
    const result = await runAutoMergePhase(
      armArgs({
        gh: ghWithQueueNode(
          { isMergeQueueEnabled: true, isInMergeQueue: false },
          { mergeCalls },
        ),
        progress: (_tag, msg) => lines.push(msg),
      }),
    );
    assert.equal(result.autoMergeEnabled, true);
    assert.equal(result.mergeQueue, true);
    assert.deepEqual(mergeCalls, [['42', ['--auto']]]);
    assert.match(lines.join('\n'), /merge queue/);
  });

  it('a non-queue base keeps --auto --squash --delete-branch', async () => {
    const mergeCalls = [];
    const result = await runAutoMergePhase(
      armArgs({
        gh: ghWithQueueNode(
          { isMergeQueueEnabled: false, isInMergeQueue: false },
          { mergeCalls },
        ),
      }),
    );
    assert.equal(result.autoMergeEnabled, true);
    assert.deepEqual(mergeCalls, [
      ['42', ['--auto', '--squash', '--delete-branch']],
    ]);
  });

  it('a failed queue probe falls back to the non-queue spelling', async () => {
    const mergeCalls = [];
    const result = await runAutoMergePhase(
      armArgs({
        gh: {
          pr: {
            merge: async (ref, flags) => {
              mergeCalls.push([ref, flags]);
            },
          },
        },
        readMergeQueueStateFn: async () => ({
          queueRequired: null,
          inQueue: null,
          prNodeId: null,
          error: 'HTTP 502',
        }),
      }),
    );
    assert.equal(result.autoMergeEnabled, true);
    assert.deepEqual(mergeCalls, [
      ['42', ['--auto', '--squash', '--delete-branch']],
    ]);
  });
});

describe('disarmAutoMerge — enqueued PR (Story #5395)', () => {
  it('dequeues an enqueued PR instead of the no-op --disable-auto', async () => {
    const mutations = [];
    const mergeCalls = [];
    const lines = [];
    const result = await disarmAutoMerge({
      prNumber: 42,
      gh: ghWithQueueNode(
        { isMergeQueueEnabled: true, isInMergeQueue: true },
        { mutations, mergeCalls },
      ),
      progress: (_tag, msg) => lines.push(msg),
    });
    assert.deepEqual(result, {
      disarmed: true,
      alreadyUnarmed: false,
      detail: 'dequeued',
    });
    assert.equal(mutations.length, 1);
    assert.match(mutations[0].query, /dequeuePullRequest/);
    assert.equal(mutations[0].variables.id, 'PR_node');
    assert.deepEqual(mergeCalls, []);
    assert.match(lines.join('\n'), /removed from the merge queue/);
  });

  it('a failed dequeue reports not-disarmed and warns', async () => {
    const lines = [];
    const result = await disarmAutoMerge({
      prNumber: 42,
      gh: {
        pr: { merge: async () => assert.fail('must not --disable-auto') },
        api: async () => {
          throw new Error('HTTP 403: forbidden');
        },
      },
      readMergeQueueStateFn: async () => ({
        queueRequired: true,
        inQueue: true,
        prNodeId: 'PR_node',
      }),
      progress: (_tag, msg) => lines.push(msg),
    });
    assert.equal(result.disarmed, false);
    assert.match(result.detail, /merge-queue dequeue failed: .*HTTP 403/);
    assert.match(lines.join('\n'), /Disarm by hand/);
  });

  it('an armed-but-not-yet-enqueued PR on a queue base keeps --disable-auto', async () => {
    const mergeCalls = [];
    const result = await disarmAutoMerge({
      prNumber: 42,
      gh: ghWithQueueNode(
        { isMergeQueueEnabled: true, isInMergeQueue: false },
        { mergeCalls },
      ),
    });
    assert.equal(result.disarmed, true);
    assert.deepEqual(mergeCalls, [['42', ['--disable-auto']]]);
  });
});
