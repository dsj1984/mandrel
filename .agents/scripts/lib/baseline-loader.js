import { createGitInterface } from './git-utils.js';

/**
 * Read a JSON baseline at a git ref (`git show <ref>:<path>`), so gates
 * compare against the committed baseline rather than the working tree.
 * Memoized per process; failures are not cached, so a transient git error
 * cannot poison later calls.
 */

const _cache = new Map();

/**
 * @param {string} ref
 * @param {string} path
 * @returns {string}
 */
export function cacheKeyFor(ref, path) {
  // NUL is legal in neither a ref nor a path, so keys cannot collide.
  return `${ref}\u0000${path}`;
}

/** Test-only cache reset. */
export function clearBaselineCache() {
  _cache.clear();
}

/**
 * @param {string} ref
 * @param {string} path Repo-relative.
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {ReturnType<typeof createGitInterface>} [opts.git]
 * @returns {unknown} Parsed JSON; the schema is the caller's contract.
 * @throws {Error} Naming ref and path, on an unresolvable blob or bad JSON.
 */
export function readBaselineAtRef(ref, path, opts = {}) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('[baseline-loader] ref must be a non-empty string');
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('[baseline-loader] path must be a non-empty string');
  }

  const key = cacheKeyFor(ref, path);
  if (_cache.has(key)) return _cache.get(key);

  const cwd = opts.cwd ?? process.cwd();
  const gitIface = opts.git ?? createGitInterface({});
  const res = gitIface.gitSpawn(cwd, 'show', `${ref}:${path}`);
  if (res.status !== 0) {
    const detail = res.stderr || res.stdout || `exit ${res.status}`;
    throw new Error(
      `[baseline-loader] unable to read "${path}" at ref "${ref}": ${detail}`,
    );
  }

  const raw = res.stdout ?? '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[baseline-loader] parse-error reading "${path}" at ref "${ref}": ${err?.message ?? err}`,
    );
  }

  _cache.set(key, parsed);
  return parsed;
}
