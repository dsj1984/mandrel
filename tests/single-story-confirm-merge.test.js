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

import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';

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

  it('is idempotent: noop when the issue is already closed (GitHub Closes # auto-close raced us)', async () => {
    const provider = makeFakeProvider({
      initialStory: {
        id: 3385,
        state: 'closed',
        title: 'Auto-closed',
        labels: ['agent::closing'],
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
});
