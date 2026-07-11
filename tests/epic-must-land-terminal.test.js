// tests/epic-must-land-terminal.test.js
/**
 * Unit tests for the epic-path must-land terminal step (Story #4427,
 * Epic #4425 slice 2).
 *
 * Covers, with injected probes so every case is hermetic (no real `gh`
 * shell-outs, no real ledger/filesystem writes):
 *
 *   - An `api-race-other` block triggers exactly ONE re-arm attempt,
 *     implemented as a re-emitted `epic.merge.ready` (never a direct
 *     `gh pr merge` call) — so the existing AutomergeArmer single-emit
 *     invariant (subscribes to `epic.merge.ready` and ONLY that event;
 *     `tests/lib/orchestration/lifecycle/listener-armer.test.js`) holds
 *     unmodified. The re-arm is exercised end-to-end through a REAL
 *     `AutomergeArmer` wired onto the same bus, with a stubbed `gh`
 *     layer, to prove the wiring — not just the classification.
 *   - A `checks-pending-timeout` block with checks still progressing
 *     extends the watch budget once and keeps polling in the same
 *     watch cycle.
 *   - `branch-protection-human-required` (and a doubly-exhausted-retry
 *     case) emits `merge.unlanded` with `scope: "epic"` and the
 *     matching `blockClass`.
 *   - On watcher budget exhaustion, `merge.unlanded` (carrying
 *     `blockClass`) is emitted alongside the EXISTING `epic.blocked`
 *     routing — exactly one blocked path, never a duplicate
 *     `agent::blocked` transition (i.e. `epic.blocked` still emits
 *     exactly once).
 *   - Attended mode (`headless` unset / `false`) is byte-for-byte
 *     unchanged: no classification, no retry, no `merge.unlanded`,
 *     immediate `epic.blocked`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AutomergeArmer } from '../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js';
import {
  MergeWatcher,
  parsePrNumberFromUrl,
} from '../.agents/scripts/lib/orchestration/lifecycle/listeners/merge-watcher.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/** A `gh pr view` probe stub whose stdout describes a specific state. */
function probeStdout({
  merged = false,
  mergeStateStatus = 'BLOCKED',
  reviewDecision = null,
  statusCheckRollup = [],
  number = 42,
} = {}) {
  return JSON.stringify({
    mergeCommit: merged ? { oid: 'deadbeef' } : null,
    mergedAt: merged ? '2026-07-11T00:00:00Z' : null,
    number,
    mergeStateStatus,
    reviewDecision,
    statusCheckRollup,
  });
}

/** A fake clock: each `nowMsFn()` call advances by `stepMs`. */
function makeClock(stepMs) {
  let now = 0;
  return () => {
    now += stepMs;
    return now;
  };
}

