/**
 * checks/state.js — Scope-aware state assembler for the checks registry.
 *
 * `assembleState({ scope })` returns the subset of environment/git/fs probes
 * that checks declared for the given scope actually need. The runner in
 * `index.js` filters the registry by `scope` first, then asks this module
 * for state; the per-scope projection keeps probe cost proportional to the
 * call site (e.g. `story-close` does not pay for `epic-deliver` probes, and
 * the `retro` consumer only probes inputs the retro-scoped checks need).
 *
 * Privacy contract:
 *   - The `env` projection records **presence only** (`'set' | 'missing'`).
 *     It must never return, log, or otherwise expose the value of any
 *     environment variable. Specifically `GITHUB_TOKEN` and similarly
 *     scoped secrets are reduced to a single `'set'` / `'missing'` string
 *     before reaching the caller.
 *   - The `fs` projection records the **existence** of bootstrap files
 *     (`.env`, `.mcp.json`, `.worktrees/`); it does not read their contents.
 *
 * Memoization:
 *   - Results are cached per-scope by a module-local `Map`. Repeated calls
 *     with the same scope reuse the prior result without re-running any
 *     probe (verifiable via a probe spy in unit tests).
 *   - Different scopes get independent entries — they probe different keys
 *     and must not share a cached object.
 *   - `clearStateCache()` is exported for tests so a fresh probe matrix can
 *     be observed without restarting the process.
 *
 * Probes are injectable for testing. Production callers omit the `probes`
 * option and get the real `git` / `fs` / `process.env` probes; tests pass
 * spy probes to assert call counts and shapes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Scope → declared keys. Each scope only assembles the state its checks
 * need. Adding a new scope (or extending an existing one) is a deliberate
 * edit here — checks should not silently grow the probe surface.
 *
 * Keys are namespaced by category (`git.*`, `fs.*`, `env.*`) so the probe
 * dispatcher can route them without re-parsing.
 *
 * @type {Record<string, readonly string[]>}
 */
const SCOPE_KEYS = Object.freeze({
  'story-close': Object.freeze([
    'git.headRef',
    'git.epicBranches',
    'git.coreBare',
    'fs.worktrees',
    'env.GITHUB_TOKEN',
  ]),
  'epic-deliver': Object.freeze([
    'git.headRef',
    'git.epicBranches',
    'git.coreBare',
    'fs.worktrees',
    'fs.dotEnv',
    'fs.dotMcp',
    'env.GITHUB_TOKEN',
  ]),
  retro: Object.freeze(['git.headRef', 'git.epicBranches', 'fs.worktrees']),
  diagnose: Object.freeze([
    'git.headRef',
    'git.epicBranches',
    'git.coreBare',
    'fs.worktrees',
    'fs.dotEnv',
    'fs.dotMcp',
    'env.GITHUB_TOKEN',
  ]),
});

/**
 * Module-local cache. Keyed by `${scope}::${cwd}` so a test that swaps cwd
 * does not collide with a prior probe matrix.
 *
 * @type {Map<string, StateObject>}
 */
const cache = new Map();

/**
 * Clear the memoization cache. Tests call this between cases to observe a
 * fresh probe matrix without restarting the process.
 */
export function clearStateCache() {
  cache.clear();
}

/**
 * Default git probe — `spawnSync` wrapper that never throws. A non-zero
 * exit is reported as `{ ok: false, stdout: '' }` so callers can treat the
 * absence of a ref as "missing" rather than crashing the probe assembly.
 *
 * @param {string} cwd
 * @param {...string} args
 * @returns {{ ok: boolean, stdout: string }}
 */
function defaultGitProbe(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: '' };
  }
  return { ok: true, stdout: String(result.stdout ?? '').trim() };
}

/**
 * Default fs probe — `existsSync` wrapper. Never reads file contents.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
function defaultFsProbe(absPath) {
  return existsSync(absPath);
}

/**
 * Default env probe — returns `'set' | 'missing'` for the named variable.
 * Never returns the value.
 *
 * @param {string} name
 * @returns {'set' | 'missing'}
 */
