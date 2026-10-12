/**
 * Story #5637 — an explicit `project.commands.typecheck: null` disables the
 * close `typecheck` gate as a reported skip, never an `npm run typecheck`
 * fallback that fails in a repo with no such script.
 *
 * Pins, through the public seams only: the resolver's own-key `null` probe;
 * the `typecheck` gate `buildDefaultGates` registers (pre-decided skip when
 * disabled, `npm run typecheck` argv when absent or malformed, the configured
 * string when set); and that `runCloseValidation` spawns nothing for the
 * disabled gate and reports it as skipped with reason `typecheck-disabled`.
 *
 * Tier: unit. Every git / evidence / projection seam is injected; nothing
 * spawns a process or writes under temp/.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isTypecheckDisabled, resolveTypecheckCommand } from '../commands.js';
import { buildDefaultGates } from '../gates.js';
import { runCloseValidation } from '../runner.js';

const WORKTREE = path.resolve('/repo/.worktrees/story-5637');
const NO_CRAP = { quality: { gates: { crap: { enabled: false } } } };

const configWith = (commands) => ({
  project: { commands },
  delivery: NO_CRAP,
});

const typecheckGate = (config) =>
  buildDefaultGates({
    config,
    cwd: WORKTREE,
    packageScripts: { test: 'whatever' },
    presentBaselines: [],
  }).find((gate) => gate.name === 'typecheck');

describe('isTypecheckDisabled', () => {
  it('is true only for an own-present explicit null', () => {
    assert.equal(isTypecheckDisabled(configWith({ typecheck: null })), true);
  });

  it('is false when the key is absent, set, or the config is malformed', () => {
    assert.equal(isTypecheckDisabled(configWith({})), false);
    assert.equal(isTypecheckDisabled(configWith({ typecheck: 'tsc' })), false);
    assert.equal(isTypecheckDisabled(configWith(null)), false);
    assert.equal(isTypecheckDisabled({ project: null }), false);
    assert.equal(isTypecheckDisabled(null), false);
    assert.equal(isTypecheckDisabled(undefined), false);
    const inherited = Object.create({ typecheck: null });
    assert.equal(isTypecheckDisabled(configWith(inherited)), false);
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
    assert.equal(resolveTypecheckCommand(configWith({})), 'npm run typecheck');
  });

  it('keeps the fallback for a malformed config', () => {
    for (const config of [
      { project: { commands: 'nope' } },
      { project: null },
      null,
      undefined,
    ]) {
      const gate = typecheckGate(config);
      assert.equal(gate.skip, undefined);
      assert.deepEqual([gate.cmd, ...gate.args], ['npm', 'run', 'typecheck']);
    }
  });

  it('runs a configured string', () => {
    const gate = typecheckGate(configWith({ typecheck: 'tsc --noEmit' }));
    assert.equal(gate.skip, undefined);
    assert.deepEqual([gate.cmd, ...gate.args], ['tsc', '--noEmit']);
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
