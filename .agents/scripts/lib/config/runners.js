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

/**
 * Hardcoded deliver-runner defaults. Operators override via
 * `delivery.deliverRunner.*` in `.agentrc.json`.
 *
 * **Throughput tradeoff — `concurrencyCap`.**
 * The default of 3 is intentionally conservative: it keeps host-quota
 * consumption low for Epics with small waves and avoids saturating the
 * GitHub API with concurrent label writes. For wide-wave Epics where the
 * host has adequate parallel-agent quota, operators should raise
 * `delivery.deliverRunner.concurrencyCap` — wall-clock time falls
 * proportionally to the extra concurrency. The safe default is a tuning
 * knob, not a performance ceiling. See `helpers/deliver-epic.md` § Phase 2b and
 * `agentrc-reference.json` `delivery.deliverRunner.concurrencyCap` for details.
 *
 * **`verifyConcurrencyCap`** (Epic #3019 Tech Spec §1.4 / Story #3024) is a
 * separate knob that bounds the `verifyWaveResults` loop independently of
 * Story-dispatch concurrency, so operators can tune ticket-verify parallelism
 * without raising the wave fan-out. Default 4.
 */
const DEFAULT_DELIVER_RUNNER = Object.freeze({
  concurrencyCap: 3,
  progressReportIntervalSec: 120,
  verifyConcurrencyCap: 4,
});

/**
 * Default auto-fix loop ceilings for /deliver Phase 4 (epic-audit)
 * and Phase 5 (code-review). Operators override via
 * `delivery.epicAudit.*` and `delivery.codeReview.*` in `.agentrc.json`
 * (Story #2611, Epic #2586).
 *
 * `autoFixSeverity` is **tier-aware** (Story #4412, Epic #4405). The
 * Epic-close audit tier (`DEFAULT_EPIC_AUDIT`) defaults to `'high'` —
 * remediating only 🔴 Critical + 🟠 High findings on-branch while 🟡 Medium
 * and 🟢 Suggestion findings graduate to follow-up issues. This is the
 * three-tier model's slim outermost tier: 🟡 Medium code-quality concerns are
 * already routed into on-branch remediation shift-left (the write-time
 * checklist threading of Story #4410 and the Story-scope local-lens pass of
 * Story #4409), so the Epic-close tier stops paying to re-remediate them where
 * a fix is most expensive. The code-review tier (`DEFAULT_CODE_REVIEW`) keeps
 * the `'medium'` default introduced by Story #4399. Both are hard cutovers per
 * `rules/git-conventions.md` — no back-compat flag; an operator opts back into
 * the wider routing by setting `delivery.epicAudit.autoFixSeverity: 'medium'`.
 */
export const DEFAULT_EPIC_AUDIT = Object.freeze({
  maxFixAttempts: 3,
  maxFixScopeFiles: 5,
  autoFixSeverity: 'high',
});

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
 *   deliverRunner: { concurrencyCap: number, progressReportIntervalSec: number, verifyConcurrencyCap: number },
 *   epicAudit: { maxFixAttempts: number, maxFixScopeFiles: number, autoFixSeverity: 'high'|'medium' },
 *   codeReview: { maxFixAttempts: number, maxFixScopeFiles: number, autoFixSeverity: 'high'|'medium' },
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
      verifyConcurrencyCap:
        deliverRunnerUser.verifyConcurrencyCap ??
        DEFAULT_DELIVER_RUNNER.verifyConcurrencyCap,
    },
    epicAudit: {
      maxFixAttempts:
        epicAuditUser.maxFixAttempts ?? DEFAULT_EPIC_AUDIT.maxFixAttempts,
      maxFixScopeFiles:
        epicAuditUser.maxFixScopeFiles ?? DEFAULT_EPIC_AUDIT.maxFixScopeFiles,
      autoFixSeverity:
        epicAuditUser.autoFixSeverity ?? DEFAULT_EPIC_AUDIT.autoFixSeverity,
    },
    codeReview: {
      maxFixAttempts:
        codeReviewUser.maxFixAttempts ?? DEFAULT_CODE_REVIEW.maxFixAttempts,
      maxFixScopeFiles:
        codeReviewUser.maxFixScopeFiles ?? DEFAULT_CODE_REVIEW.maxFixScopeFiles,
      autoFixSeverity:
        codeReviewUser.autoFixSeverity ?? DEFAULT_CODE_REVIEW.autoFixSeverity,
    },
    storyMergeRetry: DEFAULT_STORY_MERGE_RETRY,
    decomposer: DEFAULT_DECOMPOSER,
  };
}
