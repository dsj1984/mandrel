/**
 * `orchestration.runners` accessor (Epic #773 Story 7).
 *
 * Returns the typed grouped object containing every runner-flavoured
 * sub-block. Defaults are applied for `closeRetry` and `decomposer` (the two
 * sub-blocks that ship with framework defaults via `DEFAULT_CLOSE_RETRY` /
 * `DEFAULT_DECOMPOSER` in `config-schema.js`); the remaining sub-blocks fall
 * back to an empty object so callers can destructure without guarding.
 */

import { DEFAULT_CLOSE_RETRY, DEFAULT_DECOMPOSER } from '../config-schema.js';

/**
 * Read the `orchestration.runners` block. Accepts either the full resolved
 * config (`{ orchestration: { runners: ... } }`) or a bare orchestration
 * object (`{ runners: ... }`).
 *
 * @param {{ orchestration?: { runners?: object } } | { runners?: object } | null | undefined} config
 * @returns {{
 *   epicRunner: object,
 *   planRunner: object,
 *   concurrency: object,
 *   closeRetry: { maxAttempts: number, backoffMs: number[] },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  const runners = config?.orchestration?.runners ?? config?.runners ?? {};
  return {
    epicRunner: runners.epicRunner ?? {},
    planRunner: runners.planRunner ?? {},
    concurrency: runners.concurrency ?? {},
    closeRetry: runners.closeRetry ?? DEFAULT_CLOSE_RETRY,
    decomposer: runners.decomposer ?? DEFAULT_DECOMPOSER,
  };
}
