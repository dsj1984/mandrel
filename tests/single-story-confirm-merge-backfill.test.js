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
import {
  createGh,
  GhExecError,
  setGraphqlAvailability,
} from '../.agents/scripts/lib/gh-exec.js';

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
  worktreeReap: true,
  refCleanup: true,
  baseFastForward: true,
  tempPurge: true,
  leaseRelease: true,
  epicRollup: true,
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

/**
 * Story #5793 AC-3 — with GraphQL blocked (the proxy 403), confirm resolves
 * the Story's PR by head branch over REST and lands it: no `--pr`, no
 * `No PR found`, and no `gh pr` subcommand spawned.
 */
describe('single-story-confirm-merge — GraphQL blocked (Story #5793)', () => {
  it('resolves the PR by head branch over REST and flips agent::done', async (t) => {
    t.after(() => setGraphqlAvailability(null));
    t.mock.module(POST_LAND_URL, {
      namedExports: { runPostLandTail: async () => ({ ...TAIL }) },
    });
    const merged = {
      number: 77,
      html_url: 'https://github.com/o/r/pull/77',
      state: 'closed',
      merged: true,
      merged_at: '2026-10-20T00:00:00Z',
    };
    const argvs = [];
    const exec = async ({ args }) => {
      argvs.push(args);
      const endpoint = args[3];
      if (endpoint === 'graphql') {
        throw new GhExecError('gh-exec: gh exited with code 1', {
          args,
          stderr:
            'gh: GitHub GraphQL is not available from Claude Code sessions (HTTP 403)',
          code: 1,
        });
      }
      if (
        endpoint ===
        'repos/{owner}/{repo}/pulls?head={owner}:story-5793&state=all'
      ) {
        return { stdout: JSON.stringify([merged]) };
      }
      if (endpoint === 'repos/{owner}/{repo}/pulls/77') {
        return { stdout: JSON.stringify(merged) };
      }
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    };
    const provider = makeProvider({
      id: 5793,
      state: 'open',
      title: 'confirm over REST',
      labels: ['agent::closing'],
    });
    const { runConfirmMerge } = await import(`${SUT_URL}?t=rest-confirm`);
    const { terminal } = await runConfirmMerge({
      storyId: 5793,
      cwd: '/repo',
      injectedProvider: provider,
      injectedConfig: fakeConfig(),
      injectedGh: createGh(exec, {}, { lazyProbe: true }),
      injectedNotify: async () => {},
    });

    assert.equal(terminal.status, 'landed');
    assert.equal(terminal.pr.number, 77);
    assert.ok(
      provider
        ._updates()
        .some((u) => u.patch?.labels?.add?.includes('agent::done')),
      'the Story flips to agent::done',
    );
    assert.deepEqual(
      argvs.filter((a) => a[0] !== 'api'),
      [],
      'no gh pr subcommand is spawned',
    );
  });
});
