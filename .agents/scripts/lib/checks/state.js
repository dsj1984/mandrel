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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
    'git.epicBranchSync',
    'git.coreBare',
    'fs.worktrees',
    'fs.epicMergeLocks',
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
 * Default lock-file probe — reads an epic merge lock file at the given
 * absolute path. Returns `{ exists, pid, acquiredAt, mtimeMs }` or
 * `{ exists: false }`. PID + timestamp are NOT secrets — they are
 * operational data the orphan-lock check uses to decide if a lock is
 * stale. This probe is separate from the privacy-bounded `fs` probe so
 * the README's "fs records existence only" contract for bootstrap files
 * (.env, .mcp.json) remains intact.
 *
 * @param {string} absPath
 * @returns {{ exists: boolean, pid?: number|null, acquiredAt?: number|null, mtimeMs?: number|null }}
 */
function defaultLockProbe(absPath) {
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return { exists: false };
  }
  let pid = null;
  let acquiredAt = null;
  try {
    const raw = readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    pid = Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : null;
    acquiredAt = Number.isFinite(Number(parsed.acquiredAt))
      ? Number(parsed.acquiredAt)
      : null;
  } catch {
    // Corrupted or unreadable — still report existence with null fields so
    // the consumer can surface "lock file exists but is unparseable".
  }
  return { exists: true, pid, acquiredAt, mtimeMs: st.mtimeMs };
}

/**
 * Default process-liveness probe — `process.kill(pid, 0)` checks existence
 * without delivering a signal. Returns true for live, false for dead/missing.
 * Separated from the lock probe so tests can independently spy on each.
 *
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
function defaultPidLivenessProbe(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but unsignalable — still alive.
    return err && err.code === 'EPERM';
  }
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
    } else if (field === 'epicBranchSync') {
      // Build a map of epic branch → { local, remote, ahead } sync state.
      // Depends on `epicBranches` being assembled; the SCOPE_KEYS ordering
      // ensures it appears first. Each entry probes:
      //   - the local SHA of `epic/<id>` via `git rev-parse <ref>`
      //   - the remote SHA of `origin/epic/<id>` via `git rev-parse <ref>`
      // `ahead` is true when the local SHA exists, the remote SHA exists,
      // and they differ — i.e. local is potentially ahead of (or has
      // diverged from) origin. The check consumer treats divergence as a
      // blocker because the close script's rebase will fight a stale base.
      const sync = {};
      const branches = out.epicBranches ?? [];
      for (const branch of branches) {
        const local = git(cwd, 'rev-parse', '--verify', branch);
        const remote = git(cwd, 'rev-parse', '--verify', `origin/${branch}`);
        const localSha = local.ok ? local.stdout : null;
        const remoteSha = remote.ok ? remote.stdout : null;
        sync[branch] = {
          local: localSha,
          remote: remoteSha,
          ahead: Boolean(localSha && remoteSha && localSha !== remoteSha),
        };
      }
      out.epicBranchSync = sync;
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
 * @param {{ epicBranches?: string[], gitCommonDir?: string }} ctx
 * @param {(absPath: string) => object} lockProbe
 * @param {(pid: number|null) => boolean} pidLivenessProbe
 * @returns {Record<string, unknown>}
 */
function probeFs(keys, cwd, fs, ctx, lockProbe, pidLivenessProbe) {
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
    } else if (field === 'epicMergeLocks') {
      // For each epic branch, probe the matching lock file in the git
      // common dir. The lock path mirrors epic-merge-lock.js's
      // `lockPathFor()`: `<gitCommonDir>/epic-<id>.merge.lock`.
      const commonDir = ctx.gitCommonDir ?? path.join(cwd, '.git');
      const locks = {};
      const branches = ctx.epicBranches ?? [];
      for (const branch of branches) {
        const id = branch.replace(/^epic\//, '');
        const lockPath = path.join(commonDir, `epic-${id}.merge.lock`);
        const meta = lockProbe(lockPath);
        if (!meta.exists) {
          locks[id] = {
            exists: false,
            path: lockPath,
            pid: null,
            holderAlive: false,
            acquiredAt: null,
            mtimeMs: null,
          };
          continue;
        }
        locks[id] = {
          exists: true,
          path: lockPath,
          pid: meta.pid ?? null,
          acquiredAt: meta.acquiredAt ?? null,
          mtimeMs: meta.mtimeMs ?? null,
          holderAlive: pidLivenessProbe(meta.pid ?? null),
        };
      }
      out.epicMergeLocks = locks;
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
  const lockProbe = probes?.lock ?? defaultLockProbe;
  const pidLivenessProbe = probes?.pidLiveness ?? defaultPidLivenessProbe;
  const gitProjection = probeGit(keys, cwd, gitProbe);
  // Lock probes need the resolved git common dir; query it via the git
  // probe so test injection still works. In a linked worktree this points
  // at the parent repo's .git/, matching epic-merge-lock.js's lookup.
  let gitCommonDir;
  if (keys.includes('fs.epicMergeLocks')) {
    const r = gitProbe(cwd, 'rev-parse', '--git-common-dir');
    if (r.ok && r.stdout) {
      gitCommonDir = path.isAbsolute(r.stdout)
        ? r.stdout
        : path.resolve(cwd, r.stdout);
    } else {
      gitCommonDir = path.join(cwd, '.git');
    }
  }
  const fsProjection = probeFs(
    keys,
    cwd,
    fsProbe,
    { epicBranches: gitProjection.epicBranches, gitCommonDir },
    lockProbe,
    pidLivenessProbe,
  );
  const state = Object.freeze({
    scope,
    git: Object.freeze(gitProjection),
    fs: Object.freeze(fsProjection),
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
