// tests/cli/ui-accounts.test.js — the board's account probes: the GitHub
// login, the whitelisted Claude account, the 60 s reuse and no logging.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createAccountProbe } from '../../lib/cli/ui/accounts.js';

const STATUS = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'dev@example.test',
  orgId: 'org-uuid-secret',
  orgName: 'Example Org',
  subscriptionType: 'max',
  planTier: 'tier-x',
  configDirectory: 'config-dir-value',
  projectsDirectory: 'projects-dir-value',
  loginExpiresAt: '2030-01-01T00:00:00Z',
};

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

/** A runner answering `gh api user` and `claude auth status`, recording calls. */
function fakeRunner({
  gh = ok('octocat\n'),
  claude = ok(JSON.stringify(STATUS)),
} = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return cmd === 'gh' ? gh : claude;
  };
  return { runner, calls };
}

const probe = (runner, extra = {}) =>
  createAccountProbe({ env: {}, runner, ...extra })();

describe('AC-1: the GitHub login', () => {
  it('reads the login from `gh api user` with a 10 s timeout', async () => {
    const { runner, calls } = fakeRunner();
    const result = await probe(runner);
    assert.deepEqual(result.github, { login: 'octocat' });
    const gh = calls.find((c) => c.cmd === 'gh');
    assert.deepEqual(gh.args, ['api', 'user', '--jq', '.login']);
    assert.equal(gh.opts.timeout, 10_000);
  });

  it('is null with login-unavailable on failure or a malformed login', async () => {
    for (const gh of [
      { status: 1, stdout: '', stderr: 'HTTP 401' },
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT') },
      ok('not a login\n'),
      ok(''),
    ]) {
      const { runner } = fakeRunner({ gh });
      assert.deepEqual((await probe(runner)).github, {
        login: null,
        reason: 'login-unavailable',
      });
    }
  });
});

describe('AC-2: the Claude account', () => {
  it('forwards only email, org name, plan and login method', async () => {
    const { runner, calls } = fakeRunner();
    const { claude } = await probe(runner);
    assert.deepEqual(claude, {
      email: 'dev@example.test',
      orgName: 'Example Org',
      subscriptionType: 'max',
      authMethod: 'claude.ai',
    });
    const call = calls.find((c) => c.cmd === 'claude');
    assert.deepEqual(call.args, ['auth', 'status', '--json']);
    assert.equal(call.opts.timeout, 10_000);
  });

  it('adds the API provider only when it is not first-party', async () => {
    const { runner } = fakeRunner({
      claude: ok(JSON.stringify({ ...STATUS, apiProvider: 'bedrock' })),
    });
    assert.equal((await probe(runner)).claude.apiProvider, 'bedrock');
  });

  it('is null when logged out, unparseable or failing', async () => {
    for (const claude of [
      ok(JSON.stringify({ ...STATUS, loggedIn: false })),
      ok('not json'),
      { status: 1, stdout: '', stderr: '' },
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT') },
    ]) {
      const { runner } = fakeRunner({ claude });
      assert.equal((await probe(runner)).claude, null);
    }
  });
});

describe('AC-3: reuse and logging', () => {
  let logged;
  const saved = {};
  beforeEach(() => {
    logged = [];
    for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
      saved[name] = console[name];
      console[name] = (...args) => logged.push(args);
    }
  });
  afterEach(() => {
    Object.assign(console, saved);
  });

  it('runs both probes in parallel, at most once per 60 s', async () => {
    let clock = 0;
    let pending = 0;
    let peak = 0;
    const runner = async (cmd) => {
      pending += 1;
      peak = Math.max(peak, pending);
      await new Promise((resolve) => setImmediate(resolve));
      pending -= 1;
      return cmd === 'gh' ? ok('octocat') : ok(JSON.stringify(STATUS));
    };
    let spawned = 0;
    const counting = (...args) => {
      spawned += 1;
      return runner(...args);
    };
    const read = createAccountProbe({
      env: {},
      runner: counting,
      now: () => clock,
    });
    await read();
    assert.equal(peak, 2, 'both probes in flight together');
    clock = 59_999;
    await read();
    assert.equal(spawned, 2);
    clock = 60_000;
    await read();
    assert.equal(spawned, 4);
    assert.deepEqual(logged, [], 'no account value is logged');
  });
});
