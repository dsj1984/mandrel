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
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseSprintArgs,
  parseSprintArgsTolerant,
} from '../.agents/scripts/lib/cli-args.js';
import { TEST_TEMP_ROOT_ENV } from '../.agents/scripts/lib/config/temp-paths.js';
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
import {
  TERMINAL_BEGIN_MARKER,
  TERMINAL_END_MARKER,
  terminalFromWaitOutcome,
  validateTerminalEnvelope,
} from '../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

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
      tempPurge: true,
      leaseRelease: true,
      epicRollup: true,
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
            tempPurge: true,
            leaseRelease: true,
            epicRollup: true,
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
    // Story #5279's negative control too: the advisory paragraph must not
    // reach a class where the PR is genuinely NOT mergeable.
    assert.match(
      provider._comments()[0].payload.body,
      /required check is \*\*red\*\*/,
    );
    assert.doesNotMatch(
      provider._comments()[0].payload.body,
      /mergeable regardless/i,
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

/**
 * Story #4949 — `--merge-watch-mode` exists because run topology is invisible
 * from inside close. Close sees one Story; only the orchestrator knows whether
 * a sibling's close is queued behind this one, and therefore whether the
 * foreground merge wait is the cheapest ending or the run's dominant
 * serialized cost. The config default deliberately stays `sync`.
 */
describe('merge wait — --merge-watch-mode override (Story #4949)', () => {
  it('AC-1: the explicit mode wins over delivery.mergeWatch.mode in both directions', () => {
    // Config sync (and config-absent) → the override selects async.
    assert.equal(resolveMergeWaitConfig({}).mode, 'sync');
    assert.equal(resolveMergeWaitConfig({}, undefined, 'async').mode, 'async');
    assert.equal(
      resolveMergeWaitConfig(
        { delivery: { mergeWatch: { mode: 'sync' } } },
        undefined,
        'async',
      ).mode,
      'async',
    );
    // Config async → the override selects sync. An override that could only
    // ever escalate would leave an async-configured consumer unable to ask a
    // solo close for the cheaper foreground wait.
    const asyncConfig = { delivery: { mergeWatch: { mode: 'async' } } };
    assert.equal(resolveMergeWaitConfig(asyncConfig).mode, 'async');
    assert.equal(
      resolveMergeWaitConfig(asyncConfig, undefined, 'sync').mode,
      'sync',
    );
  });

  it('AC-1: an absent override defers to the config, exactly as --max-wait-seconds does', () => {
    const asyncConfig = { delivery: { mergeWatch: { mode: 'async' } } };
    for (const absent of [undefined, null]) {
      assert.equal(
        resolveMergeWaitConfig(asyncConfig, undefined, absent).mode,
        'async',
      );
      assert.equal(resolveMergeWaitConfig({}, undefined, absent).mode, 'sync');
    }
  });

  it('AC-1: the mode override carries the async probe cap, and --max-wait-seconds still wins over it', () => {
    // Mode override alone → the same clamp a config-selected async gets.
    assert.equal(
      resolveMergeWaitConfig({}, undefined, 'async').maxWaitSeconds,
      ASYNC_PROBE_WINDOW_SECONDS,
    );
    // The two flags compose and stay mode-agnostic: the explicit bound wins
    // over the probe cap regardless of where the async mode came from.
    const composed = resolveMergeWaitConfig({}, 3600, 'async');
    assert.equal(composed.mode, 'async');
    assert.equal(composed.maxWaitSeconds, 3600);
    // A sync override leaves the configured bound untouched.
    assert.equal(
      resolveMergeWaitConfig(
        { delivery: { mergeWatch: { mode: 'async', maxWaitSeconds: 300 } } },
        undefined,
        'sync',
      ).maxWaitSeconds,
      300,
    );
  });

  it('AC-1: the phase honours the override — a sync-configured close returns pending inside the probe window', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        provider,
        // Config says sync — only the per-invocation flag asks for async.
        config: { delivery: { mergeWatch: { mode: 'sync' } } },
        mergeWatchMode: 'async',
        nowMsFn: makeClock(40_000),
        readPrWaitProbeFn: async () => openProbe(),
        emitMergeUnlandedFn: () => emitted.push('unlanded'),
      }),
    );
    assert.equal(outcome.terminal, 'pending');
    assert.equal(
      outcome.waitBudget.maxWaitSeconds,
      ASYNC_PROBE_WINDOW_SECONDS,
      'the flag must reach resolveMergeWaitConfig, not just the log line',
    );
    // The async ending is the SAME resumable pending contract: nothing mutated.
    assert.equal(emitted.length, 0);
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._comments().length, 0);
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

