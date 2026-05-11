import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGhMergeArgs,
  parseAutomergeArgs,
  runEpicDeliverAutomerge,
} from '../../.agents/scripts/epic-deliver-automerge.js';

const cleanVerdict = {
  clean: true,
  reasons: [],
  signals: { manualInterventions: 0 },
};

const dirtyVerdict = {
  clean: false,
  reasons: ['manual interventions recorded (1): discarded drift'],
  signals: { manualInterventions: 1 },
};

describe('parseAutomergeArgs', () => {
  it('parses --epic / --pr / --strategy / --dry-run', () => {
    const out = parseAutomergeArgs([
      '--epic',
      '1178',
      '--pr',
      '1272',
      '--strategy',
      'squash',
      '--dry-run',
    ]);
    assert.deepEqual(out, {
      epicId: 1178,
      prNumber: 1272,
      strategy: 'squash',
      dryRun: true,
      help: false,
    });
  });

  it('defaults strategy to squash', () => {
    const out = parseAutomergeArgs(['--epic', '1', '--pr', '2']);
    assert.equal(out.strategy, 'squash');
  });

  it('rejects invalid strategy values (falls back to squash)', () => {
    const out = parseAutomergeArgs([
      '--epic',
      '1',
      '--pr',
      '2',
      '--strategy',
      'bogus',
    ]);
    assert.equal(out.strategy, 'squash');
  });

  it('rejects bad ids', () => {
    assert.equal(parseAutomergeArgs(['--epic', '0', '--pr', '0']).epicId, null);
    assert.equal(
      parseAutomergeArgs(['--epic', '0', '--pr', '0']).prNumber,
      null,
    );
  });
});

describe('buildGhMergeArgs', () => {
  it('default squash + delete-branch', () => {
    assert.deepEqual(buildGhMergeArgs({ prNumber: 1272 }), [
      'pr',
      'merge',
      '1272',
      '--squash',
      '--delete-branch',
    ]);
  });

  it('honors --merge / --rebase', () => {
    assert.deepEqual(buildGhMergeArgs({ prNumber: 7, strategy: 'merge' }), [
      'pr',
      'merge',
      '7',
      '--merge',
      '--delete-branch',
    ]);
    assert.deepEqual(buildGhMergeArgs({ prNumber: 7, strategy: 'rebase' }), [
      'pr',
      'merge',
      '7',
      '--rebase',
      '--delete-branch',
    ]);
  });
});

describe('runEpicDeliverAutomerge', () => {
  it('fires gh pr merge when verdict is clean', async () => {
    const ghCalls = [];
    const ghSpawnFn = (args, cwd) => {
      ghCalls.push({ args, cwd });
      return { status: 0, stdout: '', stderr: '' };
    };
    const out = await runEpicDeliverAutomerge({
      epicId: 1178,
      prNumber: 1272,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({ read: async () => ({}) }),
      evaluatePredicateFn: async () => cleanVerdict,
      ghSpawnFn,
    });
    assert.equal(out.merged, true);
    assert.equal(out.verdict.clean, true);
    assert.equal(ghCalls.length, 1);
    assert.deepEqual(ghCalls[0].args, [
      'pr',
      'merge',
      '1272',
      '--squash',
      '--delete-branch',
    ]);
  });

  it('skips gh pr merge when verdict is dirty', async () => {
    let ghCalled = false;
    const out = await runEpicDeliverAutomerge({
      epicId: 1,
      prNumber: 2,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({ read: async () => ({}) }),
      evaluatePredicateFn: async () => dirtyVerdict,
      ghSpawnFn: () => {
        ghCalled = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(out.merged, false);
    assert.equal(out.verdict.clean, false);
    assert.equal(ghCalled, false, 'gh pr merge must not run when dirty');
  });

  it('dry-run does not invoke gh pr merge even when clean', async () => {
    let ghCalled = false;
    const out = await runEpicDeliverAutomerge({
      epicId: 1,
      prNumber: 2,
      dryRun: true,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({ read: async () => ({}) }),
      evaluatePredicateFn: async () => cleanVerdict,
      ghSpawnFn: () => {
        ghCalled = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(out.merged, false);
    assert.equal(out.dryRun, true);
    assert.equal(ghCalled, false);
  });

  it('captures gh stderr when the merge call fails', async () => {
    const out = await runEpicDeliverAutomerge({
      epicId: 1,
      prNumber: 2,
      injectedConfig: { orchestration: { provider: 'fake' } },
      injectedProvider: {},
      checkpointerFactory: () => ({ read: async () => ({}) }),
      evaluatePredicateFn: async () => cleanVerdict,
      ghSpawnFn: () => ({ status: 1, stdout: '', stderr: 'merge conflict' }),
    });
    assert.equal(out.merged, false);
    assert.match(out.ghStderr, /merge conflict/);
  });

  it('rejects invalid arguments', async () => {
    await assert.rejects(
      () =>
        runEpicDeliverAutomerge({
          epicId: 0,
          prNumber: 1,
          injectedConfig: { orchestration: { provider: 'fake' } },
          injectedProvider: {},
        }),
      /epicId must be a positive integer/,
    );
    await assert.rejects(
      () =>
        runEpicDeliverAutomerge({
          epicId: 1,
          prNumber: 0,
          injectedConfig: { orchestration: { provider: 'fake' } },
          injectedProvider: {},
        }),
      /prNumber must be a positive integer/,
    );
    await assert.rejects(
      () =>
        runEpicDeliverAutomerge({
          epicId: 1,
          prNumber: 2,
          strategy: 'bogus',
          injectedConfig: { orchestration: { provider: 'fake' } },
          injectedProvider: {},
        }),
      /strategy must be one of/,
    );
  });
});
