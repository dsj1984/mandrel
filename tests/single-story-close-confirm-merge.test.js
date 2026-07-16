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
import {
  parseCloseOptions,
  resolveWaitForMerge,
} from '../.agents/scripts/lib/orchestration/single-story-close/phases/options.js';
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

    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.action, 'done');
    assert.equal(confirmCalls, 1, 'confirmStoryMerged runs exactly once');
    // No blocked transition, no friction comment, no merge.unlanded.
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._comments().length, 0);
  });

  it('blocks explicitly instead of reporting confirmed:true when the merge landed but the agent::done flip failed', async () => {
    // Regression test for an audit-quality Critical finding (Epic #4425
    // Phase 4): confirmation.merged is true even when the agent::done
    // label flip itself threw (action: 'flip-failed') — reporting
    // confirmed:true in that case would exit 0 while the Story stayed
    // stuck at agent::closing with no notification and no block.
    //
    // Story #4539 kept that contract and corrected the attribution: the
    // block now reports through `merge.flip-failed`, because the merge DID
    // land and a `merge.unlanded` record was a false report.
    const provider = makeFakeProvider();
    const emitted = [];
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
      confirmStoryMergedFn: async () => ({
        storyId: 4428,
        action: 'flip-failed',
        merged: true,
      }),
      emitMergeFlipFailedFn: (payload) => {
        emitted.push(payload);
        return { ledgerPath: '/tmp/fake.ndjson', record: payload };
      },
    });

    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.blockClass, 'merged-flip-failed');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].scope, 'story');
    assert.equal(emitted[0].ticketId, 4428);

    // Friction comment posted and the Story routed to agent::blocked —
    // never a silent confirmed:true exit.
    assert.equal(provider._comments().length, 1);
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
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

    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.action, 'done');
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
    // Regression assertion (audit-clean-code finding, Epic #4425): must
    // NOT misclassify as checks-pending-timeout — the PR is definitively
    // closed, not still-in-flight.
    assert.notEqual(outcome.blockClass, 'checks-pending-timeout');
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

describe('land tail + flip-failed reporting (Story #4539)', () => {
  it('captures Story follow-ups on the confirmed-merge path — the default path previously captured them never', async () => {
    const provider = makeFakeProvider();
    const captured = [];
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4539,
      prNumber: 77,
      prUrl: 'https://github.com/o/r/pull/77',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      nowMsFn: () => 0,
      sleepFn: async () => {},
      confirmStoryMergedFn: async () => ({
        action: 'done',
        merged: true,
      }),
      captureFollowUpsAfterConfirmFn: async (confirmation, ctx) => {
        captured.push({ action: confirmation.action, storyId: ctx.storyId });
        return { ok: true, filed: 2 };
      },
    });

    assert.equal(outcome.confirmed, true);
    assert.deepEqual(
      captured,
      [{ action: 'done', storyId: 4539 }],
      'the shared capture helper runs on the in-close landing path',
    );
    assert.deepEqual(outcome.followUps, { ok: true, filed: 2 });
  });

  it('a flaked follow-up capture never fails a landed merge', async () => {
    const provider = makeFakeProvider();
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4539,
      prNumber: 77,
      prUrl: 'https://github.com/o/r/pull/77',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      nowMsFn: () => 0,
      sleepFn: async () => {},
      confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
      captureFollowUpsAfterConfirmFn: async () => null,
    });
    assert.equal(outcome.confirmed, true);
  });

  it('reports a merged-but-flip-failed PR as flip-failed, NOT as an unlanded merge', async () => {
    const provider = makeFakeProvider();
    const unlanded = [];
    const flipFailed = [];
    const outcome = await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4539,
      prNumber: 88,
      prUrl: 'https://github.com/o/r/pull/88',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      nowMsFn: () => 0,
      sleepFn: async () => {},
      confirmStoryMergedFn: async () => ({
        action: 'flip-failed',
        merged: true,
        reason: 'labels API 500',
      }),
      emitMergeUnlandedFn: (p) => {
        unlanded.push(p);
        return { ledgerPath: '/tmp/f.ndjson', record: p };
      },
      emitMergeFlipFailedFn: (p) => {
        flipFailed.push(p);
        return { ledgerPath: '/tmp/f.ndjson', record: p };
      },
    });

    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.blockClass, 'merged-flip-failed');
    assert.equal(
      unlanded.length,
      0,
      'the merge landed — emitting merge.unlanded would be a false report',
    );
    assert.equal(flipFailed.length, 1);
    assert.equal(flipFailed[0].ticketId, 4539);
    assert.equal(flipFailed[0].prNumber, 88);
    assert.equal(flipFailed[0].reason, 'labels API 500');

    // Still terminates explicitly — a merged PR resting at agent::closing
    // is the silent strand the must-land contract exists to prevent.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::blocked']);
  });

  it('the flip-failed friction names the merge as landed and the confirm re-run as the remedy', async () => {
    const provider = makeFakeProvider();
    await runConfirmMergePhase({
      cwd: '/repo',
      storyId: 4539,
      prNumber: 88,
      prUrl: 'https://github.com/o/r/pull/88',
      autoMergeEnabled: true,
      autoMergeReason: null,
      provider,
      config: {},
      progress: NOOP_PROGRESS,
      nowMsFn: () => 0,
      sleepFn: async () => {},
      confirmStoryMergedFn: async () => ({
        action: 'flip-failed',
        merged: true,
        reason: 'labels API 500',
      }),
      emitMergeFlipFailedFn: () => ({ ledgerPath: '', record: {} }),
    });

    const friction = provider
      ._comments()
      .filter((c) => c.payload?.type === 'friction');
    assert.equal(friction.length, 1);
    const body = friction[0].payload.body;
    assert.match(body, /merged successfully/i);
    assert.match(body, /single-story-confirm-merge\.js --story 4539/);
    assert.doesNotMatch(
      body,
      /without observing a confirmed merge/i,
      'must not reuse the unlanded wording — the merge landed',
    );
  });
});

