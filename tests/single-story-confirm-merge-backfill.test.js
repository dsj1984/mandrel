/**
 * tests/single-story-confirm-merge-backfill.test.js
 *
 * The belated-manual-confirm backfill (Story #4543).
 *
 * `phases/post-land.js` and `story-follow-ups.js` both document the gap this
 * pins: a Story whose `agent::done` label was already set (auto-merge's
 * `Closes #<id>` footer, or an interrupted run) makes `confirmStoryMerged`
 * return `action: 'noop', merged: true`. Gating the land tail on
 * `action === 'done'` therefore skipped it for exactly the case the tail is
 * supposed to rescue — follow-ups uncaptured, base never fast-forwarded, and
 * no way to backfill by re-running confirm.
 *
 * The gate is `merged`, not `action`. Re-running is safe because every tail
 * step is idempotent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const POST_LAND_URL = new URL(
  '../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js',
  import.meta.url,
).href;

const SUT_URL = new URL(
  '../.agents/scripts/single-story-confirm-merge.js',
  import.meta.url,
).href;

const TAIL = Object.freeze({
  followUps: true,
  statusResync: true,
  refCleanup: true,
  baseFastForward: true,
  details: {},
});

function fakeConfig() {
  return {
    project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
    github: { owner: 'o', repo: 'r' },
  };
}

function makeProvider(story) {
  const updates = [];
  return {
    getTicket: async () => ({ ...story }),
    updateTicket: async (id, patch) => updates.push({ id, patch }),
    _updates: () => updates,
  };
}

/** `gh pr list` for the story branch → one merged PR. */
function makeGh() {
  return {
    pr: {
      list: async () => [{ number: 77, url: 'https://example/pull/77' }],
      view: async () => ({ state: 'MERGED', mergedAt: '2026-07-16T00:00:00Z' }),
    },
  };
}

describe('single-story-confirm-merge — land-tail backfill', () => {
  it('runs the land tail for an already-agent::done Story (the backfill case)', async (t) => {
    const calls = [];
    t.mock.module(POST_LAND_URL, {
      namedExports: {
        runPostLandTail: async (args) => {
          calls.push(args.storyId);
          return { ...TAIL };
        },
      },
    });

    const { runConfirmMerge } = await import(`${SUT_URL}?t=backfill`);
    const { terminal } = await runConfirmMerge({
      storyId: 4321,
      cwd: '/repo',
      pr: 77,
      injectedProvider: makeProvider({
        id: 4321,
        state: 'closed',
        title: 'Landed already',
        labels: ['agent::done'],
      }),
      injectedConfig: fakeConfig(),
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      injectedReadPrMergeState: async () => ({
        state: 'MERGED',
        mergedAt: '2026-07-16T00:00:00Z',
      }),
    });

    assert.deepEqual(
      calls,
      [4321],
      'the tail must run even though this invocation did not flip the label',
    );
    assert.equal(terminal.status, 'landed');
    assert.equal(terminal.tail.followUps, true);
    assert.equal(terminal.tail.baseFastForward, true);
  });

  it('does not run the land tail when the PR has not merged', async (t) => {
    const calls = [];
    t.mock.module(POST_LAND_URL, {
      namedExports: {
        runPostLandTail: async (args) => {
          calls.push(args.storyId);
          return { ...TAIL };
        },
      },
    });

    const { runConfirmMerge } = await import(`${SUT_URL}?t=unmerged`);
    const { terminal } = await runConfirmMerge({
      storyId: 4322,
      cwd: '/repo',
      pr: 77,
      injectedProvider: makeProvider({
        id: 4322,
        state: 'open',
        title: 'Still open',
        labels: ['agent::closing'],
      }),
      injectedConfig: fakeConfig(),
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      injectedReadPrMergeState: async () => ({ state: 'OPEN', mergedAt: null }),
    });

    assert.deepEqual(calls, [], 'no merge, no tail');
    assert.equal(terminal.tail, null);
    assert.notEqual(terminal.status, 'landed');
  });
});
