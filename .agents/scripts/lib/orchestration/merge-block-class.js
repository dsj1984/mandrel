// .agents/scripts/lib/orchestration/merge-block-class.js
/**
 * merge-block-class.js — the one pure classifier attributing an unlanded
 * delivery run to exactly one block class, from observed arm / probe /
 * budget signals, for `emitMergeUnlanded`.
 */

import {
  ADVISORY_GATE_INCONCLUSIVE_CLASS,
  ADVISORY_GATE_RED_CLASS,
  CHECKS_FAILED_CLASS,
  formatChecksFailedReason,
  requiredCheckFailedBlocksMerge,
} from './merge-poll.js';

/**
 * Every valid `merge.unlanded` attribution. The first five are the classes
 * `classifyMergeBlock` can return, in its evaluation priority; the rest are
 * emitted directly, never by the classifier: `predicate-refused` (kept so
 * archived records validate), the advisory-gate pair, and the REST
 * transport's merge-queue refusal (`merge-queue.js` owns its constant).
 */
const MERGE_UNLANDED_BLOCK_CLASSES = Object.freeze([
  CHECKS_FAILED_CLASS,
  'checks-pending-timeout',
  'branch-protection-human-required',
  'arm-failure',
  'api-race-other',
  'predicate-refused',
  // Sourced from the gate's own constants so the vocabulary cannot drift.
  ADVISORY_GATE_RED_CLASS,
  ADVISORY_GATE_INCONCLUSIVE_CLASS,
  'merge-queue-rest-unsupported',
]);

const BLOCK_CLASS_SET = new Set(MERGE_UNLANDED_BLOCK_CLASSES);

/**
 * @param {string} value
 * @returns {boolean} `true` iff `value` is a valid `merge.unlanded`
 *   block-class attribution.
 */
export function isValidBlockClass(value) {
  return BLOCK_CLASS_SET.has(value);
}

/** Case-insensitive markers of a protection/review rejection in arm text. */
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

/** The most specific `api-race-other` reason the signals allow. */
function describeApiRaceFallback(prProbe, budget) {
  if (prProbe?.error) {
    return `PR probe error: ${prProbe.error}`;
  }
  // Red but non-gating checks: don't send the operator to fix them — auto-merge
  // was free to land this PR and did not.
  if (prProbe?.checksStatus === 'failure') {
    return `PR did not land although its failing checks are not required (mergeStateStatus=${prProbe?.mergeStateStatus ?? 'n/a'}); the red checks are not the block — check that auto-merge is still armed`;
  }
  if (budget && budget.exhausted === true) {
    return `watch budget exhausted with an unrecognised checks status (${prProbe?.checksStatus ?? 'unknown'})`;
  }
  return 'no definitive block signal observed; classified as a transient API race or other condition';
}

/**
 * Positive evidence a check is still running. Attributed evidence scopes
 * `requiredRunInFlight` to re-runs; `runInFlight` still says "something is
 * running".
 *
 * @param {object} [prProbe]
 * @returns {boolean}
 */
function hasChecksPendingEvidence(prProbe) {
  const status = prProbe?.checksStatus;
  const evidence = prProbe?.requiredRunEvidence;
  return (
    status === 'pending' ||
    status === 'still-running' ||
    evidence?.requiredRunInFlight === true ||
    evidence?.runInFlight === true
  );
}

/**
 * Step 1: a failed arm leaves no armed PR to probe.
 *
 * @param {object} armResult
 * @returns {{ blockClass: string, reason: string }}
 */
function classifyArmFailure(armResult) {
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

/**
 * Step 2: BLOCKED is the steady state while checks run; a slow-CI timeout
 * must not read as human-required. Positive evidence only: `unknown` routes
 * to the fallback; `undefined` (no probe) keeps this mapping.
 *
 * @param {object} [prProbe]
 * @param {object} [budget]
 * @returns {boolean}
 */
function isChecksPendingTimeout(prProbe, budget) {
  if (budget?.exhausted !== true) return false;
  return (
    hasChecksPendingEvidence(prProbe) || prProbe?.checksStatus === undefined
  );
}

/**
 * Step 3: BLOCKED counts only with checks settled — a genuinely human gate.
 *
 * @param {object} [prProbe]
 * @returns {boolean}
 */
function isHumanRequired(prProbe) {
  if (!prProbe) return false;
  return (
    prProbe.reviewDecision === 'REVIEW_REQUIRED' ||
    (prProbe.mergeStateStatus === 'BLOCKED' &&
      !hasChecksPendingEvidence(prProbe))
  );
}

/**
 * Classify why a delivery run finished without a confirmed merge. First match
 * wins: (1) arm failure (a protection rejection at arm time still routes to
 * human-required); (1b) a red required check; (2) budget exhausted with
 * checks in flight; (3) human-required probe signals; (4) `api-race-other`.
 *
 * @param {object} input
 * @param {object} [input.armResult] Outcome of the arm call.
 * @param {boolean} [input.armResult.armed] `false` when the arm call
 *   failed or was refused up-front.
 * @param {string} [input.armResult.reason] Failure detail (e.g. `gh` stderr).
 * @param {string} [input.armResult.error]
 * @param {object} [input.prProbe] Latest `gh pr view` read.
 * @param {string} [input.prProbe.reviewDecision]
 * @param {string} [input.prProbe.mergeStateStatus]
 * @param {string} [input.prProbe.checksStatus] Aggregate over ALL checks;
 *   required-ness comes from `mergeStateStatus`.
 * @param {string} [input.prProbe.error] Set when the probe itself errored.
 * @param {object} [input.budget] Poll-budget accounting.
 * @param {boolean} [input.budget.exhausted]
 * @param {number} [input.budget.elapsedSeconds]
 * @returns {{ blockClass: string, reason: string }}
 */
export function classifyMergeBlock(input) {
  const { armResult, prProbe, budget } = input ?? {};

  if (armResult && armResult.armed === false) {
    return classifyArmFailure(armResult);
  }

  // 1b. Definitive, and before step 3 since it also presents as BLOCKED.
  // Head-anchored evidence, not the raw rollup (optional/superseded runs).
  if (requiredCheckFailedBlocksMerge(prProbe)) {
    return {
      blockClass: CHECKS_FAILED_CLASS,
      reason: formatChecksFailedReason(prProbe, prProbe?.evidencePath),
    };
  }

  if (isChecksPendingTimeout(prProbe, budget)) {
    return {
      blockClass: 'checks-pending-timeout',
      reason: `watch budget exhausted after ${budget.elapsedSeconds ?? 'an unknown number of'} seconds with required checks still pending`,
    };
  }

  if (isHumanRequired(prProbe)) {
    return {
      blockClass: 'branch-protection-human-required',
      reason: `PR requires human action (reviewDecision=${prProbe.reviewDecision ?? 'n/a'}, mergeStateStatus=${prProbe.mergeStateStatus ?? 'n/a'})`,
    };
  }

  return {
    blockClass: 'api-race-other',
    reason: describeApiRaceFallback(prProbe, budget),
  };
}
