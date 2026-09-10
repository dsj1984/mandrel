/**
 * phases/options.js — CLI / injection option parsing for
 * `single-story-close`.
 *
 * Handles the conditional param-vs-CLI branch and all flag defaults in one
 * place so the main `runSingleStoryClose` body stays focused on close
 * pipeline logic. Each `??` operator counts as a branch in escomplex; the
 * `resolveFlag` helper keeps the cyclomatic complexity tally bounded.
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
 * Resolve a flag value from an explicit override or a parsed CLI arg.
 *
 * Returns `undefined` when neither is supplied — that absence is itself the
 * answer here, letting each caller below apply its own default (a `!!` coerce,
 * a config lookup, or a deliberate `undefined` passed further down). The
 * former third `defaultValue` parameter was dropped in Story #4961: no call
 * site passed it, so it documented a mode nobody used.
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
 * An integer flag at or above `min`, or `undefined` — the shape BOTH numeric
 * close flags share (Story #5266 deduplicated them): absence is preserved so
 * the reader downstream applies its own config default, and a junk value is
 * treated as absent rather than coerced into a bound nobody asked for.
 *
 * `min` is what separates them: `--max-wait-seconds 0` is a typo (a
 * zero-second wait), while `--rerun-advisory 0` is the meaningful default.
 *
 * @param {unknown} value
 * @param {number} min
 * @returns {number|undefined}
 */
