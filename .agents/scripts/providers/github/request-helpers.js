/**
 * GitHub Provider — shared REST request helpers.
 */

import { Logger } from '../../lib/Logger.js';
import { withTransientRetry } from './errors.js';

export const DEFAULT_PAGE_CAP = 50;
export const DEFAULT_PER_PAGE = 100;

/** `null` for an empty body (e.g. a 204 DELETE). */
export function parseApiJson(result) {
  const stdout = result?.stdout ?? '';
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

/** One greppable `[gh-api retry]` shape for every call site. */
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
 * Concatenate pages until a short page lands. Each page retries transient
 * errors on its own, so a blip on page N keeps pages 1..N-1. Hitting the page
 * cap throws (naming endpoint and count) rather than truncating silently.
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
  return items;
}
