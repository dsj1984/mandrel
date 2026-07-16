// tests/cli/registry.test.js
/**
 * Unit tests for lib/cli/registry.js — the mandrel doctor check registry.
 *
 * Each test drives a specific check in isolation via injectable seams so no
 * real child processes are spawned and no real filesystem is touched.
 *
 * Coverage contract (per AC):
 *   1. registry exports an ordered array of 7 check objects shaped { name, run() }
 *   2. Every required check name is present
 *   3. Each run() resolves to { ok, detail, remedy? }
 *   4. github-token check never echoes the token value
 *   5. All checks return the correct shape on both ok=true and ok=false paths
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { registry } from '../../lib/cli/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate a check by name, or throw to fail the test fast.
 *
 * @param {string} name
 */
function findCheck(name) {
  const check = registry.find((c) => c.name === name);
  assert.ok(check, `Expected a check named "${name}" in registry`);
  return check;
}

/**
 * Assert that a result conforms to { ok: boolean, detail: string, remedy?: string }.
 * When ok is false, remedy must be a non-empty string.
 *
 * @param {{ ok: unknown, detail: unknown, remedy?: unknown }} result
 * @param {{ expectOk?: boolean }} [opts]
 */
function assertResultShape(result, { expectOk } = {}) {
  assert.equal(typeof result.ok, 'boolean', 'result.ok must be boolean');
  assert.equal(typeof result.detail, 'string', 'result.detail must be string');
  assert.ok(result.detail.length > 0, 'result.detail must be non-empty');
  if (!result.ok) {
    assert.equal(
      typeof result.remedy,
      'string',
      'result.remedy must be a string when ok is false',
    );
    assert.ok(
      result.remedy.length > 0,
      'result.remedy must be non-empty when ok is false',
    );
  }
  if (expectOk !== undefined) {
    assert.equal(result.ok, expectOk, `Expected result.ok to be ${expectOk}`);
  }
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('is an array', () => {
    assert.ok(Array.isArray(registry), 'registry must be an array');
  });

  it('contains exactly 12 checks', () => {
    assert.equal(registry.length, 12);
  });

  it('every entry has a string name and a run function', () => {
    for (const check of registry) {
      assert.equal(typeof check.name, 'string', 'check.name must be a string');
      assert.ok(check.name.length > 0, 'check.name must be non-empty');
      assert.equal(
        typeof check.run,
        'function',
        `check "${check.name}".run must be a function`,
      );
    }
  });

  it('contains the required check names in order', () => {
    const expected = [
      'node-version',
      'git-available',
      'gh-available',
      'github-token',
      'gh-auth',
      'commands-in-sync',
      'agents-in-sync',
      'runtime-deps',
      'agents-materialized',
      'agents-drift',
      'pin-current',
      'version-current',
    ];
    assert.deepEqual(
      registry.map((c) => c.name),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// node-version
// ---------------------------------------------------------------------------

describe('node-version check', () => {
  it('returns ok=true for a valid node version', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '22.22.1' });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /22\.22\.1/);
  });

  it('returns ok=true for a version in range (e.g. 23.x)', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '23.0.0' });
    assertResultShape(result, { expectOk: true });
  });

  it('returns ok=false for a version below the floor', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '18.0.0' });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Upgrade Node/);
    assert.doesNotMatch(result.detail, /undefined/);
  });

  it('returns ok=false for a version at or above the ceiling', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '25.0.0' });
    assertResultShape(result, { expectOk: false });
  });
});

// ---------------------------------------------------------------------------
// git-available
// ---------------------------------------------------------------------------

