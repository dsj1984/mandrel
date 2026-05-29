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
// Shared key set: story-close and epic-close probe the same surface
// (integration branch + worktree set). Story #1289 introduced the
// `epic-close` and `npm-test` aliases.
const STORY_CLOSE_KEYS = Object.freeze([
  'git.headRef',
  'git.epicBranches',
  'git.epicBranchSync',
  'git.localBranches',
  'git.coreBare',
  'fs.worktrees',
  'fs.epicMergeLocks',
  'env.GITHUB_TOKEN',
]);

const EPIC_DELIVER_KEYS = Object.freeze([
  'git.headRef',
  'git.epicBranches',
  'git.coreBare',
  'fs.worktrees',
  'fs.dotEnv',
  'fs.dotMcp',
  'env.GITHUB_TOKEN',
]);

const SCOPE_KEYS = Object.freeze({
  'story-close': STORY_CLOSE_KEYS,
  'epic-close': STORY_CLOSE_KEYS,
  'epic-deliver': EPIC_DELIVER_KEYS,
  'npm-test': Object.freeze([
    'git.headRef',
    'git.coreBare',
    'fs.worktrees',
    'fs.dotEnv',
    'fs.dotMcp',
  ]),
  retro: Object.freeze(['git.headRef', 'git.epicBranches', 'fs.worktrees']),
  diagnose: EPIC_DELIVER_KEYS,
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
 * Predicate: is `pid` a shape we can hand to `process.kill(_, 0)`? Splits
 * the input-validity check out of `defaultPidLivenessProbe` so the
 * defensive guard cascade and the OS round-trip are independently
 * testable. Exported so sibling tests can exercise every branch without
 * monkey-patching `process.kill`.
 *
 * @param {*} pid
 * @returns {boolean}
 */
export function validatePidProbeInputs(pid) {
  if (pid === null || pid === undefined) return false;
  if (typeof pid !== 'number') return false;
  if (!Number.isFinite(pid)) return false;
  if (pid <= 0) return false;
  return true;
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
  if (!validatePidProbeInputs(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but unsignalable — still alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Probe the current HEAD ref (short / abbreviated form). Returns the branch
 * name, or `null` when git cannot resolve HEAD (detached / non-repo).
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {(cwd: string, ...args: string[]) => { ok: boolean, stdout: string }} args.git
 * @returns {string|null}
 */
function probeHeadRef({ cwd, git }) {
  const result = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  return result.ok ? result.stdout : null;
}

/**
 * Split a newline-delimited `for-each-ref --format='%(refname:short)'`
 * payload into a trimmed, non-empty short-name list.
 *
 * @param {{ ok: boolean, stdout: string }} result
 * @returns {string[]}
 */
function parseBranchList(result) {
  return result.ok && result.stdout
    ? result.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Probe the epic branches (`refs/heads/epic/`), short-name form.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {(cwd: string, ...args: string[]) => { ok: boolean, stdout: string }} args.git
 * @returns {string[]}
 */
function probeEpicBranches({ cwd, git }) {
  return parseBranchList(
    git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/epic/'),
  );
}

/**
 * Probe all local branches (`refs/heads/`), short-name form. Used by checks
 * that grep over the branch list for legacy naming patterns.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {(cwd: string, ...args: string[]) => { ok: boolean, stdout: string }} args.git
 * @returns {string[]}
 */
function probeLocalBranches({ cwd, git }) {
  return parseBranchList(
    git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'),
  );
}

/**
 * Probe `core.bare`. Returns the config value, or `null` when unset.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {(cwd: string, ...args: string[]) => { ok: boolean, stdout: string }} args.git
 * @returns {string|null}
 */
function probeCoreBare({ cwd, git }) {
  const result = git(cwd, 'config', '--get', 'core.bare');
  return result.ok ? result.stdout : null;
}

/**
 * Build a map of epic branch → { local, remote, ahead } sync state.
 * Standalone (Story #3351): takes the already-assembled `epicBranches` as an
 * explicit argument rather than reading sibling probe output, so it is
 * independently testable and the ordering dependency on the epicBranches
 * probe is explicit at the call site.
 *
 * Story #2463 (preflight batching): the prior implementation issued
 * two `git rev-parse --verify` spawnSync calls per epic branch
 * (one for `epic/<id>`, one for `origin/epic/<id>`), giving an
 * O(branches × 2) probe cost. The collapsed implementation issues
 * exactly one `git for-each-ref` invocation that emits
 *   `<refname> <objectname> <upstream:short> <upstream:objectname>`
 * for every local branch, then filters to the epic branches the
 * scope already declared. Probe cost drops to O(1) for the spawn
 * surface while preserving the byte-identical return shape:
 *   { local: string|null, remote: string|null, ahead: boolean }.
 *
 * `ahead` stays true only when local AND remote SHAs both exist and
 * differ — branches with no upstream config (no `%(upstream:objectname)`)
 * report `remote: null, ahead: false`, matching the pre-batch behavior
 * where `rev-parse --verify origin/<branch>` failed for unpushed refs.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {(cwd: string, ...args: string[]) => { ok: boolean, stdout: string }} args.git
 * @param {readonly string[]} args.epicBranches
 * @returns {Record<string, { local: string|null, remote: string|null, ahead: boolean }>}
 */
function probeEpicBranchSync({ cwd, git, epicBranches }) {
  const sync = {};
  const branches = epicBranches ?? [];
  const branchSet = new Set(branches);
  const formatted = git(
    cwd,
    'for-each-ref',
    '--format=%(refname:short) %(objectname) %(upstream:short) %(upstream:objectname)',
    'refs/heads/',
  );
  const rows = new Map();
  if (formatted.ok && formatted.stdout) {
    for (const line of formatted.stdout.split('\n')) {
      if (!line) continue;
      // Split on whitespace; trailing fields may be empty strings.
      // refname is mandatory (always present); objectname always populated
      // for an existing ref; upstream fields may be missing.
      const parts = line.split(' ');
      const refname = parts[0];
      if (!refname || !branchSet.has(refname)) continue;
      const objectname = parts[1] || null;
      const upstreamShort = parts[2] || null;
      const upstreamObjectname = parts[3] || null;
      rows.set(refname, {
        local: objectname,
        // Surface remote SHA only when an upstream is configured AND
        // git resolved its objectname. An upstream short-name without
        // an objectname (gone-upstream edge case) collapses to null.
        remote: upstreamShort && upstreamObjectname ? upstreamObjectname : null,
      });
    }
  }
  for (const branch of branches) {
    const row = rows.get(branch);
    const localSha = row?.local ?? null;
    const remoteSha = row?.remote ?? null;
    sync[branch] = {
      local: localSha,
      remote: remoteSha,
      ahead: Boolean(localSha && remoteSha && localSha !== remoteSha),
    };
  }
  return sync;
}

/**
 * Handler map keyed by git probe field name (the part after `git.`). Each
 * handler receives `{ cwd, git, out }` and returns the field's value. `out`
 * exposes the already-assembled projection so dependent probes (e.g.
 * `epicBranchSync`, which needs `epicBranches`) can read upstream results.
 *
 * Story #3351: replaces the prior if/else ladder so each probe is
 * independently testable and the `epicBranchSync` → `epicBranches` ordering
 * dependency is explicit (it reads `out.epicBranches` and the SCOPE_KEYS
 * ordering guarantees that field is assembled first).
 *
 * @type {Record<string, (ctx: { cwd: string, git: (cwd: string, ...args: string[]) => { ok: boolean, stdout: string }, out: Record<string, unknown> }) => unknown>}
 */
const GIT_PROBES = Object.freeze({
  headRef: ({ cwd, git }) => probeHeadRef({ cwd, git }),
  epicBranches: ({ cwd, git }) => probeEpicBranches({ cwd, git }),
  localBranches: ({ cwd, git }) => probeLocalBranches({ cwd, git }),
  coreBare: ({ cwd, git }) => probeCoreBare({ cwd, git }),
  epicBranchSync: ({ cwd, git, out }) =>
    probeEpicBranchSync({ cwd, git, epicBranches: out.epicBranches ?? [] }),
});

/**
 * Build the git projection for a key list by iterating the `GIT_PROBES`
 * handler map. Keys are processed in declaration order; a probe that depends
 * on a sibling field (e.g. `epicBranchSync` → `epicBranches`) relies on the
 * SCOPE_KEYS ordering placing its dependency first.
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
    const handler = GIT_PROBES[field];
    if (!handler) continue;
    out[field] = handler({ cwd, git, out });
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
  // Story #1289: `cwd` is surfaced so fs-scanning checks target the
  // worktree they were assembled for.
  const state = Object.freeze({
    scope,
    cwd,
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
