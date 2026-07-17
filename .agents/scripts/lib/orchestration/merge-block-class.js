// .agents/scripts/lib/orchestration/merge-block-class.js
/**
 * merge-block-class.js — Story #4426 (Epic #4425, slice 1: foundation).
 *
 * Shared block-class classifier for the `single-story-close` must-land
 * terminal step and `deliver-recover`, so a headless delivery run that
 * finishes its work without a confirmed merge is attributable to exactly one
 * class from ONE decision logic, instead of each caller inventing its own ad
 * hoc diagnosis. (It was written to serve an epic-path terminal too; the v2
 * cutover left `single-story-close` as the only delivery path.)
 *
 * Block classes (Epic #4425 Goal; `predicate-refused` added by #4472):
 *   - `checks-pending-timeout`           The watch/poll budget was
 *                                         exhausted while required checks
 *                                         were still pending/running — not
 *                                         a hard block, the run simply ran
 *                                         out of time.
 *   - `checks-failed`                    A required check went RED — red
 *                                         checks that branch protection does
 *                                         not require are NOT this class
 *                                         (see `failingChecksBlockMerge`). A
 *                                         definitive terminal the merge wait
 *                                         must fail fast on (Story #4543):
 *                                         before this class the in-close poll
 *                                         read only `state`/`mergedAt`, so a
 *                                         check that failed at minute one
 *                                         burned the entire budget and then
 *                                         classified as
 *                                         `branch-protection-human-required`
 *                                         (the exhaustion probe sees
 *                                         `mergeStateStatus: BLOCKED` with
 *                                         checks settled) — sending the
 *                                         operator to diagnose branch
 *                                         protection instead of the red check
 *                                         that is actually in their way.
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
 *   - `predicate-refused`                The AutomergePredicate refused to
 *                                         arm merge BEFORE any arm attempt —
 *                                         a red/pending required check, an
 *                                         unreadable check probe, a dirty
 *                                         structured-signal verdict, or a
 *                                         (retired `requireChecks` policy
 *                                         block on a checks-less repo (#4472).
 *                                         The must-land contract previously
 *                                         only covered post-arm poll
 *                                         exhaustion, so a predicate refusal
 *                                         in headless mode silently parked;
 *                                         this class makes it attributable.
 *
 * Pure function, no I/O: callers pass in the already-observed
 * arm-result / PR-probe / budget signals (from the close path's merge wait,
 * a raw `gh pr view` read, or the standalone
 * `single-story-confirm-merge.js` poll) and get back a
 * `{ blockClass, reason }` verdict ready to hand to `emitMergeUnlanded`
 * (`emit-merge-unlanded.js`).
 */

import { failingChecksBlockMerge } from './merge-poll.js';

/**
 * Every class `classifyMergeBlock` can return. Order is the evaluation
 * priority documented on `classifyMergeBlock` below, NOT an arbitrary
 * listing — earlier entries are checked first when a real input happens to
 * satisfy more than one heuristic.
 *
 * Started as the four classes named in the Epic #4425 Goal; Story #4543
 * added `checks-failed` so a red required check is attributable as itself
 * rather than being absorbed by the timeout or branch-protection verdicts.
 */
export const BLOCK_CLASSES = Object.freeze([
  'checks-failed',
  'checks-pending-timeout',
  'branch-protection-human-required',
  'arm-failure',
  'api-race-other',
]);

/**
 * The full set of block-class values a `merge.unlanded` record may carry.
 * This is the classifier's four outputs PLUS `predicate-refused` (#4472),
 * emitted DIRECTLY for a headless refusal that never reached the
 * poll-exhaustion classifier — so it is a valid attribution value even though
 * `classifyMergeBlock` never produces it. (The Epic-era listeners that used to
 * emit it, AutomergePredicate and AutomergeArmer, are gone; the value stays
 * because archived `merge.unlanded` records carry it and the schema enum
 * must keep validating them.) `isValidBlockClass` (and the `merge.unlanded` schema enum)
 * validate against this broader set; the classifier's own reachability
 * invariant stays scoped to `BLOCK_CLASSES`.
 */
export const MERGE_UNLANDED_BLOCK_CLASSES = Object.freeze([
  ...BLOCK_CLASSES,
  'predicate-refused',
]);

const BLOCK_CLASS_SET = new Set(MERGE_UNLANDED_BLOCK_CLASSES);

/**
 * @param {string} value
 * @returns {boolean} `true` iff `value` is a valid `merge.unlanded`
 *   block-class attribution (the four classifier outputs plus the directly-
 *   emitted `predicate-refused`).
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
  // Red checks that do not gate the merge (step 1b declined them). Name the
  // situation precisely: the operator must NOT be sent to fix the red check,
  // because auto-merge was free to land this PR and did not.
  if (prProbe?.checksStatus === 'failure') {
    return `PR did not land although its failing checks are not required (mergeStateStatus=${prProbe?.mergeStateStatus ?? 'n/a'}); the red checks are not the block — check that auto-merge is still armed`;
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
 *   1b. A red required check — `checks-failed` (Story #4543). Evaluated
 *      before every budget and probe signal because it is *definitive*:
 *      no amount of remaining budget turns a failed check green, and on a
 *      protected branch it also presents as `mergeStateStatus: 'BLOCKED'`,
 *      so leaving it to step 3 would attribute the operator's red test run
 *      to branch protection.
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
 * @param {string} [input.prProbe.checksStatus] Aggregate status across ALL
 *   checks observed on the last probe (`success` | `pending` |
 *   `still-running` | `failure` | `unknown`) — required-ness is decided by
 *   `mergeStateStatus`, not by this field.
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

  // 1b. A required check is RED. Definitive — no remaining budget makes a
  // failed check pass — so this precedes both the budget branch and the
  // BLOCKED-merge-state heuristic, which would otherwise attribute the red
  // check to branch protection on any protected base.
  //
  // Gated on `failingChecksBlockMerge` rather than the raw rollup status:
  // `checksStatus: 'failure'` covers optional checks too, and naming an
  // optional red check as THE block sends the operator to fix a check that
  // was never gating the merge. A red-but-not-gating PR that still failed to
  // land falls through to the fallback, whose reason says exactly that.
  if (failingChecksBlockMerge(prProbe)) {
    return {
      blockClass: 'checks-failed',
      reason: `a required check failed (mergeStateStatus=${prProbe?.mergeStateStatus ?? 'n/a'})`,
    };
  }

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
