/**
 * phases/options.js — CLI / injection option parsing for `single-story-close`.
 */

import path from 'node:path';
import {
  parseMergeWatchMode,
  parseOverrideReviewBlock,
  parseSprintArgs,
} from '../../../cli-args.js';
import { getDeliveryRouting } from '../../../config/delivery-routing.js';
import { PROJECT_ROOT } from '../../../project-root.js';
import { isOperatorMergeReason } from './auto-merge.js';

/**
 * Param beats parsed arg; `undefined` lets each caller apply its own default.
 * (A helper, since each `??` counts toward cyclomatic complexity.)
 *
 * @template T
 * @param {T|undefined} paramValue
 * @param {T|undefined} parsedValue
 * @returns {T|undefined}
 */
function resolveFlag(paramValue, parsedValue) {
  return paramValue ?? parsedValue;
}

/**
 * A boolean flag: param beats parsed arg, absent reads as `false`.
 *
 * @param {unknown} paramValue
 * @param {unknown} parsedValue
 * @returns {boolean}
 */
function booleanFlag(paramValue, parsedValue) {
  return !!resolveFlag(paramValue, parsedValue);
}

/**
 * Junk reads as absent (so the config default applies), never coerced.
 *
 * @param {unknown} value
 * @param {number} min
 * @returns {number|undefined}
 */
function intAtLeast(value, min) {
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/**
 * Precedence: `--no-wait-merge`; then an un-armed PR (operator owns the
 * merge — not even `--wait-merge` can land it); then `--wait-merge`; then
 * `delivery.routing.closeAndLand`.
 *
 * @param {{
 *   waitForMergeExplicit?: boolean,
 *   noWaitForMerge?: boolean,
 *   config?: object|null,
 *   autoMergeReason?: string|null,
 * }} args
 * @returns {{ waitForMerge: boolean, reason: 'opt-out-flag'|'operator-merge'|'explicit-flag'|'config-close-and-land' }}
 */
export function resolveWaitForMerge({
  waitForMergeExplicit,
  noWaitForMerge = false,
  config = null,
  autoMergeReason = null,
} = {}) {
  if (noWaitForMerge) {
    return { waitForMerge: false, reason: 'opt-out-flag' };
  }
  if (isOperatorMergeReason(autoMergeReason)) {
    return { waitForMerge: false, reason: 'operator-merge' };
  }
  if (typeof waitForMergeExplicit === 'boolean') {
    return { waitForMerge: waitForMergeExplicit, reason: 'explicit-flag' };
  }
  return {
    waitForMerge: getDeliveryRouting(config).closeAndLand,
    reason: 'config-close-and-land',
  };
}

/**
 * Flags once advertised but never implemented. Parsing is `strict: false`,
 * so an unknown flag would be silently ignored and the close run for real;
 * reject them before any phase instead.
 */
const RETIRED_FLAGS = Object.freeze({
  '--dry-run':
    'this pipeline has never had a dry-run mode; it was advertised in error.',
  '--no-evidence':
    'per-close evidence control was never wired here; the working flag of that name belongs to the gate wrappers.',
});

/**
 * Matches `--flag` and `--flag=value` only.
 *
 * @param {string[]} argv
 * @throws {Error}
 */
function assertNoRetiredFlags(argv) {
  for (const [flag, why] of Object.entries(RETIRED_FLAGS)) {
    const present = argv.some((a) => a === flag || a.startsWith(`${flag}=`));
    if (!present) continue;
    throw new Error(
      `${flag} was retired: ${why} Nothing was mutated — no branch, label, ` +
        `comment, or PR was touched. Re-run without it to close for real.`,
    );
  }
}

/**
 * Returns raw wait-for-merge intent; the runner resolves it after the arm.
 *
 * @param {{ storyIdParam, cwdParam, skipValidationParam, skipSyncParam, noAutoMergeParam, waitForMergeParam, noWaitForMergeParam, maxWaitSecondsParam, mergeWatchModeParam, rerunAdvisoryParam, overrideReviewBlockParam, workerTokensParam }} raw
 * @returns {{ storyId, cwd, skipValidation, skipSync, noAutoMerge, waitForMergeExplicit, noWaitForMerge, maxWaitSeconds, mergeWatchMode, rerunAdvisory, overrideReviewBlock, workerTokens }}
 */
export function parseCloseOptions({
  storyIdParam,
  cwdParam,
  skipValidationParam,
  skipSyncParam,
  noAutoMergeParam,
  waitForMergeParam,
  noWaitForMergeParam,
  maxWaitSecondsParam,
  mergeWatchModeParam,
  rerunAdvisoryParam,
  overrideReviewBlockParam,
  workerTokensParam,
}) {
  // An injecting caller never reads argv (the host's flags are not its
  // business), so `parsed` stays empty and the retired-flag guard is skipped.
  let parsed = {};
  if (storyIdParam === undefined) {
    assertNoRetiredFlags(process.argv.slice(2));
    parsed = parseSprintArgs();
  }
  // Undefined when unsupplied, so the closeAndLand default applies.
  const waitForMergeExplicit = resolveFlag(
    waitForMergeParam,
    parsed.waitForMerge,
  );
  const maxWaitSeconds = resolveFlag(
    maxWaitSecondsParam,
    parsed.maxWaitSeconds,
  );
  const rerunAdvisory = resolveFlag(rerunAdvisoryParam, parsed.rerunAdvisory);
  return {
    storyId: resolveFlag(storyIdParam, parsed.storyId),
    cwd: path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT),
    // Unsupplied values stay `undefined` so config defaults apply; 0 is a
    // typo for a wait but a meaningful rerun allowance.
    maxWaitSeconds: intAtLeast(maxWaitSeconds, 1),
    mergeWatchMode: parseMergeWatchMode(
      resolveFlag(mergeWatchModeParam, parsed.mergeWatchMode),
    ),
    rerunAdvisory: intAtLeast(rerunAdvisory, 0),
    skipValidation: booleanFlag(skipValidationParam, parsed.skipValidation),
    skipSync: booleanFlag(skipSyncParam, parsed.skipSync),
    noAutoMerge: booleanFlag(noAutoMergeParam, parsed.noAutoMerge),
    waitForMergeExplicit:
      typeof waitForMergeExplicit === 'boolean'
        ? waitForMergeExplicit
        : undefined,
    noWaitForMerge: booleanFlag(noWaitForMergeParam, parsed.noWaitForMerge),
    // Both doors validate, so neither can arm a reasonless override.
    overrideReviewBlock: parseOverrideReviewBlock(
      resolveFlag(overrideReviewBlockParam, parsed.overrideReviewBlock),
    ),
    // Raw: validated best-effort by the runner, never thrown on.
    workerTokens: resolveFlag(workerTokensParam, parsed.workerTokens),
  };
}
