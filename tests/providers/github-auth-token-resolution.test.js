/**
 * Token precedence contract for `providers/github/auth.js`: GITHUB_TOKEN, then
 * GH_TOKEN, then `gh auth token` through `execSyncHolder`, then no token (a
 * classified throw). A CLI-resolved token is written back to the env once, so
 * the second resolve never shells out again. Every token here is a sentinel;
 * assertions compare by identity and never print one.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  __setExecSyncForTests,
  execSyncHolder,
  readGhCliToken,
  resolveToken,
} from '../../.agents/scripts/providers/github/auth.js';
import { TOKEN_SOURCE_ENV } from '../../.agents/scripts/providers/github/gh-token-diagnostics.js';

const KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', TOKEN_SOURCE_ENV];
const ENV_SENTINEL = 'sentinel-env-value';
const ALT_SENTINEL = 'sentinel-alt-value';
const CLI_SENTINEL = 'sentinel-cli-value';

/** An exec stub that counts calls and answers with `out` (or throws it). */
function stubGh(out) {
  const calls = [];
  __setExecSyncForTests((file, args) => {
    calls.push([file, ...args].join(' '));
    if (out instanceof Error) throw out;
    return out;
  });
  return calls;
}

describe('GitHub token resolution precedence', () => {
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __setExecSyncForTests(null);
  });

  it('GITHUB_TOKEN wins over GH_TOKEN and never reaches the gh CLI', () => {
    process.env.GITHUB_TOKEN = ENV_SENTINEL;
    process.env.GH_TOKEN = ALT_SENTINEL;
    const calls = stubGh(`${CLI_SENTINEL}\n`);
    assert.ok(resolveToken() === ENV_SENTINEL, 'GITHUB_TOKEN resolves first');
    assert.equal(calls.length, 0);
  });

  it('GH_TOKEN is read when GITHUB_TOKEN is unset', () => {
    process.env.GH_TOKEN = ALT_SENTINEL;
    const calls = stubGh(`${CLI_SENTINEL}\n`);
    assert.ok(resolveToken() === ALT_SENTINEL, 'GH_TOKEN resolves second');
    assert.equal(calls.length, 0);
  });

  it('falls back to `gh auth token` and writes the result back to the env once', () => {
    const calls = stubGh(`${CLI_SENTINEL}\n`);
    assert.ok(resolveToken() === CLI_SENTINEL, 'gh CLI token resolves third');
    assert.ok(process.env.GITHUB_TOKEN === CLI_SENTINEL, 'memoised to env');
    assert.equal(process.env[TOKEN_SOURCE_ENV], 'gh-cli');
    assert.ok(resolveToken() === CLI_SENTINEL, 'second resolve reads env');
    assert.deepEqual(calls, ['gh auth token']);
  });

  it('resolves to no token when gh prints nothing, and throws without writing the env', () => {
    stubGh('  \n');
    assert.equal(readGhCliToken().token, null);
    assert.throws(() => resolveToken(), /Authentication Failed/);
    assert.equal(process.env.GITHUB_TOKEN, undefined);
    assert.equal(process.env[TOKEN_SOURCE_ENV], undefined);
  });

  it('a gh failure carries a classified verdict and no token', () => {
    stubGh(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const got = readGhCliToken();
    assert.equal(got.token, null);
    assert.equal(got.verdict, 'not-installed');
    assert.equal(typeof execSyncHolder.impl, 'function');
  });
});
