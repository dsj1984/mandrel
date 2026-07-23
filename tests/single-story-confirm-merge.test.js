/**
 * tests/single-story-confirm-merge.test.js — coverage for the post-merge
 * confirmation path of the standalone close (Story #3385).
 *
 * `single-story-close.js` now rests a standalone Story at `agent::closing`
 * with its GitHub issue OPEN while the PR is open with auto-merge armed.
 * The `agent::done` flip (which closes the issue) is deferred to
 * `confirmStoryMerged` / `single-story-confirm-merge.js`, driven by the
 * CI-watch loop once the PR merge is confirmed.
 *
 * This file exercises the state-machine contract directly against the
 * pure `confirmStoryMerged` helper (no subprocess, no real `gh`):
 *
 *   - PR merged  → `executing|closing → done`, issue closes, story-merged
 *     notify fires once.
 *   - PR open    → stays `agent::closing`, issue stays OPEN, no done flip.
 *   - PR closed-without-merge → stays `agent::closing`, issue stays OPEN.
 *   - already-done / already-closed → idempotent noop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveMergeWaitConfig } from '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js';
import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';
import { runConfirmMerge } from '../.agents/scripts/single-story-confirm-merge.js';

/**
 * Fake ticketing provider. Records every `updateTicket` patch and applies
 * it to the in-memory story so subsequent reads reflect the flip.
 */
function makeFakeProvider({
  initialStory = {
    id: 3385,
    state: 'open',
    title: 'Confirm merge story',
    labels: ['agent::closing'],
  },
  updateThrows = false,
} = {}) {
  let story = { ...initialStory };
  const updates = [];
  return {
    getTicket: async () => ({ ...story }),
    updateTicket: async (id, patch) => {
      updates.push({ id, patch });
      if (updateThrows) throw new Error('provider failure');
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
    _story: () => story,
    _updates: () => updates,
  };
}

/** A `readPrMergeStateFn` stub that returns a fixed PR state. */
function fakeMergeState(state, mergedAt = null) {
  return async () => ({ state, mergedAt });
}

describe('confirmStoryMerged', () => {
  it('flips agent::closing → agent::done and closes the issue when the PR is MERGED', async () => {
    const provider = makeFakeProvider();
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      cwd: '/repo',
      injectedNotify: async (ticketId, payload) =>
        notifyCalls.push({ ticketId, payload }),
      readPrMergeStateFn: fakeMergeState('MERGED', '2026-05-31T00:00:00Z'),
    });

    assert.equal(result.action, 'done');
    assert.equal(result.merged, true);

    // The flip routes through transitionTicketState — the patch closes the
    // issue (`state: 'closed'`, `state_reason: 'completed'`) on the
    // agent::done transition.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::done']);
    assert.ok(patch.labels.remove.includes('agent::closing'));
    assert.equal(patch.state, 'closed');
    assert.equal(patch.state_reason, 'completed');

    // story-merged notify fires exactly once.
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].payload.event, 'story-merged');
    assert.equal(notifyCalls[0].payload.level, 'story');
    assert.match(notifyCalls[0].payload.message, /agent::done/);
  });

  it('treats a non-null mergedAt as merged even when state is not literally MERGED', async () => {
    const provider = makeFakeProvider();
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: fakeMergeState(null, '2026-05-31T00:00:00Z'),
    });
    assert.equal(result.action, 'done');
    assert.equal(result.merged, true);
  });

  it('leaves the Story at agent::closing and issue OPEN when the PR is still open', async () => {
    const provider = makeFakeProvider();
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async (...a) => notifyCalls.push(a),
      readPrMergeStateFn: fakeMergeState('OPEN'),
    });

    assert.equal(result.action, 'pending');
    assert.equal(result.reason, 'pr-open');
    assert.equal(result.merged, false);
    // No flip — issue stays OPEN at agent::closing.
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._story().state, 'open');
    assert.deepEqual(provider._story().labels, ['agent::closing']);
    assert.equal(notifyCalls.length, 0);
  });

  it('leaves the Story at agent::closing when the PR was closed without merging', async () => {
    const provider = makeFakeProvider();
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: fakeMergeState('CLOSED'),
    });

    assert.equal(result.action, 'pending');
    assert.equal(result.reason, 'pr-not-merged');
    assert.equal(result.merged, false);
    assert.equal(provider._updates().length, 0);
    assert.equal(provider._story().state, 'open');
  });

  it('is idempotent: noop when the Story already carries agent::done', async () => {
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Already done',
        labels: ['agent::done'],
      },
    });
    let prRead = 0;
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: async () => {
        prRead += 1;
        return { state: 'MERGED', mergedAt: 'x' };
      },
    });

    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-done');
    assert.equal(result.merged, true);
    assert.equal(provider._updates().length, 0, 'no re-flip on noop');
    assert.equal(prRead, 0, 'PR state is not even read once already done');
  });

  it('is idempotent: noop when a closed issue also carries agent::done', async () => {
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Already done and closed',
        labels: ['agent::done'],
      },
    });
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {},
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-done');
    assert.equal(provider._updates().length, 0, 'no re-flip on noop');
  });

  it('still flips to agent::done when the Closes-footer already closed the issue but the label is agent::closing (Story #3415)', async () => {
    // Reproduces Story #3413 / PR #3414: GitHub auto-merge closes the issue
    // via the `Closes #<id>` footer *before* confirm-merge runs, so the
    // story arrives here with `state: 'closed'` while the label is still
    // `agent::closing`. A closed issue alone must NOT short-circuit — the
    // `agent::closing → agent::done` flip must still fire.
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Auto-closed by Closes-footer',
        labels: ['agent::closing'],
      },
    });
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      cwd: '/repo',
      injectedNotify: async (ticketId, payload) =>
        notifyCalls.push({ ticketId, payload }),
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });

    // The flip fires (NOT a noop) even though the issue was already closed.
    assert.equal(result.action, 'done');
    assert.equal(result.merged, true);

    // transitionTicketState was invoked and applied the agent::done flip.
    const [{ patch }] = provider._updates();
    assert.deepEqual(patch.labels.add, ['agent::done']);
    assert.ok(patch.labels.remove.includes('agent::closing'));

    // story-merged notify fires exactly once.
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].payload.event, 'story-merged');
  });

  it('reports flip-failed and skips the notify when the done transition throws', async () => {
    const provider = makeFakeProvider({ updateThrows: true });
    const notifyCalls = [];
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async (...a) => notifyCalls.push(a),
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });

    assert.equal(result.action, 'flip-failed');
    assert.equal(result.merged, true);
    assert.equal(
      notifyCalls.length,
      0,
      'notify must not fire on a failed flip',
    );
  });

  it('swallows notify failures and still reports done', async () => {
    const provider = makeFakeProvider();
    const result = await confirmStoryMerged({
      provider,
      storyId: 3385,
      prNumber: 42,
      cwd: '/repo',
      injectedNotify: async () => {
        throw new Error('webhook offline');
      },
      readPrMergeStateFn: fakeMergeState('MERGED', 'x'),
    });
    assert.equal(result.action, 'done');
    assert.equal(provider._story().state, 'closed');
  });

  it('propagates a transient PR-read failure so the CLI can report it (Story #4543)', async () => {
    // The PR read is a live `gh` call. It throws on a transient API error, and
    // this is a landing surface — the one `pending` tells the operator to
    // re-run. The library propagates (a flaked read must not look like a
    // verdict); the CLI boundary turns it into a `failed` envelope so the
    // surface is never silent. Pin the propagation the CLI relies on.
    await assert.rejects(
      () =>
        confirmStoryMerged({
          provider: makeFakeProvider(),
          storyId: 3385,
          prNumber: 42,
          cwd: '/repo',
          readPrMergeStateFn: async () => {
            throw new Error('gh-exec: resource not found');
          },
        }),
      /resource not found/,
    );
  });
});

