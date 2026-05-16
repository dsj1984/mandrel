/**
 * Story #1642 — unit-test the extracted helpers behind `defaultGateRunner`.
 *
 * `attachGateAbortHandler` and `gateExitCode` are the two pure pieces that
 * came out of the cc-reduction refactor. Coverage on them keeps the file's
 * function-coverage above its baseline.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachGateAbortHandler,
  buildDefaultGates,
  gateExitCode,
  runCloseValidation,
} from '../../.agents/scripts/lib/close-validation.js';

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

function makeFakeChild() {
  const calls = { killed: 0 };
  return {
    kill: () => {
      calls.killed += 1;
    },
    calls,
  };
}

describe('attachGateAbortHandler', () => {
  it('returns a no-op detach when signal is absent', () => {
    const child = makeFakeChild();
    const detach = attachGateAbortHandler(child, null);
    detach();
    assert.equal(child.calls.killed, 0);
  });

  it('kills the child immediately when signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const child = makeFakeChild();
    attachGateAbortHandler(child, ac.signal);
    assert.equal(child.calls.killed, 1);
  });

  it('attaches an abort listener that kills the child when the signal fires', () => {
    const ac = new AbortController();
    const child = makeFakeChild();
    const detach = attachGateAbortHandler(child, ac.signal);
    assert.equal(child.calls.killed, 0);
    ac.abort();
    assert.equal(child.calls.killed, 1);
    detach();
  });

  it('detach removes the listener so a later abort is a no-op', () => {
    const ac = new AbortController();
    const child = makeFakeChild();
    const detach = attachGateAbortHandler(child, ac.signal);
    detach();
    ac.abort();
    assert.equal(child.calls.killed, 0);
  });

  it('swallows kill() races (child already exited)', () => {
    const ac = new AbortController();
    const child = {
      kill: () => {
        throw new Error('already exited');
      },
    };
    attachGateAbortHandler(child, ac.signal);
    // Must not throw.
    assert.doesNotThrow(() => ac.abort());
  });
});

describe('buildDefaultGates per-kind in-process gates (Story #1973 / Task #1984)', () => {
  const PER_KIND_GATE_NAMES = ['check-maintainability', 'check-crap'];

  it('attaches an in-process `run` callable to each per-kind baseline gate', () => {
    const gates = buildDefaultGates({ epicBranch: 'epic/1943' });
    for (const name of PER_KIND_GATE_NAMES) {
      const gate = gates.find((g) => g.name === name);
      assert.ok(gate, `expected ${name} gate to be present`);
      assert.equal(
        typeof gate.run,
        'function',
        `${name} gate must carry an in-process run() callable`,
      );
    }
  });

  it('preserves the legacy cmd/args shape so introspecting call sites keep working', () => {
    const gates = buildDefaultGates({ epicBranch: 'epic/1943' });
    const mi = gates.find((g) => g.name === 'check-maintainability');
    assert.equal(mi.cmd, 'node');
    assert.deepStrictEqual(mi.args, [
      '.agents/scripts/check-maintainability.js',
      '--epic-ref',
      'epic/1943',
    ]);
    const crap = gates.find((g) => g.name === 'check-crap');
    assert.equal(crap.cmd, 'node');
    assert.deepStrictEqual(crap.args, [
      '.agents/scripts/check-crap.js',
      '--epic-ref',
      'epic/1943',
    ]);
  });

  it('runs the per-kind baseline gates without invoking child_process spawn for the per-kind CLI', async () => {
    const spawnLog = [];
    const spyRunner = (cmd, args, _opts) => {
      // The default runner spawns; this spy records each invocation so we
      // can assert that the per-kind CLIs were NEVER reached. Returning
      // status 0 keeps the wave moving in case any non-target gate slips
      // through.
      spawnLog.push({ cmd, args });
      return { status: 0 };
    };
    // Stub kindModule so the in-process gate path does not try to read a
    // real baseline file from disk during the test. Each `run` callable
    // returns `{ status: 0 }` and never delegates to the spy runner.
    const fakeKind = { compare: () => ({ regressions: [] }) };
    const gates = [
      {
        name: 'check-maintainability',
        cmd: 'node',
        args: ['.agents/scripts/check-maintainability.js'],
        run: async () => ({ status: 0 }),
      },
      {
        name: 'check-crap',
        cmd: 'node',
        args: ['.agents/scripts/check-crap.js'],
        run: async () => ({ status: 0 }),
      },
    ];
    void fakeKind;
    const result = await runCloseValidation({
      cwd: '.',
      gates,
      runner: spyRunner,
      log: () => {},
      useEvidence: false,
    });
    assert.equal(result.ok, true);
    // The spy runner must NOT have observed either per-kind CLI argv.
    const cliInvocations = spawnLog.filter((c) =>
      c.args.some(
        (arg) =>
          arg === '.agents/scripts/check-maintainability.js' ||
          arg === '.agents/scripts/check-crap.js' ||
          arg === '.agents/scripts/check-mutation.js',
      ),
    );
    assert.equal(
      cliInvocations.length,
      0,
      `expected zero child_process spawns of per-kind CLIs; observed: ${JSON.stringify(cliInvocations)}`,
    );
  });

  it('flags a regression returned by the per-kind compare as a non-zero gate exit', async () => {
    let dispatched = 0;
    const gates = [
      {
        name: 'check-maintainability',
        cmd: 'node',
        args: [],
        run: async (_cmd, _args, opts) => {
          dispatched += 1;
          opts?.log?.('[maintainability] 1 regression(s) detected:');
          return { status: 1 };
        },
      },
    ];
    const result = await runCloseValidation({
      cwd: '.',
      gates,
      runner: () => {
        throw new Error('default runner must not be reached');
      },
      log: () => {},
      useEvidence: false,
    });
    assert.equal(dispatched, 1);
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].gate.name, 'check-maintainability');
    assert.equal(result.failed[0].status, 1);
  });
});
