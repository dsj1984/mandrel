// tests/scripts/ceremony-derive.test.js
//
// Story #5313 — `ceremony-derive.js` replaces the three-module import block
// the deliver digest used to hand the worker. The contract is one JSON object
// carrying `files`, `level`, `classes`, `mode`, `reason` and `verdictOwner`,
// computed from the branch rather than recalled — and the `--help` contract
// every `.agents/scripts` CLI owes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveCeremony,
  parseArgv,
  runCeremonyDeriveCli,
} from '../../.agents/scripts/ceremony-derive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'ceremony-derive.js');

/** A change-set seam that never touches git. */
const changeSetOf = (files) => () => ({
  baseRef: 'main',
  headRef: 'story-1',
  files,
  enumerated: files !== null,
});

describe('parseArgv', () => {
  test('reads --story as a positive integer, with optional --base and --cwd', () => {
    assert.deepEqual(
      parseArgv(['--story', '42', '--base', 'develop', '--cwd', '/x']),
      { storyId: 42, base: 'develop', cwd: '/x' },
    );
    assert.deepEqual(parseArgv(['--story', '7']), {
      storyId: 7,
      base: null,
      cwd: null,
    });
  });

  test('a missing or malformed --story resolves to null', () => {
    for (const argv of [[], ['--story', 'x'], ['--story', '0'], ['--story']]) {
      assert.equal(parseArgv(argv).storyId, null, JSON.stringify(argv));
    }
  });
});

describe('deriveCeremony — one change set, one decision', () => {
  test('AC-3: carries files, level, classes, mode, reason and verdictOwner', () => {
    const out = deriveCeremony(
      {
        storyId: 1,
        baseRef: 'main',
        cwd: '/repo',
        ceremonyProfile: 'standard',
      },
      {
        computeChangeSetImpl: changeSetOf(['docs/onboarding.md']),
        deriveChangeLevelImpl: () => ({ level: 'low', classes: [] }),
      },
    );
    for (const key of [
      'files',
      'level',
      'classes',
      'mode',
      'reason',
      'verdictOwner',
    ]) {
      assert.ok(key in out, `envelope must carry ${key}`);
    }
    assert.deepEqual(out.files, ['docs/onboarding.md']);
    assert.equal(out.level, 'low');
    assert.equal(out.mode, 'inline');
    assert.equal(out.verdictOwner, 'inline-self-eval');
    assert.equal(out.headRef, 'story-1');
  });

  test('hands the level STRING to the ceremony resolver, never the object', () => {
    const seen = [];
    deriveCeremony(
      {
        storyId: 1,
        baseRef: 'main',
        cwd: '/repo',
        ceremonyProfile: 'standard',
      },
      {
        computeChangeSetImpl: changeSetOf(['lib/a.js']),
        deriveChangeLevelImpl: () => ({ level: 'high', classes: ['security'] }),
        resolveCeremonyImpl: (input) => {
          seen.push(input);
          return {
            mode: 'fresh',
            reason: 'r',
            profile: 'standard',
            verdictOwner: 'fresh-critic',
          };
        },
      },
    );
    assert.equal(seen[0].derivedLevel, 'high');
    assert.equal(seen[0].ceremonyProfile, 'standard');
  });

  test('an unenumerable diff routes to the fail-safe fresh critic', () => {
    const out = deriveCeremony(
      {
        storyId: 1,
        baseRef: 'main',
        cwd: '/repo',
        ceremonyProfile: 'standard',
      },
      { computeChangeSetImpl: changeSetOf(null) },
    );
    assert.equal(out.files, null);
    assert.equal(out.enumerated, false);
    assert.equal(out.level, null);
    assert.equal(out.mode, 'fresh');
    assert.match(out.reason, /underivable/);
  });

  test('a sensitive path derives high and a fresh critic through the real level derivation', () => {
    const out = deriveCeremony(
      {
        storyId: 1,
        baseRef: 'main',
        cwd: '/repo',
        ceremonyProfile: 'standard',
      },
      {
        computeChangeSetImpl: changeSetOf(['lib/migrations/steps/x.js']),
      },
    );
    assert.equal(out.level, 'high');
    assert.ok(out.classes.length > 0);
    assert.equal(out.mode, 'fresh');
    assert.equal(out.verdictOwner, 'fresh-critic');
  });
});

describe('runCeremonyDeriveCli', () => {
  test('prints exactly one JSON object and defaults the base to project.baseBranch', async () => {
    const out = [];
    const envelope = await runCeremonyDeriveCli(['--story', '5'], {
      resolveConfigImpl: () => ({
        project: { baseBranch: 'trunk' },
        delivery: { routing: { ceremonyProfile: 'strict' } },
      }),
      stdout: { write: (s) => out.push(s) },
      cwd: '/repo',
      computeChangeSetImpl: (args) => {
        assert.equal(args.baseRef, 'trunk');
        assert.equal(args.headRef, 'story-5');
        assert.equal(args.cwd, '/repo');
        return changeSetOf(['README.md'])();
      },
    });
    assert.equal(out.length, 1);
    assert.deepEqual(JSON.parse(out[0]), envelope);
    assert.equal(envelope.mode, 'fresh', 'strict profile → fresh');
    assert.equal(envelope.baseRef, 'trunk');
  });

  test('--base overrides the configured base branch', async () => {
    const envelope = await runCeremonyDeriveCli(
      ['--story', '5', '--base', 'release'],
      {
        resolveConfigImpl: () => ({ project: { baseBranch: 'main' } }),
        stdout: { write: () => {} },
        computeChangeSetImpl: changeSetOf([]),
      },
    );
    assert.equal(envelope.baseRef, 'release');
  });

  test('refuses a missing --story', async () => {
    await assert.rejects(
      () => runCeremonyDeriveCli([], { stdout: { write: () => {} } }),
      /--story <id> is required/,
    );
  });
});

describe('the --help contract', () => {
  test('prints a usage block with the flag rows and exits 0 without deriving', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(
      res.stdout,
      /^Usage: node \.agents\/scripts\/ceremony-derive\.js/,
    );
    assert.match(res.stdout, /--story <id>/);
    assert.match(res.stdout, /--base <ref>/);
    assert.doesNotMatch(res.stdout, /"files"/, 'help must not derive');
  });
});
