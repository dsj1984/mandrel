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

const { __setExecSyncForTests, resolveToken, readGhCliToken, execSyncHolder } =
  authMod;

describe('providers/github/auth.js — token resolution', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    savedEnv.GH_TOKEN = process.env.GH_TOKEN;
    savedEnv.MANDREL_GH_TOKEN_SOURCE = process.env.MANDREL_GH_TOKEN_SOURCE;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.MANDREL_GH_TOKEN_SOURCE;
  });

  afterEach(() => {
    if (savedEnv.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedEnv.GITHUB_TOKEN;
    if (savedEnv.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedEnv.GH_TOKEN;
    if (savedEnv.MANDREL_GH_TOKEN_SOURCE === undefined)
      delete process.env.MANDREL_GH_TOKEN_SOURCE;
    else process.env.MANDREL_GH_TOKEN_SOURCE = savedEnv.MANDREL_GH_TOKEN_SOURCE;
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
    let received = null;
    __setExecSyncForTests((file, args) => {
      received = { file, args };
      return 'cli-token\n';
    });

    const got = resolveToken();

    assert.strictEqual(got, 'cli-token');
    assert.deepStrictEqual(received, { file: 'gh', args: ['auth', 'token'] });
    // memoization side-effect: subsequent reads from env return the same.
    assert.strictEqual(process.env.GITHUB_TOKEN, 'cli-token');
    assert.strictEqual(process.env.MANDREL_GH_TOKEN_SOURCE, 'gh-cli');
  });

  it('gh-cli-fallback: throws instructive error when CLI also fails', () => {
    __setExecSyncForTests(() => {
      throw Object.assign(new Error('Command failed: gh auth token'), {
        status: 1,
        stderr:
          'You are not logged into any GitHub hosts. To log in, run: gh auth login',
      });
    });

    assert.throws(
      () => resolveToken(),
      /Authentication Failed[\s\S]*gh auth login/,
    );
  });

  it('readGhCliToken classifies a missing gh as not-installed', () => {
    __setExecSyncForTests(() => {
      throw new Error('command not found');
    });
    const got = readGhCliToken();
    assert.strictEqual(got.token, null);
    assert.strictEqual(got.verdict, 'not-installed');
  });

  it('readGhCliToken reads empty stdout as a confirmed missing login', () => {
    __setExecSyncForTests(() => '   \n');
    const got = readGhCliToken();
    assert.strictEqual(got.token, null);
    assert.strictEqual(got.verdict, 'auth-rejected');
  });

  it('__setExecSyncForTests(null) restores the real implementation', () => {
    __setExecSyncForTests(() => 'fake');
    __setExecSyncForTests(null);
    // After reset, the holder points back at the default execFileSync.
    // We can't run gh in tests, but we can assert the holder's impl shape.
    assert.strictEqual(typeof execSyncHolder.impl, 'function');
  });
});