describe('epic must-land terminal step — api-race-other re-arm (exactly once)', () => {
  it('re-arms once via a re-emitted epic.merge.ready (never a direct gh pr merge call), then confirms', async () => {
    const bus = new Bus();
    const readyEmits = [];
    const armedEmits = [];
    const blockedEmits = [];
    const unlandedEmits = [];
    bus.on('epic.merge.ready', async (ctx) => readyEmits.push(ctx.payload));
    bus.on('epic.merge.armed', async (ctx) => armedEmits.push(ctx.payload));
    bus.on('epic.blocked', async (ctx) => blockedEmits.push(ctx.payload));

    // Real AutomergeArmer wired onto the same bus — proves the re-arm
    // routes through the armer's existing single-subscription contract
    // rather than a new/second gh-pr-merge call site.
    let armCalls = 0;
    const armer = new AutomergeArmer({
      bus,
      // Already armed on GitHub's side (arm succeeded on the initial
      // cycle) — the armer's idempotent probe short-circuits to a
      // single epic.merge.armed re-emit without re-issuing gh pr merge.
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout:
          '{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"bot"}}}',
        stderr: '',
      }),
      ghPrMergeAutoFn: () => {
        armCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
    });
    armer.register();

    // The watch cycle: first poll times out (api-race-other — no
    // reviewDecision/mergeStateStatus human-required signal, checks
    // status unknown), the watcher re-arms, and the SECOND watch cycle
    // (triggered by the armer's re-emitted epic.merge.armed) confirms
    // the merge on its first poll.
    let ghCalls = 0;
    const appended = [];
    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      headless: true,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: ({ record }) => appended.push(record),
      ghPrViewMergeFn: () => {
        ghCalls += 1;
        if (ghCalls === 1) {
          // First (and only) poll of the first watch cycle: not
          // merged, no human-required signal, empty checks rollup —
          // classifies to api-race-other.
          return {
            status: 0,
            stdout: probeStdout({
              merged: false,
              mergeStateStatus: 'CLEAN',
              reviewDecision: null,
              statusCheckRollup: [],
            }),
            stderr: '',
          };
        }
        // Second watch cycle (post re-arm): merged.
        return {
          status: 0,
          stdout: probeStdout({ merged: true, number: 4242 }),
          stderr: '',
        };
      },
      sleepFn: async () => {},
      nowMsFn: makeClock(2000), // each call advances 2s; budget is 1s
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 1,
      payload: { prUrl: 'https://github.com/o/r/pull/4242' },
    });

    // Exactly one re-arm: one epic.merge.ready re-emit, and the armer's
    // idempotent probe means gh pr merge --auto is NOT re-issued.
    assert.equal(readyEmits.length, 1, 'exactly one must-land re-arm');
    assert.equal(
      armCalls,
      0,
      'gh pr merge --auto not re-issued (already armed)',
    );
    // The re-arm's epic.merge.armed re-emit (seqId 2) re-triggers the
    // SAME watcher instance for a fresh watch cycle that confirms.
    assert.equal(
      armedEmits.length,
      1,
      'armer re-emitted epic.merge.armed once',
    );
    assert.equal(
      blockedEmits.length,
      0,
      'no epic.blocked — the retry succeeded',
    );
    assert.equal(
      unlandedEmits.length,
      0,
      'no merge.unlanded — the retry succeeded',
    );

    const reArmedClassification = watcher.classifications.find(
      (c) => c.outcome === 're-armed',
    );
    assert.ok(reArmedClassification, 're-armed classification recorded');
    assert.equal(reArmedClassification.reason.length > 0, true);

    const confirmed = watcher.classifications.find(
      (c) => c.outcome === 'confirmed',
    );
    assert.ok(confirmed, 'second watch cycle confirmed the merge');
  });

  it('does not re-arm a second time if the retried cycle also times out', async () => {
    const bus = new Bus();
    const readyEmits = [];
    const blockedEmits = [];
    const unlandedEmits = [];
    bus.on('epic.merge.ready', async (ctx) => readyEmits.push(ctx.payload));
    bus.on('epic.blocked', async (ctx) => blockedEmits.push(ctx.payload));

    const armer = new AutomergeArmer({
      bus,
      ghPrViewAutoMergeFn: () => ({
        status: 0,
        stdout:
          '{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"bot"}}}',
        stderr: '',
      }),
      ghPrMergeAutoFn: () => ({ status: 0, stdout: '', stderr: '' }),
      logger: quietLogger(),
    });
    armer.register();

    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      headless: true,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      // Every poll (both watch cycles) times out with the same
      // ambiguous api-race-other signal.
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout: probeStdout({
          merged: false,
          mergeStateStatus: 'CLEAN',
          reviewDecision: null,
          statusCheckRollup: [],
        }),
        stderr: '',
      }),
      sleepFn: async () => {},
      nowMsFn: makeClock(2000),
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 10,
      payload: { prUrl: 'https://github.com/o/r/pull/9' },
    });

    assert.equal(
      readyEmits.length,
      1,
      'only ONE re-arm across both watch cycles',
    );
    assert.equal(
      blockedEmits.length,
      1,
      'exactly one epic.blocked — the terminal path',
    );
    assert.equal(
      unlandedEmits.length,
      1,
      'merge.unlanded emitted once on the exhausted retry',
    );
    assert.equal(unlandedEmits[0].scope, 'epic');
    assert.equal(unlandedEmits[0].blockClass, 'api-race-other');
  });

  it('falls through to merge.unlanded + epic.blocked when the re-arm epic.merge.ready emit itself throws', async () => {
    // Regression test for an audit-quality Critical finding (Epic #4425
    // Phase 4): a failed re-arm emit used to be swallowed and the
    // watcher returned silently — neither epic.blocked nor
    // merge.unlanded fired, stranding the run with no diagnosis.
    const bus = new Bus();
    const blockedEmits = [];
    const unlandedEmits = [];
    bus.on('epic.blocked', async (ctx) => blockedEmits.push(ctx.payload));
    // No epic.merge.ready listener registered — any emit throws
    // "no handler" inside Bus, simulating a re-arm emit failure.
    bus.on('epic.merge.ready', async () => {
      throw new Error('simulated re-arm emit failure');
    });

    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      headless: true,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout: probeStdout({
          merged: false,
          mergeStateStatus: 'CLEAN',
          reviewDecision: null,
          statusCheckRollup: [],
        }),
        stderr: '',
      }),
      sleepFn: async () => {},
      nowMsFn: makeClock(2000),
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 20,
      payload: { prUrl: 'https://github.com/o/r/pull/99' },
    });

    assert.equal(
      unlandedEmits.length,
      1,
      'merge.unlanded still emitted despite the re-arm emit throwing',
    );
    assert.equal(unlandedEmits[0].scope, 'epic');
    assert.equal(unlandedEmits[0].blockClass, 'api-race-other');
    assert.equal(
      blockedEmits.length,
      1,
      'epic.blocked still emitted despite the re-arm emit throwing',
    );
  });
});

