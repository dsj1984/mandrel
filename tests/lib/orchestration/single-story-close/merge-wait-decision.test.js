/**
 * The merge wait's pure decision (Story #5446): given the explicit state, one
 * probe and the clock, the next state and a verdict. Every case here runs
 * with no timer, no `gh` and no injected effect — the decision takes plain
 * values and returns plain values.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMergeWaitState,
  decideMergeWaitPoll,
} from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js';

const LIMITS = Object.freeze({
  intervalSeconds: 30,
  maxWaitSeconds: 300,
  maxBudgetSeconds: 3600,
});

const START_MS = 1_000_000;

function openProbe(overrides = {}) {
  return {
    state: 'OPEN',
    mergedAt: null,
    createdAt: null,
    checksStatus: 'pending',
    ...overrides,
  };
}

/** A red, merge-gated probe without per-run evidence. */
function failingProbe(overrides = {}) {
  return openProbe({
    checksStatus: 'failure',
    mergeStateStatus: 'BLOCKED',
    ...overrides,
  });
}

function decide({ state, probe, nowMs = START_MS, cumulativeNowMs, limits }) {
  return decideMergeWaitPoll({
    state:
      state ??
      createMergeWaitState({ startedAtMs: START_MS, intervalSeconds: 30 }),
    probe,
    nowMs,
    cumulativeNowMs,
    limits: limits ?? LIMITS,
  });
}

describe('createMergeWaitState', () => {
  it('starts with no polls, no updates, no failing snapshots and the configured interval', () => {
    assert.deepEqual(
      createMergeWaitState({ startedAtMs: START_MS, intervalSeconds: 30 }),
      {
        startedAtMs: START_MS,
        polls: 0,
        intervalMs: 30_000,
        updatesUsed: 0,
        consecutiveRequiredFailSnapshots: 0,
      },
    );
  });
});

describe('decideMergeWaitPoll — verdicts', () => {
  it('merged: a MERGED probe (or a set mergedAt) is definitive', () => {
    assert.equal(
      decide({ probe: openProbe({ state: 'MERGED' }) }).verdict,
      'merged',
    );
    assert.equal(
      decide({ probe: openProbe({ mergedAt: '2026-09-25T00:00:00Z' }) })
        .verdict,
      'merged',
    );
  });

  it('closed: a PR closed without merging is definitive', () => {
    assert.equal(
      decide({ probe: openProbe({ state: 'CLOSED' }) }).verdict,
      'closed',
    );
  });

  it('checks-failed: per-run evidence of a red required check fails fast on the first probe', () => {
    const decision = decide({
      probe: failingProbe({
        requiredRunEvidence: {
          requiredRunFailed: true,
          requiredRunInFlight: false,
        },
      }),
    });
    assert.equal(decision.verdict, 'checks-failed');
    assert.equal(decision.failFast.evidencePath, 'per-run');
    assert.equal(decision.failFast.blockClass, 'checks-failed');
  });

  it('checks-failed: without evidence it needs two consecutive failing probes', () => {
    const first = decide({ probe: failingProbe() });
    assert.equal(first.verdict, 'continue');
    assert.equal(first.state.consecutiveRequiredFailSnapshots, 1);

    const second = decide({ state: first.state, probe: failingProbe() });
    assert.equal(second.verdict, 'checks-failed');
    assert.equal(second.failFast.evidencePath, 'consecutive-probe');
  });

  it('continue: a green-pending probe inside both bounds keeps polling', () => {
    const decision = decide({ probe: openProbe(), nowMs: START_MS + 10_000 });
    assert.equal(decision.verdict, 'continue');
    assert.equal(decision.failFast, undefined);
  });

  it('wait-bound: the next sleep would overrun this invocation', () => {
    // 280s waited + a 30s interval > the 300s invocation bound.
    const decision = decide({ probe: openProbe(), nowMs: START_MS + 280_000 });
    assert.equal(decision.verdict, 'wait-bound');
    assert.deepEqual(decision.waitBudget, {
      maxWaitSeconds: 300,
      waitedSeconds: 280,
      cumulativeSeconds: 280,
      maxBudgetSeconds: 3600,
    });
  });

  it('budget-exhausted: the cumulative budget, anchored at createdAt, wins over the invocation bound', () => {
    const createdAt = new Date(START_MS - 3_600_000).toISOString();
    const state = {
      ...createMergeWaitState({ startedAtMs: START_MS, intervalSeconds: 30 }),
      polls: 1,
    };
    const decision = decide({
      state,
      probe: openProbe({ createdAt }),
      nowMs: START_MS + 280_000,
    });
    assert.equal(decision.verdict, 'budget-exhausted');
    assert.equal(decision.cumulativeMs, 3_880_000);
  });

  it('budget-exhausted is held back until the poll floor: a long-open PR is never blocked on its first probe', () => {
    const createdAt = new Date(START_MS - 7_200_000).toISOString();
    const first = decide({ probe: openProbe({ createdAt }) });
    assert.equal(first.verdict, 'continue');
    const second = decide({
      state: first.state,
      probe: openProbe({ createdAt }),
    });
    assert.equal(second.verdict, 'budget-exhausted');
  });
});

