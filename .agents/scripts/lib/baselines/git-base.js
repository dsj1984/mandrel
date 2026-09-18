// The one loader for base-ref baseline reads: `git show <ref>:<file>` via
// argv tokens (no shell), with a `(ref, file)` LRU that also caches `null`.
//
// Exit semantics: 0 → contents; 128 → `null` ("path absent at ref", and only
// that); anything else (bad ref, signal-killed child) throws, so callers may
// treat a throw as a hard config failure, never as "no baseline".

import { formatChildFailure, spawnChild } from '../child-exec.js';

// Seven kinds × two refs is 14 entries; 64 bounds long-lived runs without
// evicting hot entries.
const DEFAULT_MAX_ENTRIES = 64;

/** @type {Function | undefined} */
let _spawnRunner;
let _cache = new Map();
let _maxEntries = DEFAULT_MAX_ENTRIES;

/**
 * Test-only.
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawn]    - Mock spawnSync.
 * @param {number} [opts.maxEntries] - Override LRU capacity.
 */
export function __setSpawnRunner(opts = {}) {
  if (opts.spawn) {
    _spawnRunner = opts.spawn;
  }
  if (typeof opts.maxEntries === 'number') {
    _maxEntries = opts.maxEntries;
  }
  _cache = new Map();
}

export function __resetForTests() {
  _spawnRunner = undefined;
  _maxEntries = DEFAULT_MAX_ENTRIES;
  _cache = new Map();
}

/**
 * NUL-joined: neither refs nor paths may contain NUL.
 *
 * @param {string} ref
 * @param {string} file
 * @returns {string}
 */
function cacheKey(ref, file) {
  return `${ref}\u0000${file}`;
}

/**
 * Move to the MRU end (Map iteration is insertion order) and evict the LRU.
 *
 * @param {string} key
 * @param {string | null} value
 */
function touch(key, value) {
  _cache.delete(key);
  _cache.set(key, value);
  while (_cache.size > _maxEntries) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * Drop inherited `GIT_*` vars: under husky, `GIT_DIR`/`GIT_WORK_TREE` would
 * point git at the wrong worktree.
 */
function cleanGitEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function stdoutOf(result) {
  return typeof result?.stdout === 'string' ? result.stdout : '';
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} opts
 */
function runGit(args, opts) {
  return spawnChild('git', args, {
    run: _spawnRunner,
    cwd: opts.cwd ?? process.cwd(),
    env: cleanGitEnv(),
  });
}

/**
 * @param {string} ref
 * @param {string} file    - Repo-relative path.
 * @param {{ cwd?: string }} [opts]
 * @returns {string | null}
 */
export function readBaseFromGit(ref, file, opts = {}) {
  if (!isNonEmptyString(ref)) {
    throw new TypeError('readBaseFromGit: ref must be a non-empty string');
  }
  if (!isNonEmptyString(file)) {
    throw new TypeError('readBaseFromGit: file must be a non-empty string');
  }

  const key = cacheKey(ref, file);
  if (_cache.has(key)) {
    const cached = _cache.get(key);
    touch(key, cached);
    return cached;
  }

  const spec = `${ref}:${file}`;
  const result = runGit(['show', spec], opts);

  // `status: null` (signal-killed) falls through to the throw.
  const status = result.status;
  if (status === 0) {
    const out = stdoutOf(result);
    touch(key, out);
    return out;
  }

  // Match the exit code, not stderr: stable across git versions and locales.
  if (status === 128) {
    touch(key, null);
    return null;
  }

  throw new Error(
    formatChildFailure({
      label: `readBaseFromGit: git show ${spec}`,
      status,
      stderr: result.stderr,
    }),
  );
}

/**
 * Commits in `<baseRef>..HEAD` touching `<file>`; `sha` lets the refresh
 * acknowledgment scope to what that commit rewrote. `[]` on failure keeps the
 * ratchet strict. Uncached: depends on live HEAD.
 *
 * @param {string} baseRef
 * @param {string} file    - Repo-relative path to the baseline file.
 * @param {{ cwd?: string }} [opts]
 * @returns {{ sha: string, subject: string }[]} newest first; `[]` on any failure.
 */
export function readRangeCommitsTouchingFile(baseRef, file, opts = {}) {
  if (!isNonEmptyString(baseRef) || !isNonEmptyString(file)) return [];

  let result;
  try {
    result = runGit(
      ['log', `${baseRef}..HEAD`, '--format=%H%x00%s', '--', file],
      opts,
    );
  } catch {
    return [];
  }

  if (result?.status !== 0) return [];
  return stdoutOf(result)
    .split('\n')
    .map((line) => {
      const sep = line.indexOf('\u0000');
      if (sep === -1) return null;
      return {
        sha: line.slice(0, sep).trim(),
        subject: line.slice(sep + 1).trim(),
      };
    })
    .filter((commit) => commit !== null && commit.sha.length > 0);
}

/**
 * Test-only.
 *
 * @returns {number}
 */
export function __cacheSize() {
  return _cache.size;
}
