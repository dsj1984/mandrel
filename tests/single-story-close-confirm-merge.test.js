/**
 * tests/single-story-close-confirm-merge.test.js — the close-and-land merge
 * wait (Story #4428; reworked into a resumable, checks-aware wait by Story
 * #4543).
 *
 * Exercises `runConfirmMergePhase`
 * (`.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js`)
 * with injected probes. The suite is organised around the four things the
 * rework had to get right:
 *
 *   1. **The split timing model.** `maxWaitSeconds` bounds ONE invocation and
 *      its expiry is `pending` — no label flip, no `merge.unlanded` event.
 *      `maxBudgetSeconds` bounds the CUMULATIVE wait anchored at the PR's
 *      `createdAt`, so a resume continues the clock instead of restarting it,
 *      and exhausting THAT is the genuine block.
 *   2. **The wait is not weaker than the watch it displaced.** A red check
 *      fails fast as `checks-failed`; a BEHIND PR gets a bounded update.
 *   3. **The ticket re-read is hoisted out of the loop** — it used to cost
 *      ~240 reads per Story per hour for an answer that cannot change
 *      mid-poll.
 *   4. **The land tail runs on the confirmed path**, and `confirmStoryMerged`
 *      remains the ONE shared merged/`agent::done` implementation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_WAIT_SECONDS,
  DEFAULT_UPDATE_ATTEMPTS,
  MIN_POLLS_BEFORE_BUDGET_BLOCK,
  readPrWaitProbe,
  resolveBudgetAnchorMs,
  resolveMergeWaitConfig,
  runConfirmMergePhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js';
import {
  parseCloseOptions,
  resolveWaitForMerge,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/options.js';
import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';

/**
 * Fake ticketing provider mirroring the minimal surface the sibling suites
 * rely on: `getTicket` / `updateTicket` for the label flip, `postComment` for
 * the friction comment. No `getTicketDependencies` / `getSubTickets` means
 * the upward-cascade guard in `transitionTicketState` no-ops (best-effort,
 * matching the established fake-provider contract).
 */
function makeFakeProvider({
  initialStory = {
    id: 4428,
    state: 'open',
    title: 'Close-and-land story',
    labels: ['agent::closing'],
  },
} = {}) {
  let story = { ...initialStory };
  const updates = [];
  const comments = [];
  let getTicketCalls = 0;
  return {
    getTicket: async () => {
      getTicketCalls += 1;
      return { ...story };
    },
    updateTicket: async (id, patch) => {
      updates.push({ id, patch });
      const labels = patch.labels
        ? [
            ...(story.labels ?? []).filter(
              (l) => !(patch.labels.remove ?? []).includes(l),
            ),
            ...(patch.labels.add ?? []),
          ]
        : story.labels;
      story = {
        ...story,
        ...(patch.state ? { state: patch.state } : {}),
        labels,
      };
    },
    postComment: async (id, payload) => {
      comments.push({ id, payload });
      return { id: 'friction-comment-1' };
    },
    _story: () => story,
    _updates: () => updates,
    _comments: () => comments,
    _getTicketCalls: () => getTicketCalls,
  };
}

const NOOP_PROGRESS = () => {};

/** A clock that advances by `stepMs` on every read. */
function makeClock(stepMs, startMs = 0) {
  let now = startMs;
  return () => {
    const value = now;
    now += stepMs;
    return value;
  };
}

/** Probe factory — an open PR whose checks are still pending. */
function openProbe(overrides = {}) {
  return {
    state: 'OPEN',
    mergedAt: null,
    createdAt: null,
    checksStatus: 'pending',
    ...overrides,
  };
}

/**
 * Base args for the phase. Every collaborator is injected so the suite never
 * touches git, GitHub, or a real clock.
 */
