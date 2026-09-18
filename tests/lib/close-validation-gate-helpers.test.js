/**
 * Story #1642 — unit-test the extracted helpers behind `defaultGateRunner`.
 *
 * `gateExitCode` came out of the cc-reduction refactor; Story #5377 replaced
 * the abort helper beside it with the process-group supervision every gate
 * child now runs under, pinned here with fakes and with real process trees.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDefaultGates,
  partitionGates,
} from '../../.agents/scripts/lib/close-validation/gates.js';
import {
  defaultGateRunner,
  gateExitCode,
} from '../../.agents/scripts/lib/close-validation/process.js';
import { runCloseValidation } from '../../.agents/scripts/lib/close-validation/runner.js';
import { COVERAGE_GATE_DEFAULTS } from '../../.agents/scripts/lib/config/quality.js';
import {
  FULL_SUITE_LOCK_EXPIRY_ENV,
  LOCK_WAIT_EXPIRED_EXIT_CODE,
} from '../../.agents/scripts/lib/full-suite-lock.js';
import {
  groupSpawnOptions,
  superviseGroup,
} from '../../.agents/scripts/lib/process-group.js';
import { acquireSweepLock } from '../../.agents/scripts/lib/single-story-sweep/sweep-lock.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { hashCommandConfig } from '../../.agents/scripts/lib/validation-evidence.js';
import {
  waitForDeath,
  waitForExit,
  waitForFile,
} from '../fixtures/process-group/probe.js';

describe('gateExitCode', () => {
  it('returns numeric exit codes verbatim', () => {
    assert.equal(gateExitCode(0, null), 0);
    assert.equal(gateExitCode(2, null), 2);
    assert.equal(gateExitCode(127, null), 127);
  });
  it('maps SIGTERM (no exit code) to 143', () => {
    assert.equal(gateExitCode(null, 'SIGTERM'), 143);
    assert.equal(gateExitCode(undefined, 'SIGKILL'), 143);
  });
  it('falls back to 1 when both code and signal are absent', () => {
    assert.equal(gateExitCode(null, null), 1);
  });
});

function makeFakeChild({ pid, throws = false } = {}) {
  const calls = { killed: [] };
  return {
    pid,
    kill: (signal) => {
      calls.killed.push(signal);
      if (throws) throw new Error('already exited');
    },
    calls,
  };
}

describe('the process-group kill (Story #5377)', () => {
  const abortWith = (child, killOptions) => {
    const ac = new AbortController();
    const supervisor = superviseGroup(child, {
      abortSignal: ac.signal,
      killOptions,
    });
    ac.abort();
    supervisor.release();
  };

  it('signals the whole group on POSIX', () => {
    const sent = [];
    const child = makeFakeChild({ pid: 4242 });
    abortWith(child, {
      platform: 'linux',
      killFn: (pid, signal) => sent.push([pid, signal]),
    });
    assert.deepEqual(sent, [[-4242, 'SIGTERM']]);
    assert.deepEqual(child.calls.killed, []);
  });

  it('falls back to the child when the group is already gone', () => {
    const child = makeFakeChild({ pid: 4242 });
    abortWith(child, {
      platform: 'darwin',
      killFn: () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
    });
    assert.deepEqual(child.calls.killed, ['SIGTERM']);
  });

  it('AC-11: degrades to the plain child kill on win32 and never throws', () => {
    const groupKills = [];
    const child = makeFakeChild({ pid: 4242, throws: true });
    assert.doesNotThrow(() =>
      abortWith(child, {
        platform: 'win32',
        killFn: (pid) => groupKills.push(pid),
      }),
    );
    assert.deepEqual(groupKills, [], 'no POSIX group kill on win32');
    assert.deepEqual(child.calls.killed, ['SIGTERM']);
  });

  it('spawns a group leader only where process groups exist', () => {
    assert.deepEqual(groupSpawnOptions('win32'), {});
    assert.deepEqual(groupSpawnOptions('linux'), { detached: true });
  });
});

describe('superviseGroup — abort wiring', () => {
  it('kills the child immediately when the signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const child = makeFakeChild();
    superviseGroup(child, { abortSignal: ac.signal }).release();
    assert.deepEqual(child.calls.killed, ['SIGTERM']);
  });

  it('kills the child when the signal fires, and not after release', () => {
    const ac = new AbortController();
    const child = makeFakeChild();
    const supervisor = superviseGroup(child, { abortSignal: ac.signal });
    assert.deepEqual(child.calls.killed, []);
    ac.abort();
    assert.deepEqual(child.calls.killed, ['SIGTERM']);
    supervisor.release();
    const later = new AbortController();
    const quiet = makeFakeChild();
    superviseGroup(quiet, { abortSignal: later.signal }).release();
    later.abort();
    assert.deepEqual(quiet.calls.killed, []);
  });

  it('swallows kill() races (child already exited)', () => {
    const ac = new AbortController();
    const supervisor = superviseGroup(makeFakeChild({ throws: true }), {
      abortSignal: ac.signal,
    });
    assert.doesNotThrow(() => ac.abort());
    supervisor.release();
  });

  it('forwards SIGINT/SIGTERM to the group only while the child is live', () => {
    const before = process.listenerCount('SIGTERM');
    const supervisor = superviseGroup(makeFakeChild());
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
    supervisor.release();
    assert.equal(process.listenerCount('SIGTERM'), before);
  });
});

describe('the close `test` gate is bounded (Story #5377)', () => {
  it('AC-3: runCloseValidation hands the full-suite gate the coverage wall clock', async () => {
    const seen = [];
    await runCloseValidation({
      cwd: '/repo',
      gates: [
        { name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true },
        { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
      ],
      config: {},
      runner: async (_cmd, _args, opts) => {
        seen.push(opts);
        return { status: 0 };
      },
      runProjections: async () => {},
      deferOnLockExpiry: true,
    });
    const test = seen.find((o) => o.gateName === 'test');
    const lint = seen.find((o) => o.gateName === 'lint');
    // The coverage wall clock is the fixed constant since Story #5382.
    assert.equal(test.timeoutMs, COVERAGE_GATE_DEFAULTS.timeoutMs);
    assert.equal(test.deferOnLockExpiry, true);
    assert.equal(
      lint.timeoutMs,
      undefined,
      'only the full-suite gate is bounded here',
    );
    for (const opts of [test, lint]) {
      assert.equal(
        opts.env[FULL_SUITE_LOCK_EXPIRY_ENV],
        'defer',
        'close opts every gate child in to the defer posture',
      );
    }
  });

  it('outside close no gate child is opted in to defer', async () => {
    const seen = [];
    await runCloseValidation({
      cwd: '/repo',
      gates: [
        { name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true },
      ],
      runner: async (_cmd, _args, opts) => {
        seen.push(opts);
        return { status: 0 };
      },
      runProjections: async () => {},
    });
    assert.equal(seen[0].env, undefined);
    assert.equal(seen[0].deferOnLockExpiry, false);
    assert.equal(seen[0].timeoutMs, 600_000, 'the resolved default budget');
  });

  it('a deferred full-suite gate reports the lock-expiry exit without spawning', async () => {
    const lockDir = makeTempDir('mandrel-gate-defer-');
    try {
      const lockPath = path.join(lockDir, 'full-suite.lock');
      const marker = path.join(lockDir, 'spawned');
      const holder = acquireSweepLock({ lockPath, timeoutMs: 600_000 });
      const result = await defaultGateRunner(
        process.execPath,
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`,
        ],
        {
          cwd: lockDir,
          gateName: 'test',
          log: () => {},
          fullSuiteLock: true,
          deferOnLockExpiry: true,
          lockOptions: { lockPath, waitMs: 0 },
        },
      );
      holder.release();
      assert.deepEqual(result, { status: LOCK_WAIT_EXPIRED_EXIT_CODE });
      assert.equal(fs.existsSync(marker), false, 'nothing was spawned');
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

/**
 * Story #5377 — real process trees. POSIX-only: win32 has no process groups
 * and its degraded kill is pinned above.
 */