describe('merge wait — bounded gh subprocess calls (Story #4710 AC-1)', () => {
  it('a never-returning gh probe surfaces a probe error within the bound instead of hanging', async () => {
    // The hang shape: async mode runs the wait unattended with no host tool
    // ceiling, so a wedged `gh pr view` used to strand the wait forever — no
    // terminal envelope, no label flip, no friction record.
    const probe = await readPrWaitProbe({
      prNumber: 99,
      gh: { pr: { view: () => new Promise(() => {}) } },
      ghTimeoutMs: 25,
    });
    // The timeout maps to the EXISTING degraded probe-error path — the same
    // conservative shape a flaky API read produces.
    assert.equal(probe.checksStatus, 'pending');
    assert.equal(probe.state, null);
    assert.match(probe.error, /timeout/i);
  });

  it('the wait reaches its resumable pending terminal even when every probe hangs', async () => {
    // End-to-end through the REAL readPrWaitProbe (no probe seam): a hung gh
    // degrades each poll to a probe error, and the per-invocation bound still
    // fires — the wait terminates with the resumable terminal, never hangs.
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        injectedGh: { pr: { view: () => new Promise(() => {}) } },
        ghTimeoutMs: 25,
        config: {
          delivery: { mergeWatch: { maxWaitSeconds: 1, intervalSeconds: 1 } },
        },
        nowMsFn: makeClock(1000),
      }),
    );
    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.terminal, 'pending');
    assert.match(outcome.prProbe.error, /timeout/i);
  });

  it('a never-returning gh pr update-branch does not strand the wait', async () => {
    let updateCalled = false;
    const outcome = await runConfirmMergePhase(
      phaseArgs({
        readPrWaitProbeFn: async () =>
          openProbe({ mergeStateStatus: 'BEHIND' }),
        injectedGh: {
          pr: {
            updateBranch: () => {
              updateCalled = true;
              return new Promise(() => {});
            },
          },
        },
        ghTimeoutMs: 25,
        config: {
          delivery: { mergeWatch: { maxWaitSeconds: 1, intervalSeconds: 1 } },
        },
        nowMsFn: makeClock(1000),
      }),
    );
    assert.equal(updateCalled, true, 'the BEHIND update must be attempted');
    // The hung update is best-effort: it times out, logs, and the wait still
    // reaches its own terminal.
    assert.equal(outcome.terminal, 'pending');
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

  it('AC-1: accepts --merge-watch-mode sync|async and REFUSES anything else before a phase runs', () => {
    for (const [raw, expected] of [
      ['async', 'async'],
      ['sync', 'sync'],
      ['  ASYNC  ', 'async'],
    ]) {
      assert.equal(
        parseCloseOptions({ storyIdParam: 1, mergeWatchModeParam: raw })
          .mergeWatchMode,
        expected,
      );
    }
    // Absent → undefined, which is what defers to delivery.mergeWatch.mode.
    assert.equal(
      parseCloseOptions({ storyIdParam: 1 }).mergeWatchMode,
      undefined,
    );
    // Fail closed. Coercing a typo to the config default would silently put a
    // multi-Story run back on synchronous merge-watch — every close burning
    // its foreground slot, with the wall clock as the only evidence. Parsing
    // runs before the first phase, so this throw costs no mutation.
    for (const bad of ['ASYNCH', 'true', 'background', '', 1]) {
      assert.throws(
        () => parseCloseOptions({ storyIdParam: 1, mergeWatchModeParam: bad }),
        /--merge-watch-mode must be one of sync\|async/,
      );
    }
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
            tempPurge: true,
            leaseRelease: true,
            epicRollup: true,
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

/**
 * Story #4873 — one poll primitive, one progress signal.
 *
 * The wait's cadence moved onto the shared `pollUntil` primitive, and each
 * poll now writes a heartbeat through `progress`. Both are observable
 * properties, not refactoring trivia: the first means there is one place in
 * the codebase where a wait sleeps, and the second is what lets an
 * orchestrator watching a backgrounded close's output file tell an in-flight
 * wait from a stalled process without asking GitHub.
 */
describe('Story #4873 — shared poll primitive and progress heartbeat', () => {
  it('AC-5: the merge-confirm wait drives the shared poll primitive, not its own loop', async () => {
    const source = await readFile(
      new URL(
        '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js',
        import.meta.url,
      ),
      'utf-8',
    );
    assert.match(
      source,
      /import \{ pollUntil \} from '\.\.\/\.\.\/\.\.\/util\/poll-loop\.js';/,
      'the phase must import the shared poll primitive',
    );
    assert.match(source, /await pollUntil\(/, 'and actually drive it');
    assert.doesNotMatch(
      source,
      /while \(true\)/,
      'the bespoke wait loop must be gone, not merely wrapped',
    );
  });

  it('AC-5: the shared primitive honours the phase’s own sleep seam and cadence', async () => {
    const sleeps = [];
    const probes = [openProbe(), openProbe(), { state: 'MERGED' }];
    let i = 0;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4873,
      prNumber: 21,
      prUrl: 'https://github.com/o/r/pull/21',
      autoMergeEnabled: true,
      provider: makeFakeProvider(),
      config: { delivery: { mergeWatch: { intervalSeconds: 7 } } },
      progress: NOOP_PROGRESS,
      readPrWaitProbeFn: async () => probes[i++] ?? { state: 'MERGED' },
      confirmStoryMergedFn: async () => ({ merged: true, action: 'flipped' }),
      runPostLandTailFn: async () => ({}),
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      nowMsFn: makeClock(0),
    });
    assert.equal(outcome.confirmed, true);
    assert.deepEqual(
      sleeps,
      [7000, 7000],
      'one interval sleep between each pair of polls, taken through the injected seam',
    );
  });

  it('AC-6: every poll writes a heartbeat naming the PR state and the elapsed budget', async () => {
    const lines = [];
    const probes = [
      openProbe({ mergeStateStatus: 'BLOCKED' }),
      openProbe({ checksStatus: 'success' }),
      { state: 'MERGED' },
    ];
    let i = 0;
    await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4873,
      prNumber: 22,
      prUrl: 'https://github.com/o/r/pull/22',
      autoMergeEnabled: true,
      provider: makeFakeProvider(),
      config: { delivery: { mergeWatch: { intervalSeconds: 5 } } },
      progress: (tag, msg) => lines.push(`${tag} ${msg}`),
      readPrWaitProbeFn: async () => probes[i++] ?? { state: 'MERGED' },
      confirmStoryMergedFn: async () => ({ merged: true, action: 'flipped' }),
      runPostLandTailFn: async () => ({}),
      sleepFn: async () => {},
      nowMsFn: makeClock(0),
    });
    const heartbeats = lines.filter((l) => l.includes('poll '));
    assert.equal(
      heartbeats.length,
      3,
      'one heartbeat per poll — the file must grow while the wait is healthy',
    );
    assert.match(heartbeats[0], /poll 1: PR #22 state=OPEN/);
    assert.match(heartbeats[0], /checks=pending/);
    assert.match(heartbeats[0], /mergeState=BLOCKED/);
    assert.match(heartbeats[0], /cumulative/);
    assert.match(heartbeats[1], /poll 2: .*checks=success/);
    assert.match(heartbeats[2], /poll 3: PR #22 state=MERGED/);
  });

  it('AC-6: a degraded probe says so on the heartbeat rather than looking healthy', async () => {
    const lines = [];
    await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4873,
      prNumber: 23,
      prUrl: 'https://github.com/o/r/pull/23',
      autoMergeEnabled: true,
      provider: makeFakeProvider(),
      config: {
        delivery: { mergeWatch: { intervalSeconds: 5, maxWaitSeconds: 5 } },
      },
      progress: (tag, msg) => lines.push(`${tag} ${msg}`),
      readPrWaitProbeFn: async () => ({
        state: null,
        mergedAt: null,
        createdAt: null,
        checksStatus: 'pending',
        error: 'PR probe failed: gh exploded',
      }),
      sleepFn: async () => {},
      nowMsFn: makeClock(3000),
    });
    const heartbeat = lines.find((l) => l.includes('poll 1'));
    assert.match(heartbeat, /state=unknown/);
    assert.match(heartbeat, /probe error: PR probe failed: gh exploded/);
  });
});

/**
 * Story #4959 — the argv path itself.
 *
 * Every `--merge-watch-mode` assertion above drives `parseCloseOptions`, the
 * injection seam. That seam was green throughout the window in which the real
 * CLI could not survive the flag at all: `parseSprintArgs` threw, and the
 * catch in each entry's `main()` called `parseSprintArgs()` *again* to build
 * its envelope, so the second throw escaped the handler. An unparseable argv
 * produced a bare stack trace with no terminal envelope and no friction
 * signal — on the two surfaces whose entire contract is that they emit one.
 *
 * These cases drive real argv, and the spawn cases drive the real process.
 */
describe('argv path — --merge-watch-mode (Story #4959)', () => {
  /** Real argv shape: node:util slices the first two entries off. */
  const argv = (...flags) => ['node', 'single-story-close.js', ...flags];

  const scriptPath = (basename) =>
    fileURLToPath(new URL(`../.agents/scripts/${basename}`, import.meta.url));

  /** Pull the one envelope out from between the terminal markers. */
  function readTerminalEnvelope(stdout) {
    const begin = stdout.indexOf(TERMINAL_BEGIN_MARKER);
    const end = stdout.indexOf(TERMINAL_END_MARKER);
    assert.ok(
      begin >= 0 && end > begin,
      `stdout carried no terminal envelope:\n${stdout}`,
    );
    return JSON.parse(
      stdout.slice(begin + TERMINAL_BEGIN_MARKER.length, end).trim(),
    );
  }

  it('honours a valid --merge-watch-mode read off real argv', () => {
    for (const [flags, expected] of [
      [['--merge-watch-mode', 'async'], 'async'],
      [['--merge-watch-mode=sync'], 'sync'],
      [['--merge-watch-mode', '  ASYNC  '], 'async'],
      [[], undefined],
    ]) {
      assert.equal(
        parseSprintArgs(argv('--story', '7', ...flags)).mergeWatchMode,
        expected,
      );
    }
  });

  it('an UNREGISTERED flag spelling parses to nothing — the silent class strict:false permits', () => {
    // `strict: false` means `node:util`'s parseArgs neither rejects nor
    // reports an unknown flag: a near-miss spelling is dropped on the floor
    // and the run silently keeps the config default, with the wall clock as
    // the only evidence. Pinned here so the hazard is asserted rather than
    // assumed — and so the spawn cases below are read for what they also are:
    // the canary that the REGISTERED spelling is still wired. Rename or drop
    // `merge-watch-mode` from the parser spec and `bogus` parses to nothing,
    // no error is raised, and those cases fail on a missing envelope.
    const parsed = parseSprintArgs(
      argv('--story', '7', '--merge-watch-modes', 'bogus'),
    );
    assert.equal(parsed.mergeWatchMode, undefined);
    assert.equal(parsed.storyId, 7, 'the rest of argv still parses');
  });

  it('parseSprintArgsTolerant returns the rejection ALONGSIDE the fields, never instead of them', () => {
    const { args, error } = parseSprintArgsTolerant(
      argv('--story', '42', '--skip-validation', '--merge-watch-mode', 'bogus'),
    );
    assert.match(
      error.message,
      /--merge-watch-mode must be one of sync\|async/,
    );
    // The fields an error handler needs to report an envelope survive the
    // rejection; only the flag that failed validation degrades to absent.
    assert.equal(args.storyId, 42);
    assert.equal(args.skipValidation, true);
    assert.equal(args.mergeWatchMode, undefined);
    // A clean argv reports no error and parses exactly as parseSprintArgs does.
    const clean = parseSprintArgsTolerant(
      argv('--story', '42', '--merge-watch-mode', 'async'),
    );
    assert.equal(clean.error, null);
    assert.equal(clean.args.mergeWatchMode, 'async');
  });

  for (const basename of [
    'single-story-close.js',
    'single-story-confirm-merge.js',
  ]) {
    it(`AC-1: ${basename} emits a failed init envelope AND friction for an invalid --merge-watch-mode`, () => {
      // A per-spawn scratch tempRoot: the child inherits the env, so its
      // friction record lands here instead of the repo's real ledger, where a
      // fixture story id has previously been mistaken for a live signal.
      const scratch = makeTempDir('merge-watch-argv-');
      const storyId = 424242;
      const run = spawnSync(
        process.execPath,
        [
          scriptPath(basename),
          '--story',
          String(storyId),
          '--merge-watch-mode',
          'bogus',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, [TEST_TEMP_ROOT_ENV]: scratch },
        },
      );

      assert.equal(run.status, 1, `expected exit 1, got ${run.status}`);
      const envelope = readTerminalEnvelope(run.stdout);
      const { valid, errors } = validateTerminalEnvelope(envelope);
      assert.ok(
        valid,
        `envelope must be schema-valid: ${JSON.stringify(errors)}`,
      );
      assert.equal(envelope.status, 'failed');
      // `init`, not a phase name: the flag is rejected before the pipeline
      // starts, so nothing was mutated and the envelope must not imply it was.
      assert.equal(envelope.phase, 'init');
      assert.equal(envelope.storyId, storyId);
      assert.match(
        envelope.failure.reason,
        /--merge-watch-mode must be one of/,
      );

      // Story #4578's contract: a close that dies before the runner can report
      // its own terminal is exactly the friction the retro must see. Located
      // by search rather than by a hand-built path — the scratch root is a
      // base the configured `project.paths.tempRoot` nests under, so spelling
      // the layout out here would couple the assertion to that config value.
      const ledger = readdirSync(scratch, { recursive: true })
        .map(String)
        .find(
          (entry) =>
            entry.endsWith('signals.ndjson') &&
            entry.includes(`story-${storyId}`),
        );
      assert.ok(ledger, `no signals ledger was written under ${scratch}`);
      const signals = readFileSync(path.join(scratch, ledger), 'utf8');
      const records = signals
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(
        records.some(
          (r) => r.kind === 'friction' && r.category === 'close-failed',
        ),
        `no close-failed friction record was emitted: ${signals}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Story #5096 — the IN-POLL advisory disarm.
//
// This is the half that catches the real shape. Close arms immediately after
// opening the PR, while the advisory gate is still QUEUED, so the pre-arm
// refusal sees a healthy PR; the gate reddens mid-wait and native auto-merge
// lands it the moment the REQUIRED contexts go green. The wait must disarm
// FIRST — an armed PR can merge out from under the block being recorded —
// then block as `advisory-gate-red`.
// ---------------------------------------------------------------------------

describe('runConfirmMergePhase — in-poll advisory disarm (Story #5096)', () => {
  const advisoryProbe = (overrides = {}) =>
    openProbe({
      mergeStateStatus: 'UNSTABLE',
      checksStatus: 'failure',
      redHeadRuns: [{ name: 'Bundle-size ratchet', conclusion: 'FAILURE' }],
      ...overrides,
    });

  function runWith(overrides = {}) {
    const disarms = [];
    const emitted = [];
    const lines = [];
    const args = {
      cwd: '/repo',
      storyId: 5096,
      prNumber: 1850,
      prUrl: 'https://github.com/o/r/pull/1850',
      autoMergeEnabled: true,
      provider: makeFakeProvider(),
      config: { delivery: { mergeWatch: { intervalSeconds: 5 } } },
      progress: (tag, msg) => lines.push(`${tag} ${msg}`),
      confirmStoryMergedFn: async () => ({ merged: true, action: 'flipped' }),
      runPostLandTailFn: async () => ({}),
      emitMergeUnlandedFn: (record) => emitted.push(record),
      disarmAutoMergeFn: async (a) => {
        disarms.push(a.prNumber);
        return true;
      },
      sleepFn: async () => {},
      nowMsFn: makeClock(0),
      ...overrides,
    };
    return { args, disarms, emitted, lines };
  }

  it('disarms and blocks when an advisory gate reddens AFTER the arm', async () => {
    // Poll 1 healthy (the gate is still running) — exactly the state the
    // pre-arm gate would have seen. Poll 2 is red.
    const probes = [openProbe(), advisoryProbe()];
    let i = 0;
    const ctx = runWith({
      readPrWaitProbeFn: async () => probes[i++] ?? advisoryProbe(),
    });
    const outcome = await runConfirmMergePhase(ctx.args);

    assert.equal(outcome.confirmed, false);
    assert.deepEqual(ctx.disarms, [1850], 'auto-merge must be disarmed');
    assert.equal(ctx.emitted.length, 1);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-red');
    assert.match(ctx.emitted[0].reason, /Bundle-size ratchet → FAILURE/);
  });

  it('disarms BEFORE recording the block, so GitHub cannot land underneath it', async () => {
    const order = [];
    const ctx = runWith({
      readPrWaitProbeFn: async () => advisoryProbe(),
      disarmAutoMergeFn: async () => {
        order.push('disarm');
        return true;
      },
      emitMergeUnlandedFn: () => order.push('emit'),
    });
    await runConfirmMergePhase(ctx.args);
    assert.deepEqual(order, ['disarm', 'emit']);
  });

  it('leaves the PR open — no merge, no post-land tail', async () => {
    let tailRan = false;
    const ctx = runWith({
      readPrWaitProbeFn: async () => advisoryProbe(),
      runPostLandTailFn: async () => {
        tailRan = true;
        return {};
      },
    });
    const outcome = await runConfirmMergePhase(ctx.args);
    assert.equal(tailRan, false);
    assert.equal(outcome.confirmed, false);
  });

  it('keeps waiting when the red run is allowlisted', async () => {
    const probes = [advisoryProbe(), { state: 'MERGED' }];
    let i = 0;
    const ctx = runWith({
      config: {
        delivery: {
          mergeWatch: { intervalSeconds: 5 },
          ci: { advisoryAllowlist: ['Bundle-size ratchet'] },
        },
      },
      readPrWaitProbeFn: async () => probes[i++] ?? { state: 'MERGED' },
    });
    const outcome = await runConfirmMergePhase(ctx.args);
    assert.equal(outcome.confirmed, true);
    assert.deepEqual(ctx.disarms, []);
  });

  it('keeps waiting when the knob is disabled — pre-#5096 behaviour verbatim', async () => {
    const probes = [advisoryProbe(), { state: 'MERGED' }];
    let i = 0;
    const ctx = runWith({
      config: {
        delivery: {
          mergeWatch: { intervalSeconds: 5 },
          ci: { blockOnAdvisoryFailure: false },
        },
      },
      readPrWaitProbeFn: async () => probes[i++] ?? { state: 'MERGED' },
    });
    const outcome = await runConfirmMergePhase(ctx.args);
    assert.equal(outcome.confirmed, true);
    assert.deepEqual(ctx.disarms, []);
  });

  it('never disarms a PR GitHub is already gating (BLOCKED keeps checks-failed)', async () => {
    const ctx = runWith({
      readPrWaitProbeFn: async () =>
        advisoryProbe({
          mergeStateStatus: 'BLOCKED',
          requiredRunEvidence: {
            requiredRunFailed: true,
            requiredRunInFlight: false,
          },
        }),
    });
    await runConfirmMergePhase(ctx.args);
    assert.deepEqual(ctx.disarms, [], 'the required-check path owns this case');
    assert.equal(ctx.emitted[0].blockClass, 'checks-failed');
  });

  it('an UNKNOWN merge state never disarms, so a healthy PR still lands', async () => {
    const probes = [
      advisoryProbe({ mergeStateStatus: 'UNKNOWN' }),
      { state: 'MERGED' },
    ];
    let i = 0;
    const ctx = runWith({
      readPrWaitProbeFn: async () => probes[i++] ?? { state: 'MERGED' },
    });
    const outcome = await runConfirmMergePhase(ctx.args);
    assert.equal(outcome.confirmed, true);
    assert.deepEqual(ctx.disarms, []);
  });

  it('still blocks when the disarm itself fails, and says the merge may land', async () => {
    const ctx = runWith({
      readPrWaitProbeFn: async () => advisoryProbe(),
      disarmAutoMergeFn: async () => false,
    });
    const outcome = await runConfirmMergePhase(ctx.args);
    assert.equal(outcome.confirmed, false);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-red');
  });

  // -------------------------------------------------------------------------
  // Story #5266 — a scan that never FINISHED is not a scan that found
  // something. Same block, different class, different remedies.
  // -------------------------------------------------------------------------

  const NAV_TIMEOUT = 'Navigation timeout of 30000 ms exceeded';

  /** A `gh` double whose `api` records every endpoint it is asked for. */
  function makeGh({ checkRuns = [], rerunThrows = false } = {}) {
    const calls = [];
    return {
      calls,
      api: async ({ method = 'GET', endpoint }) => {
        calls.push(`${method} ${endpoint}`);
        if (endpoint.includes('/rerun-failed-jobs')) {
          if (rerunThrows) throw new Error('rerun refused');
          return { stdout: '{}', stderr: '', code: 0 };
        }
        return {
          stdout: JSON.stringify({ check_runs: checkRuns }),
          stderr: '',
          code: 0,
        };
      },
    };
  }

  /** The observed shape: a red advisory run that timed out reporting nothing. */
  const timedOutProbe = (overrides = {}) =>
    advisoryProbe({
      headSha: 'deadbeef',
      redHeadRuns: [
        {
          name: 'a11y scan',
          conclusion: 'FAILURE',
          runId: 1234,
          completedAt: '2026-09-10T10:00:00Z',
        },
      ],
      ...overrides,
    });

  const timedOutCheckRuns = [
    {
      name: 'a11y scan',
      output: { title: 'Scan failed', summary: NAV_TIMEOUT },
    },
  ];

  it('blocks a timed-out scan as advisory-gate-inconclusive, reading the check-run output', async () => {
    const gh = makeGh({ checkRuns: timedOutCheckRuns });
    const ctx = runWith({
      injectedGh: gh,
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    const outcome = await runConfirmMergePhase(ctx.args);

    assert.equal(outcome.confirmed, false);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-inconclusive');
    assert.match(ctx.emitted[0].reason, /FAILED WITHOUT FINISHING/);
    assert.match(ctx.emitted[0].reason, /a11y scan → FAILURE/);
    assert.deepEqual(ctx.disarms, [1850], 'the gate still blocks and disarms');
    assert.ok(
      gh.calls.some((c) => c.includes('/commits/deadbeef/check-runs')),
      'the head check-run output is what makes the classification possible',
    );
  });

  it('keeps advisory-gate-red when the run reported a real violation', async () => {
    const gh = makeGh({
      checkRuns: [
        { name: 'a11y scan', output: { summary: '3 violations found' } },
      ],
    });
    const ctx = runWith({
      injectedGh: gh,
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    await runConfirmMergePhase(ctx.args);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-red');
    assert.match(ctx.emitted[0].reason, /concluded red on the PR head/);
  });

  it('falls back to advisory-gate-red when the output cannot be read', async () => {
    const gh = {
      calls: [],
      api: async () => {
        throw new Error('api down');
      },
    };
    const ctx = runWith({
      injectedGh: gh,
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    await runConfirmMergePhase(ctx.args);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-red');
  });

  it('reruns NOTHING and mutates no GitHub state with no flag and no config (AC-6)', async () => {
    const gh = makeGh({ checkRuns: timedOutCheckRuns });
    const ctx = runWith({
      injectedGh: gh,
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    await runConfirmMergePhase(ctx.args);
    assert.deepEqual(
      gh.calls.filter((c) => c.startsWith('POST')),
      [],
      'the default allowance is 0 — close spends no CI minutes unasked',
    );
    assert.equal(ctx.emitted.length, 1, 'it still blocks');
  });

  it('at --rerun-advisory 1 it reruns once, re-polls, and lands on the green re-run (AC-7)', async () => {
    const gh = makeGh({ checkRuns: timedOutCheckRuns });
    // Poll 1 red → rerun; poll 2 is the STALE pre-rerun snapshot (identical
    // signature), which must not re-block; poll 3 sees the merge.
    const probes = [timedOutProbe(), timedOutProbe(), { state: 'MERGED' }];
    let i = 0;
    const ctx = runWith({
      rerunAdvisory: 1,
      injectedGh: gh,
      readPrWaitProbeFn: async () => probes[i++] ?? { state: 'MERGED' },
    });
    const outcome = await runConfirmMergePhase(ctx.args);

    assert.deepEqual(
      gh.calls.filter((c) => c.startsWith('POST')),
      ['POST /repos/{owner}/{repo}/actions/runs/1234/rerun-failed-jobs'],
      'exactly one rerun, of the workflow run behind the failed job',
    );
    assert.equal(outcome.confirmed, true, 'the re-poll landed the PR');
    assert.deepEqual(ctx.disarms, [], 'nothing was disarmed on the way');
  });

  it('spends the allowance once: a fresh red observation after it blocks', async () => {
    const gh = makeGh({ checkRuns: timedOutCheckRuns });
    // The re-run finished and is red again — a NEW completedAt, so a new
    // observation, and the (now exhausted) allowance cannot suppress it.
    const probes = [
      timedOutProbe(),
      timedOutProbe({
        redHeadRuns: [
          {
            name: 'a11y scan',
            conclusion: 'FAILURE',
            runId: 1234,
            completedAt: '2026-09-10T11:00:00Z',
          },
        ],
      }),
    ];
    let i = 0;
    const ctx = runWith({
      rerunAdvisory: 1,
      injectedGh: gh,
      readPrWaitProbeFn: async () => probes[i++] ?? probes[1],
    });
    await runConfirmMergePhase(ctx.args);
    assert.equal(
      gh.calls.filter((c) => c.startsWith('POST')).length,
      1,
      'the allowance is spent across the wait, not per poll',
    );
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-inconclusive');
    assert.match(
      ctx.emitted[0].reason,
      /rerun allowance \(1\) is already spent/,
    );
  });

  it('blocks rather than silently skipping when the rerun request fails', async () => {
    const gh = makeGh({ checkRuns: timedOutCheckRuns, rerunThrows: true });
    const ctx = runWith({
      rerunAdvisory: 1,
      injectedGh: gh,
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    await runConfirmMergePhase(ctx.args);
    assert.equal(ctx.emitted.length, 1);
    assert.deepEqual(ctx.disarms, [1850]);
  });

  it('carries the pre-arm INCONCLUSIVE class through instead of relabelling it red', async () => {
    const ctx = runWith({
      autoMergeEnabled: false,
      autoMergeReason: 'advisory-gate-red',
      advisoryGate: {
        blockClass: 'advisory-gate-inconclusive',
        reason: 'Unfinished advisory job(s): a11y scan → FAILURE.',
      },
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    await runConfirmMergePhase(ctx.args);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-inconclusive');
  });

  it('carries the pre-arm refusal through as advisory-gate-red, not arm-failure', async () => {
    const ctx = runWith({
      autoMergeEnabled: false,
      autoMergeReason: 'advisory-gate-red',
      advisoryGate: {
        reason: 'Red advisory job(s): Bundle-size ratchet → FAILURE.',
      },
      readPrWaitProbeFn: async () => advisoryProbe(),
    });
    await runConfirmMergePhase(ctx.args);
    assert.equal(ctx.emitted[0].blockClass, 'advisory-gate-red');
    assert.match(ctx.emitted[0].reason, /Bundle-size ratchet/);
  });

  // -------------------------------------------------------------------------
  // Story #5279 — the friction comment for an advisory block.
  //
  // Both advisory classes used to fall through to the generic remedy, whose
  // opening line sends the operator to "branch protection, required checks,
  // or a manual merge". An advisory gate blocks precisely BECAUSE none of
  // those is broken: GitHub reports the PR mergeable over a NON-required red
  // check, and close refused to let auto-merge land it. Asserted against the
  // block class the run produced, not against the comment's own wording.
  // -------------------------------------------------------------------------

  /** The friction body posted for a run driven to the given probe. */
  async function frictionBodyFor(overrides) {
    const provider = makeFakeProvider();
    const ctx = runWith({ provider, ...overrides });
    await runConfirmMergePhase(ctx.args);
    const posted = provider._comments();
    assert.equal(posted.length, 1, 'exactly one friction comment');
    return {
      body: posted[0].payload.body,
      blockClass: ctx.emitted[0]?.blockClass,
    };
  }

  it('AC-3: the inconclusive friction names --rerun-advisory and says the PR is mergeable regardless', async () => {
    const { body, blockClass } = await frictionBodyFor({
      injectedGh: makeGh({ checkRuns: timedOutCheckRuns }),
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    assert.equal(blockClass, 'advisory-gate-inconclusive');
    assert.match(body, /--rerun-advisory/);
    assert.match(body, /mergeable regardless/i);
    assert.match(body, /advisory/i);
    // The remedy the class exists to avoid recommending first.
    assert.match(body, /failed without finishing/i);
    // …and never the generic branch-protection diagnosis.
    assert.doesNotMatch(
      body,
      /Resolve the underlying condition \(branch protection/,
    );
  });

  it('AC-3: the red-advisory friction also says the PR is mergeable regardless, but implicates the change', async () => {
    const { body, blockClass } = await frictionBodyFor({
      injectedGh: makeGh({
        checkRuns: [
          { name: 'a11y scan', output: { summary: '3 violations found' } },
        ],
      }),
      readPrWaitProbeFn: async () => timedOutProbe(),
    });
    assert.equal(blockClass, 'advisory-gate-red');
    assert.match(body, /mergeable regardless/i);
    assert.match(body, /reported a real violation/i);
    assert.match(body, /advisoryAllowlist/);
    assert.doesNotMatch(
      body,
      /Resolve the underlying condition \(branch protection/,
    );
  });
});
