// Story #5880 — the `test` delta re-credit, driven through the phase with the
// real gate builder and every git / evidence probe injected.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefaultGates } from '../../../../close-validation/gates.js';
import { applyTestDelta } from '../../../../close-validation/test-delta.js';
import { runCloseValidationPhase } from '../close-validation.js';

const SINCE = 'c'.repeat(40);
const TEST_CHANGED = 'pnpm vitest run --changed $MANDREL_CHANGED_SINCE';
const DELTA_LABEL = `test (delta since ${'c'.repeat(12)}, 2 incoming path(s))`;

function configWith(commands) {
  return { project: { commands } };
}

async function runPhase({
  config = configWith({ testChanged: TEST_CHANGED }),
  baseSync = { changedPaths: ['src/b.js', 'lib/c.js'], creditedCommit: SINCE },
  credited = true,
  storyFiles = ['src/a.js'],
  packageScripts = {},
  validationResult = () => ({ ok: true, failed: [], skipped: [] }),
} = {}) {
  const logged = [];
  const progressed = [];
  const probes = [];
  let gates;
  const probesFor = {
    gitSpawnImpl: () => ({ status: 1, stdout: '' }),
    shouldSkipImpl: (input) => {
      probes.push(input);
      return { skip: credited, reason: 'probe' };
    },
    getChangedFilesImpl: ({ ref }) => {
      if (storyFiles === null) throw new Error(`bad ref ${ref}`);
      return storyFiles;
    },
  };
  const run = runCloseValidationPhase({
    cwd: '/repo',
    worktreePath: '/repo/.worktrees/story-5880',
    config,
    baseBranch: 'main',
    storyBranch: 'story-5880',
    storyId: 5880,
    baseSync,
    progress: (_tag, msg) => progressed.push(msg),
    runPreGateSteps: async () => {},
    createGateLogSink: () => ({
      log: (m) => logged.push(m),
      flush: async () => {},
      digest: () => '',
      replay: () => {},
    }),
    createLockEventChannel: () => ({
      read: () => [],
      dispose: () => {},
      env: {},
      emit: () => {},
    }),
    buildDefaultGates: (opts) =>
      buildDefaultGates({
        ...opts,
        ...probesFor,
        packageScripts,
        presentBaselines: [],
      }),
    applyTestDelta: (list, opts) =>
      applyTestDelta(list, { ...opts, ...probesFor }),
    runCloseValidation: async ({ gates: list }) => {
      gates = list;
      return validationResult(list);
    },
  });
  const result = await run.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return { ...result, gates, logged, progressed, probes };
}

const testGates = (gates) => gates.filter((g) => g.name === 'test');
const notEligible = (logged) =>
  logged.filter((l) => l.includes('test delta re-credit not eligible'));

describe('close-validation phase — the test delta re-credit (Story #5880)', () => {
  it('AC-2: runs testChanged keyed on the credited commit as the only test gate', async () => {
    const { gates, logged, progressed, probes } = await runPhase();
    const [gate, ...rest] = testGates(gates);
    assert.equal(rest.length, 0, 'exactly one test gate');
    assert.equal(gate.cmd, 'pnpm');
    assert.deepEqual(gate.args, ['vitest', 'run', '--changed', SINCE]);
    assert.deepEqual(gate.env, { MANDREL_CHANGED_SINCE: SINCE });
    assert.equal(gate.fullSuiteLock, true);
    assert.deepEqual(gate.evidenceIdentity, { cmd: 'npm', args: ['test'] });
    assert.deepEqual(gate.evidenceNote, { scope: 'delta', since: SINCE });
    assert.equal(probes[0].currentSha, SINCE);
    assert.ok(progressed.includes(DELTA_LABEL), 'the progress line names it');
    assert.deepEqual(notEligible(logged), []);
  });

  it('Story #5903: a shared baseline path is not overlap', async () => {
    const baseline = 'baselines/coverage.json';
    const { gates, progressed } = await runPhase({
      baseSync: {
        changedPaths: ['src/b.js', 'lib/c.js', baseline],
        creditedCommit: SINCE,
      },
      storyFiles: ['src/a.js', baseline],
    });
    assert.equal(testGates(gates)[0].cmd, 'pnpm');
    assert.ok(progressed.some((l) => l.endsWith('3 incoming path(s))')));
  });

  it('AC-4: a red delta run fails the close with a hint naming the scope and command', async () => {
    const { error } = await runPhase({
      validationResult: (list) => ({
        ok: false,
        failed: [{ gate: list.find((g) => g.name === 'test'), status: 1 }],
        skipped: [],
      }),
    });
    assert.equal(error?.closeGate, 'test');
    assert.match(error.message, /scope: delta/);
    assert.ok(error.message.includes(TEST_CHANGED));
  });

  const fullSuite = (gates) => {
    const [gate] = testGates(gates);
    assert.equal(gate.cmd, 'npm');
    assert.deepEqual(gate.args, ['test']);
    assert.equal(gate.evidenceIdentity, undefined);
  };

  const ineligible = [
    [
      'no changed-tests command',
      { config: configWith({}) },
      /no `project\.commands\.testChanged`/,
    ],
    [
      'an explicitly disabled changed-tests command',
      { config: configWith({ testChanged: null }) },
      /no `project\.commands\.testChanged`/,
    ],
    [
      'no test credit for the pre-sync head',
      { credited: false },
      /no `test` credit/,
    ],
    [
      'a coverage-config file among the incoming paths',
      { baseSync: { changedPaths: ['pnpm-lock.yaml'], creditedCommit: SINCE } },
      /coverage-determining config pnpm-lock\.yaml/,
    ],
    [
      'an incoming path that is a Story file',
      { storyFiles: ['src/b.js'] },
      /shares src\/b\.js/,
    ],
    [
      'a baseline-only incoming set',
      {
        baseSync: {
          changedPaths: ['baselines/coverage.json'],
          creditedCommit: SINCE,
        },
      },
      /delta has no suite-input path/,
    ],
    [
      'an unreadable Story change set',
      { storyFiles: null },
      /Story change set unreadable/,
    ],
  ];
  for (const [what, overrides, reason] of ineligible) {
    it(`AC-3: ${what} logs the reason and runs the full suite`, async () => {
      const { gates, logged, progressed } = await runPhase(overrides);
      fullSuite(gates);
      const [line, ...more] = notEligible(logged);
      assert.equal(more.length, 0);
      assert.match(line, reason);
      assert.match(line, /running the full suite$/);
      assert.ok(!progressed.some((l) => l.startsWith('test (delta')));
    });
  }

  it('AC-3: coverage-capture running the suite keeps the capture as the test gate', async () => {
    const { gates, logged } = await runPhase({
      packageScripts: { 'test:coverage': 'c8 node --test' },
      storyFiles: null,
    });
    assert.deepEqual(testGates(gates), []);
    assert.ok(gates.some((g) => g.name === 'coverage-capture' && !g.skip));
    assert.match(notEligible(logged)[0], /coverage-capture runs the suite/);
  });

  it('no base move plans nothing and logs nothing', async () => {
    const { gates, logged } = await runPhase({
      baseSync: { changedPaths: [], creditedCommit: null },
    });
    fullSuite(gates);
    assert.deepEqual(notEligible(logged), []);
  });

  it('a skipped sync (no base-sync result) is today’s close', async () => {
    const { gates, logged } = await runPhase({ baseSync: null });
    fullSuite(gates);
    assert.deepEqual(notEligible(logged), []);
  });
});