describe('git-available check', () => {
  it('returns ok=true when git --version succeeds', () => {
    const check = findCheck('git-available');
    const result = check.run({
      runner: () => ({ status: 0, stdout: 'git version 2.49.0\n', stderr: '' }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.detail, 'git version 2.49.0');
  });

  it('returns ok=false when git is not on PATH (ENOENT)', () => {
    const check = findCheck('git-available');
    const result = check.run({
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install git/i);
  });

  it('returns ok=false when git exits non-zero', () => {
    const check = findCheck('git-available');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'some error' }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install git/i);
  });
});

// ---------------------------------------------------------------------------
// gh-available
// ---------------------------------------------------------------------------

describe('gh-available check', () => {
  it('returns ok=true when gh --version succeeds', () => {
    const check = findCheck('gh-available');
    const result = check.run({
      runner: () => ({
        status: 0,
        stdout:
          'gh version 2.72.0 (2025-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.72.0\n',
        stderr: '',
      }),
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /gh version/);
  });

  it('returns ok=false when gh is not on PATH (ENOENT)', () => {
    const check = findCheck('gh-available');
    const result = check.run({
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install gh/i);
  });

  it('returns ok=false when gh exits non-zero', () => {
    const check = findCheck('gh-available');
    const result = check.run({
      runner: () => ({ status: 127, stdout: '', stderr: 'command not found' }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install gh/i);
  });
});

// ---------------------------------------------------------------------------
// github-token
// ---------------------------------------------------------------------------

describe('github-token check', () => {
  // A runner stub that mimics `gh auth token` returning nothing (not
  // authenticated). Lets env-only branches assert without spawning a real gh.
  const noGhToken = () => ({
    status: 1,
    stdout: '',
    stderr: 'not logged in',
    error: undefined,
  });

  it('returns ok=true when GITHUB_TOKEN is set', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: { GITHUB_TOKEN: 'ghp_supersecret' },
      runner: noGhToken,
    });
    assertResultShape(result, { expectOk: true });
    // Token value must never appear in detail or remedy.
    assert.doesNotMatch(result.detail, /ghp_supersecret/);
    if (result.remedy) {
      assert.doesNotMatch(result.remedy, /ghp_supersecret/);
    }
  });

  it('returns ok=true when GH_TOKEN is set (env alias, parity with runtime resolver)', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: { GH_TOKEN: 'gho_aliassecret' },
      runner: noGhToken,
    });
    assertResultShape(result, { expectOk: true });
    assert.doesNotMatch(result.detail, /gho_aliassecret/);
  });

  it('returns ok=true via the `gh auth token` fallback when env is unset (Story #3893)', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: {},
      runner: (cmd, args) => {
        assert.equal(cmd, 'gh');
        assert.deepEqual(args, ['auth', 'token']);
        return {
          status: 0,
          stdout: 'ghp_resolvedviaghcli\n',
          stderr: '',
          error: undefined,
        };
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /gh auth token/);
    // The resolved token value must never leak into detail.
    assert.doesNotMatch(result.detail, /ghp_resolvedviaghcli/);
  });

  it('returns ok=false with an accurate remedy when env is unset and gh has no token', () => {
    const check = findCheck('github-token');
    const result = check.run({ env: {}, runner: noGhToken });
    assertResultShape(result, { expectOk: false });
    // Remedy must point at the path the runtime actually uses (gh auth login)
    // and must not promise a `.env` path the CLI cannot read (Finding A.4).
    assert.match(result.remedy, /gh auth login/);
    assert.doesNotMatch(result.remedy, /\.env/);
  });

  it('returns ok=false when gh CLI is missing (ENOENT) and env is unset', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: {},
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assertResultShape(result, { expectOk: false });
  });

  it('treats an empty GITHUB_TOKEN as unset and falls through to gh fallback', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: { GITHUB_TOKEN: '' },
      runner: () => ({
        status: 0,
        stdout: 'ghp_fromgh\n',
        stderr: '',
        error: undefined,
      }),
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /gh auth token/);
  });

  it('never echoes a real-looking token value in detail or remedy', () => {
    const sensitiveToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const check = findCheck('github-token');
    const result = check.run({
      env: { GITHUB_TOKEN: sensitiveToken },
      runner: noGhToken,
    });
    assert.doesNotMatch(result.detail, /ghp_/i);
    if (result.remedy) {
      assert.doesNotMatch(result.remedy, new RegExp(sensitiveToken));
    }
  });
});

// ---------------------------------------------------------------------------
// gh-auth
// ---------------------------------------------------------------------------

