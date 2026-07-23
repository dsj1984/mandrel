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
  enableAutoMergeWith,
  runAutoMergePhase,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/auto-merge.js';
import {
  ASYNC_PROBE_WINDOW_SECONDS,
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
import { terminalFromWaitOutcome } from '../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
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
  it('a GENUINELY red required check fails fast as checks-failed on the first evidence-bearing probe (Story #4695 AC-2)', async () => {
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
            // Head-anchored evidence: a run concluded failure, none in flight.
            requiredRunEvidence: {
              requiredRunFailed: true,
              requiredRunInFlight: false,
            },
          });
        },
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    // Not branch-protection-human-required — the pre-#4543 verdict, which
    // sent the operator to diagnose rules that were working fine.
    assert.equal(outcome.blockClass, 'checks-failed');
    assert.equal(polls, 1, 'failed fast on the first evidence-bearing probe');
    assert.equal(emitted[0].blockClass, 'checks-failed');
    // AC-4: the emitted merge.unlanded record names the evidence path.
    assert.equal(emitted[0].evidencePath, 'per-run');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
    // The friction comment names the red check, not branch protection.
    assert.match(
      provider._comments()[0].payload.body,
      /required check is \*\*red\*\*/,
    );
  });

  it('does NOT fail-fast the false-positive shape: a red rollup while a required run is still in flight (Story #4695 AC-1)', async () => {
    // The measured false positive: rollup `failure` (a cancelled superseded
    // run) + `BLOCKED` while a required run is queued. The pre-#4695 fail-fast
    // hard-blocked this; now it keeps polling and the PR lands untouched.
    const provider = makeFakeProvider();
    const emitted = [];
    let polls = 0;
    const states = [
      openProbe({
        checksStatus: 'failure',
        mergeStateStatus: 'BLOCKED',
        requiredRunEvidence: {
          requiredRunFailed: false,
          requiredRunInFlight: true,
        },
      }),
      { state: 'MERGED', mergedAt: 'x' },
    ];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        readPrWaitProbeFn: async () => {
          polls += 1;
          return states.shift();
        },
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'landed');
    assert.equal(outcome.confirmed, true);
    assert.equal(polls, 2, 'kept polling past the pending required run');
    assert.equal(emitted.length, 0, 'no merge.unlanded against a merged PR');
    assert.equal(provider._updates().length, 0, 'no agent::blocked flip');
  });

  it('with per-run evidence unavailable, a single failing rollup probe never fail-fasts — two consecutive probes are required (Story #4695 AC-3)', async () => {
    // Older gh / API error: the probe carries no requiredRunEvidence. A single
    // failing snapshot must not hard-block; only a SECOND consecutive failing
    // probe (one poll interval later) fail-fasts as checks-failed.
    const provider = makeFakeProvider();
    const emitted = [];
    let polls = 0;
    let sleeps = 0;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: { delivery: { mergeWatch: { maxBudgetSeconds: 3600 } } },
        // 1s per clock read keeps both the per-invocation and cumulative
        // bounds comfortably unreached across the two probes.
        nowMsFn: makeClock(1000),
        sleepFn: async () => {
          sleeps += 1;
        },
        readPrWaitProbeFn: async () => {
          polls += 1;
          // No requiredRunEvidence field → evidence unavailable.
          return {
            state: 'OPEN',
            mergedAt: null,
            createdAt: null,
            checksStatus: 'failure',
            mergeStateStatus: 'BLOCKED',
          };
        },
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.equal(outcome.blockClass, 'checks-failed');
    assert.equal(polls, 2, 'the second consecutive failing probe fail-fasts');
    assert.equal(sleeps, 1, 'slept once between the two failing probes');
    // AC-4: the fallback path is named on the emitted record.
    assert.equal(emitted[0].evidencePath, 'consecutive-probe');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
  });

  it('a single failing rollup probe followed by a merge never blocks (evidence unavailable)', async () => {
    // The complement of AC-3: one failing snapshot, then the PR merges. The
    // single snapshot must not have hard-blocked in the meantime.
    const provider = makeFakeProvider();
    const emitted = [];
    const states = [
      {
        state: 'OPEN',
        mergedAt: null,
        createdAt: null,
        checksStatus: 'failure',
        mergeStateStatus: 'BLOCKED',
      },
      { state: 'MERGED', mergedAt: 'x' },
    ];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        nowMsFn: makeClock(1000),
        readPrWaitProbeFn: async () => states.shift(),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'landed');
    assert.equal(emitted.length, 0, 'no block from a single failing snapshot');
    assert.equal(provider._updates().length, 0);
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

describe('merge wait — async mode (Story #4698)', () => {
  it('AC-1: an unmerged healthy PR returns pending after a single bounded probe, with a resumable nextCommand', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: { delivery: { mergeWatch: { mode: 'async' } } },
        // 40s per clock read: the first iteration's waited (40s) + interval
        // (30s) already exceeds the async-clamped 60s bound, so the probe
        // window returns pending after ONE bounded probe — no 300s burn.
        nowMsFn: makeClock(40_000),
        readPrWaitProbeFn: async () => openProbe(),
        emitMergeUnlandedFn: () => emitted.push('unlanded'),
      }),
    );
    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.terminal, 'pending');
    // The async window returns the SAME resumable pending contract as a sync
    // per-invocation expiry: no label flip, no merge.unlanded, no friction.
    assert.equal(emitted.length, 0, 'no merge.unlanded from the async window');
    assert.equal(provider._updates().length, 0, 'no label mutation');
    assert.equal(provider._comments().length, 0, 'no friction comment');
    // The clamped per-invocation bound is the async probe window, not 300s.
    assert.equal(outcome.waitBudget.maxWaitSeconds, ASYNC_PROBE_WINDOW_SECONDS);

    // The pending outcome threaded through the terminal builder carries a
    // non-null nextCommand the worker launches in the background.
    const terminal = terminalFromWaitOutcome({
      waitOutcome: outcome,
      storyId: 4428,
      storyBranch: 'story-4428',
      baseBranch: 'main',
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: true,
      gates: { validation: 'passed', baseSync: 'passed', codeReview: 'passed' },
      elapsedSeconds: 1,
    });
    assert.equal(terminal.status, 'pending');
    assert.ok(terminal.nextCommand, 'pending terminal carries a nextCommand');
    assert.match(terminal.nextCommand, /single-story-confirm-merge\.js/);
  });

  it('AC-2: an instantly-red required check still fails fast within the async probe window', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    let polls = 0;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        config: { delivery: { mergeWatch: { mode: 'async' } } },
        readPrWaitProbeFn: async () => {
          polls += 1;
          return openProbe({
            checksStatus: 'failure',
            mergeStateStatus: 'BLOCKED',
            // Head-anchored evidence (Story #4695): a required run concluded
            // failure and none is in flight — the imported
            // requiredCheckFailedBlocksMerge predicate the async window reuses.
            requiredRunEvidence: {
              requiredRunFailed: true,
              requiredRunInFlight: false,
            },
          });
        },
        emitMergeUnlandedFn: (rec) => emitted.push(rec),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.equal(outcome.blockClass, 'checks-failed');
    assert.equal(polls, 1, 'failed fast on the first evidence-bearing probe');
    assert.equal(emitted[0].evidencePath, 'per-run');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
  });

  it('AC-2: an instant merge inside the async window still lands, not pends', async () => {
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        config: { delivery: { mergeWatch: { mode: 'async' } } },
        readPrWaitProbeFn: async () => ({
          state: 'MERGED',
          mergedAt: '2026-07-23T00:00:00Z',
        }),
        confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      }),
    );
    assert.equal(outcome.terminal, 'landed');
    assert.equal(outcome.confirmed, true);
  });

  it('an explicit --max-wait-seconds override wins over the async cap (headless single-block)', () => {
    const config = { delivery: { mergeWatch: { mode: 'async' } } };
    // No override → clamped to the async probe window.
    assert.equal(
      resolveMergeWaitConfig(config).maxWaitSeconds,
      ASYNC_PROBE_WINDOW_SECONDS,
    );
    // Explicit override → single-block waiting, async cap does not apply.
    assert.equal(resolveMergeWaitConfig(config, 3600).maxWaitSeconds, 3600);
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

  it('defaults mode to sync and leaves the per-invocation bound unclamped (Story #4698 AC-3)', () => {
    // Byte-compatible: with mode absent or "sync", the resolved config is the
    // pre-#4698 shape and the 300s per-invocation bound is untouched.
    assert.equal(resolveMergeWaitConfig({}).mode, 'sync');
    assert.equal(
      resolveMergeWaitConfig({}).maxWaitSeconds,
      DEFAULT_MAX_WAIT_SECONDS,
    );
    const syncConfig = { delivery: { mergeWatch: { mode: 'sync' } } };
    assert.equal(resolveMergeWaitConfig(syncConfig).mode, 'sync');
    assert.equal(
      resolveMergeWaitConfig(syncConfig).maxWaitSeconds,
      DEFAULT_MAX_WAIT_SECONDS,
    );
    // An unknown mode value degrades to sync rather than clamping.
    assert.equal(
      resolveMergeWaitConfig({ delivery: { mergeWatch: { mode: 'weird' } } })
        .mode,
      'sync',
    );
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

  it('clamps a poll interval longer than the wait bound so the budget stays reachable', () => {
    // A --max-wait-seconds shorter than the interval would otherwise fire the
    // pending check on poll 1 forever: the wait could never sleep, the poll
    // floor could never be met, and the cumulative budget would be unreachable
    // across ANY number of resumes — permanent pending that never escalates.
    const resolved = resolveMergeWaitConfig(
      { delivery: { mergeWatch: { intervalSeconds: 30 } } },
      10,
    );
    assert.equal(resolved.maxWaitSeconds, 10);
    assert.equal(resolved.intervalSeconds, 10, 'interval clamped to the bound');
    assert.ok(resolved.intervalSeconds <= resolved.maxWaitSeconds);
  });

  it('a short bound still reaches the poll floor and can block', async () => {
    // The behavioural consequence of the clamp: a misconfigured short wait
    // still escalates a genuinely stuck PR instead of parking forever.
    const provider = makeFakeProvider();
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        maxWaitSeconds: 10,
        config: {
          delivery: {
            mergeWatch: { intervalSeconds: 30, maxBudgetSeconds: 60 },
          },
        },
        // A non-advancing clock isolates the poll sequence: without the clamp
        // the interval (30s) exceeds the bound (10s), so the pending check
        // fires on poll 1 and the loop never sleeps — polls can never reach
        // the floor and the budget is unreachable forever.
        nowMsFn: makeClock(0, Date.parse('2026-07-16T00:00:00Z')),
        readPrWaitProbeFn: async () =>
          openProbe({ createdAt: '2026-07-01T00:00:00Z' }),
      }),
    );
    assert.equal(outcome.terminal, 'blocked');
    assert.deepEqual(provider._updates()[0].patch.labels.add, [
      'agent::blocked',
    ]);
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
              statusCheckRollup: [
                { status: 'COMPLETED', conclusion: 'SUCCESS' },
                { status: 'IN_PROGRESS' },
              ],
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
    // The probe carries head-anchored per-run evidence (Story #4695).
    assert.deepEqual(probe.requiredRunEvidence, {
      requiredRunFailed: false,
      requiredRunInFlight: true,
    });
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

/**
 * Story #4681 — a merged PR must never be stranded at `agent::blocked`
 * because `gh`'s LOCAL head-branch delete lost a race with the per-Story
 * worktree that still holds `story-<id>`.
 *
 * The observed cohort failure: `gh pr merge --auto --squash --delete-branch`
 * merged the PR, then failed its local `git branch -D story-1` with
 * "Cannot delete branch 'story-1' used by worktree at …" and exited 1. The
 * arm read as failed, so the confirm phase took the never-armed branch and
 * blocked a Story whose code was already on `main`.
 */
describe('Story #4681 — local branch-delete failure never blocks a landed merge', () => {
  const WORKTREE_HELD_STDERR =
    "error: Cannot delete branch 'story-4681' used by worktree at " +
    "'/repo/.worktrees/story-4681'";

  /** A `gh` facade whose `pr.merge` fails with `stderr` at exit code 1. */
  function ghFailingMergeWith(stderr) {
    return {
      pr: {
        merge: async () => {
          const err = new Error('gh pr merge failed');
          err.code = 1;
          err.stderr = stderr;
          throw err;
        },
      },
    };
  }

  it('AC-1: reports the arm as armed-with-deferred-cleanup, and the wait lands the Story instead of blocking', async () => {
    const armed = await runAutoMergePhase({
      cwd: '/repo',
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      noAutoMerge: false,
      gh: ghFailingMergeWith(WORKTREE_HELD_STDERR),
      progress: NOOP_PROGRESS,
    });
    assert.equal(armed.autoMergeEnabled, true);
    assert.equal(armed.autoMergeReason, null);
    assert.equal(
      armed.localCleanupDeferred,
      true,
      'the deferred local ref cleanup must be reported, not swallowed',
    );

    // Feed the arm outcome into the wait exactly as the runner does. The PR
    // is MERGED, so the terminal is `landed` and the tail owns the ref reap.
    const provider = makeFakeProvider();
    const tailCalls = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        autoMergeEnabled: armed.autoMergeEnabled,
        autoMergeReason: armed.autoMergeReason,
        readPrWaitProbeFn: async () => ({
          state: 'MERGED',
          mergedAt: '2026-07-21T00:00:00Z',
          createdAt: null,
          checksStatus: 'success',
        }),
        // The real `confirmStoryMerged` drives the label flip; only its PR
        // read is stubbed so the suite never touches GitHub.
        readPrMergeStateFn: async () => ({
          state: 'MERGED',
          mergedAt: '2026-07-21T00:00:00Z',
        }),
        injectedNotify: async () => {},
        runPostLandTailFn: async (args) => {
          tailCalls.push(args);
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

    assert.equal(outcome.terminal, 'landed');
    assert.equal(outcome.confirmed, true);
    assert.ok(
      provider._story().labels.includes('agent::done'),
      'the merged Story must reach agent::done, not agent::blocked',
    );
    assert.deepEqual(
      provider
        ._comments()
        .map((c) => c.payload?.kind ?? c.payload?.type ?? null)
        .filter(Boolean),
      [],
      'no friction comment: nothing about this run is blocked',
    );
    assert.equal(
      tailCalls.length,
      1,
      'the post-land tail runs and performs the deferred local ref cleanup',
    );
    assert.equal(tailCalls[0].storyBranch, 'story-4428');
  });

  it('AC-3: a genuinely refused REMOTE merge still fails the arm and blocks', async () => {
    const armed = await runAutoMergePhase({
      cwd: '/repo',
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      noAutoMerge: false,
      gh: ghFailingMergeWith(
        'Pull request is not mergeable: the base branch policy prohibits the merge.',
      ),
      progress: NOOP_PROGRESS,
    });
    assert.equal(armed.autoMergeEnabled, false);
    assert.match(armed.autoMergeReason, /gh-exit-1/);
    assert.equal(armed.localCleanupDeferred, false);

    const provider = makeFakeProvider();
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        autoMergeEnabled: armed.autoMergeEnabled,
        autoMergeReason: armed.autoMergeReason,
        readPrWaitProbeFn: async () => {
          throw new Error('an un-armed PR must never be polled');
        },
      }),
    );

    assert.equal(outcome.terminal, 'blocked');
    assert.ok(
      provider._story().labels.includes('agent::blocked'),
      'the existing blocked behaviour for a real merge failure is preserved',
    );
    assert.equal(provider._comments().length, 1);
  });

  it('classifies only the branch-DELETE signature — the #4282 checkout collision still fails the arm', async () => {
    // Asserted through the public arm surface: the classifier itself is
    // module-private, so its contract is the arm outcome it produces.
    const armWith = (stderr) =>
      enableAutoMergeWith({
        cwd: '/repo',
        prNumber: 99,
        runner: () => ({ status: 1, stdout: '', stderr }),
        resolveArmCwd: (cwd) => cwd,
      });

    for (const stderr of [
      WORKTREE_HELD_STDERR,
      'failed to delete local branch story-4681',
    ]) {
      const result = await armWith(stderr);
      assert.equal(result.enabled, true, stderr);
      assert.equal(result.localCleanupDeferred, true, stderr);
    }

    for (const stderr of [
      // Story #4282: `gh` aborted BEFORE the branch delete, so there is no
      // evidence the merge stands — this must keep failing the arm.
      "failed to run git: fatal: 'main' is already used by worktree at '/repo'",
      'Pull request is not mergeable',
      '',
    ]) {
      const result = await armWith(stderr);
      assert.equal(result.enabled, false, stderr);
      assert.equal(result.localCleanupDeferred, undefined, stderr);
    }
  });
});
