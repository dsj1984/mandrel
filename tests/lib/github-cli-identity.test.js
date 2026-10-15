/**
 * Story #5693 — project-local `gh` config dir, operator identity preflight,
 * and transport-vs-auth classification. Every token here is a synthetic
 * sentinel; exec and transport are mocked, so no real `gh` ever runs.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import { applyGhConfigDir } from '../../.agents/scripts/lib/config/gh-config-dir.js';
import {
  PROJECT_ROOT,
  resolveConfig,
} from '../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-schema.js';
import { validate as validateGenerated } from '../../.agents/scripts/lib/generated/agentrc-validator.js';
import {
  classify,
  createGh,
  describeGraphqlPreflight,
  exec,
  GhAuthError,
  probeGraphqlAvailability,
} from '../../.agents/scripts/lib/gh-exec.js';
import {
  __setExecSyncForTests,
  readGhCliToken,
  resolveToken,
} from '../../.agents/scripts/providers/github/auth.js';
import {
  describeTokenFailure,
  resolveTokenSource,
} from '../../.agents/scripts/providers/github/gh-token-diagnostics.js';
import { GitHubProvider } from '../../.agents/scripts/providers/github.js';

/** Synthetic sentinel — asserted absent from every diagnostic. */
const SENTINEL = 'ghp_SYNTHETICsentinelTOKEN000000000000';
const ENV_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_CONFIG_DIR',
  'MANDREL_GH_TOKEN_SOURCE',
];
const FIXTURE_ROOT = path.resolve(
  PROJECT_ROOT,
  '.worktrees/story-5693-identity-fixture',
);
const STORE = path.join(FIXTURE_ROOT, 'gh-store');

function assertNoToken(text) {
  assert.ok(!String(text).includes(SENTINEL), 'token sentinel leaked');
  assert.ok(!/ghp_[A-Za-z0-9]{8,}/.test(String(text)), 'token shape leaked');
}

let savedEnv;
let storeSeq = 0;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // The /user memo is keyed by GH_CONFIG_DIR: a fresh dir per test is a fresh probe.
  process.env.GH_CONFIG_DIR = path.join(FIXTURE_ROOT, `store-${++storeSeq}`);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setExecSyncForTests(null);
});

const BASE_CONFIG = {
  project: {
    paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  },
  github: { owner: 'o', repo: 'r', operatorHandle: '@Expected-Op' },
};

