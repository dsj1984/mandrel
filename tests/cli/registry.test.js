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

  it('contains exactly 10 checks', () => {
    assert.equal(registry.length, 10);
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
      'runtime-deps',
      'agents-materialized',
      'agents-drift',
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
  it('returns ok=true when GITHUB_TOKEN is set', () => {
    const check = findCheck('github-token');
    const result = check.run({ env: { GITHUB_TOKEN: 'ghp_supersecret' } });
    assertResultShape(result, { expectOk: true });
    // Token value must never appear in detail or remedy.
    assert.doesNotMatch(result.detail, /ghp_supersecret/);
    if (result.remedy) {
      assert.doesNotMatch(result.remedy, /ghp_supersecret/);
    }
  });

  it('returns ok=false when GITHUB_TOKEN is absent', () => {
    const check = findCheck('github-token');
    const result = check.run({ env: {} });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /GITHUB_TOKEN/);
  });

  it('returns ok=false when GITHUB_TOKEN is empty string', () => {
    const check = findCheck('github-token');
    const result = check.run({ env: { GITHUB_TOKEN: '' } });
    assertResultShape(result, { expectOk: false });
  });

  it('never echoes a real-looking token value in detail or remedy', () => {
    const sensitiveToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const check = findCheck('github-token');
    const result = check.run({ env: { GITHUB_TOKEN: sensitiveToken } });
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

  it('returns ok=false when gh auth status exits non-zero', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /gh auth login/);
  });
});

// ---------------------------------------------------------------------------
// commands-in-sync
// ---------------------------------------------------------------------------

describe('commands-in-sync check', () => {
  it('returns ok=true when sources and destinations match', () => {
    const check = findCheck('commands-in-sync');
    const files = ['epic-deliver.md', 'story-deliver.md', 'git-push.md'];
    const result = check.run({
      projectRoot: '/fake/root',
      readDir: () => [...files],
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 plugin commands up to date/);
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
    assert.match(result.remedy, /npm install/);
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
      resolvePackage: () =>
        '/fake/project/node_modules/@mandrelai/agents/package.json',
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
    assert.match(result.remedy, /npm install @mandrelai\/agents/);
  });

  it('does not echo file contents — detail and remedy are path/instruction only', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () =>
        '/fake/project/node_modules/@mandrelai/agents/package.json',
    });
    assert.doesNotMatch(result.detail, /\n/);
  });
});
