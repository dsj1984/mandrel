/**
 * Runner accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * Post-reshape, only `delivery.deliverRunner`, `delivery.epicAudit`, and
 * `delivery.codeReview` are configurable; everything else lives in
 * framework-internal constants exported alongside (`DEFAULT_STORY_MERGE_RETRY`,
 * `DEFAULT_DECOMPOSER`).
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
 * Default auto-fix loop ceilings for /epic-deliver Phase 4 (epic-audit)
 * and Phase 5 (code-review). Operators override via
 * `delivery.epicAudit.*` and `delivery.codeReview.*` in `.agentrc.json`
 * (Story #2611, Epic #2586).
 */
export const DEFAULT_EPIC_AUDIT = Object.freeze({
  maxFixAttempts: 3,
  maxFixScopeFiles: 5,
});

export const DEFAULT_CODE_REVIEW = Object.freeze({
  maxFixAttempts: 3,
  maxFixScopeFiles: 5,
});

/**
 * Read the merged deliver-runner block.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   deliverRunner: { concurrencyCap: number, progressReportIntervalSec: number },
 *   epicAudit: { maxFixAttempts: number, maxFixScopeFiles: number },
 *   codeReview: { maxFixAttempts: number, maxFixScopeFiles: number },
 *   storyMergeRetry: { maxAttempts: number, backoffMs: readonly number[] },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  const deliverRunnerUser = config?.delivery?.deliverRunner ?? {};
  const epicAuditUser = config?.delivery?.epicAudit ?? {};
  const codeReviewUser = config?.delivery?.codeReview ?? {};
  return {
    deliverRunner: {
      concurrencyCap:
        deliverRunnerUser.concurrencyCap ??
        DEFAULT_DELIVER_RUNNER.concurrencyCap,
      progressReportIntervalSec:
        deliverRunnerUser.progressReportIntervalSec ??
        DEFAULT_DELIVER_RUNNER.progressReportIntervalSec,
    },
    epicAudit: {
      maxFixAttempts:
        epicAuditUser.maxFixAttempts ?? DEFAULT_EPIC_AUDIT.maxFixAttempts,
      maxFixScopeFiles:
        epicAuditUser.maxFixScopeFiles ?? DEFAULT_EPIC_AUDIT.maxFixScopeFiles,
    },
    codeReview: {
      maxFixAttempts:
        codeReviewUser.maxFixAttempts ?? DEFAULT_CODE_REVIEW.maxFixAttempts,
      maxFixScopeFiles:
        codeReviewUser.maxFixScopeFiles ?? DEFAULT_CODE_REVIEW.maxFixScopeFiles,
    },
    storyMergeRetry: DEFAULT_STORY_MERGE_RETRY,
    decomposer: DEFAULT_DECOMPOSER,
  };
}
