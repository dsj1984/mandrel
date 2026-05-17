/**
 * Runner accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * Post-reshape, only `delivery.deliverRunner` survives as configurable. The
 * remaining sub-blocks moved to framework-internal constants:
 *
 *   - `runners.planRunner.*` — dropped (no production consumers).
 *   - `runners.concurrency.*` — hardcoded in `concurrency.js` as
 *     `DEFAULT_CONCURRENCY`.
 *   - `runners.storyMergeRetry.*` — hardcoded in `push-epic-retry.js` as
 *     `DEFAULT_STORY_MERGE_RETRY`.
 *   - `runners.decomposer.*` — hardcoded in `epic-plan-decompose.js` as
 *     `DEFAULT_DECOMPOSER`.
 *
 * The `getRunners(config)` accessor is preserved so existing call sites
 * keep working: it returns a wrapper carrying `deliverRunner` (real
 * config) plus stub objects for the legacy keys (drained but present).
 * The framework-internal defaults live with the code that consumes them.
 */

/** Hardcoded story-merge retry policy (was `orchestration.runners.storyMergeRetry`). */
export const DEFAULT_STORY_MERGE_RETRY = Object.freeze({
  maxAttempts: 3,
  backoffMs: Object.freeze([250, 500, 1000]),
});

/** Hardcoded decomposer concurrency cap (was `orchestration.runners.decomposer.concurrencyCap`). */
export const DEFAULT_DECOMPOSER = Object.freeze({
  concurrencyCap: 3,
});

/** Hardcoded deliver-runner concurrency cap. Operators override via
 * `delivery.deliverRunner.concurrencyCap` in `.agentrc.json`. */
const DEFAULT_DELIVER_RUNNER = Object.freeze({
  concurrencyCap: 3,
  progressReportIntervalSec: 120,
});

/**
 * Read the merged deliver-runner block plus the legacy companion stubs.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   deliverRunner: { concurrencyCap: number, progressReportIntervalSec: number },
 *   planRunner: object,
 *   concurrency: object,
 *   storyMergeRetry: { maxAttempts: number, backoffMs: readonly number[] },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  const deliverRunnerUser =
    config?.delivery?.deliverRunner ??
    config?.deliverRunner ??
    config?.orchestration?.runners?.deliverRunner ??
    {};
  return {
    deliverRunner: {
      concurrencyCap:
        deliverRunnerUser.concurrencyCap ??
        DEFAULT_DELIVER_RUNNER.concurrencyCap,
      progressReportIntervalSec:
        deliverRunnerUser.progressReportIntervalSec ??
        DEFAULT_DELIVER_RUNNER.progressReportIntervalSec,
    },
    planRunner: {},
    concurrency: {},
    storyMergeRetry: DEFAULT_STORY_MERGE_RETRY,
    decomposer: DEFAULT_DECOMPOSER,
  };
}