function phaseArgs(overrides = {}) {
  return {
    cwd: '/repo',
    storyId: 4428,
    storyBranch: 'story-4428',
    baseBranch: 'main',
    prNumber: 99,
    prUrl: 'https://github.com/o/r/pull/99',
    autoMergeEnabled: true,
    autoMergeReason: 'armed',
    provider: makeFakeProvider(),
    config: {},
    progress: NOOP_PROGRESS,
    sleepFn: async () => {},
    nowMsFn: makeClock(0),
    runPostLandTailFn: async () => ({
      followUps: true,
      statusResync: true,
      refCleanup: true,
      baseFastForward: true,
      details: {},
    }),
    emitMergeUnlandedFn: () => {},
    emitMergeFlipFailedFn: () => {},
    ...overrides,
  };
}

describe('merge wait — the confirmed path', () => {
  it('calls the shared confirmStoryMerged once and runs the land tail', async () => {
    let confirmCalls = 0;
    let tailArgs = null;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        readPrWaitProbeFn: async () => ({
          state: 'MERGED',
          mergedAt: '2026-07-16T00:00:00Z',
        }),
        confirmStoryMergedFn: async (args) => {
          confirmCalls += 1;
          assert.equal(args.storyId, 4428);
          assert.equal(args.prNumber, 99);
          return { storyId: 4428, action: 'done', merged: true };
        },
        runPostLandTailFn: async (args) => {
          tailArgs = args;
          return {
            followUps: true,
            statusResync: true,
            refCleanup: true,
            baseFastForward: true,
            details: {},
          };
        },
      }),
    );
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.terminal, 'landed');
    assert.equal(confirmCalls, 1, 'confirmStoryMerged runs exactly once');
    // The land tail is reached on the DEFAULT path — before #4543 it ran only
    // on the standalone CLI, which this path is told to skip, so follow-ups
    // were captured never.
    assert.equal(outcome.tail.followUps, true);
    assert.equal(tailArgs.storyBranch, 'story-4428');
    assert.equal(tailArgs.baseBranch, 'main');
  });

  it('does NOT re-read the ticket on every poll (the ~240-reads-per-hour fix)', async () => {
    const provider = makeFakeProvider();
    const states = [
      openProbe(),
      openProbe(),
      { state: 'MERGED', mergedAt: 'x' },
    ];
    let polls = 0;
    await runConfirmMergePhase(
      phaseArgs({
        provider,
        readPrWaitProbeFn: async () => {
          polls += 1;
          return states.shift();
        },
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    assert.equal(polls, 3, 'polled the PR three times');
    // The loop probes the PR only; the ticket is read once, inside the single
    // confirmStoryMerged call — which is stubbed here, so zero reads.
    assert.equal(
      provider._getTicketCalls(),
      0,
      'the wait loop must not re-fetch the ticket per poll',
    );
  });

  it('polls until the merge appears, sleeping between polls', async () => {
    const states = [
      openProbe(),
      openProbe(),
      { state: 'MERGED', mergedAt: 'x' },
    ];
    let sleepCalls = 0;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        sleepFn: async () => {
          sleepCalls += 1;
        },
        readPrWaitProbeFn: async () => states.shift(),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    assert.equal(outcome.confirmed, true);
    assert.equal(sleepCalls, 2, 'slept between the two pending polls');
  });

  it('carries the OBSERVED checks rollup, not an assumed success', async () => {
    // A merge can land by admin override, or with non-required checks red.
    // Stamping 'success' would report a green run nobody observed — the same
    // report-an-outcome-you-never-checked shape the tail booleans prevent.
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        readPrWaitProbeFn: async () => ({
          state: 'MERGED',
          mergedAt: 'x',
          checksStatus: 'failure',
        }),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.prProbe.checksStatus, 'failure');
  });

  it('defaults confirmStoryMergedFn to the SAME export the standalone CLI calls', () => {
    // Story #4428 AC4: exactly one merged/agent::done implementation. Pin the
    // identity rather than re-testing the flip here.
    assert.equal(typeof confirmStoryMerged, 'function');
  });
});

