/**
 * path-canon.js — single canonicalisation authority for every path written
 * into (or compared against) a Mandrel baseline (Story #1891, Epic #1786).
 *
 * This module is the one place baseline path canonicalisation lives. It
 * exposes three helpers tuned to two boundaries (Story #3345 folded the
 * formerly separate `canonicalize-path.js` permissive coercer in here so
 * there is a single import surface):
 *
 *   - `canonicalise(p)` — the **strict** repo-relative canonicaliser. It
 *     rejects input it considers unsafe to key a baseline by, then
 *     normalises what it accepts.
 *   - `assertCanonical(p)` — the **throw-on-reject** writer-boundary check.
 *     It runs the same rejection checks as `canonicalise` but never
 *     transforms the input.
 *   - `canonicalizeBaselinePath(p)` — the **permissive coercer** used by the
 *     refresh service. It never throws on absolute / drive-letter / UNC
 *     input; instead it transforms those shapes into a repo-relative key,
 *     because its caller funnels raw `git diff` and tool output through a
 *     single point that must always yield a canonical key.
 *
 * `canonicalise` enforces, in order:
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
 * Both `canonicalise` and `canonicalizeBaselinePath` are **idempotent**:
 * feeding either function's output back in produces the same string. Tests
 * pin this property explicitly.
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

/**
 * Permissively coerce a raw filesystem path into the POSIX, repo-relative
 * key shape used by the Unified Baseline Refresh Service (Story #2192,
 * Epic #2173). Unlike `canonicalise`, this helper never throws on absolute,
 * drive-letter, or UNC input — it transforms those shapes into a
 * repo-relative key because its caller (the refresh service) receives raw
 * paths from `git diff` and tool output and needs a single funnel that
 * always produces a canonical key.
 *
 * Rules, in order:
 *   1. Reject non-string input with `TypeError`.
 *   2. Swap every `\` for `/` so the rest of the pipeline sees a single
 *      separator style regardless of platform.
 *   3. Strip a UNC prefix (`//server/share/`) so paths surfaced by tools
 *      that resolved a network share collapse to a repo-relative key.
 *   4. Strip a Windows drive-letter prefix (`C:` / `C:/`) so paths
 *      surfaced by Windows tools collapse to the same key as the
 *      equivalent Linux path.
 *   5. Strip a single leading `/` so a path that was absolute after
 *      drive-letter stripping becomes repo-relative.
 *   6. Strip a leading `.worktrees/<workspace>/` prefix so a refresh run
 *      from inside a worktree produces the same key as a refresh from the
 *      main checkout. This MUST match the equivalent step in
 *      `canonicalise()` (Story #3695): the strict canonicaliser used by the
 *      per-kind `projectRow` strips this prefix, so the permissive coercer
 *      that builds the diff-scope `scope.files` set MUST strip it too —
 *      otherwise a scored row's path (`src/new.js`) never matches its
 *      worktree-prefixed scope entry (`.worktrees/story-1/src/new.js`) and
 *      a brand-new file's row is silently dropped from the scoped baseline.
 *   7. Strip a leading `./` for cosmetic stability.
 *   8. Collapse any `/{2,}` run to a single `/`.
 *
 * The function is **idempotent**: feeding its own output back in produces
 * the same string. Downstream consumers (the refresh service and the gate
 * reader) rely on this property so a row written on Windows compares equal
 * to the same row written on Linux.
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

  // 5. Strip a leading `.worktrees/<workspace>/` prefix (Story #3695) so a
  //    worktree-rooted path collapses to the same repo-relative key the
  //    strict `canonicalise()` produces. Without this, a scored row path and
  //    its diff-scope `scope.files` entry diverge inside a worktree and the
  //    scope-aware merge drops brand-new files. Only a single leading
  //    segment is stripped — a legitimate inner `.worktrees/` directory the
  //    user named themselves is preserved (mirrors `canonicalise`).
  working = working.replace(WORKTREE_PREFIX, '');

  // 6. Strip a leading `./`.
  if (working.startsWith('./')) {
    working = working.slice(2);
  }

  // 7. Collapse redundant separators.
  working = working.replace(/\/{2,}/g, '/');

  return working;
}
