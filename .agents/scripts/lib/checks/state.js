/**
 * Scope-aware, memoized state assembler for the checks registry: each scope
 * probes only the keys its checks need.
 *
 * Privacy contract: `env` records presence only (`'set' | 'missing'`), never a
 * value; `fs` records existence only, never contents.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Scope → probe keys (`git.*`, `fs.*`, `env.*`). Growing the probe surface is
 * a deliberate edit here.
 *
 * @type {Record<string, readonly string[]>}
 */
const STORY_CLOSE_KEYS = Object.freeze([
  'git.headRef',
  'git.localBranches',
  'git.coreBare',
  'fs.worktrees',
  'env.GITHUB_TOKEN',
]);

const DIAGNOSE_KEYS = Object.freeze([
  'git.headRef',
  'git.coreBare',
  'fs.worktrees',
  'fs.dotEnv',
  'fs.dotMcp',
  'env.GITHUB_TOKEN',
]);

const SCOPE_KEYS = Object.freeze({
  'story-close': STORY_CLOSE_KEYS,
  'npm-test': Object.freeze([
    'git.headRef',
    'git.coreBare',
    'fs.worktrees',
    'fs.dotEnv',
    'fs.dotMcp',
  ]),
  // core-bare-clean runs in retro; without git.coreBare its detect() is a
  // silent no-op.
  retro: Object.freeze(['git.headRef', 'git.coreBare', 'fs.worktrees']),
  diagnose: DIAGNOSE_KEYS,
});

/**
 * Keyed by `${scope}::${cwd}`.
 *
 * @type {Map<string, StateObject>}
 */
const cache = new Map();

export function clearStateCache() {
  cache.clear();
}

/**
 * Never throws; a failure reads as `{ ok: false }`.
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
 * @param {string} absPath
 * @returns {boolean}
 */
function defaultFsProbe(absPath) {
  return existsSync(absPath);
}

/**
 * @param {string} name
 * @returns {'set' | 'missing'}
 */
function defaultEnvProbe(name) {
  return process.env[name] ? 'set' : 'missing';
}

/**
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
 * Keyed by the field after `git.`.
 *
 * @type {Record<string, (ctx: { cwd: string, git: (cwd: string, ...args: string[]) => { ok: boolean, stdout: string } }) => unknown>}
 */
const GIT_PROBES = Object.freeze({
  headRef: ({ cwd, git }) => probeHeadRef({ cwd, git }),
  localBranches: ({ cwd, git }) => probeLocalBranches({ cwd, git }),
  coreBare: ({ cwd, git }) => probeCoreBare({ cwd, git }),
});

/**
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
    out[field] = handler({ cwd, git });
  }
  return out;
}

/**
 * @param {readonly string[]} keys
 * @param {string} cwd
 * @param {(absPath: string) => boolean} fs
 * @returns {Record<string, unknown>}
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
 * Frozen state with projections for the scope's keys only; memoized per
 * `(scope, cwd)` unless `probes` are injected.
 *
 * @param {object} [opts]
 * @param {string} [opts.scope]  Undefined yields an empty projection.
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]  `{ git, fs, env }` test spies.
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
  const gitProjection = probeGit(keys, cwd, gitProbe);
  const fsProjection = probeFs(keys, cwd, fsProbe);
  // `cwd` lets fs-scanning checks target the worktree they were assembled for.
  const state = Object.freeze({
    scope,
    cwd,
    git: Object.freeze(gitProjection),
    fs: Object.freeze(fsProjection),
    env: Object.freeze(probeEnv(keys, envProbe)),
  });
  if (!probes) {
    cache.set(cacheKey, state);
  }
  return state;
}

/**
 * @returns {Record<string, readonly string[]>}
 */
export function getScopeKeys() {
  return SCOPE_KEYS;
}
