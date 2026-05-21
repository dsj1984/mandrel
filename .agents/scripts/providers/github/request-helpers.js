/**
 * GitHub Provider — shared REST request helpers.
 *
 * Story #2852: dedupes the `parseApiJson` + `paginateRest` copies that
 * previously lived inline in `tickets.js`, `issues.js`, `comments.js`,
 * `branch-protection.js`, and `merge-methods.js`, and folds in two
 * resilience guards:
 *
 *   1. **Transient retry** — each underlying `gh.api({...})` call inside
 *      `paginateRest` is wrapped in `withTransientRetry` (from `./errors.js`),
 *      so a single 502 / 429 / ECONNRESET on page N of M does not lose
 *      pages 1..N-1 of work. The retry shape matches the existing
 *      `addSubIssue` mutation retry contract in `sub-issues.js`.
 *   2. **Page cap** — `paginateRest` enforces a hard ceiling (default
 *      `DEFAULT_PAGE_CAP = 50` → 5000 items at `per_page=100`). Exceeding
 *      the cap throws a clear error naming the endpoint, cap, and items
 *      collected so far, so a runaway loop fails fast and visibly instead
 *      of hanging. Pass `pageCap` in the options bag to opt into a larger
 *      ceiling when the call site has a legitimate reason.
 *
 * @see Story #2852 — Harden provider REST read path.
 */

import { Logger } from '../../lib/Logger.js';
import { withTransientRetry } from './errors.js';

export const DEFAULT_PAGE_CAP = 50;
export const DEFAULT_PER_PAGE = 100;

/**
 * Parse a `gh api ...` stdout payload into JSON. Returns `null` for empty
 * bodies (HTTP 204 DELETE responses).
 */
export function parseApiJson(result) {
  const stdout = result?.stdout ?? '';
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

/**
 * Default retry-warn logger — shared so every retro-relevant call site
 * emits in the same shape and operators can grep for `[gh-api retry]`.
 */
export function defaultRetryWarn({ attempt, maxAttempts, delay, err, label }) {
  const msg =
    typeof err === 'object' && err && typeof err.message === 'string'
      ? err.message
      : String(err);
  Logger.warn(
    `[gh-api retry] ${label} transient (attempt ${attempt}/${maxAttempts}); ` +
      `retrying in ${delay}ms: ${msg}`,
  );
}

/**
 * Paginate a REST list endpoint by appending `page=N&per_page=100` until
 * a short page lands or the page cap is exceeded. Mirrors the legacy
 * behaviour for callers (returns a single concatenated array) and adds
 * the Story #2852 transient-retry + page-cap guards.
 *
 * @param {object} ghFacade           bound gh facade (provider._gh)
 * @param {string} endpoint           REST endpoint without `page=` set
 * @param {{
 *   pageCap?: number,
 *   perPage?: number,
 *   retry?: object,
 *   label?: string,
 *   onRetry?: (info: object) => void,
 * }} [opts]
 */
export async function paginateRest(ghFacade, endpoint, opts = {}) {
  const pageCap =
    Number.isInteger(opts.pageCap) && opts.pageCap > 0
      ? opts.pageCap
      : DEFAULT_PAGE_CAP;
  const perPage =
    Number.isInteger(opts.perPage) && opts.perPage > 0
      ? opts.perPage
      : DEFAULT_PER_PAGE;
  const label = opts.label ?? `paginateRest ${endpoint}`;
  const onRetry = opts.onRetry ?? defaultRetryWarn;

  const items = [];
  const separator = endpoint.includes('?') ? '&' : '?';

  for (let page = 1; page <= pageCap; page++) {
    const result = await withTransientRetry(
      () =>
        ghFacade.api({
          method: 'GET',
          endpoint: `${endpoint}${separator}page=${page}&per_page=${perPage}`,
        }),
      { ...opts.retry, label, onRetry },
    );
    const batch = parseApiJson(result);
    if (!Array.isArray(batch)) return items;
    items.push(...batch);
    if (batch.length < perPage) return items;
    if (page === pageCap) {
      throw new Error(
        `[paginateRest] page cap exceeded for ${endpoint} ` +
          `(cap=${pageCap}, perPage=${perPage}, collected=${items.length}). ` +
          'Pass a larger pageCap via opts when the caller expects deeper pagination.',
      );
    }
  }
  // Unreachable: the loop returns or throws on the last iteration. Kept
  // for type-narrowing / future-proofing.
  return items;
}
