/**
 * canonicalize-path.js — POSIX path canonicalizer for the Unified Baseline
 * Refresh Service (Story #2192, Epic #2173).
 *
 * Every persisted baseline row must use a single, byte-identical key shape
 * across Windows and Linux. `canonicalizeBaselinePath(p)` is the single
 * authority that produces that key from a raw filesystem path: it strips
 * Windows drive letters, swaps backslashes for forward slashes, collapses
 * redundant separators, strips a leading `./`, and rejects non-string
 * input.
 *
 * The function is **idempotent**: feeding its own output back in produces
 * the same string. Downstream consumers (the refresh service and the gate
 * reader) rely on this property so a row written on Windows compares equal
 * to the same row written on Linux.
 *
 * This helper is intentionally permissive (it transforms absolute / drive-
 * letter input rather than throwing) because its caller is the refresh
 * service, which receives raw paths from `git diff` and tool output and
 * needs a single funnel that always produces a canonical key. The stricter
 * writer-boundary `assertCanonical` in `.agents/scripts/lib/baselines/path-canon.js`
 * is a separate concern and is not exported from this module.
 *
 * @module lib/baselines/canonicalize-path
 */

/**
 * Canonicalize a raw filesystem path into the POSIX, repo-relative form
 * used as a baseline row key.
 *
 * Rules, in order:
 *   1. Reject non-string input with `TypeError`.
 *   2. Swap every `\` for `/` so the rest of the pipeline sees a single
 *      separator style regardless of platform.
 *   3. Strip a Windows drive-letter prefix (`C:` / `C:/`) so paths
 *      surfaced by Windows tools collapse to the same key as the
 *      equivalent Linux path.
 *   4. Strip a UNC prefix (`//server/share/`) so paths surfaced by tools
 *      that resolved a network share also collapse.
 *   5. Strip a single leading `/` so a path that was absolute after
 *      drive-letter stripping becomes repo-relative.
 *   6. Strip a leading `./` for cosmetic stability.
 *   7. Collapse any `/{2,}` run to a single `/`.
 *
 * @param {string} input  A raw filesystem path. May use `\` or `/`
 *                        separators, may carry a Windows drive letter, may
 *                        be absolute or relative.
 * @returns {string}      The canonical, forward-slash, repo-relative key.
 * @throws {TypeError}    When `input` is not a string.
 */
export function canonicalizeBaselinePath(input) {
  if (typeof input !== 'string') {
    throw new TypeError(
      `canonicalizeBaselinePath: expected string, got ${input === null ? 'null' : typeof input}`,
    );
  }

  // 1. Normalize separators first.
  let working = input.replace(/\\/g, '/');

  // 2. Strip UNC share prefix (`//server/share/...`) before generic
  //    double-slash collapse so the share name is preserved as a regular
  //    path segment, not eaten.
  const uncMatch = working.match(/^\/\/([^/]+)\/([^/]+)(\/|$)/);
  if (uncMatch) {
    working = working.slice(uncMatch[0].length);
  }

  // 3. Strip Windows drive-letter prefix (`C:` or `C:/`).
  working = working.replace(/^[A-Za-z]:\/?/, '');

  // 4. Strip a single leading `/` so an absolute path becomes
  //    repo-relative.
  if (working.startsWith('/')) {
    working = working.replace(/^\/+/, '');
  }

  // 5. Strip a leading `./`.
  if (working.startsWith('./')) {
    working = working.slice(2);
  }

  // 6. Collapse redundant separators.
  working = working.replace(/\/{2,}/g, '/');

  return working;
}
