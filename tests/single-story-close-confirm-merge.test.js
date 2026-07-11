/**
 * tests/single-story-close-confirm-merge.test.js — coverage for the
 * headless must-land terminal phase (Story #4428, Epic #4425 slice 3).
 *
 * Exercises `runConfirmMergePhase`
 * (`.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js`)
 * with injected probes:
 *
 *   - merge confirmed within budget → the SAME `confirmStoryMerged` flip
 *     logic (`.agents/scripts/lib/single-story/confirm-merge.js`, not
 *     re-extracted) runs with no operator action.
 *   - an arm failure → `merge.unlanded` (scope: "story", blockClass:
 *     "arm-failure") emitted and the Story routed to `agent::blocked`.
 *   - budget exhaustion while checks are still pending → `merge.unlanded`
 *     emitted and the Story blocked rather than silently resting at
 *     `agent::closing`.
 *   - a PR closed without merging → blocked immediately (not a silent
 *     budget-timeout wait).
 *
 * Also covers `parseCloseOptions`'s `--wait-merge` / `--no-wait-merge`
 * flags (AC3) and asserts the phase's default `confirmStoryMergedFn` is
 * the exact same export `single-story-confirm-merge.js` calls (AC4: one
 * merged/`agent::done` implementation).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runConfirmMergePhase } from '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js';
import { parseCloseOptions } from '../.agents/scripts/lib/orchestration/single-story-close/phases/options.js';
import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';

/**
 * Fake ticketing provider mirroring the minimal surface
 * `tests/single-story-confirm-merge.test.js` already relies on:
 * `getTicket` / `updateTicket` for the label flip, `postComment` for the
 * friction comment. No `getTicketDependencies` / `getSubTickets` means the
 * upward-cascade guard in `transitionTicketState` no-ops (best-effort,
 * matches the established fake-provider contract).
 */
function makeFakeProvider({
  initialStory = {
    id: 4428,
    state: 'open',
    title: 'Headless must-land story',
    labels: ['agent::closing'],
  },
} = {}) {
  let story = { ...initialStory };
  const updates = [];
  const comments = [];
  return {
    getTicket: async () => ({ ...story }),
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
    },
    _story: () => story,
    _updates: () => updates,
    _comments: () => comments,
  };
}

const NOOP_PROGRESS = () => {};

describe('runConfirmMergePhase — merge confirmed (no operator action)', () => {
  it('calls the shared confirmStoryMerged flip logic once and reports confirmed:true', async () => {
    const provider = makeFakeProvider();
    let confirmCalls = 0;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      confirmStoryMergedFn: async (args) => {
        confirmCalls += 1;
        assert.equal(args.storyId, 4428);
        assert.equal(args.prNumber, 99);
        return { storyId: 4428, action: 'done', merged: true };
      },
    });

    assert.deepEqual(outcome, { confirmed: true, action: 'done' });
    assert.equal(confirmCalls, 1, 'confirmStoryMerged runs exactly once');
    // No blocked transition, no friction comment, no merge.unlanded.
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._comments().length, 0);
  });

  it('polls (sleeping between attempts) until the merge confirms, reusing the same confirm call each round', async () => {
    const provider = makeFakeProvider();
    const results = ['pending', 'pending', 'merged'];
    let confirmCalls = 0;
    let sleepCalls = 0;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {
        delivery: {
          mergeWatch: { intervalSeconds: 5, maxBudgetSeconds: 3600 },
        },
      },
      progress: NOOP_PROGRESS,
      sleepFn: async () => {
        sleepCalls += 1;
      },
      nowMsFn: () => 0,
      confirmStoryMergedFn: async () => {
        const next = results[confirmCalls];
        confirmCalls += 1;
        if (next === 'merged') {
          return { action: 'done', merged: true };
        }
        return { action: 'pending', reason: 'pr-open', merged: false };
      },
    });

    assert.deepEqual(outcome, { confirmed: true, action: 'done' });
    assert.equal(confirmCalls, 3);
    assert.equal(sleepCalls, 2, 'slept between the two pending polls');
  });

  it('the default confirmStoryMergedFn IS the exact single-story/confirm-merge.js export (AC4: one implementation)', async () => {
    const provider = makeFakeProvider();
    let sawDefault = false;
    // Prove by observable effect: confirmStoryMerged flips `agent::closing`
    // → `agent::done` via `transitionTicketState` (issue closes). Running
    // the phase WITHOUT injecting `confirmStoryMergedFn` must produce the
    // exact same side effect the direct `confirmStoryMerged` unit tests
    // assert (tests/single-story-confirm-merge.test.js) — proving the
    // phase's default parameter resolves to the same shared export rather
    // than a re-extracted copy.
    assert.equal(typeof confirmStoryMerged, 'function');
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      readPrMergeStateFn: async () => {
        sawDefault = true;
        return { state: 'MERGED', mergedAt: '2026-07-11T00:00:00Z' };
      },
    });

    assert.equal(sawDefault, true);
    assert.equal(outcome.confirmed, true);
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::done']);
    assert.equal(patch.state, 'closed');
  });
});

