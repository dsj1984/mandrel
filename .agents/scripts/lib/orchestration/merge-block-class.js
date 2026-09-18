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
 * Every class `classifyMergeBlock` can return, in its evaluation priority.
 */
export const BLOCK_CLASSES = Object.freeze([
  CHECKS_FAILED_CLASS,
  'checks-pending-timeout',
  'branch-protection-human-required',
  'arm-failure',
  'api-race-other',
]);

/**
 * Plus classes emitted directly, never by the classifier: `predicate-refused`
 * (kept so archived records validate) and the advisory-gate pair.
 */
export const MERGE_UNLANDED_BLOCK_CLASSES = Object.freeze([
  ...BLOCK_CLASSES,
  'predicate-refused',
  // Sourced from the gate's own constants so the vocabulary cannot drift.
  ADVISORY_GATE_RED_CLASS,
  ADVISORY_GATE_INCONCLUSIVE_CLASS,
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

  // 1. Arm failed: no armed PR is left to probe.
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

  // Positive evidence only: `unknown` routes to the fallback; `undefined`
  // (no probe) keeps the step-2 mapping.
  const checksStatus = prProbe?.checksStatus;
  const checksPendingEvidence =
    checksStatus === 'pending' ||
    checksStatus === 'still-running' ||
    prProbe?.requiredRunEvidence?.requiredRunInFlight === true;

  // 1b. Definitive, and before step 3 since it also presents as BLOCKED.
  // Head-anchored evidence, not the raw rollup (optional/superseded runs).
  if (requiredCheckFailedBlocksMerge(prProbe)) {
    return {
      blockClass: CHECKS_FAILED_CLASS,
      reason: formatChecksFailedReason(prProbe, prProbe?.evidencePath),
    };
  }

  // 2. BLOCKED is the steady state while checks run; a slow-CI timeout must
  // not read as human-required.
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

  // 3. BLOCKED counts only with checks settled — a genuinely human gate.
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

  return {
    blockClass: 'api-race-other',
    reason: describeApiRaceFallback(prProbe, budget),
  };
}
