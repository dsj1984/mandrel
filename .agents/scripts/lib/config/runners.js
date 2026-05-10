/**
 * `orchestration.runners` accessor (Epic #773 Story 7; renamed in Epic
 * #1142 Story #1157).
 *
 * Returns the typed grouped object containing every runner-flavoured
 * sub-block. Defaults are applied for `storyMergeRetry` and `decomposer`
 * (the two sub-blocks that ship with framework defaults via
 * `DEFAULT_STORY_MERGE_RETRY` / `DEFAULT_DECOMPOSER` in `config-schema.js`);
 * the remaining sub-blocks fall back to an empty object so callers can
 * destructure without guarding.
 *
 * Story #1157 renamed two sub-blocks under `orchestration.runners`; see
 * `docs/CHANGELOG.md` 5.40.0 for the legacy → new key mapping. The
 * accessor surfaces only the new names — repos with stale `.agentrc.json`
 * will fail AJV validation upstream of this read.
 */

import {
  DEFAULT_DECOMPOSER,
  DEFAULT_STORY_MERGE_RETRY,
} from '../config-schema.js';

/**
 * Read the `orchestration.runners` block. Accepts either the full resolved
 * config (`{ orchestration: { runners: ... } }`) or a bare orchestration
 * object (`{ runners: ... }`).
 *
 * @param {{ orchestration?: { runners?: object } } | { runners?: object } | null | undefined} config
 * @returns {{
 *   deliverRunner: object,
 *   planRunner: object,
 *   concurrency: object,
 *   storyMergeRetry: { maxAttempts: number, backoffMs: number[] },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  const runners = config?.orchestration?.runners ?? config?.runners ?? {};
  return {
    deliverRunner: runners.deliverRunner ?? {},
    planRunner: runners.planRunner ?? {},
    concurrency: runners.concurrency ?? {},
    storyMergeRetry: runners.storyMergeRetry ?? DEFAULT_STORY_MERGE_RETRY,
    decomposer: runners.decomposer ?? DEFAULT_DECOMPOSER,
  };
}