function intAtLeast(value, min) {
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/**
 * Resolve whether close lands the PR in-process (`waitForMerge`).
 *
 * Called by `runSingleStoryClose` **after** config resolution and the
 * auto-merge phase, because two of its four inputs are not knowable at
 * parse time: the resolved config (whose `cwd` this parse produces) and the
 * actual arm outcome. Resolving it here — once, where every input exists —
 * is what makes `delivery.routing.closeAndLand` governable at all.
 *
 * Precedence, highest first:
 *   1. `--no-wait-merge` / injected opt-out — always wins.
 *   2. **Operator owns the merge** (`--no-auto-merge`, or
 *      `delivery.ci.autoMerge: "strict"`): the PR was deliberately left
 *      un-armed, so there is nothing for close to land. Resting at
 *      `agent::closing` for the human IS the documented contract for both
 *      surfaces; waiting would only burn the poll budget and then block a
 *      perfectly healthy Story. An explicit `--wait-merge` cannot override
 *      this — you cannot land-in-one-close a PR you refused to arm — so the
 *      caller is told rather than silently ignored.
 *   3. Explicit `--wait-merge` / injected boolean.
 *   4. `delivery.routing.closeAndLand` (framework default `true`).
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
 * Flags this CLI advertised in its `--help` descriptor and never implemented
 * (Story #5100). `--dry-run` was transcribed into the usage block by the
 * #4750 self-describing sweep and read by nothing in this pipeline —
 * `git log -S dryRun` over it is empty in every revision — so an operator who
 * trusted it got a real base-sync merge, an `agent::blocked` Story, and a
 * terminal envelope that then captured `deliver-recover`'s routing.
 * `--no-evidence` names a working flag on the gate wrappers
 * (`evidence-gate.js`), but the slot this CLI parsed had no reader at all.
 *
 * Deleting them from the descriptor is NOT enough. `parseSprintArgs` runs
 * `parseArgs` with `strict: false`, so an unknown flag is silently ignored and
 * the close proceeds for real — the identical injury, now with no help text to
 * explain it. Fail closed instead, exactly as `parseMergeWatchMode` does for an
 * unrecognized mode: throw during option parsing, before the first phase, so
 * the CLI boundary reports `failed` at phase `init` and nothing is mutated.
 */
const RETIRED_FLAGS = Object.freeze({
  '--dry-run':
    'this pipeline has never had a dry-run mode; it was advertised in error.',
  '--no-evidence':
    'per-close evidence control was never wired here; the working flag of that name belongs to the gate wrappers.',
});

/**
 * Reject a retired flag before any phase runs.
 *
 * Matches `--flag` and `--flag=value`; a bare `--` terminator or a positional
 * that merely contains the text is not a flag and does not trip it.
 *
 * @param {string[]} argv argv tail (`process.argv.slice(2)`)
 * @throws {Error} naming the flag, why it is gone, and that nothing was mutated
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
 * Parse and resolve all CLI / injection options for `runSingleStoryClose`.
 *
 * `waitForMerge` is deliberately **not** resolved here — see
 * {@link resolveWaitForMerge}. This returns the raw operator intent
 * (`waitForMergeExplicit` / `noWaitForMerge`) for the runner to resolve once
 * the config and the arm outcome exist.
 *
 * @param {{ storyIdParam, cwdParam, skipValidationParam, skipSyncParam, noAutoMergeParam, waitForMergeParam, noWaitForMergeParam, maxWaitSecondsParam, mergeWatchModeParam, rerunAdvisoryParam, overrideReviewBlockParam }} raw
 * @returns {{ storyId, cwd, skipValidation, skipSync, noAutoMerge, waitForMergeExplicit, noWaitForMerge, maxWaitSeconds, mergeWatchMode, rerunAdvisory, overrideReviewBlock }}
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
}) {
  // An injecting caller (`storyIdParam` supplied) is not reading argv at all,
  // so there is nothing to parse and `parsed` stays empty. This used to build a
  // stand-in object that copied every `*Param` into the slot of the same name —
  // which is precisely what `resolveFlag` already does below, preferring the
  // param over the parsed slot. One expression per flag now serves both
  // callers, so a new flag is added in one place instead of two that can drift.
  // The guard runs on the argv door only: an injecting caller supplies
  // `storyIdParam` and never reads argv, so the host process's flags (a test
  // runner's, say) are none of its business.
  let parsed = {};
  if (storyIdParam === undefined) {
    assertNoRetiredFlags(process.argv.slice(2));
    parsed = parseSprintArgs();
  }
  // Preserve undefined so resolveWaitForMerge can apply the closeAndLand
  // config default when neither flag was supplied.
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
    // `undefined` when unsupplied — the merge wait then reads
    // `delivery.mergeWatch.maxWaitSeconds`. A per-run override exists so a
    // headless caller with no host tool-invocation ceiling can keep
    // single-block semantics without editing the consumer's config.
    maxWaitSeconds: intAtLeast(maxWaitSeconds, 1),
    // `undefined` when unsupplied — the merge wait then reads
    // `delivery.mergeWatch.mode`. The two merge-watch flags stay composable and
    // mode-agnostic: `--merge-watch-mode async` picks the posture, and an
    // explicit `--max-wait-seconds` still wins over that posture's probe cap.
    mergeWatchMode: parseMergeWatchMode(
      resolveFlag(mergeWatchModeParam, parsed.mergeWatchMode),
    ),
    // Story #5266 — `undefined` when unsupplied, so the merge wait reads
    // `delivery.ci.rerunAdvisory` (default 0). An explicit 0 is preserved as
    // an explicit 0: it means "spend nothing", which is also the default, but
    // an operator who typed it must not have it read as absent.
    rerunAdvisory: intAtLeast(rerunAdvisory, 0),
    skipValidation: !!resolveFlag(skipValidationParam, parsed.skipValidation),
    skipSync: !!resolveFlag(skipSyncParam, parsed.skipSync),
    noAutoMerge: !!resolveFlag(noAutoMergeParam, parsed.noAutoMerge),
    waitForMergeExplicit:
      typeof waitForMergeExplicit === 'boolean'
        ? waitForMergeExplicit
        : undefined,
    noWaitForMerge: !!resolveFlag(noWaitForMergeParam, parsed.noWaitForMerge),
    // `undefined` when unsupplied, which is what keeps a review
    // critical blocker blocking. An injecting caller passes the reason string
    // directly; both doors run the same validating parser, so neither can arm
    // a reasonless override.
    overrideReviewBlock: parseOverrideReviewBlock(
      resolveFlag(overrideReviewBlockParam, parsed.overrideReviewBlock),
    ),
  };
}