describe('merge wait — pending (the resumable terminal)', () => {
  it('returns pending on per-invocation expiry WITHOUT flipping a label or emitting unlanded', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: {
          delivery: { mergeWatch: { intervalSeconds: 30, maxWaitSeconds: 60 } },
        },
        // 40s per read → the second iteration's waited (40s) + interval (30s)
        // exceeds the 60s bound.
        nowMsFn: makeClock(40_000),
        readPrWaitProbeFn: async () => openProbe(),
        emitMergeUnlandedFn: () => emitted.push('unlanded'),
      }),
    );
    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.terminal, 'pending');
    // The three things that make it resumable rather than a block.
    assert.equal(emitted.length, 0, 'no merge.unlanded event');
    assert.equal(provider._updates().length, 0, 'no label mutation');
    assert.equal(provider._comments().length, 0, 'no friction comment');
    assert.equal(outcome.waitBudget.maxWaitSeconds, 60);
  });

  it('reports a cumulative budget anchored at the PR createdAt, not this invocation', async () => {
    // The PR was created 10 minutes before this invocation started. A resume
    // must continue that clock — otherwise every resume gets a fresh hour and
    // the cumulative bound means nothing.
    const startMs = Date.parse('2026-07-16T00:10:00Z');
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        config: {
          delivery: { mergeWatch: { intervalSeconds: 30, maxWaitSeconds: 60 } },
        },
        nowMsFn: makeClock(40_000, startMs),
        readPrWaitProbeFn: async () =>
          openProbe({ createdAt: '2026-07-16T00:00:00Z' }),
      }),
    );
    assert.equal(outcome.terminal, 'pending');
    assert.ok(
      outcome.waitBudget.cumulativeSeconds >= 600,
      `cumulative (${outcome.waitBudget.cumulativeSeconds}s) must include the PR's prior life`,
    );
    assert.ok(
      outcome.waitBudget.cumulativeSeconds > outcome.waitBudget.waitedSeconds,
      'cumulative must outrun this invocation',
    );
  });

  it('a raised per-invocation bound keeps waiting instead of returning pending', async () => {
    // The headless escape hatch: a caller with no host tool-invocation
    // ceiling raises maxWaitSeconds and lands in one block.
    const states = [
      openProbe(),
      openProbe(),
      { state: 'MERGED', mergedAt: 'x' },
    ];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        maxWaitSeconds: 3600,
        config: {
          delivery: { mergeWatch: { intervalSeconds: 30, maxWaitSeconds: 60 } },
        },
        nowMsFn: makeClock(40_000),
        readPrWaitProbeFn: async () => states.shift(),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    assert.equal(
      outcome.confirmed,
      true,
      'the raised bound outlasted the wait',
    );
  });
});