function defaultEnvProbe(name) {
  return process.env[name] ? 'set' : 'missing';
}

/**
 * Build the git projection for a key list.
 *
 * @param {readonly string[]} keys
 * @param {string} cwd
 * @param {(cwd: string, ...args: string[]) => { ok: boolean, stdout: string }} git
 * @returns {Record<string, unknown>}
 */
function probeGit(keys, cwd, git) {
  const out = {};
  for (const key of keys) {
    if (!key.startsWith('git.')) continue;
    const field = key.slice(4);
    if (field === 'headRef') {
      const result = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
      out.headRef = result.ok ? result.stdout : null;
    } else if (field === 'epicBranches') {
      const result = git(
        cwd,
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/epic/',
      );
      out.epicBranches =
        result.ok && result.stdout
          ? result.stdout
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
    } else if (field === 'coreBare') {
      const result = git(cwd, 'config', '--get', 'core.bare');
      out.coreBare = result.ok ? result.stdout : null;
    }
  }
  return out;
}

/**
 * Build the fs projection for a key list.
 *
 * @param {readonly string[]} keys
 * @param {string} cwd
 * @param {(absPath: string) => boolean} fs
 * @returns {Record<string, boolean>}
 */
function probeFs(keys, cwd, fs) {
  const out = {};
  for (const key of keys) {
    if (!key.startsWith('fs.')) continue;
    const field = key.slice(3);
    if (field === 'worktrees') {
      out.worktrees = fs(path.join(cwd, '.worktrees'));
    } else if (field === 'dotEnv') {
      out.dotEnv = fs(path.join(cwd, '.env'));
    } else if (field === 'dotMcp') {
      out.dotMcp = fs(path.join(cwd, '.mcp.json'));
    }
  }
  return out;
}

/**
 * Build the env projection for a key list. Presence only.
 *
 * @param {readonly string[]} keys
 * @param {(name: string) => 'set' | 'missing'} env
 * @returns {Record<string, 'set' | 'missing'>}
 */
function probeEnv(keys, env) {
  const out = {};
  for (const key of keys) {
    if (!key.startsWith('env.')) continue;
    const name = key.slice(4);
    out[name] = env(name);
  }
  return out;
}

/**
 * Scope-aware state assembler. Returns a frozen state object with
 * `{ git, fs, env, scope }` projections populated only for the keys the
 * scope declares. Memoized per `(scope, cwd)`.
 *
 * @param {object} [opts]
 * @param {string} [opts.scope]  Required in practice — every consumer is
 *   scope-specific. An undefined scope returns an empty projection (used
 *   only by tests that want to verify the no-op path).
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]  Test injection — `{ git, fs, env }` spies.
 *   Production callers omit this and get the default probes.
 * @returns {StateObject}
 *
 * @typedef {object} StateObject
 * @property {string|undefined} scope
 * @property {Record<string, unknown>} git
 * @property {Record<string, boolean>} fs
 * @property {Record<string, 'set' | 'missing'>} env
 */
export function assembleState({ scope, cwd = process.cwd(), probes } = {}) {
  const cacheKey = `${scope ?? ''}::${cwd}`;
  if (!probes && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const keys = scope ? (SCOPE_KEYS[scope] ?? []) : [];
  const gitProbe = probes?.git ?? defaultGitProbe;
  const fsProbe = probes?.fs ?? defaultFsProbe;
  const envProbe = probes?.env ?? defaultEnvProbe;
  const state = Object.freeze({
    scope,
    git: Object.freeze(probeGit(keys, cwd, gitProbe)),
    fs: Object.freeze(probeFs(keys, cwd, fsProbe)),
    env: Object.freeze(probeEnv(keys, envProbe)),
  });
  if (!probes) {
    // Only memoize the default-probe path. Tests with injected spies want
    // to observe call counts on every invocation.
    cache.set(cacheKey, state);
  }
  return state;
}

/**
 * Expose the scope → key map for tests and `/diagnose --show-scope`.
 *
 * @returns {Record<string, readonly string[]>}
 */
export function getScopeKeys() {
  return SCOPE_KEYS;
}
