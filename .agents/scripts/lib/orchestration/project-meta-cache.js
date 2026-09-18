/**
 * project-meta-cache — on-disk cache of repo-invariant Projects v2 board
 * metadata (`{ projectId, fieldId, options }`), so each cold CLI process that
 * flips a label skips re-resolving it. Stored at
 * `<tempRoot>/cache/project-meta.json`, keyed `<owner>/<projectNumber>`, with
 * a TTL. A stale entry at worst fails one mutation, which the caller answers
 * by invalidating and re-resolving — never a wrong write.
 */

import fs from 'node:fs';
import path from 'node:path';
import { anchorTempRoot, tempRootFrom } from '../config/temp-paths.js';

/** One hour spans a delivery run's cold flips yet forces periodic refresh. */
const DEFAULT_META_TTL_MS = 60 * 60 * 1000;

/**
 * Anchored to the main checkout so worktree children and the host share it.
 *
 * @param {object} [config] Optional resolved config bag.
 * @returns {string}
 */
function projectMetaCachePath(config) {
  return path.join(
    anchorTempRoot(tempRootFrom(config)),
    'cache',
    'project-meta.json',
  );
}

/**
 * @param {string|null|undefined} owner
 * @param {number|string|null|undefined} projectNumber
 * @returns {string|null} null when un-keyable (caller skips the cache).
 */
function projectMetaCacheKey(owner, projectNumber) {
  if (!owner || projectNumber === null || projectNumber === undefined) {
    return null;
  }
  return `${owner}/${projectNumber}`;
}

/**
 * A missing or corrupt file reads as `{}` — a cold miss.
 *
 * @param {string} filePath
 * @returns {Record<string, object>}
 */
function readCacheFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A fresh entry with `options` re-hydrated to a Map, else `null`. Never throws.
 *
 * @param {{
 *   owner?: string|null,
 *   projectNumber?: number|string|null,
 *   config?: object,
 *   ttlMs?: number,
 *   now?: number,
 * }} opts
 * @returns {{ projectId: string, fieldId: string, options: Map<string,string> } | null}
 */
export function readProjectMetaCache(opts = {}) {
  const key = projectMetaCacheKey(opts.owner, opts.projectNumber);
  if (!key) return null;
  const ttlMs = opts.ttlMs ?? DEFAULT_META_TTL_MS;
  const now = opts.now ?? Date.now();

  const filePath = projectMetaCachePath(opts.config);
  const store = readCacheFile(filePath);
  const entry = store[key];
  if (!entry || typeof entry !== 'object') return null;

  const { cachedAt, projectId, fieldId, options } = entry;
  if (
    typeof cachedAt !== 'number' ||
    typeof projectId !== 'string' ||
    typeof fieldId !== 'string' ||
    !options ||
    typeof options !== 'object'
  ) {
    return null;
  }
  if (now - cachedAt > ttlMs) return null;

  return {
    projectId,
    fieldId,
    options: new Map(Object.entries(options)),
  };
}

/**
 * Best-effort write preserving sibling board entries.
 *
 * @param {{
 *   owner?: string|null,
 *   projectNumber?: number|string|null,
 *   meta: { projectId: string, fieldId: string, options: Map<string,string>|Record<string,string> },
 *   config?: object,
 *   now?: number,
 * }} opts
 * @returns {boolean} true when the entry was written, false on a skip/failure.
 */
export function writeProjectMetaCache(opts = {}) {
  const key = projectMetaCacheKey(opts.owner, opts.projectNumber);
  if (!key) return false;
  const meta = opts.meta;
  if (
    !meta ||
    typeof meta.projectId !== 'string' ||
    typeof meta.fieldId !== 'string'
  ) {
    return false;
  }
  const now = opts.now ?? Date.now();

  const options =
    meta.options instanceof Map
      ? Object.fromEntries(meta.options)
      : { ...(meta.options ?? {}) };

  const filePath = projectMetaCachePath(opts.config);
  try {
    const store = readCacheFile(filePath);
    store[key] = {
      cachedAt: now,
      projectId: meta.projectId,
      fieldId: meta.fieldId,
      options,
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop an entry after a GraphQL error against cached metadata, so a board
 * reconfiguration self-heals. Best-effort, idempotent.
 *
 * @param {{
 *   owner?: string|null,
 *   projectNumber?: number|string|null,
 *   config?: object,
 * }} opts
 * @returns {boolean}
 */
export function invalidateProjectMetaCache(opts = {}) {
  const key = projectMetaCacheKey(opts.owner, opts.projectNumber);
  if (!key) return false;
  const filePath = projectMetaCachePath(opts.config);
  try {
    const store = readCacheFile(filePath);
    if (!(key in store)) return false;
    delete store[key];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
