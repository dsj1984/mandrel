/**
 * lib/orchestration/review-depth.js — Shared review-depth resolver combining
 * judged risk and mechanical diff width (Story #3938).
 *
 * The single depth authority for the code-review pipeline. It folds the two
 * signals the framework already computes — the planner-judged risk
 * (`planningRisk.overallLevel`) and the mechanical changed-file count of the
 * diff under review — into one tier (`light` / `standard` / `deep`) without
 * inventing a new complexity score or any new config knob.
 *
 * Tier rules:
 *   - `deep`     — `overallLevel === 'high'` OR the changed-file count exceeds
 *                  the wide-change scale (`sizing.hardFiles`). A wide-footprint
 *                  Epic whose risk was judged low (or never judged) still earns
 *                  a deep pass on size alone.
 *   - `light`    — `overallLevel === 'low'` AND the changed-file count is at or
 *                  below the small-change scale (`sizing.softFiles`). An
 *                  *unknown* count does NOT block `light`: a missing diff width
 *                  is treated as "not wide", so a low-risk Epic with no count
 *                  still resolves to `light` (preserves the #3937 producer
 *                  contract where depth is resolved from risk before any diff
 *                  is enumerated).
 *   - `standard` — everything else, including absent/malformed risk envelopes
 *                  and a `medium` level. Fail toward the middle, never toward
 *                  `light`: an Epic that skipped `/plan` has no risk
 *                  verdict, and treating it as `light` would under-review
 *                  unjudged work while `standard` preserves today's behaviour.
 *
 * Pure and total: inputs in, tier out. No I/O, no throws. `null` / `undefined`
 * / malformed inputs all degrade to `standard` (or `deep`/`light` only when the
 * width signal unambiguously says so). Callers (e.g. `runCodeReview`) enumerate
 * the changed-file count from the diff they already run and supply it here, and
 * pass the operator's `planning.taskSizing` override as `sizing` so retuning
 * sizing retunes the depth thresholds in lockstep with the ticket validator.
 *
 * @typedef {'light'|'standard'|'deep'} ReviewDepth
 */

import { DEFAULT_TASK_SIZING } from './ticket-validator-sizing.js';

/**
 * Coerce an arbitrary input into a non-negative integer changed-file count, or
 * `null` when the count is unknown / unusable. A `null` count is the neutral
 * "width unknown" signal: it neither triggers `deep` nor blocks `light`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeChangedFileCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Resolve the review depth for a change set from its judged risk and diff
 * width. See the module header for the tier rules.
 *
 * @param {{
 *   overallLevel?: ('low'|'medium'|'high'|string|null|undefined),
 *   changedFileCount?: (number|null|undefined),
 *   sizing?: { softFiles?: number, hardFiles?: number }|null,
 * }} [input]
 * @returns {ReviewDepth}
 */
export function resolveDepth(input = {}) {
  const overallLevel =
    input && typeof input === 'object' ? input.overallLevel : undefined;
  const changedFileCount =
    input && typeof input === 'object'
      ? normalizeChangedFileCount(input.changedFileCount)
      : null;

  const mergedSizing = {
    ...DEFAULT_TASK_SIZING,
    ...(input && typeof input === 'object' && input.sizing ? input.sizing : {}),
  };
  const { softFiles, hardFiles } = mergedSizing;

  // A known count strictly above the wide-change scale is wide.
  const isWide = changedFileCount !== null && changedFileCount > hardFiles;
  // An unknown count is treated as "not wide" — it does not block `light`.
  const isSmall = changedFileCount === null || changedFileCount <= softFiles;

  // deep — high judged risk OR a wide diff.
  if (overallLevel === 'high' || isWide) return 'deep';
  // light — low judged risk AND a (known-or-unknown-but-not-wide) small diff.
  if (overallLevel === 'low' && isSmall) return 'light';
  // standard — everything else (medium, absent/malformed level, or a low-risk
  // diff whose width is between softFiles and hardFiles).
  return 'standard';
}