describe('single-story-confirm-merge --max-wait-seconds (Story #4710 AC-3)', () => {
  // The resume CLI is the exact command async mode's `pending` terminal hands
  // the merge wait to. Without this flag the documented per-run wait override
  // was unreachable on the resume path, so a slow-CI landing depended on an
  // unbounded chain of short invocations.
  it('threads the override to the merge-wait phase, where resolveMergeWaitConfig lets it win', async () => {
    const calls = [];
    await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: true,
      maxWaitSeconds: 45,
      injectedProvider: {
        getTicket: async () => ({
          id: 555,
          state: 'open',
          labels: ['agent::closing'],
        }),
        updateTicket: async () => {},
      },
      injectedConfig: {
        project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
        github: { owner: 'o', repo: 'r' },
      },
      injectedGh: {
        pr: { list: async () => [{ number: 77, url: 'https://e/pull/77' }] },
      },
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async (args) => {
        calls.push(args);
        return {
          confirmed: false,
          terminal: 'pending',
          waitBudget: {
            maxWaitSeconds: 45,
            waitedSeconds: 45,
            cumulativeSeconds: 45,
            maxBudgetSeconds: 3600,
          },
          prProbe: { state: 'OPEN', checksStatus: 'still-running' },
        };
      },
    });

    assert.equal(calls.length, 1, 'the wait phase must run');
    assert.equal(
      calls[0].maxWaitSeconds,
      45,
      'the override must reach the phase (and thence resolveMergeWaitConfig)',
    );
    // The phase resolves the override through resolveMergeWaitConfig exactly
    // as close does — the per-run value beats the config and the async cap.
    const resolved = resolveMergeWaitConfig(
      { delivery: { mergeWatch: { mode: 'async', maxWaitSeconds: 300 } } },
      calls[0].maxWaitSeconds,
    );
    assert.equal(resolved.maxWaitSeconds, 45);
  });
});