describe('runConfirmMergePhase — arm failure', () => {
  it('emits merge.unlanded (scope: story, blockClass: arm-failure), posts friction, and blocks', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: false,
      autoMergeReason: 'gh-exit-1: some auth failure',
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      emitMergeUnlandedFn: (payload) => {
        emitted.push(payload);
        return { ledgerPath: '/tmp/fake.ndjson', record: payload };
      },
    });

    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.blockClass, 'arm-failure');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].scope, 'story');
    assert.equal(emitted[0].ticketId, 4428);
    assert.equal(emitted[0].prNumber, 99);
    assert.equal(emitted[0].blockClass, 'arm-failure');

    // Friction comment posted.
    assert.equal(provider._comments().length, 1);
    assert.match(provider._comments()[0].payload.body, /merge did not land/);
    assert.match(provider._comments()[0].payload.body, /arm-failure/);

    // Routed to agent::blocked.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
    assert.equal(provider._story().labels.includes('agent::blocked'), true);
  });

  it('classifies a branch-protection arm rejection distinctly from a generic arm-failure', async () => {
    const provider = makeFakeProvider();
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 100,
      prUrl: 'https://github.com/o/r/pull/100',
      autoMergeEnabled: false,
      autoMergeReason: 'gh-exit-1: Required review is missing approval',
      provider,
      config: {},
      progress: NOOP_PROGRESS,
    });
    assert.equal(outcome.blockClass, 'branch-protection-human-required');
  });
});

describe('runConfirmMergePhase — budget exhaustion', () => {
  it('emits merge.unlanded (checks-pending-timeout) and blocks instead of resting at agent::closing', async () => {
    const provider = makeFakeProvider();
    const emitted = [];
    let now = 0;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {
        delivery: { mergeWatch: { intervalSeconds: 30, maxBudgetSeconds: 60 } },
      },
      progress: NOOP_PROGRESS,
      nowMsFn: () => now,
      sleepFn: async (ms) => {
        now += ms;
      },
      confirmStoryMergedFn: async () => ({
        action: 'pending',
        reason: 'pr-open',
        merged: false,
      }),
      emitMergeUnlandedFn: (payload) => {
        emitted.push(payload);
        return { ledgerPath: '/tmp/fake.ndjson', record: payload };
      },
    });

    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.blockClass, 'checks-pending-timeout');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].blockClass, 'checks-pending-timeout');
    assert.ok(emitted[0].elapsedSeconds >= 0);

    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
  });

  it('blocks immediately (not after the full budget) when the PR closed without merging', async () => {
    const provider = makeFakeProvider();
    let sleepCalls = 0;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {
        delivery: {
          mergeWatch: { intervalSeconds: 30, maxBudgetSeconds: 3600 },
        },
      },
      progress: NOOP_PROGRESS,
      nowMsFn: () => 0,
      sleepFn: async () => {
        sleepCalls += 1;
      },
      confirmStoryMergedFn: async () => ({
        action: 'pending',
        reason: 'pr-not-merged',
        merged: false,
      }),
    });

    assert.equal(outcome.confirmed, false);
    assert.equal(
      sleepCalls,
      0,
      'never slept — closed-without-merge is terminal',
    );
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
  });

  it('does not crash when the PR number is unparseable — skips the merge.unlanded emit but still blocks', async () => {
    const provider = makeFakeProvider();
    let emitCalls = 0;
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: null,
      prUrl: 'https://github.com/o/r/pull/???',
      autoMergeEnabled: false,
      autoMergeReason: 'pr-number-unparseable',
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      emitMergeUnlandedFn: () => {
        emitCalls += 1;
      },
    });

    assert.equal(outcome.confirmed, false);
    assert.equal(emitCalls, 0);
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
  });
});

describe('runConfirmMergePhase — best-effort side effects never mask the block', () => {
  it('still blocks even when the merge.unlanded emit throws', async () => {
    const provider = makeFakeProvider();
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: false,
      autoMergeReason: 'gh-spawn-error: ENOENT',
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      emitMergeUnlandedFn: () => {
        throw new Error('schema drift');
      },
    });
    assert.equal(outcome.confirmed, false);
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
  });

  it('still blocks even when posting the friction comment throws', async () => {
    const provider = makeFakeProvider();
    provider.postComment = async () => {
      throw new Error('API down');
    };
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4428,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      autoMergeEnabled: false,
      autoMergeReason: 'gh-spawn-error: ENOENT',
      provider,
      config: {},
      progress: NOOP_PROGRESS,
    });
    assert.equal(outcome.confirmed, false);
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
  });
});

describe('parseCloseOptions — --wait-merge / --no-wait-merge (AC3)', () => {
  it('defaults waitForMerge to false (attended behaviour preserved)', () => {
    const opts = parseCloseOptions({ storyIdParam: 4428, cwdParam: '/repo' });
    assert.equal(opts.waitForMerge, false);
  });

  it('injecting waitForMergeParam:true opts into headless wait', () => {
    const opts = parseCloseOptions({
      storyIdParam: 4428,
      cwdParam: '/repo',
      waitForMergeParam: true,
    });
    assert.equal(opts.waitForMerge, true);
  });

  it('the explicit opt-out (noWaitForMergeParam:true) always wins, even with waitForMergeParam:true', () => {
    const opts = parseCloseOptions({
      storyIdParam: 4428,
      cwdParam: '/repo',
      waitForMergeParam: true,
      noWaitForMergeParam: true,
    });
    assert.equal(
      opts.waitForMerge,
      false,
      'explicit opt-out preserves the pre-change exit shape even in headless mode',
    );
  });
});
