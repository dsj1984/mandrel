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
 *
 * **Scope: EVERY check reported on the PR, required or not.** The rollup
 * carries no required-vs-optional discriminator (`gh`'s projection has no
 * `isRequired` field), so `failure` here means "something on this PR is red",
 * NOT "the merge is blocked". Use {@link failingChecksBlockMerge} before
 * treating a `failure` as terminal.
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

/**
 * The one `mergeStateStatus` value that means GitHub itself is gating the
 * merge. See {@link failingChecksBlockMerge}.
 */
const MERGE_GATED_STATE = 'BLOCKED';

/**
 * Pure: does the PR's RED check status actually gate the merge?
 *
 * `deriveChecksStatus` aggregates the whole rollup, so it reports `failure`
 * for a red check of any kind. Branch protection — and therefore GitHub
 * native auto-merge — gates only on REQUIRED checks. A red optional check
 * (an advisory bot, or a `CANCELLED` superseded workflow run, which the
 * rollup derivation counts as a failure) says nothing about whether the PR
 * will land: auto-merge lands it regardless. Treating that as terminal is
 * what stranded a Story `agent::blocked` on a PR that merged anyway.
 *
 * `mergeStateStatus` is GitHub's own verdict, computed against the live
 * branch-protection rules, so it supplies the required-vs-optional
 * discrimination the rollup lacks:
 *
 *   - `BLOCKED`  — merging is gated. With red checks observed, the red
 *                  required check is the gate.
 *   - `UNSTABLE` — "mergeable with non-passing commit status": the red
 *                  checks are NOT required. Auto-merge will land it.
 *   - `CLEAN` / `BEHIND` / `UNKNOWN` / absent — not evidence that the red
 *     check gates the merge.
 *
 * Deliberately conservative: only `BLOCKED` returns `true`. A transient
 * `UNKNOWN` (GitHub has not finished computing the merge state) or a token
 * that cannot see the field degrades to "keep waiting" — the caller's poll
 * budget still bounds the wait and the budget-exhausted classification still
 * fires. The asymmetry is intentional: failing to fail fast costs poll time,
 * whereas failing fast wrongly costs a merged-but-`agent::blocked` strand
 * that only an operator can unpick.
 *
 * @param {{ checksStatus?: string, mergeStateStatus?: string }} [prProbe]
 * @returns {boolean}
 */
export function failingChecksBlockMerge(prProbe) {
  if (prProbe?.checksStatus !== 'failure') return false;
  return (
    String(prProbe?.mergeStateStatus ?? '').toUpperCase() === MERGE_GATED_STATE
  );
}