describe('decideMergeWaitPoll — state and clock', () => {
  it('returns a new state and never mutates the one it was given', () => {
    const state = Object.freeze(
      createMergeWaitState({ startedAtMs: START_MS, intervalSeconds: 30 }),
    );
    const decision = decide({ state, probe: failingProbe() });
    assert.equal(state.polls, 0);
    assert.equal(decision.state.polls, 1);
    assert.notEqual(decision.state, state);
  });

  it('a non-failing probe resets the consecutive failing-snapshot count', () => {
    const state = {
      ...createMergeWaitState({ startedAtMs: START_MS, intervalSeconds: 30 }),
      consecutiveRequiredFailSnapshots: 1,
    };
    assert.equal(
      decide({ state, probe: openProbe() }).state
        .consecutiveRequiredFailSnapshots,
      0,
    );
  });

  it('tightens the next interval once every check is green', () => {
    const decision = decide({ probe: openProbe({ checksStatus: 'success' }) });
    assert.ok(decision.state.intervalMs < 30_000);
    assert.equal(decide({ probe: openProbe() }).state.intervalMs, 30_000);
  });

  it('scores the invocation bound on the first clock read and the budget on the second', () => {
    const decision = decide({
      probe: openProbe(),
      nowMs: START_MS + 1000,
      cumulativeNowMs: START_MS + 5000,
    });
    assert.equal(decision.waitedMs, 1000);
    assert.equal(decision.cumulativeMs, 5000);
    assert.equal(decision.elapsedSeconds, 1);
  });

  it('carries the BEHIND update count through untouched (the loop spends it)', () => {
    const state = {
      ...createMergeWaitState({ startedAtMs: START_MS, intervalSeconds: 30 }),
      updatesUsed: 2,
    };
    assert.equal(decide({ state, probe: openProbe() }).state.updatesUsed, 2);
  });
});

/**
 * Story #5479 — the async posture probes once: a probe that is neither
 * definitive nor green settles `single-probe` (a resumable pending) instead of
 * sleeping through a window that cannot observe a merge whose checks have not
 * started.
 */
describe('decideMergeWaitPoll — async single probe (Story #5479)', () => {
  const ASYNC_LIMITS = Object.freeze({
    ...LIMITS,
    maxWaitSeconds: 60,
    singleProbe: true,
  });

  it('settles single-probe on a first probe whose checks are unstarted or still running', () => {
    for (const checksStatus of ['unknown', 'still-running', 'pending']) {
      const decision = decide({
        probe: openProbe({ checksStatus }),
        limits: ASYNC_LIMITS,
      });
      assert.equal(decision.verdict, 'single-probe', checksStatus);
      assert.deepEqual(decision.waitBudget, {
        maxWaitSeconds: 60,
        waitedSeconds: 0,
        cumulativeSeconds: 0,
        maxBudgetSeconds: 3600,
      });
    }
  });

  it('keeps polling at the green cadence when the first probe reads success', () => {
    const decision = decide({
      probe: openProbe({ checksStatus: 'success' }),
      limits: ASYNC_LIMITS,
    });
    assert.equal(decision.verdict, 'continue');
    assert.equal(decision.state.intervalMs, 10_000);
  });

  it('keeps definitive verdicts definitive', () => {
    assert.equal(
      decide({ probe: openProbe({ state: 'MERGED' }), limits: ASYNC_LIMITS })
        .verdict,
      'merged',
    );
    assert.equal(
      decide({ probe: openProbe({ state: 'CLOSED' }), limits: ASYNC_LIMITS })
        .verdict,
      'closed',
    );
    assert.equal(
      decide({
        probe: failingProbe({
          requiredRunEvidence: {
            requiredRunFailed: true,
            requiredRunInFlight: false,
          },
        }),
        limits: ASYNC_LIMITS,
      }).verdict,
      'checks-failed',
    );
  });

  it('an evidence-free red probe polls on for its confirming probe, then fails fast', () => {
    const first = decide({ probe: failingProbe(), limits: ASYNC_LIMITS });
    assert.equal(first.verdict, 'continue');
    const second = decide({
      state: first.state,
      probe: failingProbe(),
      limits: ASYNC_LIMITS,
    });
    assert.equal(second.verdict, 'checks-failed');
    assert.equal(second.failFast.evidencePath, 'consecutive-probe');
  });

  it('an over-budget resume polls on so the poll floor still reaches the budget block', () => {
    const createdAt = new Date(START_MS - 7_200_000).toISOString();
    const first = decide({
      probe: openProbe({ createdAt }),
      limits: ASYNC_LIMITS,
    });
    assert.equal(first.verdict, 'continue');
    const second = decide({
      state: first.state,
      probe: openProbe({ createdAt }),
      limits: ASYNC_LIMITS,
    });
    assert.equal(second.verdict, 'budget-exhausted');
  });

  it('sync limits never settle on a single probe', () => {
    assert.equal(
      decide({ probe: openProbe({ checksStatus: 'still-running' }) }).verdict,
      'continue',
    );
  });
});
