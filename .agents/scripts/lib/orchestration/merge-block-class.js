// .agents/scripts/lib/orchestration/merge-block-class.js
/**
 * merge-block-class.js — Story #4426 (Epic #4425, slice 1: foundation).
 *
 * Shared block-class classifier consumed by BOTH delivery paths — the
 * epic-path must-land terminal step and the standalone
 * `single-story-close` must-land terminal step (the not-yet-landed
 * follow-on Stories under Epic #4425) — so a headless delivery run that
 * finishes its work without a confirmed merge is attributable to exactly
 * one of four classes from the SAME decision logic, instead of each path
 * inventing its own ad hoc diagnosis.
 *
 * Block classes (Epic #4425 Goal):
 *   - `checks-pending-timeout`           The watch/poll budget was
 *                                         exhausted while required checks
 *                                         were still pending/running — not
 *                                         a hard block, the run simply ran
 *                                         out of time.
 *   - `branch-protection-human-required` GitHub reports the PR needs a
 *                                         human action: a required review
 *                                         that hasn't been granted, or a
 *                                         branch-protection rule the
 *                                         automation cannot satisfy on its
 *                                         own.
 *   - `arm-failure`                      The arm call itself (`gh pr merge
 *                                         --auto` or equivalent) failed for
 *                                         a reason that is NOT branch
 *                                         protection — auth, rate limit, an
 *                                         already-merged race, a network
 *                                         error.
 *   - `api-race-other`                   Fallback for anything that does
 *                                         not cleanly fit the above three —
 *                                         a transient GraphQL/API error, an
 *                                         ambiguous probe result, or a
 *                                         genuinely novel condition.
 *
 * Pure function, no I/O: callers pass in the already-observed
 * arm-result / PR-probe / budget signals (from `AutomergeArmer`,
 * `MergeWatcher`, a raw `gh pr view` read, or the standalone
 * `single-story-confirm-merge.js` poll) and get back a
 * `{ blockClass, reason }` verdict ready to hand to `emitMergeUnlanded`
 * (`emit-merge-unlanded.js`).
 */

/**
 * The four block classes named in the Epic #4425 Goal. Order is the
 * evaluation priority documented on `classifyMergeBlock` below, NOT an
 * arbitrary listing — earlier entries are checked first when a real input
 * happens to satisfy more than one heuristic.
 */
export const BLOCK_CLASSES = Object.freeze([
  'checks-pending-timeout',
  'branch-protection-human-required',
  'arm-failure',
  'api-race-other',
]);

const BLOCK_CLASS_SET = new Set(BLOCK_CLASSES);

/**
 * @param {string} value
 * @returns {boolean} `true` iff `value` is one of the four canonical
 *   block classes.
 */
export function isValidBlockClass(value) {
  return BLOCK_CLASS_SET.has(value);
}

/**
 * Substrings that identify a branch-protection / human-review rejection
 * surfaced through an arm call's stderr or reason text. Matched
 * case-insensitively against the whole string.
 */
const BRANCH_PROTECTION_MARKERS = Object.freeze([
  'review',
  'required_status_checks',
  'protected branch',
  'branch protection',
  'approval',
]);

