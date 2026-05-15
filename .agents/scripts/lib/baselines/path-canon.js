/**
 * path-canon.js — single canonicalisation authority for every path written
 * into (or compared against) a Mandrel baseline (Story #1891, Epic #1786).
 *
 * Every baseline ships repo-relative POSIX-style paths. The canonicaliser:
 *
 *   1. Rejects absolute paths (Windows `C:\...` or POSIX `/...`) — baselines
 *      that key by absolute paths break the moment they're checked out on a
 *      different machine, in a worktree, or in CI.
 *   2. Rejects `..` segments — baselines must not name files outside the
 *      repo root, and the loader's signed-int comparison can otherwise be
 *      fooled by a traversal-shaped key.
 *   3. Strips a leading `.worktrees/<workspace>/` prefix so a refresh run
 *      from inside `.worktrees/story-1891/...` produces the same key as a
 *      refresh from the main checkout. This is the defensive policy that
 *      stops a future worktree-based refresh from reintroducing the
 *      maintainability worktree-prefix regression that prompted Story #1891.
 *   4. Normalises Windows backslashes to forward slashes.
 *   5. Strips a leading `./` for cosmetic stability — `./src/a.js` and
 *      `src/a.js` are the same path and should serialise to the same key.
 *
 * The function is **idempotent**: `canonicalise(canonicalise(p)) === canonicalise(p)`
 * for every input it accepts. Tests pin this property explicitly.
 *
 * `assertCanonical` is the throw-on-reject variant. It runs the same checks
 * but does not transform the input — used at the writer boundary to assert
 * a row's `path` has already been canonicalised by the caller (so the writer
 * never silently rewrites a row's identity).
 *
 * @module lib/baselines/path-canon
 */

const WORKTREE_PREFIX = /^\.worktrees\/[^/\\]+[/\\]/;

/**
 * Test whether `value` is a Windows or POSIX absolute path. Windows absolute
 * paths have a drive letter (`C:`) or start with a backslash-separator
 * (`\\server\share`). POSIX absolute paths start with a forward slash.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAbsolute(value) {
  if (value.startsWith('/')) return true;
  if (value.startsWith('\\')) return true;
  // Drive-letter form: `C:\...` or `C:/...` or even bare `C:foo` (rare but
  // still absolute in Windows semantics — refuse it).
  if (/^[A-Za-z]:[\\/]?/.test(value)) return true;
  return false;
}

/**
 * Test whether `value` contains a `..` segment. We tokenise on both `/` and
 * `\` so a Windows-shaped path like `src\..\evil.js` is caught before
 * normalisation rewrites the separators.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasTraversal(value) {
  const parts = value.split(/[/\\]/);
  return parts.some((segment) => segment === '..');
}

/**
 * Canonicalise a path for use as a baseline row key.
 *
 * @param {string} input  A repo-relative path. May use `\` or `/` separators
 *                        and may carry a leading `./` or
 *                        `.worktrees/<workspace>/` prefix.
 * @returns {string}      The canonical, forward-slash, repo-relative form.
 * @throws {TypeError}    When `input` is not a string.
 * @throws {Error}        When `input` is absolute or contains a `..` segment.
 */
export function canonicalise(input) {
  if (typeof input !== 'string') {
    throw new TypeError(
      `path-canon.canonicalise: expected string, got ${typeof input}`,
    );
  }
  if (input.length === 0) {
    throw new Error('path-canon.canonicalise: path must be non-empty');
  }
  if (isAbsolute(input)) {
    throw new Error(
      `path-canon.canonicalise: absolute paths are forbidden in baselines (got "${input}")`,
    );
  }
  if (hasTraversal(input)) {
    throw new Error(
      `path-canon.canonicalise: ".." segments are forbidden in baselines (got "${input}")`,
    );
  }

  // 1. Normalise separators first so the worktree-prefix regex sees a
  //    forward-slash form regardless of platform.
  let working = input.replace(/\\/g, '/');

  // 2. Strip `.worktrees/<workspace>/` prefix (defensive policy — see
  //    module preamble).
  working = working.replace(WORKTREE_PREFIX, '');

  // 3. Strip a leading `./` after worktree-prefix removal so
  //    `./.worktrees/story-1/src/a.js` and `.worktrees/story-1/src/a.js`
  //    converge.
  if (working.startsWith('./')) working = working.slice(2);

  // 4. Collapse any accidental double-slashes introduced by upstream
  //    string concat — leaves leading `/` alone since we've already
  //    rejected absolute paths.
  working = working.replace(/\/{2,}/g, '/');

  if (working.length === 0) {
    throw new Error(
      `path-canon.canonicalise: path collapsed to empty after canonicalisation (got "${input}")`,
    );
  }

  return working;
}

/**
 * Assert that `input` is already in canonical form. Throws on any deviation;
 * never transforms the input. Used at the writer boundary as a defensive
 * check that callers have funnelled their rows through `canonicalise` before
 * handing them to `write()`.
 *
 * @param {string} input
 * @returns {void}
 * @throws {TypeError|Error}
 */
export function assertCanonical(input) {
  if (typeof input !== 'string') {
    throw new TypeError(
      `path-canon.assertCanonical: expected string, got ${typeof input}`,
    );
  }
  if (input.length === 0) {
    throw new Error('path-canon.assertCanonical: path must be non-empty');
  }
  if (isAbsolute(input)) {
    throw new Error(
      `path-canon.assertCanonical: absolute paths are forbidden in baselines (got "${input}")`,
    );
  }
  if (hasTraversal(input)) {
    throw new Error(
      `path-canon.assertCanonical: ".." segments are forbidden in baselines (got "${input}")`,
    );
  }
  if (input.includes('\\')) {
    throw new Error(
      `path-canon.assertCanonical: backslash separators are forbidden in baselines (got "${input}")`,
    );
  }
  if (WORKTREE_PREFIX.test(input)) {
    throw new Error(
      `path-canon.assertCanonical: .worktrees/<workspace>/ prefix is forbidden in baselines (got "${input}")`,
    );
  }
  if (input.startsWith('./')) {
    throw new Error(
      `path-canon.assertCanonical: leading "./" is forbidden in baselines (got "${input}")`,
    );
  }
  if (input.includes('//')) {
    throw new Error(
      `path-canon.assertCanonical: double-slash segments are forbidden in baselines (got "${input}")`,
    );
  }
}