describe('parseCloseOptions — raw --wait-merge / --no-wait-merge intent', () => {
  it('carries the operator intent forward unresolved, so the runner can resolve it against config + arm outcome', () => {
    const opts = parseCloseOptions({ storyIdParam: 4428, cwdParam: '/repo' });
    assert.equal(
      opts.waitForMergeExplicit,
      undefined,
      'no flag passed → no explicit intent',
    );
    assert.equal(opts.noWaitForMerge, false);
  });

  it('records an injected waitForMergeParam:true as explicit intent', () => {
    const opts = parseCloseOptions({
      storyIdParam: 4428,
      cwdParam: '/repo',
      waitForMergeParam: true,
    });
    assert.equal(opts.waitForMergeExplicit, true);
  });

  it('records the opt-out flag independently of the explicit intent', () => {
    const opts = parseCloseOptions({
      storyIdParam: 4428,
      cwdParam: '/repo',
      waitForMergeParam: true,
      noWaitForMergeParam: true,
    });
    assert.equal(opts.waitForMergeExplicit, true);
    assert.equal(opts.noWaitForMerge, true);
  });
});

describe('resolveWaitForMerge — config + flag + arm-outcome precedence (Story #4539)', () => {
  it('defaults from delivery.routing.closeAndLand (framework default true)', () => {
    const { waitForMerge, reason } = resolveWaitForMerge({});
    assert.equal(waitForMerge, true);
    assert.equal(reason, 'config-close-and-land');
  });

  it('honours delivery.routing.closeAndLand:false — the operator opt-out that was previously ignored', () => {
    // Regression for the dead knob: resolveWaitForMerge used to call
    // getDeliveryRouting() with NO config, so it always returned the
    // framework default and this setting could never take effect.
    const { waitForMerge, reason } = resolveWaitForMerge({
      config: { delivery: { routing: { closeAndLand: false } } },
    });
    assert.equal(waitForMerge, false);
    assert.equal(reason, 'config-close-and-land');
  });

  it('the explicit opt-out always wins, even over an explicit --wait-merge', () => {
    const { waitForMerge, reason } = resolveWaitForMerge({
      waitForMergeExplicit: true,
      noWaitForMerge: true,
    });
    assert.equal(waitForMerge, false);
    assert.equal(reason, 'opt-out-flag');
  });

  it('an explicit --wait-merge overrides a closeAndLand:false config', () => {
    const { waitForMerge, reason } = resolveWaitForMerge({
      waitForMergeExplicit: true,
      config: { delivery: { routing: { closeAndLand: false } } },
    });
    assert.equal(waitForMerge, true);
    assert.equal(reason, 'explicit-flag');
  });

  for (const armReason of ['disabled-by-flag', 'disabled-by-policy-strict']) {
    it(`does not wait when the operator owns the merge (${armReason}) — the PR was deliberately left un-armed`, () => {
      const { waitForMerge, reason } = resolveWaitForMerge({
        autoMergeReason: armReason,
      });
      assert.equal(
        waitForMerge,
        false,
        'waiting would burn the poll budget and then block a healthy Story',
      );
      assert.equal(reason, 'operator-merge');
    });
  }

  it('operator-merge beats an explicit --wait-merge: you cannot land-in-one-close a PR you refused to arm', () => {
    const { waitForMerge, reason } = resolveWaitForMerge({
      waitForMergeExplicit: true,
      autoMergeReason: 'disabled-by-flag',
    });
    assert.equal(waitForMerge, false);
    assert.equal(reason, 'operator-merge');
  });

  it('a genuine arm FAILURE still waits (and therefore still blocks) — only deliberate disablement rests', () => {
    // The distinction that keeps the must-land contract intact: an arm that
    // failed is a fault to report, not an operator decision to respect.
    const { waitForMerge } = resolveWaitForMerge({
      autoMergeReason: 'pr-number-unparseable',
    });
    assert.equal(waitForMerge, true);
  });
});
