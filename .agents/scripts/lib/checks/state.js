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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Scope → declared keys. Each scope only assembles the state its checks
 * need. Adding a new scope (or extending an existing one) is a deliberate
 * edit here — checks should not silently grow the probe surface.
 *
 * Keys are namespaced by category (`git.*`, `fs.*`, `env.*`, `gates.*`) so
 * the probe dispatcher can route them without re-parsing.
 *
 * @type {Record<string, readonly string[]>}
 */
const SCOPE_KEYS = Object.freeze({
  'story-close': Object.freeze([
    'git.headRef',
    'git.epicBranches',
    'git.epicBranchSync',
    'git.localBranches',
    'git.coreBare',
    'fs.worktrees',
    'fs.worktreePaths',
    'fs.worktreeBiomeOrphans',
    'fs.worktreeBootstrapStatus',
    'fs.epicMergeLocks',
    'env.GITHUB_TOKEN',
  ]),
  'epic-deliver': Object.freeze([
    'git.headRef',
    'git.epicBranches',
    'git.coreBare',
    'fs.worktrees',
    'fs.worktreePaths',
    'fs.worktreeBiomeOrphans',
    'fs.worktreeBootstrapStatus',
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
    'fs.worktreePaths',
    'fs.worktreeBiomeOrphans',
    'fs.worktreeBootstrapStatus',
    'gates.biome',
    'gates.miGate',
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
 * Default directory-listing probe — returns immediate child entry names of
 * `absPath`, filtered to directories. Returns an empty array if `absPath`
 * does not exist or is not a directory. Never reads file contents.
 *
 * @param {string} absPath
 * @returns {string[]}
 */
function defaultFsListProbe(absPath) {
  try {
    if (!existsSync(absPath)) return [];
    const entries = readdirSync(absPath);
    return entries.filter((entry) => {
      try {
        return statSync(path.join(absPath, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
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
 * Default gate probe — executes a named pre-push gate (`biome`, `miGate`)
 * in a dry-run mode against HEAD and reports its pass/fail status. Tests
 * inject a fake `gates` probe to avoid the spawn cost.
 *
 * @param {string} cwd
 * @param {'biome' | 'miGate'} gate
 * @returns {{ ok: boolean, output: string }}
 */
const GATE_COMMANDS = {
  biome: {
    cmd: 'npx',
    args: ['biome', 'check', '--no-errors-on-unmatched', '.'],
  },
  miGate: { cmd: 'npm', args: ['run', '--silent', 'check:maintainability'] },
};

function runGate(cwd, cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.error) return { ok: false, output: String(result.error.message) };
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

function defaultGateProbe(cwd, gate) {
  const spec = GATE_COMMANDS[gate];
  if (!spec) return { ok: false, output: `unknown gate: ${gate}` };
  return runGate(cwd, spec.cmd, spec.args);
}

const GIT_HANDLERS = {
  headRef: (git, cwd) => {
    const result = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    return result.ok ? result.stdout : null;
  },
  epicBranches: (git, cwd) => {
    const result = git(
      cwd,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/epic/',
    );
    if (!result.ok || !result.stdout) return [];
    return result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  localBranches: (git, cwd) => {
    const result = git(
      cwd,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
    );
    if (!result.ok || !result.stdout) return [];
    return result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  coreBare: (git, cwd) => {
    const result = git(cwd, 'config', '--get', 'core.bare');
    return result.ok ? result.stdout : null;
  },
};

/**
 * Build sync state per epic branch: { local, remote, ahead }. The check
 * consumer treats divergence as a blocker because the close script's
 * rebase will fight a stale base.
 */
function buildEpicSync(git, cwd, branches) {
  const sync = {};
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
  return sync;
}

/**
 * Build the git projection for a key list.
 */
function probeGit(keys, cwd, git) {
  const out = {};
  for (const key of keys) {
    if (!key.startsWith('git.')) continue;
    const field = key.slice(4);
    if (field === 'epicBranchSync') continue; // handled below (depends on epicBranches)
    const handler = GIT_HANDLERS[field];
    if (handler) out[field] = handler(git, cwd);
  }
  if (keys.includes('git.epicBranchSync')) {
    out.epicBranchSync = buildEpicSync(git, cwd, out.epicBranches ?? []);
  }
  return out;
}

/**
 * Build per-worktree bootstrap status — presence only, never reads file
 * contents (privacy contract: see feedback_worktree_untracked_files.md).
 */
function buildBootstrapStatus(paths, fs) {
  const status = {};
  for (const p of paths) {
    status[p] = {
      dotEnv: fs(path.join(p, '.env')),
      dotMcp: fs(path.join(p, '.mcp.json')),
    };
  }
  return status;
}

/**
 * Build per-epic-branch lock-file projection. Mirrors epic-merge-lock.js's
 * `lockPathFor()`: `<gitCommonDir>/epic-<id>.merge.lock`.
 */
function buildEpicMergeLocks(branches, commonDir, lockProbe, pidLivenessProbe) {
  const locks = {};
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
  return locks;
}

/**
 * Build the fs projection for a key list.
 *
 * `fs.worktreePaths` — absolute paths to the immediate subdirectories of
 *   `.worktrees/`. Empty array if `.worktrees/` does not exist.
 * `fs.worktreeBiomeOrphans` — paths to worktree subdirectories that
 *   contain a nested `biome.json` (root biome lint will fail; see
 *   feedback_orphan_worktree_biome_block.md).
 * `fs.worktreeBootstrapStatus` — per-worktree bootstrap file presence,
 *   shape: `{ [absPath]: { dotEnv: boolean, dotMcp: boolean } }`. Presence
 *   only — never reads `.env` contents (see
 *   feedback_worktree_untracked_files.md).
 */
function probeFs(keys, cwd, fs, fsList, ctx, lockProbe, pidLivenessProbe) {
  const out = {};
  let cachedPaths = null;
  const paths = () => {
    if (cachedPaths !== null) return cachedPaths;
    const wtRoot = path.join(cwd, '.worktrees');
    cachedPaths = fsList(wtRoot).map((entry) => path.join(wtRoot, entry));
    return cachedPaths;
  };
  const handlers = {
    worktrees: () => fs(path.join(cwd, '.worktrees')),
    dotEnv: () => fs(path.join(cwd, '.env')),
    dotMcp: () => fs(path.join(cwd, '.mcp.json')),
    worktreePaths: () => paths(),
    worktreeBiomeOrphans: () =>
      paths().filter((p) => fs(path.join(p, 'biome.json'))),
    worktreeBootstrapStatus: () => buildBootstrapStatus(paths(), fs),
    epicMergeLocks: () =>
      buildEpicMergeLocks(
        ctx.epicBranches ?? [],
        ctx.gitCommonDir ?? path.join(cwd, '.git'),
        lockProbe,
        pidLivenessProbe,
      ),
  };
  for (const key of keys) {
    if (!key.startsWith('fs.')) continue;
    const field = key.slice(3);
    const handler = handlers[field];
    if (handler) out[field] = handler();
  }
  return out;
}

/**
 * Build the env projection for a key list. Presence only.
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
 * Build the gates projection for a key list.
 */
function probeGates(keys, cwd, gates) {
  const out = {};
  for (const key of keys) {
    if (!key.startsWith('gates.')) continue;
    const gate = key.slice(6);
    out[gate] = gates(cwd, gate);
  }
  return out;
}

/**
 * Resolve the git common dir for lock-file probing. In a linked worktree
 * this points at the parent repo's .git/, matching epic-merge-lock.js's
 * lookup.
 */
function resolveGitCommonDir(gitProbe, cwd) {
  const r = gitProbe(cwd, 'rev-parse', '--git-common-dir');
  if (r.ok && r.stdout) {
    return path.isAbsolute(r.stdout) ? r.stdout : path.resolve(cwd, r.stdout);
  }
  return path.join(cwd, '.git');
}

/**
 * Scope-aware state assembler. Returns a frozen state object with
 * `{ git, fs, env, gates, scope, cwd }` projections populated only for the
 * keys the scope declares. Memoized per `(scope, cwd)`.
 *
 * @param {object} [opts]
 * @param {string} [opts.scope]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes] Test injection — `{ git, fs, fsList, env, gates, lock, pidLiveness }` spies.
 * @returns {StateObject}
 *
 * @typedef {object} StateObject
 * @property {string|undefined} scope
 * @property {string} cwd
 * @property {Record<string, unknown>} git
 * @property {Record<string, unknown>} fs
 * @property {Record<string, 'set' | 'missing'>} env
 * @property {Record<string, unknown>} gates
 */
export function assembleState({ scope, cwd = process.cwd(), probes } = {}) {
  const cacheKey = `${scope ?? ''}::${cwd}`;
  if (!probes && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const keys = scope ? (SCOPE_KEYS[scope] ?? []) : [];
  const gitProbe = probes?.git ?? defaultGitProbe;
  const fsProbe = probes?.fs ?? defaultFsProbe;
  const fsListProbe = probes?.fsList ?? defaultFsListProbe;
  const envProbe = probes?.env ?? defaultEnvProbe;
  const lockProbe = probes?.lock ?? defaultLockProbe;
  const pidLivenessProbe = probes?.pidLiveness ?? defaultPidLivenessProbe;
  const gatesProbe = probes?.gates ?? defaultGateProbe;
  const gitProjection = probeGit(keys, cwd, gitProbe);
  const gitCommonDir = keys.includes('fs.epicMergeLocks')
    ? resolveGitCommonDir(gitProbe, cwd)
    : undefined;
  const fsProjection = probeFs(
    keys,
    cwd,
    fsProbe,
    fsListProbe,
    { epicBranches: gitProjection.epicBranches, gitCommonDir },
    lockProbe,
    pidLivenessProbe,
  );
  const state = Object.freeze({
    scope,
    cwd,
    git: Object.freeze(gitProjection),
    fs: Object.freeze(fsProjection),
    env: Object.freeze(probeEnv(keys, envProbe)),
    gates: Object.freeze(probeGates(keys, cwd, gatesProbe)),
  });
  if (!probes) {
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
