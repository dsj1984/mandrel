/**
 * tests/lib/close-validation/coverage-gate-registration.test.js — Story #4473.
 *
 * The coverage-capture gate spawns `npm run test:coverage`, so registering it
 * for a consumer that has no such script is a guaranteed first-try close
 * failure — and because CRAP mode drops the plain `test` gate, that consumer
 * would have NO working test gate at all. `buildDefaultGates` now probes the
 * consumer's `package.json` (injected here via `packageScripts`) and:
 *   - registers coverage-capture ONLY when CRAP is on AND `test:coverage`
 *     exists;
 *   - restores the plain `test` gate whenever coverage-capture is not the
 *     active test runner, so there is always a working test gate.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildDefaultGates,
  partitionGates,
} from '../../../.agents/scripts/lib/close-validation/gates.js';
import { runCloseValidation } from '../../../.agents/scripts/lib/close-validation/runner.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const names = (gates) => gates.map((g) => g.name);

describe('buildDefaultGates — coverage-capture registration (Story #4473)', () => {
  it('CRAP on + test:coverage present → coverage-capture runs, no separate test gate', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    assert.ok(names(gates).includes('coverage-capture'));
    assert.ok(!names(gates).includes('test'));
  });

  it('CRAP on + test:coverage ABSENT → coverage-capture dropped, plain test gate restored', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
      packageScripts: { test: 'node --test' },
    });
    assert.ok(
      !names(gates).includes('coverage-capture'),
      'coverage-capture must not be registered without test:coverage',
    );
    assert.ok(
      names(gates).includes('test'),
      'the plain test gate is the degraded test runner',
    );
    const testGate = gates.find((g) => g.name === 'test');
    assert.deepEqual([testGate.cmd, ...testGate.args], ['npm', 'test']);
  });

  // Story #5173 — the plain `test` gate is the one gate here that spawns a
  // whole suite, so it carries the host-lock flag `defaultGateRunner` acts on.
  // It is flagged on this entry alone precisely because the two full-suite
  // gates are mutually exclusive: when `coverage-capture` is registered
  // instead, the lock is taken one level down, inside `runCapture`.
  it('Story #5173: the restored test gate is flagged for the full-suite lock', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
      packageScripts: { test: 'node --test' },
    });
    assert.equal(gates.find((g) => g.name === 'test').fullSuiteLock, true);
  });

  it('Story #5173: no other gate carries the full-suite lock flag', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    assert.deepEqual(
      gates.filter((g) => g.fullSuiteLock).map((g) => g.name),
      [],
      'coverage-capture locks inside runCapture, not at the gate runner',
    );
  });

  it('CRAP off → plain test gate present, coverage-capture absent (regardless of script)', () => {
    const gates = buildDefaultGates({
      config: {
        delivery: { quality: { gates: { crap: { enabled: false } } } },
      },
      packageScripts: { 'test:coverage': 'c8 node --test' },
    });
    assert.ok(names(gates).includes('test'));
    assert.ok(!names(gates).includes('coverage-capture'));
  });

  it('no config (CRAP defaults on) + no coverage script → degraded test gate, no coverage-capture', () => {
    const gates = buildDefaultGates({ packageScripts: {} });
    assert.ok(names(gates).includes('test'));
    assert.ok(!names(gates).includes('coverage-capture'));
  });
});

describe('buildDefaultGates — the test gate never vanishes (Story #5278)', () => {
  const CRAP_ON = {
    delivery: {
      quality: {
        gates: {
          crap: {
            enabled: true,
            targetDirs: ['.agents/scripts', 'lib'],
            incrementalCoverage: { skipWhenUnchanged: true },
          },
        },
      },
    },
  };
  const SCRIPTS = { 'test:coverage': 'c8 node --test' };

  const build = (changed, config = CRAP_ON) =>
    buildDefaultGates({
      config,
      packageScripts: SCRIPTS,
      cwd: '/repo',
      baseBranch: 'main',
      getChangedFilesImpl: () => {
        if (changed === 'throw') throw new Error('bad ref');
        return changed;
      },
    });

  // AC-2 — the defect. A tests-only branch takes coverage-capture's own
  // incremental skip, and because CRAP mode had already dropped the plain
  // `test` gate the close then ran NO test gate and recorded a suite it never
  // executed as `passed`.
  it('AC-2: a tests-only diff registers a real `test` gate beside a skipped capture', () => {
    const gates = build(['tests/a.test.js', 'docs/x.md']);
    assert.ok(
      names(gates).includes('test'),
      'the suite must still run for a tests-only Story',
    );
    const capture = gates.find((g) => g.name === 'coverage-capture');
    assert.ok(capture, 'the capture gate is still reported, not omitted');
    assert.deepEqual(capture.skip, { reason: 'incremental-no-crap-changes' });
  });

  it('AC-2: a diff touching the CRAP scan scope keeps the pre-#5278 shape', () => {
    const gates = build(['.agents/scripts/lib/x.js']);
    assert.ok(!names(gates).includes('test'), 'no double full-suite spend');
    assert.equal(
      gates.find((g) => g.name === 'coverage-capture').skip,
      undefined,
    );
  });

  it('every uncertainty resolves to the pre-#5278 shape, never to a double spend', () => {
    for (const changed of ['throw', null]) {
      const gates = build(changed);
      assert.ok(
        !names(gates).includes('test'),
        `an unresolvable change set (${changed}) must not register both`,
      );
    }
    // Incremental mode off: coverage-capture always captures, so it is the
    // test runner exactly as before.
    const off = build([], {
      delivery: {
        quality: {
          gates: {
            crap: {
              enabled: true,
              incrementalCoverage: { skipWhenUnchanged: false },
            },
          },
        },
      },
    });
    assert.ok(!names(off).includes('test'));
  });

  // Story #5313 — a green bare `npm test` deposited the `test` evidence, so
  // the plain `test` gate is registered beside the capture and the runner's
  // evidence check reports it as credited instead of silently folding the
  // suite into coverage-capture.
  it('AC-5: a credited test evidence record registers the plain `test` gate beside the capture', () => {
    const gates = buildDefaultGates({
      config: CRAP_ON,
      packageScripts: SCRIPTS,
      cwd: '/repo/.worktrees/story-9',
      baseBranch: 'main',
      storyId: 9,
      evidenceCwd: '/repo',
      getChangedFilesImpl: () => ['.agents/scripts/lib/x.js'],
      gitSpawnImpl: (_cwd, ...args) => ({
        status: 0,
        stdout: args.includes('HEAD^{tree}') ? 'b'.repeat(40) : 'a'.repeat(40),
      }),
      shouldSkipImpl: (input, opts) => {
        assert.equal(input.storyId, 9);
        assert.equal(input.gateName, 'test');
        assert.equal(input.currentSha, 'a'.repeat(40));
        assert.equal(input.inputFingerprint, `tree:${'b'.repeat(40)}`);
        assert.deepEqual(opts, { cwd: '/repo', standalone: true });
        return { skip: true, reason: 'evidence-match' };
      },
    });
    assert.ok(names(gates).includes('test'), 'the credited gate is reported');
    assert.ok(names(gates).includes('coverage-capture'));
  });

  it('AC-5: an uncredited tree keeps the pre-#5313 shape — no double spend', () => {
    const gates = buildDefaultGates({
      config: CRAP_ON,
      packageScripts: SCRIPTS,
      cwd: '/repo/.worktrees/story-9',
      baseBranch: 'main',
      storyId: 9,
      evidenceCwd: '/repo',
      getChangedFilesImpl: () => ['.agents/scripts/lib/x.js'],
      gitSpawnImpl: () => ({ status: 0, stdout: 'a'.repeat(40) }),
      shouldSkipImpl: () => ({ skip: false, reason: 'no-record' }),
    });
    assert.ok(!names(gates).includes('test'));
    // No storyId at all → never consults evidence, never registers.
    const noStory = buildDefaultGates({
      config: CRAP_ON,
      packageScripts: SCRIPTS,
      cwd: '/repo',
      baseBranch: 'main',
      getChangedFilesImpl: () => ['.agents/scripts/lib/x.js'],
      shouldSkipImpl: () => {
        throw new Error('must not consult evidence without a storyId');
      },
    });
    assert.ok(!names(noStory).includes('test'));
  });

  it('never spawns git at module-load time (no cwd → no prediction)', () => {
    let spawned = false;
    const gates = buildDefaultGates({
      config: CRAP_ON,
      packageScripts: SCRIPTS,
      getChangedFilesImpl: () => {
        spawned = true;
        return [];
      },
    });
    assert.equal(spawned, false, 'DEFAULT_GATES must not shell out on import');
    assert.ok(!names(gates).includes('test'));
  });
});

describe('buildDefaultGates — the pre-push quality preview runs at close as two halves (Stories #5378, #5471)', () => {
  const CRAP_ON = {
    delivery: {
      quality: {
        gates: {
          crap: {
            enabled: true,
            targetDirs: ['.agents/scripts'],
            incrementalCoverage: { skipWhenUnchanged: true },
          },
        },
      },
    },
  };
  const SCRIPTS = { 'test:coverage': 'c8 node --test' };
  const MI = 'quality-preview-mi';
  const CRAP = 'quality-preview-crap';
  const find = (gates, name) => gates.find((g) => g.name === name);
  const gatesFor = (overrides = {}) =>
    buildDefaultGates({
      config: CRAP_ON,
      packageScripts: SCRIPTS,
      baseBranch: 'main',
      presentBaselines: ['crap'],
      ...overrides,
    });

  it('#5471 AC-1: the MI half sits in the parallel partition, ahead of coverage-capture', () => {
    const gates = gatesFor();
    const { independent, serial } = partitionGates(gates);
    assert.ok(names(independent).includes(MI), names(independent).join(','));
    assert.ok(!names(serial).includes(MI));
    assert.ok(names(serial).includes('coverage-capture'));
    const gate = find(gates, MI);
    assert.deepEqual(
      [gate.cmd, ...gate.args],
      [
        'node',
        '.agents/scripts/quality-preview.js',
        '--only',
        'mi',
        '--changed-since',
        'origin/main',
      ],
    );
    assert.match(gate.hint, /Maintainability preview failed/);
  });

  it('#5471 AC-2: the CRAP half stays serial, after coverage-capture and before the coverage-consuming baselines gate', () => {
    const gates = gatesFor();
    const { serial } = partitionGates(gates);
    const order = names(serial);
    const at = order.indexOf(CRAP);
    assert.ok(at > order.indexOf('coverage-capture'), order.join(','));
    assert.ok(at < order.indexOf('check-baselines-coverage'), order.join(','));
    const gate = find(gates, CRAP);
    assert.deepEqual(gate.args.slice(1, 3), ['--only', 'crap']);
    assert.match(gate.hint, /CRAP preview failed/);
    assert.equal(find(gates, 'quality-preview'), undefined);
  });

  it('scopes both halves to the close run base branch', () => {
    const gates = gatesFor({ baseBranch: 'develop' });
    for (const name of [MI, CRAP]) {
      assert.equal(find(gates, name).args.at(-1), 'origin/develop');
    }
  });

  it('both halves stay registered, unskipped, when the capture takes its incremental skip', () => {
    const gates = gatesFor({
      cwd: '/repo',
      getChangedFilesImpl: () => ['tests/a.test.js'],
    });
    assert.ok(find(gates, 'coverage-capture').skip);
    assert.equal(find(gates, MI).skip, undefined);
    assert.equal(find(gates, CRAP).skip, undefined);
  });

  // The registered gate list through the real close runner, with a fake spawn
  // that fails exactly the named gate. `format` is dropped: its changed-file
  // scope would shell out to git against the fake cwd.
  const runClose = ({ failing, cwd = '/repo', calls = [], log } = {}) =>
    runCloseValidation({
      cwd,
      gates: gatesFor().filter((g) => g.name !== 'format'),
      storyId: 5471,
      standalone: true,
      getHeadSha: () => 'c'.repeat(40),
      getTreeFingerprint: () => `tree:${'a'.repeat(40)}`,
      runner: async (_cmd, _args, { gateName }) => {
        calls.push(gateName);
        return { status: gateName === failing ? 1 : 0 };
      },
      ...(log ? { log } : {}),
    });

  it('#5471 AC-1: an MI regression fails close in the parallel phase, before coverage-capture spawns', async () => {
    const lines = [];
    const calls = [];
    const result = await runClose({
      failing: MI,
      calls,
      log: (m) => lines.push(m),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.failed.map((f) => [f.gate.name, f.outcome]),
      [[MI, 'failed']],
    );
    assert.ok(!calls.includes('coverage-capture'), calls.join(','));
    assert.ok(lines.some((l) => l.includes(`✖ ${MI} failed (exit 1)`)));
    assert.ok(lines.some((l) => l.includes('hint: Maintainability preview')));
  });

  it('#5471 AC-2: a CRAP regression still fails close, from the gate after coverage-capture', async () => {
    const calls = [];
    const result = await runClose({ failing: CRAP, calls });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.failed.map((f) => f.gate.name),
      [CRAP],
    );
    assert.ok(
      calls.indexOf('coverage-capture') < calls.indexOf(CRAP),
      calls.join(','),
    );
  });

  it('a pass records schema-valid evidence for both halves and a re-close at unchanged HEAD skips them', async () => {
    const cwd = makeTempDir('story-5471-');
    try {
      const calls = [];
      assert.equal((await runClose({ cwd, calls })).ok, true);
      assert.ok(calls.includes(MI) && calls.includes(CRAP));
      const again = [];
      const second = await runClose({ cwd, calls: again });
      assert.equal(second.ok, true);
      assert.ok(!again.includes(MI) && !again.includes(CRAP), again.join(','));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('absent when coverage-capture is not registered', () => {
    const crapOff = buildDefaultGates({
      config: {
        delivery: { quality: { gates: { crap: { enabled: false } } } },
      },
      packageScripts: SCRIPTS,
    });
    const noScript = buildDefaultGates({
      config: CRAP_ON,
      packageScripts: { test: 'node --test' },
    });
    for (const gates of [crapOff, noScript]) {
      assert.ok(!names(gates).includes('coverage-capture'));
      assert.equal(find(gates, MI), undefined);
      assert.equal(find(gates, CRAP), undefined);
    }
  });
});
