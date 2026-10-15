/** Operator identity preflight: the gh-store login must equal `github.operatorHandle` before any write. */

import { GhAuthError, GhNotInstalledError } from '../../lib/gh-exec.js';
import {
  isTransportFailure,
  TRANSPORT_REMEDY,
} from '../../lib/gh-transport.js';
import { failureDetail, resolveTokenSource } from './gh-token-diagnostics.js';

class GitHubIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GitHubIdentityError';
    this.code = code;
  }
}

/** `@Name` → `name`; null for unset or placeholder. */
function normalizeHandle(handle) {
  if (typeof handle !== 'string') return null;
  const bare = handle.trim().replace(/^@/, '').toLowerCase();
  if (bare.length === 0 || /^\[.*\]$/.test(bare)) return null;
  return bare;
}

function isMutatingApiCall({ method = 'GET', endpoint, body } = {}) {
  if (endpoint === 'graphql') return isGraphqlMutation(body?.query);
  return String(method).toUpperCase() !== 'GET';
}

function isGraphqlMutation(query) {
  return /^\s*mutation\b/.test(String(query ?? ''));
}

const MUTATING_METHODS = Object.freeze({
  issue: ['edit', 'comment'],
  pr: ['create', 'edit', 'merge', 'updateBranch'],
  label: ['create', 'edit'],
  repo: ['edit'],
});

/** A `createGh` facade whose writes await `ensure()` first. */
function guardMutations(gh, ensure) {
  const before =
    (fn) =>
    async (...args) => {
      await ensure();
      return fn(...args);
    };
  const guarded = {
    ...gh,
    api: async (opts) => {
      if (isMutatingApiCall(opts)) await ensure();
      return gh.api(opts);
    },
  };
  for (const [group, methods] of Object.entries(MUTATING_METHODS)) {
    if (!gh[group]) continue;
    guarded[group] = { ...gh[group] };
    for (const m of methods) {
      if (typeof gh[group][m] === 'function') {
        guarded[group][m] = before(gh[group][m].bind(gh[group]));
      }
    }
  }
  return guarded;
}

function configDirInEffect(env) {
  return env.GH_CONFIG_DIR || "gh's default config dir";
}

function classifyProbeFailure(err, configDir) {
  const said = `gh said: ${failureDetail(err)}`;
  if (isTransportFailure(err)) {
    return new GitHubIdentityError(
      `[GitHubProvider] Identity check could not reach GitHub (GH_CONFIG_DIR: ${configDir}) — a sandbox or network fault, not an authentication failure; ${TRANSPORT_REMEDY}. ${said}`,
      'identity-transport',
    );
  }
  if (err instanceof GhNotInstalledError) {
    return new GitHubIdentityError(
      `[GitHubProvider] Identity check needs the GitHub CLI (\`gh\`), which is not installed or not on PATH. ${said}`,
      'identity-not-installed',
    );
  }
  if (err instanceof GhAuthError) {
    return new GitHubIdentityError(
      `[GitHubProvider] Identity check was rejected by GitHub (GH_CONFIG_DIR: ${configDir}): the gh store holds no valid login — run \`gh auth login\` against that config dir. ${said}`,
      'identity-auth',
    );
  }
  return new GitHubIdentityError(
    `[GitHubProvider] Identity check failed for an unrecognised reason (GH_CONFIG_DIR: ${configDir}); no mutation was sent. ${said}`,
    'identity-unknown',
  );
}

/** One `/user` probe per process per GH_CONFIG_DIR. */
const _loginByConfigDir = new Map();

async function probeLogin(gh) {
  const res = await gh.api({
    method: 'GET',
    endpoint: 'user',
    fields: ['login'],
  });
  const login = String(res?.stdout ?? '').trim();
  if (!login) throw new Error('GET /user returned no login');
  return login;
}

function cachedLogin(gh, env) {
  const key = env.GH_CONFIG_DIR ?? '';
  if (!_loginByConfigDir.has(key)) {
    const pending = probeLogin(gh);
    _loginByConfigDir.set(key, pending);
    // A failed probe is not memoised; the next mutation retries it.
    pending.catch(() => _loginByConfigDir.delete(key));
  }
  return _loginByConfigDir.get(key);
}

/** `gh` is the UNGUARDED facade the probe runs through. */
function createIdentityGate({ gh, expectedHandle, env = process.env }) {
  const expected = normalizeHandle(expectedHandle);
  return async function ensureIdentity() {
    if (!expected || resolveTokenSource(env) !== 'gh-cli') return;
    const configDir = configDirInEffect(env);
    let login;
    try {
      login = await cachedLogin(gh, env);
    } catch (err) {
      throw classifyProbeFailure(err, configDir);
    }
    if (normalizeHandle(login) === expected) return;
    throw new GitHubIdentityError(
      `[GitHubProvider] Refusing to write as the wrong GitHub account: github.operatorHandle expects @${expected}, ` +
        `but the gh store (GH_CONFIG_DIR: ${configDir}) is logged in as @${login}. ` +
        'Fix: point github.cliConfigDir (in .agentrc.local.json) at the store that holds the expected account, ' +
        `or log that store in as @${expected}. No mutation was sent.`,
      'identity-mismatch',
    );
  };
}

/** Provider `_gh`/`_ensureIdentity`; an injected `opts.gh` opts in via `verifyIdentity`, an explicit token never gates. */
export function gateProviderGh(gh, operatorHandle, opts) {
  const verify = (opts.verifyIdentity ?? !opts.gh) && !opts.token;
  if (!verify) return { _gh: gh, _ensureIdentity: async () => {} };
  const ensure = createIdentityGate({ gh, expectedHandle: operatorHandle });
  return { _gh: guardMutations(gh, ensure), _ensureIdentity: ensure };
}

/** Runs `ctx.ensureIdentity` before a GraphQL mutation; queries pass. */
export async function ensureIdentityForQuery(ctx, query) {
  if (isGraphqlMutation(query)) await ctx.ensureIdentity?.();
}
