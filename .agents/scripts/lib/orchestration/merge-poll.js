/**
 * merge-poll.js — merge-wait constants and check-rollup derivation owned by
 * the close path.
 *
 * Story #4545 — these three symbols used to live in the Epic-era
 * `lifecycle/listeners/merge-watcher.js`. That listener class had no
 * production caller after the v2.0.0 Story-only cutover, but it was not
 * importer-less: the live close path (`single-story-close/phases/confirm-merge.js`)
 * and `deliver-recover.js` both reached into it for the poll defaults and
 * `deriveChecksStatus`. Relocating them here lets the listener go without
 * leaving the close path importing a lifecycle module it does not otherwise
 * participate in.
 *
 * Sits beside `merge-block-class.js`, its sole consumer pairing:
 * `deriveChecksStatus` produces the `prProbe.checksStatus` value that
 * `classifyMergeBlock` reads.
 */

/**
 * Default poll interval and cumulative budget for the merge wait. The schema
 * in `.agents/schemas/agentrc.schema.json` exposes these as
 * `delivery.mergeWatch.intervalSeconds` (default 30) and
 * `delivery.mergeWatch.maxBudgetSeconds` (default 3600). Hard-coding the same
 * numbers here keeps the close path self-contained when no config is wired in
 * (e.g. unit tests).
 */
export const DEFAULT_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_BUDGET_SECONDS = 3600;

/**
 * Pure: derive an aggregate `checksStatus` (`success` | `still-running` |
 * `failure` | `unknown`) from a `statusCheckRollup` array (`gh pr view --json
 * statusCheckRollup` shape: `{ status, conclusion }` per check). Mirrors the
 * values `classifyMergeBlock` expects on `prProbe.checksStatus`.
 */
export function deriveChecksStatus(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return 'unknown';
  }
  let anyPending = false;
  for (const check of statusCheckRollup) {
    const conclusion = String(check?.conclusion ?? '').toUpperCase();
    const status = String(check?.status ?? '').toUpperCase();
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(conclusion)) {
      return 'failure';
    }
    if (status !== 'COMPLETED') {
      anyPending = true;
    }
  }
  return anyPending ? 'still-running' : 'success';
}
