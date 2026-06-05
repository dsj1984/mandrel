// .agents/scripts/lib/github-url.js
/**
 * Shared GitHub URL utilities. Consolidates the `parsePrNumberFromUrl` helper
 * that was triplicated across `finalizer.js`, `watcher.js`, and
 * `code-review.js`, each with a subtly different regex. Story #3649.
 */

/**
 * Extract the PR number from a GitHub PR URL.
 *
 * Accepts any URL whose path contains `/pull/<digits>` — the fragment
 * (`#diff-…`), query string (`?diff=split`), and trailing slash are all
 * ignored. Returns `null` when the URL is not a string, does not contain
 * a `/pull/` segment, or when the parsed integer is ≤ 0.
 *
 * This is the canonical implementation; the inline copies in `finalizer.js`,
 * `watcher.js`, and `code-review.js` have been deleted in favour of this
 * function.
 *
 * @param {string|null|undefined} prUrl
 * @returns {number|null}
 */
export function parsePrNumberFromUrl(prUrl) {
  if (typeof prUrl !== 'string') return null;
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