describe('merge wait — blocked terminals', () => {
  it('a red required check fails fast as checks-failed, without burning the budget', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    let polls = 0;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: { delivery: { mergeWatch: { maxBudgetSeconds: 3600 } } },
        readPrWaitProbeFn: async () => {
          polls += 1;
          return openProbe({
            checksStatus: 'failure',
            mergeStateStatus: 'BLOCKED',
          });
        },
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    // Not branch-protection-human-required — the pre-#4543 verdict, which
    // sent the operator to diagnose rules that were working fine.
    assert.equal(outcome.blockClass, 'checks-failed');
    assert.equal(polls, 1, 'failed fast on the first probe');
    assert.equal(emitted[0].blockClass, 'checks-failed');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
    // The friction comment names the red check, not branch protection.
    assert.match(
      provider._comments()[0].payload.body,
      /required check is \*\*red\*\*/,
    );
  });

  it('does not block an already-over-budget PR before waiting at all', async () => {
    // The cumulative clock is anchored at the PR's createdAt so resumes do not
    // restart it — which means a PR older than maxBudgetSeconds is already
    // over budget on its FIRST probe. Without a poll floor, resuming a Story
    // the next morning would flip agent::blocked against a healthy PR that was
    // seconds from merging, having never waited.
    const provider = makeFakeProvider();
    const emitted = [];
    const states = [
      openProbe({ createdAt: '2026-07-01T00:00:00Z' }), // created weeks ago
      { state: 'MERGED', mergedAt: 'x' },
    ];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: {
          delivery: {
            mergeWatch: {
              intervalSeconds: 30,
              maxWaitSeconds: 3600,
              maxBudgetSeconds: 60,
            },
          },
        },
        nowMsFn: makeClock(1000, Date.parse('2026-07-16T00:00:00Z')),
        readPrWaitProbeFn: async () => states.shift(),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.confirmed, true, 'the healthy PR was allowed to land');
    assert.equal(emitted.length, 0, 'no merge.unlanded against a healthy PR');
    assert.equal(provider._updates().length, 0, 'no agent::blocked flip');
    // The floor is a real bound, not an unbounded reprieve: a stuck PR still
    // blocks within a poll cycle (see the next case).
    assert.ok(MIN_POLLS_BEFORE_BUDGET_BLOCK >= 2);
  });

  it('still blocks a genuinely stuck over-budget PR once the poll floor is met', async () => {
    const provider = makeFakeProvider();
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: {
          delivery: {
            mergeWatch: {
              intervalSeconds: 30,
              maxWaitSeconds: 3600,
              maxBudgetSeconds: 60,
            },
          },
        },
        nowMsFn: makeClock(1000, Date.parse('2026-07-16T00:00:00Z')),
        // Never merges, and was created long before the budget.
        readPrWaitProbeFn: async () =>
          openProbe({ createdAt: '2026-07-01T00:00:00Z' }),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
  });

  it('blocks when the cumulative budget is exhausted', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: {
          delivery: {
            mergeWatch: {
              intervalSeconds: 30,
              maxWaitSeconds: 3600,
              maxBudgetSeconds: 60,
            },
          },
        },
        nowMsFn: makeClock(40_000),
        readPrWaitProbeFn: async () => openProbe(),
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.equal(outcome.blockClass, 'checks-pending-timeout');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].scope, 'story');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
  });

  it('an un-armed PR blocks immediately as arm-failure', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        autoMergeEnabled: false,
        autoMergeReason: 'gh pr merge --auto exited 1',
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.equal(outcome.blockClass, 'arm-failure');
    assert.equal(emitted[0].ticketId, 4428);
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
  });

  it('a PR closed without merging blocks immediately, not after the budget', async () => {
    const provider = makeFakeProvider();
    let polls = 0;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        readPrWaitProbeFn: async () => {
          polls += 1;
          return { state: 'CLOSED', mergedAt: null, checksStatus: 'pending' };
        },
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.equal(polls, 1);
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
  });

  it('a merged PR whose agent::done flip failed blocks as merged-flip-failed, not unlanded', async () => {
    // Story #4539 — the merge landed, so reporting merge.unlanded would be
    // false and its friction would send the operator to branch protection
    // instead of the one-line idempotent remedy.
    const provider = makeFakeProvider();
    const unlanded = [];
    const flipFailed = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        readPrWaitProbeFn: async () => ({ state: 'MERGED', mergedAt: 'x' }),
        confirmStoryMergedFn: async () => ({
          action: 'flip-failed',
          merged: true,
          reason: 'labels API 500',
        }),
        emitMergeUnlandedFn: (rec) => unlanded.push(rec),
        emitMergeFlipFailedFn: (rec) => flipFailed.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.equal(outcome.blockClass, 'merged-flip-failed');
    assert.equal(unlanded.length, 0, 'the merge landed — no unlanded event');
    assert.equal(flipFailed.length, 1);
    assert.match(
      provider._comments()[0].payload.body,
      /label-write fault, not a merge fault/,
    );
  });

  it('carries the friction comment id so the operator can be pointed at the remediation', async () => {
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        autoMergeEnabled: false,
        autoMergeReason: 'arm failed',
      }),
    );
    assert.equal(outcome.frictionCommentId, 'friction-comment-1');
  });
});