describe('epic must-land terminal step — checks-pending-timeout budget extension (exactly once)', () => {
  it('extends the watch budget once when checks are still progressing, then confirms', async () => {
    const bus = new Bus();
    const blockedEmits = [];
    const unlandedEmits = [];
    bus.on('epic.blocked', async (ctx) => blockedEmits.push(ctx.payload));

    let ghCalls = 0;
    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      headless: true,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      ghPrViewMergeFn: () => {
        ghCalls += 1;
        if (ghCalls === 1) {
          // First poll: not merged, required checks still in progress
          // (statusCheckRollup has a non-COMPLETED entry) — trips the
          // budget check and classifies checks-pending-timeout.
          return {
            status: 0,
            stdout: probeStdout({
              merged: false,
              mergeStateStatus: 'BEHIND',
              reviewDecision: null,
              statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }],
            }),
            stderr: '',
          };
        }
        // Second poll (post budget-extension, same watch cycle):
        // merged — the `merged` branch short-circuits before the next
        // budget check, so the single extension is never re-consulted.
        return {
          status: 0,
          stdout: probeStdout({ merged: true, number: 55 }),
          stderr: '',
        };
      },
      sleepFn: async () => {},
      // Advance just past the 1s budget on each check, so the FIRST
      // poll (attempt 1) already trips the budget check before a
      // second poll happens.
      nowMsFn: makeClock(2000),
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 20,
      payload: { prUrl: 'https://github.com/o/r/pull/55' },
    });

    const extended = watcher.classifications.find(
      (c) => c.outcome === 'extended',
    );
    assert.ok(extended, 'budget-extension classification recorded');
    assert.equal(
      watcher.classifications.filter((c) => c.outcome === 'extended').length,
      1,
      'budget extended exactly once',
    );
    assert.equal(
      blockedEmits.length,
      0,
      'no epic.blocked — the extension bought enough time',
    );
    assert.equal(
      unlandedEmits.length,
      0,
      'no merge.unlanded — the extension succeeded',
    );
    const confirmed = watcher.classifications.find(
      (c) => c.outcome === 'confirmed',
    );
    assert.ok(confirmed, 'the extended cycle eventually confirmed the merge');
  });
});