describe('gate children are process groups (Story #5377)', {
  skip: process.platform === 'win32',
}, () => {
  const fixtures = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../fixtures/process-group',
  );
  let dir;
  beforeEach(() => {
    dir = makeTempDir('mandrel-gate-pgroup-');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('AC-2: a close `test` gate killed by its timeout leaves no surviving worker and exits 124', async () => {
    const pidFile = path.join(dir, 'worker.pid');
    const lines = [];
    const result = await defaultGateRunner(
      process.execPath,
      [path.join(fixtures, 'suite-tree.mjs'), pidFile],
      {
        cwd: dir,
        gateName: 'test',
        log: (m) => lines.push(m),
        fullSuiteLock: true,
        timeoutMs: 3_000,
      },
    );
    assert.deepEqual(result, { status: 124 });
    assert.match(lines.join('\n'), /exceeded 3000ms/);
    const worker = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(
      await waitForDeath(worker),
      true,
      'the worker dies with its group',
    );
  });

  it('AC-4: SIGTERM to the process running a gate kills that gate’s group before it exits', async () => {
    const pidFile = path.join(dir, 'worker.pid');
    const runner = spawn(
      process.execPath,
      [path.join(fixtures, 'gate-holder.mjs'), dir, pidFile],
      { stdio: 'ignore' },
    );
    await waitForFile(pidFile);
    const worker = Number(fs.readFileSync(pidFile, 'utf8'));
    const exited = waitForExit(runner);
    runner.kill('SIGTERM');
    const { code, signal, ms } = await exited;
    assert.ok(ms < 5_000, `the gate runner took ${ms}ms to exit`);
    assert.ok(
      signal === 'SIGTERM' || code !== 0,
      'it still dies of the signal',
    );
    assert.equal(await waitForDeath(worker), true, 'the gate’s worker is gone');
  });
});

// Story #2210 — the `describe('buildDefaultGates per-kind in-process gates')`
// block was deleted with the retirement of the in-process per-kind regression
// gate. The unified `check-baselines` gate is the only path; coverage for
// that gate lives in `tests/check-baselines-pre-merge-wiring.test.js` and
// the attribution-wiring tests under
// `tests/lib/orchestration/story-close/baseline-attribution-wiring.test.js`.
// The pure helpers above (`gateExitCode`, the process-group kill) remain.

// ─────────────────────────────────────────────────────────────────────────
// The `lint` gate resolves `project.commands.lint`.
//
// Two invariants make the key safe to add to a shipped framework. An
// unconfigured consumer must get byte-identical argv, because the gate's
// evidence record is keyed on `hashCommandConfig` over exactly that argv — a
// single character of drift would silently invalidate every lint evidence
// record already on disk. And a consumer that DOES set the key must get the
// opposite: a different hash, so evidence recorded against the old command is
// not reused for the new one.
describe('buildDefaultGates — lint command resolution', () => {
  const lintGate = (config) =>
    buildDefaultGates({ config, packageScripts: {} }).find(
      (g) => g.name === 'lint',
    );

  it('unset → `npm run lint`, with the pre-key argv preserved', () => {
    for (const config of [
      undefined,
      {},
      { project: {} },
      { project: { commands: {} } },
    ]) {
      const gate = lintGate(config);
      assert.deepEqual(
        [gate.cmd, ...gate.args],
        ['npm', 'run', 'lint'],
        'the unconfigured gate must spawn exactly what it spawned before the key existed',
      );
    }
  });

  it('unset → the evidence hash is unchanged from the hardcoded gate', () => {
    const gate = lintGate({ project: { commands: {} } });
    assert.equal(
      hashCommandConfig({ cmd: gate.cmd, args: gate.args, cwd: '/repo' }),
      hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'], cwd: '/repo' }),
      'an unconfigured consumer must keep skipping on evidence recorded before this key existed',
    );
  });

  it('set → the gate spawns the configured command', () => {
    const gate = lintGate({
      project: { commands: { lint: 'npx biome ci --changed' } },
    });
    assert.deepEqual(
      [gate.cmd, ...gate.args],
      ['npx', 'biome', 'ci', '--changed'],
    );
  });

  it('set → prior evidence is invalidated (the hash covers the resolved argv)', () => {
    const unset = lintGate({});
    const set = lintGate({
      project: { commands: { lint: 'npx biome ci --changed' } },
    });
    assert.notEqual(
      hashCommandConfig({ cmd: set.cmd, args: set.args, cwd: '/repo' }),
      hashCommandConfig({ cmd: unset.cmd, args: unset.args, cwd: '/repo' }),
    );
  });

  it('an empty or blank value falls back rather than spawning nothing', () => {
    for (const lint of ['', '   ', null]) {
      const gate = lintGate({ project: { commands: { lint } } });
      assert.deepEqual([gate.cmd, ...gate.args], ['npm', 'run', 'lint']);
    }
  });

  // The gate name and its parallel-partition membership are part of the
  // contract: a consumer pointing `lint` at a scoped command must not move it
  // out of the phase whose floor it was setting, nor rename the evidence key.
  it('keeps its name and its parallel partition under both configurations', () => {
    for (const config of [
      {},
      { project: { commands: { lint: 'make lint' } } },
    ]) {
      const gates = buildDefaultGates({ config, packageScripts: {} });
      const { independent, serial } = partitionGates(gates);
      assert.ok(
        independent.some((g) => g.name === 'lint'),
        'lint must stay in the parallel partition',
      );
      assert.ok(!serial.some((g) => g.name === 'lint'));
    }
  });
});
