/**
 * The single authority for baseline path keys: `canonicalise` (strict,
 * rejects absolute and `..` paths), `assertCanonical` (writer-boundary check,
 * never transforms), and `canonicalizeBaselinePath` (permissive, coerces raw
 * tool output). All strip a leading `.worktrees/<workspace>/` so worktree and
 * main-checkout refreshes key identically. Both transformers are idempotent.
 *
 * @module lib/baselines/path-canon
 */

const WORKTREE_PREFIX = /^\.worktrees\/[^/\\]+[/\\]/;

/**
 * Windows or POSIX absolute (including drive-relative `C:foo`).
 *
 * @param {string} value
 * @returns {boolean}
 */
function isAbsolute(value) {
  if (value.startsWith('/')) return true;
  if (value.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]?/.test(value)) return true;
  return false;
}

/**
 * Splits on both separators so `src\..\x` is caught before normalisation.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasTraversal(value) {
  const parts = value.split(/[/\\]/);
  return parts.some((segment) => segment === '..');
}

/**
 * @param {string} input  A repo-relative path.
 * @returns {string}
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

  let working = input.replace(/\\/g, '/');

  working = working.replace(WORKTREE_PREFIX, '');

  if (working.startsWith('./')) working = working.slice(2);

  working = working.replace(/\/{2,}/g, '/');

  if (working.length === 0) {
    throw new Error(
      `path-canon.canonicalise: path collapsed to empty after canonicalisation (got "${input}")`,
    );
  }

  return working;
}

/**
 * Throw unless `input` is already canonical, so the writer never silently
 * rewrites a row's identity.
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
 * Coerce raw `git diff` / tool output into a repo-relative key; never throws
 * on absolute, drive-letter or UNC input. Idempotent, so Windows and Linux
 * rows compare equal.
 *
 * @param {string} input  A raw filesystem path.
 * @returns {string}
 * @throws {TypeError}    When `input` is not a string.
 */
export function canonicalizeBaselinePath(input) {
  if (typeof input !== 'string') {
    throw new TypeError(
      `canonicalizeBaselinePath: expected string, got ${input === null ? 'null' : typeof input}`,
    );
  }

  let working = input.replace(/\\/g, '/');

  // Before the double-slash collapse, which would eat the UNC prefix.
  const uncMatch = working.match(/^\/\/([^/]+)\/([^/]+)(\/|$)/);
  if (uncMatch) {
    working = working.slice(uncMatch[0].length);
  }

  working = working.replace(/^[A-Za-z]:\/?/, '');

  if (working.startsWith('/')) {
    working = working.replace(/^\/+/, '');
  }

  // Must match `canonicalise`, or scope entries miss their rows inside a
  // worktree and the scoped merge drops brand-new files.
  working = working.replace(WORKTREE_PREFIX, '');

  if (working.startsWith('./')) {
    working = working.slice(2);
  }

  working = working.replace(/\/{2,}/g, '/');

  return working;
}
