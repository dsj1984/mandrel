/**
 * Story #5637 — an explicit `project.commands.typecheck: null` disables the
 * close `typecheck` gate as a reported skip; absent or malformed config keeps
 * the `npm run typecheck` fallback. Tier: unit, every seam injected.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveGateCommand } from '../commands.js';
import { buildDefaultGates } from '../gates.js';
import { runCloseValidation } from '../runner.js';

const WORKTREE = path.resolve('/repo/.worktrees/story-5637');
const NO_CRAP = { quality: { gates: { crap: { enabled: false } } } };

const configWith = (commands) => ({
  project: { commands },
  delivery: NO_CRAP,
});

const gateNamed = (config, name) =>
  buildDefaultGates({
    config,
    cwd: WORKTREE,
    packageScripts: { test: 'whatever' },
    presentBaselines: [],
  }).find((gate) => gate.name === name);

const typecheckGate = (config) => gateNamed(config, 'typecheck');

describe('resolveGateCommand — disabled optional gates', () => {
  it('is disabled only for an own-present explicit null', () => {
    assert.equal(
      resolveGateCommand(configWith({ typecheck: null }), 'typecheck').disabled,
      true,
    );
    for (const config of [
      configWith({}),
      configWith({ typecheck: 'tsc' }),
      { project: null },
      null,
      undefined,
      configWith(Object.create({ typecheck: null })),
    ]) {
      assert.equal(resolveGateCommand(config, 'typecheck').disabled, false);
    }
  });

  it('keeps the default argv as a disabled gate identity', () => {
    const resolved = resolveGateCommand(configWith({ lint: null }), 'lint');
    assert.deepEqual([resolved.cmd, ...resolved.args], ['npm', 'run', 'lint']);
    assert.equal(resolved.raw, null);
  });
});

describe('buildDefaultGates — typecheck gate', () => {
  it('registers a pre-decided skip when typecheck is explicitly null', () => {
    const gate = typecheckGate(configWith({ typecheck: null }));
    assert.deepEqual(gate.skip, { reason: 'typecheck-disabled' });
  });

  it('keeps the `npm run typecheck` argv byte-for-byte when the key is absent', () => {
    const gate = typecheckGate(configWith({}));
    assert.equal(gate.skip, undefined);
    assert.equal(gate.cmd, 'npm');
    assert.deepEqual(gate.args, ['run', 'typecheck']);
  });

  it('uses the default when there is no config, and throws on a malformed block', () => {
    for (const config of [{ project: null }, null, undefined]) {
      const gate = typecheckGate(config);
      assert.equal(gate.skip, undefined);
      assert.deepEqual([gate.cmd, ...gate.args], ['npm', 'run', 'typecheck']);
    }
    assert.throws(
      () => typecheckGate({ project: { commands: 'nope' } }),
      /project\.commands must be an object/,
    );
  });

  it('runs a configured string', () => {
    const gate = typecheckGate(configWith({ typecheck: 'tsc --noEmit' }));
    assert.equal(gate.skip, undefined);
    assert.deepEqual([gate.cmd, ...gate.args], ['tsc', '--noEmit']);
  });
});

describe('buildDefaultGates — lint and format honour an explicit null (Story #5737)', () => {
  it('registers lint-disabled and format-disabled skips', () => {
    const config = configWith({ lint: null, formatCheck: null });
    assert.deepEqual(gateNamed(config, 'lint').skip, {
      reason: 'lint-disabled',
    });
    assert.deepEqual(gateNamed(config, 'format').skip, {
      reason: 'format-disabled',
    });
  });

  it('runs both when absent', () => {
    const config = configWith({});
    assert.equal(gateNamed(config, 'lint').skip, undefined);
    assert.equal(gateNamed(config, 'format').skip, undefined);
  });
});

describe('runCloseValidation — disabled typecheck', () => {
  it('spawns nothing for the gate and reports it skipped', async () => {
    const gate = typecheckGate(configWith({ typecheck: null }));
    const spawned = [];
    const logs = [];
    const result = await runCloseValidation({
      cwd: WORKTREE,
      gates: [gate],
      runner: (_cmd, _args, opts) => {
        spawned.push(opts.gateName);
        return { status: 1 };
      },
      log: (line) => logs.push(line),
      useEvidence: false,
      runProjections: async () => {},
      getHeadSha: () => null,
      getTreeFingerprint: () => null,
    });
    assert.deepEqual(spawned, []);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.skipped.map((s) => [s.gate.name, s.reason]),
      [['typecheck', 'typecheck-disabled']],
    );
    assert.ok(
      logs.some((line) =>
        line.includes('⏭ typecheck skipped (typecheck-disabled)'),
      ),
    );
  });
});