describe('AC-1 github.cliConfigDir → GH_CONFIG_DIR', () => {
  beforeEach(() => {
    delete process.env.GH_CONFIG_DIR;
  });

  it('the precompiled generated validator accepts a populated github.cliConfigDir', () => {
    const cfg = {
      ...BASE_CONFIG,
      github: { ...BASE_CONFIG.github, cliConfigDir: '/tmp' },
    };
    assert.equal(
      validateGenerated(cfg),
      true,
      JSON.stringify(validateGenerated.errors),
    );
  });

  it('the runtime validator accepts a populated github.cliConfigDir', () => {
    const validate = getAgentrcValidator();
    const cfg = {
      ...BASE_CONFIG,
      github: { ...BASE_CONFIG.github, cliConfigDir: '~/.config/gh-work' },
    };
    assert.equal(validate(cfg), true, JSON.stringify(validate.errors));
  });

  it('resolves relative paths against the root and expands a leading ~', () => {
    const home = path.join(FIXTURE_ROOT, 'home');
    const vol = new Volume();
    vol.mkdirSync(path.join(home, 'gh-work'), { recursive: true });
    vol.mkdirSync(STORE, { recursive: true });
    const deps = { fsImpl: vol, homedir: () => home, warn: () => {} };
    assert.equal(
      applyGhConfigDir({ cliConfigDir: '~/gh-work' }, FIXTURE_ROOT, deps),
      path.join(home, 'gh-work'),
    );
    assert.equal(
      applyGhConfigDir({ cliConfigDir: 'gh-store' }, FIXTURE_ROOT, deps),
      STORE,
    );
  });

  it('config resolution sets GH_CONFIG_DIR from .agentrc.local.json, and every gh child inherits it', async () => {
    const vol = new Volume();
    vol.mkdirSync(STORE, { recursive: true });
    vol.writeFileSync(
      path.join(FIXTURE_ROOT, '.agentrc.json'),
      JSON.stringify(BASE_CONFIG),
    );
    vol.writeFileSync(
      path.join(FIXTURE_ROOT, '.agentrc.local.json'),
      JSON.stringify({ github: { cliConfigDir: 'gh-store' } }),
    );
    resolveConfig({ cwd: FIXTURE_ROOT, ctx: { fs: vol } });
    assert.equal(process.env.GH_CONFIG_DIR, STORE);

    // gh-exec spawn env.
    let spawnedEnv = null;
    const spawnImpl = (_cmd, _args, opts) => {
      spawnedEnv = opts.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    await exec({ args: ['issue', 'list'], spawnImpl });
    assert.equal(spawnedEnv.GH_CONFIG_DIR, STORE);

    // `gh auth token` env.
    let tokenEnv = null;
    __setExecSyncForTests((_cmd, opts) => {
      tokenEnv = opts.env;
      return `${SENTINEL}\n`;
    });
    assert.equal(readGhCliToken().verdict, 'ok');
    assert.equal(tokenEnv.GH_CONFIG_DIR, STORE);
  });

  it('a configured directory that does not exist is a config error', () => {
    const vol = new Volume();
    vol.mkdirSync(FIXTURE_ROOT, { recursive: true });
    assert.throws(
      () =>
        applyGhConfigDir({ cliConfigDir: 'missing-store' }, FIXTURE_ROOT, {
          fsImpl: vol,
        }),
      /github\.cliConfigDir points at .*missing-store.*not an existing directory/,
    );
    assert.equal(process.env.GH_CONFIG_DIR, undefined);
  });

  it('wins over a differing inherited GH_CONFIG_DIR with one path-only warning', () => {
    const vol = new Volume();
    vol.mkdirSync(STORE, { recursive: true });
    process.env.GH_CONFIG_DIR = path.join(FIXTURE_ROOT, 'other');
    const warnings = [];
    const warn = (m) => warnings.push(m);
    applyGhConfigDir({ cliConfigDir: STORE }, FIXTURE_ROOT, {
      fsImpl: vol,
      warn,
    });
    applyGhConfigDir({ cliConfigDir: STORE }, FIXTURE_ROOT, {
      fsImpl: vol,
      warn,
    });
    assert.equal(process.env.GH_CONFIG_DIR, STORE);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /overrides the inherited GH_CONFIG_DIR/);
  });

  it('an absent key leaves the env untouched', () => {
    assert.equal(applyGhConfigDir({}, FIXTURE_ROOT), null);
    assert.equal(process.env.GH_CONFIG_DIR, undefined);
  });
});

/** Mocked gh facade: `/user` answers `login`; every call is recorded. */
function fakeGh({ login = 'expected-op', userError = null } = {}) {
  const calls = [];
  const raw = createGh(async (opts) => {
    calls.push(opts.args.join(' '));
    if (opts.args.includes('user')) {
      if (userError) throw userError;
      return { stdout: `${login}\n`, stderr: '', code: 0 };
    }
    return { stdout: '{}', stderr: '', code: 0 };
  });
  return { raw, calls };
}

function provider(gh, operatorHandle = '@Expected-Op') {
  return new GitHubProvider(
    { owner: 'o', repo: 'r', operatorHandle },
    { gh, verifyIdentity: true },
  );
}

async function mutate(p) {
  return p._gh.issue.comment(1, 'hello');
}