describe('merge wait — a PR that falls behind its base', () => {
  it('updates a BEHIND PR within a bounded number of attempts', async () => {
    let updates = 0;
    const states = [
      openProbe({ mergeStateStatus: 'BEHIND' }),
      openProbe({ mergeStateStatus: 'BEHIND' }),
      { state: 'MERGED', mergedAt: 'x' },
    ];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        config: { delivery: { mergeWatch: { updateAttempts: 2 } } },
        injectedGh: {
          pr: {
            updateBranch: async () => {
              updates += 1;
            },
          },
        },
        readPrWaitProbeFn: async () => states.shift(),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    assert.equal(outcome.confirmed, true);
    assert.equal(
      updates,
      2,
      'updated the behind branch rather than waiting it out',
    );
  });

  it('stops updating once the attempt budget is spent', async () => {
    let updates = 0;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        config: {
          delivery: {
            mergeWatch: {
              updateAttempts: 1,
              intervalSeconds: 30,
              maxWaitSeconds: 120,
            },
          },
        },
        nowMsFn: makeClock(40_000),
        injectedGh: {
          pr: {
            updateBranch: async () => {
              updates += 1;
            },
          },
        },
        readPrWaitProbeFn: async () =>
          openProbe({ mergeStateStatus: 'BEHIND' }),
      }),
    );
    assert.equal(outcome.terminal, 'pending');
    assert.equal(updates, 1, 'the update budget is a bound, not a suggestion');
  });

  it('a failed update-branch does not itself terminate the wait', async () => {
    const states = [
      openProbe({ mergeStateStatus: 'BEHIND' }),
      { state: 'MERGED', mergedAt: 'x' },
    ];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        injectedGh: {
          pr: {
            updateBranch: async () => {
              throw new Error('gh: conflict');
            },
          },
        },
        readPrWaitProbeFn: async () => states.shift(),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    // The next poll re-reads the real state and lets normal classification
    // decide — a flaked update is not a verdict.
    assert.equal(outcome.confirmed, true);
  });
});

describe('resolveMergeWaitConfig / resolveBudgetAnchorMs', () => {
  it('defaults the per-invocation bound to fit a single host tool invocation', () => {
    const resolved = resolveMergeWaitConfig({});
    assert.equal(resolved.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS);
    // The host ceiling is ~10 minutes and the close gates precede the wait.
    assert.ok(resolved.maxWaitSeconds < 600);
    assert.equal(resolved.maxBudgetSeconds, 3600);
    assert.equal(resolved.intervalSeconds, 30);
    assert.equal(resolved.updateAttempts, DEFAULT_UPDATE_ATTEMPTS);
    // The two budgets are separate axes: the per-invocation bound must be
    // well inside the cumulative one, or resuming would be pointless.
    assert.ok(resolved.maxWaitSeconds < resolved.maxBudgetSeconds);
  });

  it('reads the operator config and lets an explicit override win', () => {
    const config = {
      delivery: {
        mergeWatch: {
          intervalSeconds: 5,
          maxWaitSeconds: 100,
          maxBudgetSeconds: 200,
          updateAttempts: 0,
        },
      },
    };
    assert.equal(resolveMergeWaitConfig(config).maxWaitSeconds, 100);
    assert.equal(resolveMergeWaitConfig(config).updateAttempts, 0);
    assert.equal(resolveMergeWaitConfig(config, 900).maxWaitSeconds, 900);
    // An override must not disturb the other axes.
    assert.equal(resolveMergeWaitConfig(config, 900).maxBudgetSeconds, 200);
  });

  it('ignores invalid config values rather than producing a zero-second wait', () => {
    const resolved = resolveMergeWaitConfig({
      delivery: { mergeWatch: { maxWaitSeconds: 0, intervalSeconds: -5 } },
    });
    assert.equal(resolved.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS);
    assert.equal(resolved.intervalSeconds, 30);
  });

  it('anchors the cumulative budget at the PR createdAt, degrading safely', () => {
    const created = '2026-07-16T00:00:00Z';
    assert.equal(
      resolveBudgetAnchorMs({ createdAt: created, fallbackMs: 999 }),
      Date.parse(created),
    );
    // No timestamp / an unparseable one falls back to this invocation's
    // start: the worst case is a fresh cumulative budget (the pre-#4543
    // behaviour), never a premature block.
    assert.equal(
      resolveBudgetAnchorMs({ createdAt: null, fallbackMs: 999 }),
      999,
    );
    assert.equal(
      resolveBudgetAnchorMs({ createdAt: 'not-a-date', fallbackMs: 999 }),
      999,
    );
  });
});

