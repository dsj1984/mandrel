/**
 * Direct tests for `runPostMergeClose` — the post-merge orchestration
 * helper extracted from `story-close.js`. Covers:
 *
 *   - Happy path: phase-timings JSON is written, pipeline state flows
 *     into the result envelope.
 *   - Persistence failures swallow with a warn (writeFile, mkdir,
 *     clearPhaseTimerState, clearActiveStoryEnv).
 *   - Worktree-isolation invariant: the throw fires when the pipeline
 *     omits `worktreeReap` while isolation is enabled.
 *
 * Provider/notify/post-merge dependencies are injected as stubs.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { runPostMergeClose } from '../../../../.agents/scripts/lib/orchestration/story-close/post-merge-close.js';

function buildPhaseTimer() {
  return {
    mark: mock.fn(() => {}),
    finish: mock.fn(() => ({
      total: 1234,
      phases: { 'pre-merge': 100, merge: 800, 'api-sync': 334 },
    })),
  };
}

const baseInputs = () => ({
  orchestration: {},
  storyId: 100,
  epicId: 1,
  story: { id: 100, title: 'A' },
  storyBranch: 'story-100',
  epicBranch: 'epic/1',
  cwd: '/repo',
  projectRoot: '/repo',
  provider: {},
  notify: () => {},
  tasks: [],
  skipDashboard: false,
  progress: () => {},
  logger: { warn: mock.fn(() => {}) },
  phaseTimer: buildPhaseTimer(),
  clearPhaseTimerState: mock.fn(() => {}),
  clearActiveStoryEnv: mock.fn(() => {}),
  runPostMergePipeline: mock.fn(async () => ({
    worktreeReap: { reaped: true },
    branchCleanup: { localDeleted: true, remoteDeleted: true },
    ticketClosure: {
      closedTickets: [100],
      cascadedTo: [],
      cascadeFailed: [],
    },
    manifestUpdated: true,
  })),
  drainPendingCleanupAfterClose: mock.fn(async () => ({ drained: 0 })),
  reconcileCleanupState: mock.fn(({ worktreeReap, branchCleanup }) => ({
    worktreeReap,
    branchCleanup,
  })),
  writeFileFn: mock.fn(async () => {}),
  mkdirFn: mock.fn(async () => {}),
});

describe('runPostMergeClose — happy path', () => {
  it('finishes timer, writes phase-timings JSON, runs pipeline, returns merged envelope', async () => {
    const inputs = baseInputs();
    const result = await runPostMergeClose(inputs);

    assert.equal(inputs.phaseTimer.mark.mock.callCount(), 1);
    assert.equal(inputs.phaseTimer.finish.mock.callCount(), 1);
    assert.equal(inputs.mkdirFn.mock.callCount(), 1);
    assert.equal(inputs.writeFileFn.mock.callCount(), 1);

    // The pipeline got the phase-timings path threaded through.
    const pipelineCall = inputs.runPostMergePipeline.mock.calls[0].arguments[0];
    assert.match(pipelineCall.phaseTimingsPath, /phase-timings\.json$/);

    assert.equal(result.merged, true);
    assert.equal(result.action, 'merged');
    assert.equal(result.branchDeleted, true);
    assert.deepEqual(result.ticketsClosed, [100]);
    assert.equal(result.manifestUpdated, true);
  });
});

describe('runPostMergeClose — persistence failure isolation', () => {
  it('mkdirFn failure → phaseTimingsPath becomes null + warn logged, pipeline still runs', async () => {
    const inputs = baseInputs();
    inputs.mkdirFn = mock.fn(async () => {
      throw new Error('EACCES');
    });
    const result = await runPostMergeClose(inputs);
    assert.equal(result.merged, true);
    const pipelineCall = inputs.runPostMergePipeline.mock.calls[0].arguments[0];
    assert.equal(pipelineCall.phaseTimingsPath, null);
    assert.equal(inputs.logger.warn.mock.callCount() >= 1, true);
  });

  it('writeFileFn failure → phaseTimingsPath becomes null + warn logged', async () => {
    const inputs = baseInputs();
    inputs.writeFileFn = mock.fn(async () => {
      throw new Error('disk full');
    });
    const result = await runPostMergeClose(inputs);
    assert.equal(result.merged, true);
    assert.equal(inputs.logger.warn.mock.callCount() >= 1, true);
  });

  it('clearPhaseTimerState failure is swallowed with a warn', async () => {
    const inputs = baseInputs();
    inputs.clearPhaseTimerState = mock.fn(() => {
      throw new Error('rm failed');
    });
    const result = await runPostMergeClose(inputs);
    assert.equal(result.merged, true);
    const warnMessages = inputs.logger.warn.mock.calls
      .map((c) => c.arguments[0])
      .join(' ');
    assert.match(warnMessages, /clear phase-timer state file/);
  });

  it('clearActiveStoryEnv failure is swallowed with a warn', async () => {
    const inputs = baseInputs();
    inputs.clearActiveStoryEnv = mock.fn(() => {
      throw new Error('env clear failed');
    });
    const result = await runPostMergeClose(inputs);
    assert.equal(result.merged, true);
    const warnMessages = inputs.logger.warn.mock.calls
      .map((c) => c.arguments[0])
      .join(' ');
    assert.match(warnMessages, /clear active-Story env/);
  });
});

describe('runPostMergeClose — invariants', () => {
  it('throws when worktree isolation is enabled but pipeline omits worktreeReap', async () => {
    const inputs = baseInputs();
    inputs.orchestration = { worktreeIsolation: { enabled: true } };
    inputs.runPostMergePipeline = mock.fn(async () => ({
      worktreeReap: undefined,
      branchCleanup: { localDeleted: true, remoteDeleted: true },
      ticketClosure: { closedTickets: [], cascadedTo: [], cascadeFailed: [] },
      manifestUpdated: false,
    }));
    inputs.reconcileCleanupState = mock.fn(
      ({ branchCleanup, worktreeReap }) => ({
        branchCleanup,
        worktreeReap,
      }),
    );
    await assert.rejects(
      () => runPostMergeClose(inputs),
      /worktreeReap state missing while worktree isolation is enabled/,
    );
  });

  it('does not throw when worktree isolation is disabled and reap state is omitted', async () => {
    const inputs = baseInputs();
    inputs.orchestration = { worktreeIsolation: { enabled: false } };
    inputs.runPostMergePipeline = mock.fn(async () => ({
      worktreeReap: undefined,
      branchCleanup: { localDeleted: true, remoteDeleted: true },
      ticketClosure: { closedTickets: [], cascadedTo: [], cascadeFailed: [] },
      manifestUpdated: false,
    }));
    inputs.reconcileCleanupState = mock.fn(
      ({ branchCleanup, worktreeReap }) => ({
        branchCleanup,
        worktreeReap,
      }),
    );
    const result = await runPostMergeClose(inputs);
    assert.equal(result.merged, true);
  });
});

describe('runPostMergeClose — output shape', () => {
  it('falls back to empty arrays for cascadedTo / cascadeFailed when pipeline omits them', async () => {
    const inputs = baseInputs();
    inputs.runPostMergePipeline = mock.fn(async () => ({
      worktreeReap: { reaped: true },
      branchCleanup: { localDeleted: true, remoteDeleted: false },
      ticketClosure: { closedTickets: [] },
      manifestUpdated: false,
    }));
    const result = await runPostMergeClose(inputs);
    assert.deepEqual(result.cascadedTo, []);
    assert.deepEqual(result.cascadeFailed, []);
    assert.equal(result.branchDeleted, false);
    assert.equal(result.branchLocalDeleted, true);
    assert.equal(result.branchRemoteDeleted, false);
  });
});
