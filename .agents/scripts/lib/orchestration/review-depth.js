/**
 * lib/orchestration/review-depth.js — the review-depth authority: derives a
 * change level from observable facts and folds it with diff width into a tier
 * (Story #3938, re-based on a derived signal by Story #4542).
 *
 * ## Why the level is derived, not authored
 *
 * This module used to consume `planningRisk.overallLevel` — a level the planner
 * asserted about the plan it had just written. That signal was self-refereed and
 * its fail-safe ran backwards: an *absent* verdict degraded toward MORE ceremony
 * (standard depth), while a schema-valid all-low verdict bought `light`. Nothing
 * cross-checked the claimed axes against the files actually touched, so the one
 * input that could *reduce* review was exactly the one nobody verified. Story
 * #4542 inverted that: the level is now derived at close time from the changed
 * files themselves, which makes it a fact rather than a claim — and therefore
 * trustworthy enough to reduce ceremony on.
 *
 * ## The two signals
 *
 *   - **Sensitive paths** ({@link deriveChangeLevel}) — the changed-file set
 *     intersected with the `sensitivePaths` classes registered in
 *     `.agents/schemas/audit-rules.json` (auth, migrations, billing, destructive
 *     mutation, public API). Registered as **configuration**, matched with the
 *     audit-suite's existing picomatch machinery. This is what keeps a *narrow*
 *     high-stakes diff — a three-file auth fix, a small migration — at `deep`,
 *     the one thing a pure width heuristic would miss.
 *   - **Diff width** — the mechanical changed-file count, unchanged in role.
 *
 * ## Tier rules ({@link resolveDepth})
 *
 *   - `deep`     — `derivedLevel === 'high'` (a sensitive path was touched) OR
 *                  the changed-file count exceeds the wide-change scale
 *                  (`diffWidth.hardFiles`). A wide diff earns a deep pass on
 *                  size alone even when it touches nothing sensitive.
 *   - `light`    — `derivedLevel === 'low'` (the change set is known and touches
 *                  no sensitive path) AND the count is at or below the
 *                  small-change scale (`diffWidth.softFiles`). An *unknown*
 *                  count does not block `light`: a missing width is treated as
 *                  "not wide".
 *   - `standard` — everything else, including an absent/underivable level. Fail
 *                  toward the middle, never toward `light`: when the diff cannot
 *                  be enumerated there is no evidence the change is safe, and
 *                  `standard` preserves today's behaviour.
 *
 * {@link resolveDepth} is pure and total: inputs in, tier out. No I/O, no
 * throws. `null` / `undefined` / malformed inputs degrade to `standard` (or
 * `deep`/`light` only when a signal unambiguously says so). {@link
 * deriveChangeLevel} owns the one manifest read and is likewise total — any
 * failure degrades to the `null` (fail-safe) level.
 *
 * v2 Stage 2: review depth is **decoupled** from the planning model-capacity
 * advisory. Diff width is a mechanical review signal (files in the landed
 * diff); planning capacity is an absolute authored-token session-mass signal.
 * The two no longer share a constant.
 *
 * @typedef {'light'|'standard'|'deep'} ReviewDepth
 * @typedef {'low'|'high'} ChangeLevel
 */

import { selectSensitivePathClasses } from '../audit-suite/selector.js';

/**
 * Mechanical diff-width scales for review-depth tiering. These are **not**
 * planning Story-sizing ceilings (those are gone in v2) — they only classify
 * the changed-file count of a diff under review.
 */
export const DEFAULT_DIFF_WIDTH = Object.freeze({
  softFiles: 15,
  hardFiles: 30,
});

/**
 * Derive the change level for a change set from observable facts: does the
 * changed-file set intersect any sensitive-path class registered in
 * `audit-rules.json`?
 *
 * This is the **single source** of the derived level — both the review depth
 * ({@link resolveDepth}) and the acceptance-critic fresh-vs-inline routing
 * (`ceremony-routing.js#resolveCeremonyForRisk`) consume what this returns, so
 * the two ceremony decisions can never disagree about how risky a change is.
 *
 * Returns `null` — the fail-safe "no derivable signal" level — when the change
 * set is empty/unknown or the manifest cannot be read. Both downstream
 * consumers treat `null` as the more thorough posture (`standard` depth, a
 * `fresh` critic), so a derivation failure never buys a change less checking.
 *
 * Total: never throws.
 *
 * @param {{
 *   changedFiles?: string[]|null,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: typeof selectSensitivePathClasses,
 * }} [input]
 * @returns {{ level: ChangeLevel|null, classes: string[] }}
 */
export function deriveChangeLevel(input = {}) {
  const changedFiles =
    input && typeof input === 'object' ? input.changedFiles : null;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { level: null, classes: [] };
  }

  const select =
    input.selectSensitivePathClassesFn ?? selectSensitivePathClasses;
  let classes;
  try {
    classes = select({ changedFiles, injectedRules: input.injectedRules });
  } catch {
    // An unreadable/invalid manifest is not evidence the change is safe.
    return { level: null, classes: [] };
  }
  const matched = Array.isArray(classes) ? classes : [];
  return { level: matched.length > 0 ? 'high' : 'low', classes: matched };
}

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
 * Resolve the review depth for a change set from its derived level (see
 * {@link deriveChangeLevel}) and diff width. See the module header for the tier
 * rules.
 *
 * @param {{
 *   derivedLevel?: (ChangeLevel|string|null|undefined),
 *   changedFileCount?: (number|null|undefined),
 *   diffWidth?: { softFiles?: number, hardFiles?: number }|null,
 * }} [input]
 * @returns {ReviewDepth}
 */
export function resolveDepth(input = {}) {
  const derivedLevel =
    input && typeof input === 'object' ? input.derivedLevel : undefined;
  const changedFileCount =
    input && typeof input === 'object'
      ? normalizeChangedFileCount(input.changedFileCount)
      : null;

  const override =
    input && typeof input === 'object' ? (input.diffWidth ?? {}) : {};
  const mergedWidth = {
    ...DEFAULT_DIFF_WIDTH,
    ...override,
  };
  const { softFiles, hardFiles } = mergedWidth;

  // A known count strictly above the wide-change scale is wide.
  const isWide = changedFileCount !== null && changedFileCount > hardFiles;
  // An unknown count is treated as "not wide" — it does not block `light`.
  const isSmall = changedFileCount === null || changedFileCount <= softFiles;

  // deep — a sensitive path was touched OR the diff is wide.
  if (derivedLevel === 'high' || isWide) return 'deep';
  // light — nothing sensitive touched AND a (known-or-unknown-but-not-wide)
  // small diff.
  if (derivedLevel === 'low' && isSmall) return 'light';
  // standard — everything else: an underivable level, or a non-sensitive diff
  // whose width sits between softFiles and hardFiles.
  return 'standard';
}
