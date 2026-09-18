/**
 * cached-fetch.js — coalesce redundant `git fetch origin <ref>` calls (they
 * contend on `packed-refs.lock`) by caching successes per `(cwd, ref)` for a
 * window; the async and sync wrappers share one cache.
 */

import { gitFetchWithRetry as defaultGitFetchWithRetry } from '../git-utils.js';

const DEFAULT_WINDOW_MS = 30_000;

/** Cache state keyed by `(cwd, ref)`; constructible for isolated tests. */
export class FetchCache {
  constructor({ now = () => Date.now() } = {}) {
    /** @type {Map<string, number>} */
    this._lastFetchAt = new Map();
    this._now = now;
  }

  static _key(cwd, ref) {
    return `${cwd}\u0000${ref}`;
  }

  shouldFetch(cwd, ref, windowMs = DEFAULT_WINDOW_MS) {
    const key = FetchCache._key(cwd, ref);
    const last = this._lastFetchAt.get(key);
    if (last === undefined) return true;
    return this._now() - last >= windowMs;
  }

  recordFetch(cwd, ref) {
    this._lastFetchAt.set(FetchCache._key(cwd, ref), this._now());
  }

  reset() {
    this._lastFetchAt.clear();
  }

  size() {
    return this._lastFetchAt.size;
  }
}

const moduleCache = new FetchCache();

/** Test-only. */
export function __resetModuleCache() {
  moduleCache.reset();
}

/** Test-only. */
export function __moduleCacheSize() {
  return moduleCache.size();
}

/**
 * @param {string} cwd
 * @param {string} ref  `''` fetches without a ref.
 * @param {object} [opts]
 * @param {number} [opts.windowMs=30000]
 * @param {FetchCache} [opts.cache]
 * @param {typeof defaultGitFetchWithRetry} [opts.fetchFn]
 * @returns {Promise<{ status: 0, cached: true, attempts: 0 } | { status: number, stdout: string, stderr: string, attempts: number, cached: false }>}
 */
export async function cachedGitFetch(
  cwd,
  ref,
  {
    windowMs = DEFAULT_WINDOW_MS,
    cache = moduleCache,
    fetchFn = defaultGitFetchWithRetry,
  } = {},
) {
  if (!cache.shouldFetch(cwd, ref, windowMs)) {
    return { status: 0, cached: true, attempts: 0 };
  }
  const args = ref ? [ref] : [];
  const result = await fetchFn(cwd, ...args);
  if (result.status === 0) {
    cache.recordFetch(cwd, ref);
  }
  return { ...result, cached: false };
}

/**
 * @param {string} cwd
 * @param {string} ref
 * @param {object} opts
 * @param {(cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string }} opts.gitSpawn
 * @param {number} [opts.windowMs=30000]
 * @param {FetchCache} [opts.cache]
 * @returns {{ status: 0, cached: true } | { status: number, stdout: string, stderr: string, cached: false }}
 */
export function cachedGitFetchSync(
  cwd,
  ref,
  { gitSpawn, windowMs = DEFAULT_WINDOW_MS, cache = moduleCache },
) {
  if (typeof gitSpawn !== 'function') {
    throw new Error('cachedGitFetchSync: opts.gitSpawn is required');
  }
  if (!cache.shouldFetch(cwd, ref, windowMs)) {
    return { status: 0, cached: true };
  }
  const result = gitSpawn(cwd, 'fetch', 'origin', ref);
  if (result.status === 0) {
    cache.recordFetch(cwd, ref);
  }
  return { ...result, cached: false };
}

export const __DEFAULT_WINDOW_MS = DEFAULT_WINDOW_MS;