function textIncludesAny(text, markers) {
  const lower = String(text ?? '').toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

/**
 * Build the `api-race-other` fallback reason from whatever signal is
 * available, so the emitted event still carries a specific-as-possible
 * explanation rather than a bare "unknown".
 */
function describeApiRaceFallback(prProbe, budget) {
  if (prProbe?.error) {
    return `PR probe error: ${prProbe.error}`;
  }
  if (budget && budget.exhausted === true) {
    return `watch budget exhausted with an unrecognised checks status (${prProbe?.checksStatus ?? 'unknown'})`;
  }
  return 'no definitive block signal observed; classified as a transient API race or other condition';
}

/**
 * Classify why a delivery run finished without a confirmed merge.
 *
 * Evaluation order (first match wins):
 *   1. Arm failure — the arm call itself did not succeed. A failed arm
 *      means there is no "armed but stuck" PR left to probe, so this is
 *      checked before any PR-probe or budget signal. A branch-protection
 *      rejection surfaced AT arm time still routes to
 *      `branch-protection-human-required` rather than the generic
 *      `arm-failure`.
 *   2. Budget exhaustion while checks were still in flight —
 *      `checks-pending-timeout`. Evaluated BEFORE the human-required
 *      probe signals because on a protected branch GitHub reports
 *      `mergeStateStatus: 'BLOCKED'` for the entire time required checks
 *      are still running — a slow-CI timeout would otherwise always
 *      misclassify as `branch-protection-human-required` and the
 *      headless once-only budget extension could never engage.
 *   3. PR-probe human-required signals — `reviewDecision` reporting a
 *      required review, or `mergeStateStatus: 'BLOCKED'` with checks NOT
 *      in flight (green/failed checks + BLOCKED = a genuinely human
 *      gate, e.g. a missing approval).
 *   4. Fallback — `api-race-other`.
 *
 * @param {object} input
 * @param {object} [input.armResult] Outcome of the arm call.
 * @param {boolean} [input.armResult.armed] `false` when the arm call
 *   itself failed (a non-zero `gh pr merge` exit, or arming was refused
 *   up-front).
 * @param {string} [input.armResult.reason] Free-form failure detail (e.g.
 *   `gh` stderr) — inspected for branch-protection markers.
 * @param {string} [input.armResult.error] Alternate free-form failure
 *   detail field, checked when `reason` is absent.
 * @param {object} [input.prProbe] Latest `gh pr view` read.
 * @param {string} [input.prProbe.reviewDecision] GitHub review decision
 *   (`REVIEW_REQUIRED`, `APPROVED`, …).
 * @param {string} [input.prProbe.mergeStateStatus] GitHub merge-state
 *   status (`BLOCKED`, `BEHIND`, `CLEAN`, …).
 * @param {string} [input.prProbe.checksStatus] Aggregate required-check
 *   status observed on the last probe (`success` | `pending` |
 *   `still-running` | `failure` | `unknown`).
 * @param {string} [input.prProbe.error] Set when the probe call itself
 *   errored (network / API failure reading the PR).
 * @param {object} [input.budget] Poll-budget accounting.
 * @param {boolean} [input.budget.exhausted] `true` once the watch loop hit
 *   its budget without observing a confirmed merge.
 * @param {number} [input.budget.elapsedSeconds] Elapsed watch time in
 *   seconds, folded into the `reason` text.
 * @returns {{ blockClass: string, reason: string }}
 */
export function classifyMergeBlock(input) {
  const { armResult, prProbe, budget } = input ?? {};

  // 1. Arm call failure.
  if (armResult && armResult.armed === false) {
    const detail = armResult.reason ?? armResult.error ?? '';
    if (textIncludesAny(detail, BRANCH_PROTECTION_MARKERS)) {
      return {
        blockClass: 'branch-protection-human-required',
        reason:
          detail ||
          'arm call rejected: branch protection requires a human action',
      };
    }
    return {
      blockClass: 'arm-failure',
      reason: detail || 'arm call failed for an unspecified reason',
    };
  }

  // Positive in-flight evidence from the latest probe. Only `pending` /
  // `still-running` count — `unknown` (empty rollup: a checks-less repo
  // or a probe race) routes to the api-race re-arm below, and
  // `undefined` (no probe at all) keeps its budget-timeout mapping in
  // step 2 without suppressing the step-3 human-required verdict.
  const checksStatus = prProbe?.checksStatus;
  const checksPendingEvidence =
    checksStatus === 'pending' || checksStatus === 'still-running';

  // 2. Budget exhausted while checks were still in flight. Ordered
  // before the human-required probe signals: `mergeStateStatus:
  // 'BLOCKED'` is the steady state on a protected branch while required
  // checks run, so a slow-CI timeout must not read as human-required —
  // it must consume the headless once-only budget extension instead.
  if (
    budget &&
    budget.exhausted === true &&
    (checksPendingEvidence || checksStatus === undefined)
  ) {
    return {
      blockClass: 'checks-pending-timeout',
      reason: `watch budget exhausted after ${budget.elapsedSeconds ?? 'an unknown number of'} seconds with required checks still pending`,
    };
  }

  // 3. PR-probe human-required signals. A BLOCKED merge state counts
  // only without positive checks-in-flight evidence —
  // BLOCKED-with-settled-checks is a genuinely human gate (e.g. a
  // missing required approval), whereas BLOCKED-while-checks-run is the
  // protected-branch steady state.
  if (prProbe) {
    if (
      prProbe.reviewDecision === 'REVIEW_REQUIRED' ||
      (prProbe.mergeStateStatus === 'BLOCKED' && !checksPendingEvidence)
    ) {
      return {
        blockClass: 'branch-protection-human-required',
        reason: `PR requires human action (reviewDecision=${prProbe.reviewDecision ?? 'n/a'}, mergeStateStatus=${prProbe.mergeStateStatus ?? 'n/a'})`,
      };
    }
  }

  // 4. Fallback.
  return {
    blockClass: 'api-race-other',
    reason: describeApiRaceFallback(prProbe, budget),
  };
}
