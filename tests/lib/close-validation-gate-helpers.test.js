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
  buildDefaultGates,
  partitionGates,
} from '../../.agents/scripts/lib/close-validation/gates.js';
import {
  attachGateAbortHandler,
  gateExitCode,
} from '../../.agents/scripts/lib/close-validation/process.js';
import { hashCommandConfig } from '../../.agents/scripts/lib/validation-evidence.js';

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

// Story #2210 — the `describe('buildDefaultGates per-kind in-process gates')`
// block was deleted with the retirement of the in-process per-kind regression
// gate. The unified `check-baselines` gate is the only path; coverage for
// that gate lives in `tests/check-baselines-pre-merge-wiring.test.js` and
// the attribution-wiring tests under
// `tests/lib/orchestration/story-close/baseline-attribution-wiring.test.js`.
// The pure helpers above (`gateExitCode`, `attachGateAbortHandler`) remain.

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
