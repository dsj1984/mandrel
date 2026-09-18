/**
 * git-utils.js — git runners: `gitSync` throws on failure (a bug);
 * `gitSpawn` returns a {@link GitResult} for recoverable failures.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { execFileCapture, spawnCapture } from './child-exec.js';

/**
 * `status` is 1 when null (signal); output is trimmed.
 *
 * @typedef {object} GitResult
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 */

let _execFileSync = execFileSync;
let _spawnSync = spawnSync;

/**
 * @type {NodeJS.ProcessEnv | null}
 */
let _cleanGitEnv = null;

/**
 * Memoised env with every `GIT_*` dropped: inside a git hook, the inherited
 * GIT_DIR / GIT_WORK_TREE override the `cwd` we pass.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function cleanGitEnv() {
  if (_cleanGitEnv) return _cleanGitEnv;
  _cleanGitEnv = Object.freeze(
    Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    ),
  );
  return _cleanGitEnv;
}

export function __resetCleanGitEnv() {
  _cleanGitEnv = null;
}

/**
 * Test-only; prefer {@link createGitInterface}.
 *
 * @param {typeof execFileSync} exec
 * @param {typeof spawnSync}    spawn
 */
export function __setGitRunners(exec, spawn) {
  _execFileSync = exec;
  _spawnSync = spawn;
}

/**
 * @param {typeof execFileSync} exec
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function runGitSync(exec, cwd, args) {
  return String(
    execFileCapture('git', args, {
      run: exec,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanGitEnv(),
    }),
  ).trim();
}

/**
 * @param {typeof spawnSync} spawn
 * @param {string} cwd
 * @param {string[]} args
 * @returns {GitResult}
 */
function runGitSpawn(spawn, cwd, args) {
  return spawnCapture('git', args, {
    run: spawn,
    cwd,
    env: cleanGitEnv(),
  });
}

/**
 * @param {string}   cwd
 * @param {...string} args
 * @returns {string} Trimmed stdout.
 */
export function gitSync(cwd, ...args) {
  return runGitSync(_execFileSync, cwd, args);
}

/**
 * @param {string}   cwd
 * @param {...string} args
 * @returns {GitResult}
 */
export function gitSpawn(cwd, ...args) {
  return runGitSpawn(_spawnSync, cwd, args);
}

/**
 * Same shape as this module's exports, over injected runners (`ctx.git`).
 *
 * @param {object} [deps]
 * @param {typeof execFileSync} [deps.exec]
 * @param {typeof spawnSync}    [deps.spawn]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.jitter]
 */
export function createGitInterface(deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const spawn = deps.spawn ?? spawnSync;
  const sleep = deps.sleep ?? defaultSleep;
  const jitterFactor = deps.jitter ?? 0.5;

  const boundGitSpawn = (cwd, ...args) => runGitSpawn(spawn, cwd, args);
  const withRetry =
    (argvPrefix) =>
    (cwd, ...args) =>
      gitWithContentionRetry(
        { spawnGit: boundGitSpawn, sleep, jitterFactor },
        cwd,
        argvPrefix,
        args,
      );

  return {
    gitSync: (cwd, ...args) => runGitSync(exec, cwd, args),
    gitSpawn: boundGitSpawn,
    gitFetchWithRetry: withRetry(['fetch']),
    gitPullWithRetry: withRetry(['pull', '--rebase']),
  };
}

/** Concurrent-worktree lock contention — the only failures retried. */
const PACKED_REFS_CONTENTION_PATTERNS = [
  /packed-refs\.lock/i,
  /cannot lock ref/i,
  /Unable to create '.*\.lock'/i,
  /another git process seems to be running/i,
];

function isPackedRefsContention(stderr) {
  if (!stderr) return false;
  return PACKED_REFS_CONTENTION_PATTERNS.some((p) => p.test(stderr));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @type {(ms: number) => Promise<void>}
 */
let _sleep = defaultSleep;
let _jitterFactor = 0.5;

/**
 * @param {(ms: number) => Promise<void>} fn
 * @param {{ jitter?: number }} [opts]
 */
export function __setSleep(fn, opts = {}) {
  _sleep = fn;
  _jitterFactor = opts.jitter ?? 0;
}

/** 3 retries → 4 attempts total. */
const CONTENTION_BACKOFF_MS = Object.freeze([250, 500, 1000]);

/**
 * Bounded retry on lock contention only. Deliberately no global lock — a
 * mutex would erase the parallelism worktree isolation exists for.
 *
 * @param {{ spawnGit: (cwd: string, ...args: string[]) => GitResult,
 *   sleep: (ms: number) => Promise<void>, jitterFactor: number }} runners
 * @param {string} cwd
 * @param {string[]} argvPrefix
 * @param {string[]} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string, attempts: number }>}
 */
async function gitWithContentionRetry(
  { spawnGit, sleep, jitterFactor },
  cwd,
  argvPrefix,
  args,
) {
  let attempt = 0;
  for (;;) {
    attempt++;
    const last = spawnGit(cwd, ...argvPrefix, ...args);
    const exhausted = attempt > CONTENTION_BACKOFF_MS.length;
    if (
      last.status === 0 ||
      exhausted ||
      !isPackedRefsContention(last.stderr)
    ) {
      return { ...last, attempts: attempt };
    }
    const base = CONTENTION_BACKOFF_MS[attempt - 1];
    await sleep(base + Math.floor(Math.random() * base * jitterFactor));
  }
}

/**
 * Read lazily so `__setSleep` / `__setGitRunners` take effect after import.
 *
 * @returns {{ spawnGit: typeof gitSpawn, sleep: (ms: number) => Promise<void>,
 *   jitterFactor: number }}
 */
function moduleRetryRunners() {
  return { spawnGit: gitSpawn, sleep: _sleep, jitterFactor: _jitterFactor };
}

/**
 * @param {string} cwd
 * @param {...string} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string, attempts: number }>}
 */
export function gitFetchWithRetry(cwd, ...args) {
  return gitWithContentionRetry(moduleRetryRunners(), cwd, ['fetch'], args);
}

/**
 * @param {string} cwd
 * @param {...string} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string, attempts: number }>}
 */
export function gitPullWithRetry(cwd, ...args) {
  return gitWithContentionRetry(
    moduleRetryRunners(),
    cwd,
    ['pull', '--rebase'],
    args,
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @param {string|number} storyId
 * @returns {string}
 */
export function getStoryBranch(storyId) {
  const id =
    typeof storyId === 'number' ? storyId : Number.parseInt(storyId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`getStoryBranch: invalid storyId: ${storyId}`);
  }
  return `story-${id}`;
}

const STORY_BRANCH_RE = /^story-(\d+)$/;

/**
 * @param {string} name
 * @returns {number|null}
 */
export function parseStoryBranch(name) {
  if (typeof name !== 'string') return null;
  const match = STORY_BRANCH_RE.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isStoryBranch(name) {
  return parseStoryBranch(name) !== null;
}