describe('gh-auth check', () => {
  it('returns ok=true when gh auth status succeeds and parses the username', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({
        status: 0,
        stdout: '',
        stderr: '✓ Logged in to github.com as dsj1984 (oauth_token)',
      }),
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /dsj1984/);
  });

  it('returns ok=true when gh auth status succeeds without a parseable username', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 0, stdout: 'authenticated', stderr: '' }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.detail, 'logged in');
  });

  it('returns ok=false when gh auth status exits non-zero and no env token is present', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
      env: {},
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /gh auth login/);
  });

  it('degrades to ok=true when gh auth status fails but GITHUB_TOKEN is set (CI installation token)', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: 'The token in GH_TOKEN is invalid.',
      }),
      env: { GITHUB_TOKEN: 'ghs_actions_installation_token' },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /GITHUB_TOKEN\/GH_TOKEN is set/);
    assert.equal(result.remedy, undefined);
  });

  it('degrades to ok=true when gh auth status fails but GH_TOKEN is set', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
      env: { GH_TOKEN: 'gho_some_token' },
    });
    assertResultShape(result, { expectOk: true });
  });
});

// ---------------------------------------------------------------------------
// commands-in-sync
// ---------------------------------------------------------------------------

describe('commands-in-sync check', () => {
  it('returns ok=true when sources and destinations match', () => {
    const check = findCheck('commands-in-sync');
    const files = ['epic-deliver.md', 'story-deliver.md', 'git-deliver.md'];
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => [...files],
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 commands up to date/);
  });

  it('returns ok=false when a source file is not in the destination', () => {
    const check = findCheck('commands-in-sync');
    let callCount = 0;
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => {
        callCount++;
        // First call = srcDir (2 files), second call = destDir (1 file).
        if (callCount === 1) return ['epic-deliver.md', 'story-deliver.md'];
        return ['epic-deliver.md'];
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /sync:commands/);
    assert.match(result.detail, /1 not synced/);
  });

  it('returns ok=false when the destination has a stale file not in source', () => {
    const check = findCheck('commands-in-sync');
    let callCount = 0;
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => {
        callCount++;
        if (callCount === 1) return ['epic-deliver.md'];
        return ['epic-deliver.md', 'old-command.md'];
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 stale/);
  });

  // Story #3588 — regression: without an explicit projectRoot the check MUST
  // anchor on the consumer dir (cwd()), not the package-relative
  // resolveProjectRoot() climb that lands in node_modules in a real install.
  it('defaults the root to cwd() (the consumer dir), not the package-relative climb', () => {
    const check = findCheck('commands-in-sync');
    const consumerRoot = path.join('/fake', 'consumer');
    const dirsRead = [];
    const result = check.run({
      // projectRoot intentionally omitted — exercise the default resolution.
      cwd: () => consumerRoot,
      readDir: (dir) => {
        dirsRead.push(dir);
        // Both src and dest in sync so the assertion is purely about roots.
        return ['epic-deliver.md', 'story-deliver.md'];
      },
    });
    assertResultShape(result, { expectOk: true });
    // The check must read the src/dest dirs anchored on the cwd() consumer
    // root — not a package-relative path under node_modules.
    assert.deepEqual(dirsRead, [
      path.join(consumerRoot, '.agents', 'workflows'),
      path.join(consumerRoot, '.claude', 'commands'),
    ]);
  });

  // #4482 — a workflow whose frontmatter carries `command: false` (dual-use
  // audit lens payload with a host-native standalone equivalent) is excluded
  // from projection and MUST NOT count as "not synced".
  it('excludes frontmatter `command: false` workflows from the expected set', () => {
    const check = findCheck('commands-in-sync');
    let callCount = 0;
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => {
        callCount++;
        // src has the lens + a normal workflow; dest only has the normal one.
        if (callCount === 1) return ['audit-security.md', 'epic-deliver.md'];
        return ['epic-deliver.md'];
      },
      readFile: (file) =>
        file.endsWith('audit-security.md')
          ? '---\ndescription: lens\ncommand: false\n---\n\n# Lens\n'
          : '---\ndescription: normal\n---\n\n# Normal\n',
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /1 commands up to date/);
  });
});

// ---------------------------------------------------------------------------
// agents-in-sync
// ---------------------------------------------------------------------------

