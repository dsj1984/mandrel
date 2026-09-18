/**
 * lib/orchestration/change-set.js — the one Story change-set enumerator.
 * Computed once and injected so ceremony, review depth and lens roster all
 * route off the same file list.
 *
 * Total: an unenumerable diff yields `{ files: null, enumerated: false }`.
 * `null` (no evidence) is distinct from `[]` (nothing changed) — only the
 * former must never buy less checking. `files` is trimmed, de-duplicated and
 * sorted.
 *
 * @typedef {{
 *   baseRef: string,
 *   headRef: string,
 *   files: string[]|null,
 *   enumerated: boolean,
 * }} ChangeSet
 *
 * @typedef {typeof gitSpawn} GitSpawnFn
 */

import { gitSpawn } from '../git-utils.js';

/**
 * @param {string} stdout
 * @returns {string[]}
 */
function normalizeFileList(stdout) {
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    const file = line.trim();
    if (file.length > 0) seen.add(file);
  }
  return [...seen].sort();
}

/**
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {ChangeSet}
 */
export function computeChangeSet({
  baseRef,
  headRef,
  cwd = process.cwd(),
  gitSpawnFn = gitSpawn,
} = {}) {
  const unknown = { baseRef, headRef, files: null, enumerated: false };
  if (typeof baseRef !== 'string' || baseRef.length === 0) return unknown;
  if (typeof headRef !== 'string' || headRef.length === 0) return unknown;

  try {
    const result = gitSpawnFn(
      cwd,
      'diff',
      '--name-only',
      `${baseRef}...${headRef}`,
    );
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
      return unknown;
    }
    return {
      baseRef,
      headRef,
      files: normalizeFileList(result.stdout),
      enumerated: true,
    };
  } catch {
    return unknown;
  }
}