describe('AC-2 identity preflight before the first mutation', () => {
  it('refuses on mismatch, naming expected, actual and the config dir; no mutation is sent', async () => {
    process.env.GH_CONFIG_DIR = STORE;
    const { raw, calls } = fakeGh({ login: 'someone-else' });
    const p = provider(raw);
    await assert.rejects(mutate(p), (err) => {
      assert.equal(err.name, 'GitHubIdentityError');
      assert.equal(err.code, 'identity-mismatch');
      assert.match(err.message, /@expected-op/);
      assert.match(err.message, /@someone-else/);
      assert.ok(err.message.includes(STORE));
      assertNoToken(err.message);
      return true;
    });
    assert.deepEqual(calls, ['api -X GET user --jq .login']);
  });

  it('matches case-insensitively with a leading @ stripped, probing /user once per process', async () => {
    const { raw, calls } = fakeGh({ login: 'EXPECTED-OP' });
    const p = provider(raw);
    await mutate(p);
    await p._gh.api({
      method: 'PATCH',
      endpoint: 'repos/o/r/issues/1',
      body: {},
    });
    await provider(raw)._gh.label.create('x');
    assert.equal(calls.filter((c) => c.endsWith('user --jq .login')).length, 1);
    assert.equal(calls.length, 4);
  });

  it('reads (GET, GraphQL queries) never trigger the probe', async () => {
    const { raw, calls } = fakeGh({ login: 'someone-else' });
    const p = provider(raw);
    await p._gh.api({ endpoint: 'repos/o/r/issues' });
    await p._gh.api({
      method: 'POST',
      endpoint: 'graphql',
      body: { query: 'query{viewer{login}}' },
    });
    await p._gh.issue.view(1, ['title']);
    assert.ok(!calls.some((c) => c.includes('user --jq')));
  });

  it('a GraphQL mutation is gated', async () => {
    const { raw, calls } = fakeGh({ login: 'someone-else' });
    await assert.rejects(
      provider(raw)._gh.api({
        method: 'POST',
        endpoint: 'graphql',
        body: { query: 'mutation{x}' },
      }),
      { name: 'GitHubIdentityError' },
    );
    assert.equal(calls.length, 1);
  });

  it('writes are gated; a DELETE and a padded GraphQL mutation both probe first', async () => {
    const { raw, calls } = fakeGh({ login: 'someone-else' });
    const p = provider(raw);
    await assert.rejects(
      p._gh.api({ method: 'delete', endpoint: 'repos/o/r/labels/x' }),
      { code: 'identity-mismatch' },
    );
    await assert.rejects(
      p._gh.api({
        method: 'POST',
        endpoint: 'graphql',
        body: { query: ' mutation{a}' },
      }),
      { code: 'identity-mismatch' },
    );
    assert.deepEqual(calls, ['api -X GET user --jq .login']);
  });
});

describe('AC-3 exemptions', () => {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    it(`an env-supplied ${key} skips the identity check`, async () => {
      process.env[key] = SENTINEL;
      const { raw, calls } = fakeGh({ login: 'someone-else' });
      await mutate(provider(raw));
      assert.deepEqual(calls, ['issue comment 1 --body-file -']);
    });
  }

  it('a GITHUB_TOKEN memoised out of the gh store is still checked', async () => {
    process.env.GITHUB_TOKEN = SENTINEL;
    process.env.MANDREL_GH_TOKEN_SOURCE = 'gh-cli';
    assert.equal(resolveTokenSource(), 'gh-cli');
    const { raw } = fakeGh({ login: 'someone-else' });
    await assert.rejects(mutate(provider(raw)), {
      name: 'GitHubIdentityError',
      code: 'identity-mismatch',
    });
  });

  for (const handle of [null, '@[USERNAME]', '@']) {
    it(`operatorHandle ${JSON.stringify(handle)} skips the identity check`, async () => {
      const { raw, calls } = fakeGh({ login: 'someone-else' });
      await mutate(provider(raw, handle));
      assert.deepEqual(calls, ['issue comment 1 --body-file -']);
    });
  }
});

