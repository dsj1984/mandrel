/**
 * tests/single-story-confirm-merge-resume.test.js
 *
 * `NEXT_COMMANDS.resumeLand` is what a `pending` terminal tells the caller to
 * run. It used to be a bare `--story <id>` confirm: a SINGLE probe that
 * answered `pending` and exited. So the cumulative `maxBudgetSeconds` give-up
 * — the only thing that emits `merge.unlanded` and flips a wedged Story to
 * `agent::blocked` — was reachable only inside the original close invocation.
 * A PR that wedged after the close returned could be resumed forever, always
 * answering `pending`, never escalating to anyone.
 *
 * `--wait` resumes the real bounded wait (the same phase the in-close path
 * runs, budget anchored at the PR's createdAt). The default stays a fast
 * one-shot flip, because the same CLI is also the idempotent
 * `confirmMerge` remedy and must not stall an operator-merge flow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NEXT_COMMANDS } from '../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { runConfirmMerge } from '../.agents/scripts/single-story-confirm-merge.js';

function fakeConfig() {
  return {
    project: { baseBranch: 'main', paths: { tempRoot: 'temp' } },
    github: { owner: 'o', repo: 'r' },
  };
}

function makeProvider(story) {
  return {
    getTicket: async () => ({ ...story }),
    updateTicket: async () => {},
  };
}

function makeGh() {
  return {
    pr: {
      list: async () => [{ number: 77, url: 'https://example/pull/77' }],
      view: async () => ({ state: 'OPEN', mergedAt: null }),
    },
  };
}

const OPEN_STORY = {
  id: 555,
  state: 'open',
  title: 'Waiting on merge',
  labels: ['agent::closing'],
};

describe('resumeLand command', () => {
  it('passes --wait, without which the resume cannot escalate', () => {
    assert.match(NEXT_COMMANDS.resumeLand(555), /--wait\b/);
    assert.match(NEXT_COMMANDS.resumeLand(555), /--story 555/);
  });
});

describe('single-story-confirm-merge --wait', () => {
  it('delegates to the bounded merge wait instead of probing once', async () => {
    const calls = [];
    await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: true,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: fakeConfig(),
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async (args) => {
        calls.push(args);
        return {
          confirmed: false,
          terminal: 'pending',
          waitBudget: {
            maxWaitSeconds: 300,
            waitedSeconds: 300,
            cumulativeSeconds: 300,
            maxBudgetSeconds: 3600,
          },
          prProbe: { state: 'OPEN', checksStatus: 'still-running' },
        };
      },
    });

    assert.equal(calls.length, 1, 'the wait phase must run');
    assert.equal(calls[0].storyId, 555);
    assert.equal(calls[0].prNumber, 77);
    assert.equal(
      calls[0].autoMergeEnabled,
      true,
      'the close already armed it; the resume is picking that wait back up',
    );
  });

  it('surfaces the wait phase blocking a wedged PR — the escalation that was unreachable', async () => {
    const { terminal, success } = await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: true,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: fakeConfig(),
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async () => ({
        confirmed: false,
        terminal: 'blocked',
        blockClass: 'checks-pending-timeout',
        reason: 'watch budget exhausted after 3600 seconds',
        frictionCommentId: '1',
        elapsedSeconds: 3600,
        prProbe: { state: 'OPEN', checksStatus: 'still-running' },
      }),
    });

    assert.equal(terminal.status, 'blocked');
    assert.equal(terminal.blocked.blockClass, 'checks-pending-timeout');
    assert.equal(success, true, 'blocked is a reported terminal, not a crash');
  });

  it('reports landed with the tail when the resumed wait sees the merge', async () => {
    const { terminal } = await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: true,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: fakeConfig(),
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async () => ({
        confirmed: true,
        terminal: 'landed',
        tail: {
          followUps: true,
          statusResync: true,
          refCleanup: true,
          baseFastForward: true,
          details: {},
        },
        prProbe: { state: 'MERGED', checksStatus: 'success' },
      }),
    });

    assert.equal(terminal.status, 'landed');
    assert.equal(terminal.tail.followUps, true);
  });

  it('without --wait stays a one-shot flip and never enters the wait phase', async () => {
    // The confirmMerge remedy path: the merge already happened, the operator
    // wants the label fixed now, not a five-minute poll.
    let entered = false;
    const { terminal } = await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: false,
      injectedProvider: makeProvider({
        ...OPEN_STORY,
        labels: ['agent::done'],
        state: 'closed',
      }),
      injectedConfig: fakeConfig(),
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      injectedReadPrMergeState: async () => ({
        state: 'MERGED',
        mergedAt: '2026-07-16T00:00:00Z',
      }),
      runConfirmMergePhaseFn: async () => {
        entered = true;
        return {};
      },
    });

    assert.equal(entered, false, 'the default path must not wait');
    assert.equal(terminal.status, 'landed');
  });
});
