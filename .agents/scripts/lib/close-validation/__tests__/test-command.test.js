/**
 * Story #5582 — `project.commands.test` is the close `test` gate's command
 * and the one identity every `test` credit hashes.
 *
 * Pins, through the public seams only: the resolver's fallback and trim; the
 * argv `buildDefaultGates` registers for the plain `test` gate; and that the
 * deposit (`depositTestRunCredit`), close's probe (`predictsTestEvidenceCredit`)
 * and `verify[]` credit (`resolveVerifyCredit`) all hash that same argv —
 * byte-identical to `npm test` while the key is unset, so existing credits
 * stay valid. The schema half pins that the key rejects shell composition
 * exactly as its sibling `commands.*` keys do.
 *
 * Tier: unit. Every git / evidence seam is injected; nothing spawns a
 * process or writes under temp/.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getAgentrcValidator } from '../../config-settings-schema.js';
import { resolveVerifyCredit } from '../../orchestration/verify-credit.js';
import {
  depositTestRunCredit,
  predictsTestEvidenceCredit,
} from '../../test-run-credit.js';
import { hashCommandConfig } from '../../validation-evidence.js';
import { resolveTestCommand, resolveTestGateArgv } from '../commands.js';
import { buildDefaultGates } from '../gates.js';

const PYTHON_SUITE = 'python3 scripts/validation.py';
const REPO = path.resolve('/repo');
const WORKTREE = path.join(REPO, '.worktrees', 'story-5582');

const configWith = (test) => ({
  project: { commands: test === undefined ? {} : { test } },
  delivery: { quality: { gates: { crap: { enabled: false } } } },
});

/** Answers the git questions the depositor and probes ask. */
const git = (_cwd, ...args) => {
  const answers = {
    'rev-parse --abbrev-ref HEAD': 'story-5582',
    'rev-parse HEAD': 'a'.repeat(40),
    'rev-parse HEAD^{tree}': 'b'.repeat(40),
    'rev-parse --git-common-dir': path.join(REPO, '.git'),
  };
  const out = answers[args.join(' ')];
  return out === undefined
    ? { status: 128, stdout: '' }
    : { status: 0, stdout: `${out}\n` };
};

const testGate = (config) =>
  buildDefaultGates({
    config,
    cwd: WORKTREE,
    packageScripts: { test: 'whatever' },
    presentBaselines: [],
  }).find((gate) => gate.name === 'test');

/** The configHash each credit path computes for `config`. */
function creditHashes(config) {
  const hashes = {};
  depositTestRunCredit({
    cwd: WORKTREE,
    config,
    gitSpawnFn: git,
    recordPassFn: (record) => {
      hashes.deposit = record.configHash;
    },
  });
  predictsTestEvidenceCredit({
    config,
    storyId: 5582,
    cwd: WORKTREE,
    gitSpawnImpl: git,
    shouldSkipImpl: (input) => {
      hashes.probe = input.configHash;
      return { skip: false, reason: 'probe' };
    },
  });
  resolveVerifyCredit(
    { command: 'npm test', storyId: 5582, worktree: WORKTREE },
    {
      resolveConfigImpl: () => config,
      readPackageScriptsImpl: () => ({}),
      gitSpawnFn: git,
      shouldSkipImpl: (input) => {
        hashes.verify = input.configHash;
        return { skip: false, reason: 'probe' };
      },
    },
  );
  return hashes;
}

describe('resolveTestCommand', () => {
  it('falls back to npm test when unset, empty or the config is malformed', () => {
    assert.equal(resolveTestCommand(configWith(undefined)), 'npm test');
    assert.equal(resolveTestCommand(configWith('   ')), 'npm test');
    assert.equal(resolveTestCommand(null), 'npm test');
  });

  it('returns the configured command, trimmed', () => {
    assert.equal(
      resolveTestCommand(configWith(` ${PYTHON_SUITE} `)),
      PYTHON_SUITE,
    );
    assert.deepEqual(resolveTestGateArgv(configWith(PYTHON_SUITE)), {
      cmd: 'python3',
      args: ['scripts/validation.py'],
    });
  });
});

describe('close test gate argv (AC-1, AC-2)', () => {
  it('spawns the configured command', () => {
    const gate = testGate(configWith(PYTHON_SUITE));
    assert.equal(gate.cmd, 'python3');
    assert.deepEqual(gate.args, ['scripts/validation.py']);
    assert.equal(gate.fullSuiteLock, true);
  });

  it('spawns npm test, unchanged, when the key is unset', () => {
    const gate = testGate(configWith(undefined));
    assert.equal(gate.cmd, 'npm');
    assert.deepEqual(gate.args, ['test']);
  });
});

describe('test credit identity (AC-1, AC-2)', () => {
  it('every credit path hashes the argv close spawns for a configured command', () => {
    const config = configWith(PYTHON_SUITE);
    const gate = testGate(config);
    const closeHash = hashCommandConfig({
      cmd: gate.cmd,
      args: gate.args,
      cwd: WORKTREE,
    });
    const hashes = creditHashes(config);
    assert.equal(hashes.deposit, closeHash);
    assert.equal(hashes.probe, closeHash);
    assert.equal(hashes.verify, closeHash);
  });

  it('every credit hash is the npm test hash of today when the key is unset', () => {
    const npmTestHash = hashCommandConfig({
      cmd: 'npm',
      args: ['test'],
      cwd: WORKTREE,
    });
    const hashes = creditHashes(configWith(undefined));
    assert.deepEqual(hashes, {
      deposit: npmTestHash,
      probe: npmTestHash,
      verify: npmTestHash,
    });
  });
});

describe('commands.test schema (AC-4)', () => {
  const validate = getAgentrcValidator();
  const agentrc = (commands) => ({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      commands,
    },
  });

  it('accepts a single-argv command', () => {
    assert.equal(validate(agentrc({ test: PYTHON_SUITE })), true);
  });

  for (const composed of [
    'npm test; rm -rf .',
    'npm test && echo ok',
    'npm test | tee log',
    'npm test `id`',
    'npm test $(id)',
  ]) {
    it(`rejects ${JSON.stringify(composed)} as the lint key does`, () => {
      assert.equal(validate(agentrc({ test: composed })), false);
      assert.equal(validate(agentrc({ lint: composed })), false);
    });
  }
});