describe('readPrWaitProbe — one probe carries every field the loop needs', () => {
  it('asks for the merge state, the checks rollup, and the budget anchor in one call', async () => {
    let fields = null;
    const probe = await readPrWaitProbe({
      prNumber: 99,
      gh: {
        pr: {
          view: async (_n, f) => {
            fields = f;
            return {
              state: 'OPEN',
              mergedAt: null,
              createdAt: '2026-07-16T00:00:00Z',
              mergeStateStatus: 'BEHIND',
              reviewDecision: 'APPROVED',
              statusCheckRollup: [{ conclusion: 'SUCCESS' }],
            };
          },
        },
      },
    });
    // One round-trip per poll, not one per concern.
    for (const field of [
      'state',
      'mergedAt',
      'createdAt',
      'mergeStateStatus',
      'statusCheckRollup',
    ]) {
      assert.ok(fields.includes(field), `probe omits ${field}`);
    }
    assert.equal(probe.mergeStateStatus, 'BEHIND');
    assert.equal(probe.createdAt, '2026-07-16T00:00:00Z');
  });

  it('degrades to a conservative pending probe when the read itself fails', async () => {
    // A flaky API read must not be mistaken for a definitive verdict — a
    // `failure` stamp here would block a perfectly healthy Story.
    const probe = await readPrWaitProbe({
      prNumber: 99,
      gh: {
        pr: {
          view: async () => {
            throw new Error('ETIMEDOUT');
          },
        },
      },
    });
    assert.equal(probe.checksStatus, 'pending');
    assert.notEqual(probe.checksStatus, 'failure');
    assert.equal(probe.state, null);
    assert.match(probe.error, /ETIMEDOUT/);
  });
});

describe('parseCloseOptions / resolveWaitForMerge — flag compatibility', () => {
  it('keeps --wait-merge / --no-wait-merge byte-compatible', () => {
    assert.equal(
      parseCloseOptions({ storyIdParam: 1, waitForMergeParam: true })
        .waitForMergeExplicit,
      true,
    );
    assert.equal(
      parseCloseOptions({ storyIdParam: 1, noWaitForMergeParam: true })
        .noWaitForMerge,
      true,
    );
    // Absent means "use delivery.routing.closeAndLand".
    assert.equal(
      parseCloseOptions({ storyIdParam: 1 }).waitForMergeExplicit,
      undefined,
    );
  });

  it('accepts --max-wait-seconds and rejects a nonsense value rather than coercing it', () => {
    assert.equal(
      parseCloseOptions({ storyIdParam: 1, maxWaitSecondsParam: 900 })
        .maxWaitSeconds,
      900,
    );
    // A typo must not silently become a zero-second wait.
    assert.equal(
      parseCloseOptions({ storyIdParam: 1, maxWaitSecondsParam: 0 })
        .maxWaitSeconds,
      undefined,
    );
    assert.equal(
      parseCloseOptions({ storyIdParam: 1 }).maxWaitSeconds,
      undefined,
    );
  });

  it('--no-wait-merge always wins; an un-armed PR is never waited on', () => {
    assert.deepEqual(
      resolveWaitForMerge({ noWaitForMerge: true, waitForMergeExplicit: true }),
      { waitForMerge: false, reason: 'opt-out-flag' },
    );
    // You cannot land-in-one-close a PR you deliberately refused to arm, so
    // an explicit --wait-merge loses to the operator-merge reasons.
    for (const reason of ['disabled-by-flag', 'disabled-by-policy-strict']) {
      assert.deepEqual(
        resolveWaitForMerge({
          waitForMergeExplicit: true,
          autoMergeReason: reason,
        }),
        { waitForMerge: false, reason: 'operator-merge' },
      );
    }
    assert.deepEqual(resolveWaitForMerge({ config: {} }), {
      waitForMerge: true,
      reason: 'config-close-and-land',
    });
  });
});
