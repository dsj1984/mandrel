/**
 * Runner accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * Post-reshape, only `delivery.deliverRunner` and `delivery.codeReview` are
 * configurable via this accessor; everything else lives in framework-internal
 * constants exported alongside (`DEFAULT_DECOMPOSER`).
 * `delivery.epicAudit` was removed on v2 (Story-only delivery — no
 * epic-audit runner; remediation policy lives on `delivery.codeReview`).
 */

/** Hardcoded decomposer concurrency cap (was `orchestration.runners.decomposer.concurrencyCap`). */
export const DEFAULT_DECOMPOSER = Object.freeze({
  concurrencyCap: 3,
});

/**
 * Hardcoded deliver-runner defaults. Operators override via
 * `delivery.deliverRunner.*` in `.agentrc.json`.
 *
 * **Throughput tradeoff — `concurrencyCap`.**
 * The default of 3 is intentionally moderate: it keeps host-quota
 * consumption predictable for multi-Story plan-runs and avoids saturating
 * the GitHub API with concurrent label writes, while still allowing a
 * small ready-set fan-out. Operators who want strictly sequential delivery
 * should set `delivery.deliverRunner.concurrencyCap: 1`. Raising the cap
 * reduces wall-clock time where dependencies allow. See `deliver.md` and
 * `agentrc-reference.json` `delivery.deliverRunner.concurrencyCap`.
 *
 * Story #4545 removed the sibling `verifyConcurrencyCap`: the
 * `verifyWaveResults` loop it claimed to bound never existed in the tree, and
 * its only reader was the retired execution-analysis CLI, which echoed the
 * number into a report rather than bounding anything.
 */
const DEFAULT_DELIVER_RUNNER = Object.freeze({
  concurrencyCap: 3,
});

/**
 * Default auto-fix loop ceilings for /deliver code-review. Operators
 * override via `delivery.codeReview.*` in `.agentrc.json` (Story #2611,
 * Epic #2586; `autoFixSeverity` default `'medium'` per Story #4399).
 */
export const DEFAULT_CODE_REVIEW = Object.freeze({
  maxFixAttempts: 3,
  maxFixScopeFiles: 5,
  autoFixSeverity: 'medium',
});

/**
 * Read the merged deliver-runner block.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   deliverRunner: { concurrencyCap: number },
 *   codeReview: { maxFixAttempts: number, maxFixScopeFiles: number, autoFixSeverity: 'high'|'medium' },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  const deliverRunnerUser = config?.delivery?.deliverRunner ?? {};
  const codeReviewUser = config?.delivery?.codeReview ?? {};
  return {
    deliverRunner: {
      concurrencyCap:
        deliverRunnerUser.concurrencyCap ??
        DEFAULT_DELIVER_RUNNER.concurrencyCap,
    },
    codeReview: {
      maxFixAttempts:
        codeReviewUser.maxFixAttempts ?? DEFAULT_CODE_REVIEW.maxFixAttempts,
      maxFixScopeFiles:
        codeReviewUser.maxFixScopeFiles ?? DEFAULT_CODE_REVIEW.maxFixScopeFiles,
      autoFixSeverity:
        codeReviewUser.autoFixSeverity ?? DEFAULT_CODE_REVIEW.autoFixSeverity,
    },
    decomposer: DEFAULT_DECOMPOSER,
  };
}