describe('agents-in-sync check', () => {
  it('returns ok=true when sources and destinations match', () => {
    const check = findCheck('agents-in-sync');
    const files = ['story-worker.md', 'acceptance-critic.md', 'retro.md'];
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => [...files],
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 agents up to date/);
  });

  it('is a clean no-op when there are no agent sources or dests', () => {
    const check = findCheck('agents-in-sync');
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => [],
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /0 agents up to date/);
  });

  // Inert-scaffolding divergence (#4478 PR-2): sources present but the tree
  // was never materialized (dest empty) is advisory (ok:true), not fatal —
  // nothing spawns the role agents yet.
  it('is advisory (ok:true) when sources exist but the dest tree is empty', () => {
    const check = findCheck('agents-in-sync');
    let callCount = 0;
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => {
        callCount++;
        // First call = srcDir (3 defs), second call = destDir (empty).
        if (callCount === 1) {
          return ['story-worker.md', 'acceptance-critic.md', 'retro.md'];
        }
        return [];
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 agent def\(s\) not yet materialized/);
  });

  it('returns ok=false when a source def is not in the destination', () => {
    const check = findCheck('agents-in-sync');
    let callCount = 0;
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => {
        callCount++;
        // First call = srcDir (2 defs), second call = destDir (1 def).
        if (callCount === 1) return ['story-worker.md', 'retro.md'];
        return ['story-worker.md'];
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /sync:agents/);
    assert.match(result.detail, /1 not synced/);
  });

  it('returns ok=false when the destination has a stale def not in source', () => {
    const check = findCheck('agents-in-sync');
    let callCount = 0;
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => {
        callCount++;
        if (callCount === 1) return ['story-worker.md'];
        return ['story-worker.md', 'old-agent.md'];
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 stale/);
  });

  it('defaults the root to cwd() (the consumer dir), not the package-relative climb', () => {
    const check = findCheck('agents-in-sync');
    const consumerRoot = path.join('/fake', 'consumer');
    const dirsRead = [];
    const result = check.run({
      cwd: () => consumerRoot,
      readDir: (dir) => {
        dirsRead.push(dir);
        return ['story-worker.md'];
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.deepEqual(dirsRead, [
      path.join(consumerRoot, '.agents', 'agents'),
      path.join(consumerRoot, '.claude', 'agents'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// runtime-deps
// ---------------------------------------------------------------------------

describe('runtime-deps check', () => {
  it('returns ok=true when all required deps resolve', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['ajv', 'js-yaml'],
      resolve: () => '/fake/path/to/module',
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /all dependencies found/);
  });

  it('returns ok=false when a dep is missing', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['ajv', 'missing-pkg'],
      resolve: (dep) => {
        if (dep === 'missing-pkg') throw new Error('MODULE_NOT_FOUND');
        return '/fake/path';
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /missing-pkg/);
    // Remedy names the real cause (consumer-root resolution) and the pnpm
    // hoist fix that operators who hit this actually need.
    assert.match(result.remedy, /pnpm/i);
    assert.match(result.remedy, /hoist/i);
  });

  it('returns ok=true for an empty manifest', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({ manifestRequired: [] });
    assertResultShape(result, { expectOk: true });
  });

  it('lists all missing packages in detail and remedy', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['pkg-a', 'pkg-b'],
      resolve: () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /pkg-a/);
    assert.match(result.detail, /pkg-b/);
    assert.match(result.remedy, /pkg-a/);
    assert.match(result.remedy, /pkg-b/);
  });

  it('still resolves all deps via the real require seam (behaviour unchanged)', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['ajv'],
      resolve: () => '/fake/path/to/ajv',
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /all dependencies found/);
  });
});

// ---------------------------------------------------------------------------
// agents-materialized
// ---------------------------------------------------------------------------

describe('agents-materialized check', () => {
  it('returns ok=true when ./.agents/instructions.md exists', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: (p) => p.includes('instructions.md'),
      // resolvePackage must not be consulted on the green path; throw to prove it.
      resolvePackage: () => {
        throw new Error(
          'resolvePackage should not be called when materialized',
        );
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /materialized/);
  });

  it('returns ok=false with a `mandrel sync` remedy when the package is installed but ./.agents/ is absent', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () => '/fake/project/node_modules/mandrel/package.json',
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /mandrel sync/);
  });

  it('returns ok=false with an install remedy when neither ./.agents/ nor the package is present', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () => {
        throw Object.assign(new Error('Cannot find module'), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /npm install mandrel/);
  });

  it('does not echo file contents — detail and remedy are path/instruction only', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () => '/fake/project/node_modules/mandrel/package.json',
    });
    assert.doesNotMatch(result.detail, /\n/);
  });
});