describe('epic must-land terminal step — branch-protection-human-required / exhausted retries → merge.unlanded', () => {
  it('emits merge.unlanded with scope "epic" and blockClass branch-protection-human-required, then the existing epic.blocked routing', async () => {
    const bus = new Bus();
    const blockedEmits = [];
    const unlandedEmits = [];
    bus.on('epic.blocked', async (ctx) => blockedEmits.push(ctx.payload));

    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      headless: true,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      // Every poll reports a human-required review — an unambiguous
      // branch-protection-human-required classification that must NOT
      // be retried at all.
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout: probeStdout({
          merged: false,
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: [],
          number: 77,
        }),
        stderr: '',
      }),
      sleepFn: async () => {},
      nowMsFn: makeClock(2000),
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 30,
      payload: { prUrl: 'https://github.com/o/r/pull/77' },
    });

    assert.equal(unlandedEmits.length, 1, 'exactly one merge.unlanded emit');
    assert.equal(unlandedEmits[0].scope, 'epic');
    assert.equal(unlandedEmits[0].ticketId, 4425);
    assert.equal(unlandedEmits[0].prNumber, 77);
    assert.equal(
      unlandedEmits[0].blockClass,
      'branch-protection-human-required',
    );
    assert.equal(typeof unlandedEmits[0].reason, 'string');
    assert.equal(
      blockedEmits.length,
      1,
      'one blocked path — no duplicate agent::blocked',
    );
    assert.equal(blockedEmits[0].reason, 'merge-watch:budget-exceeded');
  });

  it('falls back to parsing the PR number from the URL when the probe JSON carried no number field', async () => {
    const bus = new Bus();
    const unlandedEmits = [];
    bus.on('epic.blocked', async () => {});

    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      headless: true,
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      // A successful (status 0) probe whose JSON omits `number`
      // entirely, but is otherwise an unambiguous
      // branch-protection-human-required signal (REVIEW_REQUIRED) so
      // the terminal path fires on the very first budget check with
      // no retry cascade involved.
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout: JSON.stringify({
          mergeCommit: null,
          mergedAt: null,
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: [],
        }),
        stderr: '',
      }),
      sleepFn: async () => {},
      nowMsFn: makeClock(2000),
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 40,
      payload: { prUrl: 'https://github.com/o/r/pull/999' },
    });

    assert.equal(unlandedEmits.length, 1);
    assert.equal(
      unlandedEmits[0].blockClass,
      'branch-protection-human-required',
    );
    assert.equal(
      unlandedEmits[0].prNumber,
      999,
      'prNumber recovered from the PR URL',
    );
    assert.equal(parsePrNumberFromUrl('https://github.com/o/r/pull/999'), 999);
    assert.equal(parsePrNumberFromUrl('not-a-url'), null);
  });
});

describe('epic must-land terminal step — attended mode is unchanged', () => {
  it('headless=false (default): budget exhaustion emits epic.blocked immediately with no classification, retry, or merge.unlanded', async () => {
    const bus = new Bus();
    const readyEmits = [];
    const blockedEmits = [];
    const unlandedEmits = [];
    bus.on('epic.merge.ready', async (ctx) => readyEmits.push(ctx.payload));
    bus.on('epic.blocked', async (ctx) => blockedEmits.push(ctx.payload));

    const watcher = new MergeWatcher({
      bus,
      epicId: 4425,
      tempRoot: '/t',
      intervalSeconds: 1,
      maxBudgetSeconds: 1,
      // headless intentionally omitted — defaults to false.
      readPriorAttemptsFn: () => 0,
      appendAttemptFn: () => {},
      ghPrViewMergeFn: () => ({
        status: 0,
        stdout: probeStdout({
          merged: false,
          mergeStateStatus: 'CLEAN',
          reviewDecision: null,
          statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }],
        }),
        stderr: '',
      }),
      sleepFn: async () => {},
      nowMsFn: makeClock(2000),
      nowIsoFn: () => '2026-07-11T00:00:00Z',
      emitMergeUnlandedFn: (opts) => unlandedEmits.push(opts),
      logger: quietLogger(),
    });
    watcher.register();

    await watcher.handle({
      event: 'epic.merge.armed',
      seqId: 50,
      payload: { prUrl: 'https://github.com/o/r/pull/1' },
    });

    assert.equal(watcher.headless, false, 'headless defaults to false');
    assert.equal(readyEmits.length, 0, 'no must-land re-arm in attended mode');
    assert.equal(unlandedEmits.length, 0, 'no merge.unlanded in attended mode');
    assert.equal(blockedEmits.length, 1, 'exactly one epic.blocked, as before');
    assert.equal(blockedEmits[0].reason, 'merge-watch:budget-exceeded');
    const last = watcher.classifications.at(-1);
    assert.equal(last.outcome, 'failed');
    assert.equal(last.reason, 'budget-exceeded');
    assert.equal(
      'blockClass' in last,
      false,
      'no blockClass tagged in attended mode',
    );
  });
});
