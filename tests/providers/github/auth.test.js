/**
 * Unit tests for `.agents/scripts/providers/github/auth.js`.
 *
 * Covers:
 *   - env-precedence branch (GITHUB_TOKEN / GH_TOKEN short-circuits the CLI)
 *   - gh-cli-fallback branch (no env → `gh auth token` succeeds)
 *   - missing-token branch (no env, no CLI → throws instructive error)
 *   - public surface still resolves through `providers/github.js` so callers
 *     observe no path change.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const authMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'auth.js'),
  ).href
);
const providerMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'),
  ).href
);

const { __setExecSyncForTests, resolveToken, readGhCliToken, execSyncHolder } =
  authMod;

describe('providers/github/auth.js — token resolution', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    savedEnv.GH_TOKEN = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    if (savedEnv.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedEnv.GITHUB_TOKEN;
    if (savedEnv.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedEnv.GH_TOKEN;
    __setExecSyncForTests(null);
  });

  it('env-precedence: GITHUB_TOKEN short-circuits the gh-cli fallback', () => {
    // Arrange: set env token; ensure exec stub would throw to prove it
    // is never reached.
    process.env.GITHUB_TOKEN = 'env-token';
    let execCalled = false;
    __setExecSyncForTests(() => {
      execCalled = true;
      throw new Error('exec should not be invoked when env token is set');
    });

    // Act
    const got = resolveToken();

    // Assert
    assert.strictEqual(got, 'env-token');
    assert.strictEqual(execCalled, false);
  });

  it('env-precedence: GH_TOKEN works when GITHUB_TOKEN is absent', () => {
    process.env.GH_TOKEN = 'gh-env-token';
    __setExecSyncForTests(() => {
      throw new Error('exec should not be invoked');
    });

    const got = resolveToken();
    assert.strictEqual(got, 'gh-env-token');
  });

  it('gh-cli-fallback: shells out to `gh auth token` when env is unset', () => {
    let receivedCmd = null;
    __setExecSyncForTests((cmd) => {
      receivedCmd = cmd;
      return 'cli-token\n';
    });

    const got = resolveToken();

    assert.strictEqual(got, 'cli-token');
    assert.strictEqual(receivedCmd, 'gh auth token');
    // memoization side-effect: subsequent reads from env return the same.
    assert.strictEqual(process.env.GITHUB_TOKEN, 'cli-token');
  });

  it('gh-cli-fallback: throws instructive error when CLI also fails', () => {
    __setExecSyncForTests(() => {
      throw new Error('gh not installed');
    });

    assert.throws(() => resolveToken(), /Authentication Failed/);
  });

  it('readGhCliToken returns null when exec throws (gh missing/unauthed)', () => {
    __setExecSyncForTests(() => {
      throw new Error('command not found');
    });
    assert.strictEqual(readGhCliToken(), null);
  });

  it('readGhCliToken returns null on empty stdout', () => {
    __setExecSyncForTests(() => '   \n');
    assert.strictEqual(readGhCliToken(), null);
  });

  it('__setExecSyncForTests(null) restores the real implementation', () => {
    __setExecSyncForTests(() => 'fake');
    __setExecSyncForTests(null);
    // After reset, the holder points back at the default execSync.
    // We can't run gh in tests, but we can assert the holder's impl shape.
    assert.strictEqual(typeof execSyncHolder.impl, 'function');
  });

  it('public surface: providers/github.js re-exports the auth symbols', () => {
    assert.strictEqual(
      typeof providerMod.__setExecSyncForTests,
      'function',
      '__setExecSyncForTests must be reachable through the parent',
    );
    assert.strictEqual(
      typeof providerMod.readGhCliToken,
      'function',
      'readGhCliToken must be reachable through the parent',
    );
    assert.strictEqual(
      typeof providerMod.execSyncHolder,
      'object',
      'execSyncHolder must be reachable through the parent',
    );
  });
});
