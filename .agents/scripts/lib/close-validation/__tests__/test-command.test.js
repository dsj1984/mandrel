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

import {
  COMMANDS_DEFAULTS,
  OPTIONAL_COMMAND_KEYS,
  resolveProjectCommand,
} from '../../config/commands.js';
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
  it('defaults to npm test when unset or there is no config', () => {
    assert.equal(resolveTestCommand(configWith(undefined)), 'npm test');
    assert.equal(resolveTestCommand(null), 'npm test');
    assert.equal(resolveTestCommand({ project: null }), 'npm test');
  });

  it('throws, never falls back, on a blank, null or non-string test', () => {
    for (const test of ['   ', null, 42]) {
      assert.throws(
        () => resolveTestCommand(configWith(test)),
        /project\.commands\.test/,
      );
    }
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

describe('resolveProjectCommand — one tri-state for every key (Story #5737 AC-1)', () => {
  const withCommands = (commands) => ({ project: { commands } });
  const KEYS = Object.keys(COMMANDS_DEFAULTS);

  it('absent → the default, for every key', () => {
    for (const key of KEYS) {
      const resolved = resolveProjectCommand(withCommands({}), key);
      assert.equal(resolved.source, 'default');
      assert.equal(resolved.disabled, false);
      assert.equal(resolved.raw, COMMANDS_DEFAULTS[key]);
      assert.deepEqual(resolved.argv, COMMANDS_DEFAULTS[key].split(' '));
    }
  });

  it('a string → that command, trimmed and split, for every key', () => {
    for (const key of KEYS) {
      const resolved = resolveProjectCommand(
        withCommands({ [key]: ' tool --flag x ' }),
        key,
      );
      assert.equal(resolved.source, 'config');
      assert.equal(resolved.raw, 'tool --flag x');
      assert.deepEqual(resolved.argv, ['tool', '--flag', 'x']);
    }
  });

  it('own-present null → disabled for typecheck, lint and formatCheck only', () => {
    assert.deepEqual(OPTIONAL_COMMAND_KEYS, [
      'typecheck',
      'lint',
      'formatCheck',
    ]);
    for (const key of KEYS) {
      const config = withCommands({ [key]: null });
      if (OPTIONAL_COMMAND_KEYS.includes(key)) {
        assert.deepEqual(resolveProjectCommand(config, key), {
          argv: [],
          raw: null,
          disabled: true,
          source: 'disabled',
        });
      } else {
        assert.throws(() => resolveProjectCommand(config, key), /mandatory/);
      }
    }
  });

  it('an inherited null is not own-present, so it stays the default', () => {
    const commands = Object.create({ typecheck: null });
    assert.equal(
      resolveProjectCommand(withCommands(commands), 'typecheck').source,
      'default',
    );
  });

  it('a non-object project.commands or an unknown key throws', () => {
    for (const commands of [null, 'nope', ['npm test']]) {
      assert.throws(
        () => resolveProjectCommand(withCommands(commands), 'test'),
        /project\.commands must be an object/,
      );
    }
    assert.throws(
      () => resolveProjectCommand(withCommands({}), 'deploy'),
      /not a known command/,
    );
  });

  it('the schema rejects test: null and a non-object block, and accepts the optional nulls', () => {
    const validate = getAgentrcValidator();
    const paths = { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' };
    const valid = (commands) => validate({ project: { paths, commands } });
    assert.equal(valid({ test: null }), false);
    assert.equal(valid({ formatWrite: null }), false);
    assert.equal(valid('npm test'), false);
    assert.equal(
      valid({ typecheck: null, lint: null, formatCheck: null }),
      true,
    );
  });
});
