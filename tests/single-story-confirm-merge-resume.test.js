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
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { forEachLine } from '../.agents/scripts/lib/observability/signals-writer.js';
import { NEXT_COMMANDS } from '../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
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
          worktreeReap: true,
          refCleanup: true,
          baseFastForward: true,
          tempPurge: true,
          leaseRelease: true,
          epicRollup: true,
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

/**
 * `emitTerminalFriction` used to hard-code `emitter.tool: 'single-story-close'`,
 * so every record this CLI emitted named a CLI that never ran. The roll-up
 * (`retro-proposals.js`) reads that field to name the surface a candidate came
 * from, so the misattribution misdirected the follow-up.
 *
 * Asserted through the real CLI entry point rather than the emitter's own
 * signature: what regressed is the CALLER forgetting to name itself, which a
 * unit test on the emitter cannot see.
 */
describe('confirm-merge friction attribution', () => {
  /** Absolute per-test tempRoot — never the shared main-checkout temp. */
  let tempRoot;
  let config;

  beforeEach(async () => {
    tempRoot = await makeTempDir('confirm-merge-friction-');
    config = {
      ...fakeConfig(),
      project: { baseBranch: 'main', paths: { tempRoot } },
    };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('records its OWN tool name, not the close CLI that never ran', async () => {
    // A resumed wait that spends the whole cumulative budget with the PR
    // still in flight — the one terminal this CLI emits friction for.
    await runConfirmMerge({
      storyId: 555,
      cwd: '/repo',
      pr: 77,
      wait: true,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: config,
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: async () => ({
        confirmed: false,
        terminal: 'pending',
        waitBudget: {
          maxWaitSeconds: 300,
          waitedSeconds: 300,
          cumulativeSeconds: 3600,
          maxBudgetSeconds: 3600,
        },
        prProbe: { state: 'OPEN', checksStatus: 'still-running' },
      }),
    });

    const rows = [];
    await forEachLine(null, 555, (parsed) => rows.push(parsed), config);
    assert.equal(rows.length, 1, 'the exhausted budget must be recorded');
    assert.equal(rows[0].category, 'merge-wait-exhausted');
    assert.equal(rows[0].emitter.tool, 'single-story-confirm-merge');
  });
});

/**
 * Story #5533 — the `--wait` resume enters the same wait close does, so it
 * gets the same recovery: the Story worktree (recreated when missing) for a
 * DIRTY sync, and the re-arm of a PR a new head disarmed.
 */
describe('single-story-confirm-merge --wait — the shared wait recovery (Story #5533)', () => {
  let tempRoot;
  beforeEach(async () => {
    tempRoot = await makeTempDir('confirm-merge-rearm-');
  });
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('AC-3: resolves the Story worktree the way close does and hands it to the wait', async () => {
    const resolved = [];
    const calls = [];
    await runConfirmMerge({
      storyId: 555,
      cwd: tempRoot,
      pr: 77,
      wait: true,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: {
        ...fakeConfig(),
        project: { baseBranch: 'main', paths: { tempRoot } },
      },
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      resolveWorktreeFn: async (args) => {
        resolved.push(args);
        return '/repo/.worktrees/story-555';
      },
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
    assert.equal(
      resolved.length,
      0,
      'nothing resolves before a DIRTY sync needs it',
    );
    assert.equal(
      await calls[0].resolveWorktree(),
      '/repo/.worktrees/story-555',
    );
    assert.equal(resolved[0].storyId, 555);
    assert.equal(resolved[0].storyBranch, 'story-555');
  });

  it('confirms an already-merged PR whose worktree, local ref and remote branch are all gone', async () => {
    // The normal state after `--delete-branch` plus a sweep: the default
    // resolver would throw, so it must never run before the PR is read.
    const { runConfirmMergePhase } = await import(
      '../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js'
    );
    const tail = {
      followUps: true,
      statusResync: true,
      worktreeReap: true,
      refCleanup: true,
      baseFastForward: true,
      tempPurge: true,
      leaseRelease: true,
      epicRollup: true,
      details: {},
    };
    let lazy = null;
    const { terminal } = await runConfirmMerge({
      storyId: 555,
      cwd: tempRoot,
      pr: 77,
      wait: true,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: {
        ...fakeConfig(),
        project: { baseBranch: 'main', paths: { tempRoot } },
        delivery: { worktreeIsolation: { enabled: true } },
      },
      injectedGh: makeGh(),
      injectedNotify: async () => {},
      runConfirmMergePhaseFn: (args) => {
        lazy = args.resolveWorktree;
        return runConfirmMergePhase({
          ...args,
          readPrWaitProbeFn: async () => ({ state: 'MERGED', mergedAt: 'x' }),
          confirmStoryMergedFn: async () => ({ action: 'done', merged: true }),
          runPostLandTailFn: async () => tail,
        });
      },
    });
    assert.equal(terminal.status, 'landed');
    assert.equal(terminal.tail.leaseRelease, true);
    await assert.rejects(
      () => lazy(),
      /cannot recreate the story-555 worktree/,
      'the resolver would have thrown had it run first',
    );
  });

  /** The last close's persisted envelope, as the resume reads it. */
  const envelopeFor = (pr) => () => ({
    envelope: { storyId: 555, status: 'pending', pr },
  });

  function unarmedGh(merges) {
    return {
      pr: {
        list: async () => [{ number: 77, url: 'https://example/pull/77' }],
        view: async () => ({
          state: 'OPEN',
          mergedAt: null,
          createdAt: new Date().toISOString(),
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [],
          headRefOid: 'feedface',
          autoMergeRequest: null,
        }),
        merge: async (id, flags) => {
          merges.push([id, ...flags]);
          return { stdout: '', stderr: '' };
        },
      },
    };
  }

  it('never re-arms a PR the operator left un-armed, or one with no arm record', async () => {
    for (const pr of [
      {
        number: 77,
        autoMergeEnabled: false,
        autoMergeReason: 'disabled-by-flag',
      },
      {
        number: 77,
        autoMergeEnabled: false,
        autoMergeReason: 'disabled-by-policy-strict',
      },
      null,
    ]) {
      const merges = [];
      const { terminal } = await runConfirmMerge({
        storyId: 555,
        cwd: tempRoot,
        pr: 77,
        wait: true,
        maxWaitSeconds: 1,
        injectedProvider: makeProvider(OPEN_STORY),
        injectedConfig: {
          ...fakeConfig(),
          project: { baseBranch: 'main', paths: { tempRoot } },
        },
        injectedGh: unarmedGh(merges),
        injectedNotify: async () => {},
        readCloseEnvelopeFn: envelopeFor(pr),
      });
      assert.deepEqual(merges, [], JSON.stringify(pr));
      assert.equal(
        terminal.pr.autoMergeEnabled,
        false,
        'no evidence is carried forward',
      );
    }
  });

  it('AC-5: a resumed wait on an open, un-armed, not-red PR re-arms auto-merge', async () => {
    const merges = [];
    const gh = {
      pr: {
        list: async () => [{ number: 77, url: 'https://example/pull/77' }],
        view: async () => ({
          state: 'OPEN',
          mergedAt: null,
          createdAt: new Date().toISOString(),
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [],
          headRefOid: 'feedface',
          autoMergeRequest: null,
        }),
        merge: async (id, flags) => {
          merges.push([id, ...flags]);
          return { stdout: '', stderr: '' };
        },
      },
    };
    const { terminal } = await runConfirmMerge({
      storyId: 555,
      cwd: tempRoot,
      pr: 77,
      wait: true,
      maxWaitSeconds: 1,
      injectedProvider: makeProvider(OPEN_STORY),
      injectedConfig: {
        ...fakeConfig(),
        project: { baseBranch: 'main', paths: { tempRoot } },
      },
      injectedGh: gh,
      injectedNotify: async () => {},
      readCloseEnvelopeFn: envelopeFor({
        number: 77,
        autoMergeEnabled: true,
        autoMergeReason: null,
      }),
    });
    assert.equal(terminal.status, 'pending', 'a re-arm is not a terminal');
    assert.equal(
      terminal.pr.autoMergeEnabled,
      true,
      'the evidence carries forward',
    );
    assert.deepEqual(
      merges,
      [['77', '--auto', '--squash', '--delete-branch']],
      'armed once for the one head it saw',
    );
  });
});
