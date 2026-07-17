/**
 * lib/orchestration/change-set.js — the **one** Story change-set enumerator
 * (Story #4593).
 *
 * ## Why this exists
 *
 * A single Story delivery used to enumerate `git diff --name-only
 * <base>...<head>` three to four separate times: once for the ceremony
 * derivation in `helpers/deliver-story`, once inside `runCodeReview` (to derive
 * the review depth), once for the Story-scope local-lens roster, and once more
 * per fresh acceptance critic. Every one of those consumers must agree about
 * *what changed* — ceremony level and review depth both flow from
 * `deriveChangeLevel`, so two enumerations straddling a commit could route the
 * same Story two different ways. Computing the set once and injecting it closes
 * that window and drops the redundant git calls.
 *
 * ## Contract
 *
 * {@link computeChangeSet} is **total**: it never throws. A diff it cannot
 * enumerate (git failure, missing ref, spawn error) yields
 * `{ files: null, enumerated: false }` — the neutral "diff unknown" signal that
 * `deriveChangeLevel` / `resolveDepth` already fail safe on (`standard` depth, a
 * `fresh` critic). `null` is deliberately distinct from `[]`: an empty array is
 * the *fact* that nothing changed, whereas `null` is the *absence* of evidence,
 * and only the latter must never buy a change less checking.
 *
 * The returned `files` are trimmed, de-duplicated, and sorted, so two consumers
 * comparing the same change set compare byte-identical lists. The refs the set
 * was computed against ride along on the envelope so a downstream consumer can
 * report (or assert) its provenance rather than re-deriving it.
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
 * Trim, drop empties, de-duplicate, and sort raw `git diff --name-only` output.
 * Pure.
 *
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
 * Compute the change set for the `baseRef...headRef` diff **once**, for every
 * consumer that needs to know what a Story touched.
 *
 * Total — never throws; see the module header for the `null` vs `[]` contract.
 *
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