describe('AC-4 transport is never read as expired auth', () => {
  it('a sandboxed `gh auth token` spawn yields a transport diagnostic without `gh auth login`', () => {
    __setExecSyncForTests(() => {
      throw Object.assign(new Error('spawnSync /bin/sh EPERM'), {
        code: 'EPERM',
      });
    });
    const result = readGhCliToken();
    assert.equal(result.verdict, 'transport');
    assert.throws(resolveToken, (err) => {
      assert.match(err.message, /sandbox or network fault/);
      assert.match(err.message, /re-authenticating will not help/);
      assert.doesNotMatch(err.message, /gh auth login/);
      return true;
    });
  });

  it('a timed-out or network-failed `gh auth token` is transport', () => {
    __setExecSyncForTests(() => {
      throw Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      });
    });
    assert.equal(readGhCliToken().verdict, 'transport');
    __setExecSyncForTests(() => {
      throw Object.assign(new Error('Command failed'), {
        status: 1,
        stderr: 'error connecting to api.github.com',
      });
    });
    assert.equal(readGhCliToken().verdict, 'transport');
  });

  it('only a confirmed not-logged-in result carries `gh auth login`', () => {
    __setExecSyncForTests(() => {
      throw Object.assign(new Error('Command failed'), {
        status: 1,
        stderr: 'no oauth token found for github.com',
      });
    });
    const result = readGhCliToken();
    assert.equal(result.verdict, 'auth-rejected');
    assert.match(describeTokenFailure(result), /gh auth login/);
    for (const verdict of ['transport', 'not-installed', 'unknown']) {
      assert.doesNotMatch(
        describeTokenFailure({ verdict, detail: null }),
        /gh auth login/,
      );
    }
  });

  it('a transport failure on the /user probe is reported as transport, not mismatch', async () => {
    const userError = classify({
      args: ['api'],
      code: 1,
      stderr: 'dial tcp: lookup api.github.com: no such host',
    });
    assert.equal(userError.name, 'GhTransportError');
    const { raw, calls } = fakeGh({ userError });
    await assert.rejects(mutate(provider(raw)), (err) => {
      assert.equal(err.code, 'identity-transport');
      assert.doesNotMatch(err.message, /gh auth login/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('a 401 on the /user probe carries the re-authentication remedy', async () => {
    const userError = classify({
      args: ['api'],
      code: 1,
      stderr: 'HTTP 401: Bad credentials',
    });
    assert.ok(userError instanceof GhAuthError);
    const { raw } = fakeGh({ userError });
    await assert.rejects(mutate(provider(raw)), (err) => {
      assert.equal(err.code, 'identity-auth');
      assert.match(err.message, /gh auth login/);
      return true;
    });
  });

  it('a sandbox-denied gh spawn classifies as transport', () => {
    const err = classify({
      args: ['api'],
      spawnError: Object.assign(new Error('x'), { code: 'EPERM' }),
    });
    assert.equal(err.name, 'GhTransportError');
    assert.doesNotMatch(err.message, /gh auth login/);
  });

  it('the GraphQL preflight never gives a transport failure the auth-failed copy', async () => {
    const failing = {
      api: async () => {
        throw classify({
          args: ['api'],
          code: 1,
          stderr: 'error connecting to api.github.com',
        });
      },
    };
    const probe = await probeGraphqlAvailability({ ghFacade: failing });
    assert.notEqual(probe.verdict, 'auth-failed');
    assert.equal(probe.reason, 'transport-inconclusive');
    assert.doesNotMatch(describeGraphqlPreflight(probe), /gh auth login/);
  });
});

describe('AC-6 no token in any diagnostic', () => {
  it('redacts a token-shaped string gh echoes into stderr', () => {
    __setExecSyncForTests(() => {
      throw Object.assign(new Error('Command failed'), {
        status: 1,
        stderr: `unexpected value ${SENTINEL}`,
      });
    });
    const result = readGhCliToken();
    assertNoToken(result.detail);
    assertNoToken(describeTokenFailure(result));
  });

  it('a mismatch diagnostic with an env-memoised token never carries it', async () => {
    process.env.GITHUB_TOKEN = SENTINEL;
    process.env.MANDREL_GH_TOKEN_SOURCE = 'gh-cli';
    const userError = Object.assign(new Error(`boom ${SENTINEL}`), {
      stderr: `HTTP 500 ${SENTINEL}`,
    });
    const { raw } = fakeGh({ userError });
    await assert.rejects(mutate(provider(raw)), (err) => {
      assertNoToken(err.message);
      return true;
    });
  });
});
