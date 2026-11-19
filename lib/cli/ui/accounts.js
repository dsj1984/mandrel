// lib/cli/ui/accounts.js
/**
 * Which GitHub login and Claude account the board and its local launches
 * act as. Both probes run in parallel, the result is reused for `ttlMs`, and
 * nothing here logs a value: account fields leave only in the response.
 *
 * @module cli/ui/accounts
 */

import { runGh } from '../../../.agents/scripts/lib/gh-exec.js';

const TIMEOUT_MS = 10_000;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ACCOUNT_FIELDS = ['email', 'orgName', 'subscriptionType', 'authMethod'];
const FIRST_PARTY = 'firstParty';

async function githubLogin(env, runner) {
  const r = await runGh(
    ['api', 'user', '--jq', '.login'],
    { env, timeout: TIMEOUT_MS },
    runner,
  );
  const login = !r.error && r.status === 0 ? (r.stdout ?? '').trim() : '';
  return LOGIN_RE.test(login)
    ? { login }
    : { login: null, reason: 'login-unavailable' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The whitelisted account summary from `claude auth status --json`, or `null`. */
function accountOf(status) {
  if (status?.loggedIn !== true) return null;
  const account = {};
  for (const field of ACCOUNT_FIELDS) {
    if (typeof status[field] === 'string') account[field] = status[field];
  }
  const provider = status.apiProvider;
  if (typeof provider === 'string' && provider !== FIRST_PARTY) {
    account.apiProvider = provider;
  }
  return account;
}

async function claudeAccount(runner) {
  const r = await runner('claude', ['auth', 'status', '--json'], {
    shell: process.platform === 'win32',
    timeout: TIMEOUT_MS,
  });
  return !r.error && r.status === 0 ? accountOf(parseJson(r.stdout)) : null;
}

/**
 * @param {{ env: Record<string, string|undefined>, runner: Function,
 *   ttlMs?: number, now?: () => number }} deps
 * @returns {() => Promise<{ github: { login: string|null, reason?: string },
 *   claude: object|null }>}
 */
export function createAccountProbe({
  env,
  runner,
  ttlMs = 60_000,
  now = Date.now,
}) {
  let cached = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.promise;
    const promise = Promise.all([
      githubLogin(env, runner),
      claudeAccount(runner),
    ]).then(([github, claude]) => ({ github, claude }));
    cached = { at: now(), promise };
    return promise;
  };
}
