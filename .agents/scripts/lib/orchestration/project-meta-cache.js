/**
 * project-meta-cache — on-disk cache for repo-invariant GitHub Projects v2
 * board metadata (Story #4252).
 *
 * Every `agent::*` label flip routes through `transitionTicketState` →
 * `ColumnSync.sync`, which must resolve the board's `{ projectId, fieldId,
 * options }` before issuing the Status mutation. Single-story delivery
 * performs each flip in a *separate cold CLI process* (init → executing,
 * close → closing, confirm-merge → done, plus `resync-status-column`), so
 * the in-process `_meta` cache is always empty and every flip re-pays
 * `resolveProjectMeta` + an item-id lookup + the mutation (~3 GraphQL
 * round-trips).
 *
 * The board metadata is **repo-invariant** — it changes only when the
 * Status single-select field is reconfigured — so it is a prime candidate
 * for an on-disk cache that survives across the cold processes. This module
 * persists the resolved metadata to a small JSON file under the resolved
 * `tempRoot`, keyed by `owner/projectNumber`, carrying a TTL. Correctness
 * is bounded by "the mutation still validates against the live board": a
 * stale entry at worst causes one failed mutation, which the caller treats
 * as a signal to invalidate the entry and re-resolve — never a wrong write.
 *
 * Layout: `<tempRoot>/cache/project-meta.json`, a single JSON object keyed
 * by `<owner>/<projectNumber>`:
 *
 *   {
 *     "dsj1984/1": {
 *       "cachedAt": 1718000000000,
 *       "projectId": "PVT_…",
 *       "fieldId": "PVTSSF_…",
 *       "options": { "Todo": "abc", "In Progress": "def", "Done": "ghi" }
 *     }
 *   }
 *
 * The `options` map is serialised as a plain object and re-hydrated into a
 * `Map<name, id>` on read so the ColumnSync call site is identical whether
 * the metadata came from the disk cache or a live resolve.
 *
 * The cache file lives under `tempRoot`, which is gitignored
 * (`temp/` in `.gitignore`), so it introduces no new tracked artifact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { anchorTempRoot, tempRootFrom } from '../config/temp-paths.js';

/**
 * Default time-to-live for a cached board-metadata entry, in milliseconds.
 * Board metadata is repo-invariant (it only changes on a manual Status
 * field reconfiguration), so a generous TTL is safe — and a stale entry is
 * self-healing via invalidate-on-error regardless. One hour comfortably
 * spans a single `/single-story-deliver` run's four cold flips while still
 * forcing a periodic re-resolve.
 */
const DEFAULT_META_TTL_MS = 60 * 60 * 1000;

/**
 * Resolve the path to the on-disk project-meta cache file under the
 * (anchored) resolved `tempRoot`. A relative `tempRoot` is anchored to the
 * main checkout root so a worktree child and the main-checkout host
 * converge on the same file (Story #3900 semantics, reused here).
 *
 * @param {object} [config] Optional resolved config bag. Omitted → framework
 *   default (`temp`).
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
 * Build the per-board cache key from `(owner, projectNumber)`.
 *
 * @param {string|null|undefined} owner
 * @param {number|string|null|undefined} projectNumber
 * @returns {string|null} `<owner>/<projectNumber>`, or null when either part
 *   is missing (an un-keyable board — caller skips the cache).
 */
function projectMetaCacheKey(owner, projectNumber) {
  if (!owner || projectNumber === null || projectNumber === undefined) {
    return null;
  }
  return `${owner}/${projectNumber}`;
}

/**
 * Read the entire cache file as a plain object. Returns an empty object on
 * any read/parse failure (missing file, malformed JSON) so the caller treats
 * a corrupt cache as a cold miss rather than throwing.
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
 * Read a cached metadata entry for `(owner, projectNumber)`.
 *
 * Returns the re-hydrated `{ projectId, fieldId, options: Map }` descriptor
 * when a fresh (within TTL) entry exists, or `null` on a miss / expired /
 * malformed entry. Never throws — a read failure is a cache miss.
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
  // TTL check — an expired entry is a miss so the caller re-resolves.
  if (now - cachedAt > ttlMs) return null;

  return {
    projectId,
    fieldId,
    options: new Map(Object.entries(options)),
  };
}

/**
 * Persist a resolved metadata descriptor for `(owner, projectNumber)`.
 *
 * The `options` value may be a `Map<name,id>` or a plain object; it is
 * normalised to a plain object on disk. Best-effort: any write failure is
 * swallowed (the cache is a pure optimisation — a failed write just means
 * the next process re-resolves). Writes the rest of the store back intact so
 * sibling board entries are preserved.
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
 * Invalidate (delete) the cached entry for `(owner, projectNumber)`.
 *
 * Called when a GraphQL error fires against a board whose metadata came from
 * the cache, so a mid-run board reconfiguration self-heals on the next flip
 * (which re-resolves and re-writes). Best-effort and idempotent: a missing
 * entry or unreadable file is a no-op. Returns true when an entry was
 * actually removed.
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
