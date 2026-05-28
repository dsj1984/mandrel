// .agents/scripts/lib/story-plan/trigger.js
/**
 * Triggering predicate for the story-plan structured-comment checkpoint
 * (Epic #3212). A Story is considered "non-trivial" (always-emit) when
 * any of:
 *
 *   - `changes.length >= floor.changes`   (default 3), OR
 *   - `acceptance.length >= floor.acceptance` (default 3), OR
 *   - `sizingProfile === 'atomic-rewrite'`
 *
 * The floors are overridable via the `delivery.storyPlan.alwaysEmitFloor`
 * config object, which is resolved by `config-resolver.js` and passed
 * directly to `isNonTrivial`. When the caller passes no floor overrides
 * the module defaults apply.
 *
 * @module story-plan/trigger
 */

import { SIZING_PROFILE_VALUES } from '../orchestration/ticket-validator-sizing.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default always-emit floor values when no config override is present. */
export const DEFAULT_ALWAYS_EMIT_FLOOR = Object.freeze({
  changes: 3,
  acceptance: 3,
});

/**
 * The sizing profile that always triggers a story-plan comment regardless
 * of changes/acceptance counts.
 */
export const ALWAYS_EMIT_SIZING_PROFILE = 'atomic-rewrite';

// Guard: ensure ALWAYS_EMIT_SIZING_PROFILE is still in the enum set.
// If ticket-validator-sizing.js removes 'atomic-rewrite', this module
// needs an update.
if (!SIZING_PROFILE_VALUES.includes(ALWAYS_EMIT_SIZING_PROFILE)) {
  throw new Error(
    `trigger.js: ALWAYS_EMIT_SIZING_PROFILE "${ALWAYS_EMIT_SIZING_PROFILE}" is not in SIZING_PROFILE_VALUES. ` +
      `Update this module when the sizing enum changes.`,
  );
}

// ---------------------------------------------------------------------------
// Predicate
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AlwaysEmitFloor
 * @property {number} [changes]    - Minimum changes[] length. Default 3.
 * @property {number} [acceptance] - Minimum acceptance[] length. Default 3.
 */

/**
 * @typedef {object} IsNonTrivialInput
 * @property {Array<unknown>} changes        - Parsed `changes[]` array from the Story body.
 * @property {Array<string>}  acceptance     - Parsed `acceptance[]` array from the Story body.
 * @property {string|null}    sizingProfile  - The Story's sizing profile, or null.
 * @property {AlwaysEmitFloor} [floor]       - Config overrides for the triggering thresholds.
 */

/**
 * Return `true` when the Story should always emit a story-plan comment
 * (i.e. it is "non-trivial"), `false` when it is below all thresholds.
 *
 * The predicate is intentionally pure — no I/O, no side effects. The
 * caller (Step 0.6 of `single-story-deliver.md`) is responsible for
 * resolving the Story body and the config floor before calling here.
 *
 * ### Rules (any one is sufficient)
 * 1. `changes.length >= floor.changes` — the Story touches enough files.
 * 2. `acceptance.length >= floor.acceptance` — the Story has enough AC items.
 * 3. `sizingProfile === 'atomic-rewrite'` — the heaviest sizing profile.
 *
 * @param {IsNonTrivialInput} input
 * @returns {boolean}
 */
export function isNonTrivial({ changes, acceptance, sizingProfile, floor }) {
  const resolvedFloor = {
    changes:
      typeof floor?.changes === 'number' && floor.changes >= 1
        ? floor.changes
        : DEFAULT_ALWAYS_EMIT_FLOOR.changes,
    acceptance:
      typeof floor?.acceptance === 'number' && floor.acceptance >= 1
        ? floor.acceptance
        : DEFAULT_ALWAYS_EMIT_FLOOR.acceptance,
  };

  const changesCount = Array.isArray(changes) ? changes.length : 0;
  const acceptanceCount = Array.isArray(acceptance) ? acceptance.length : 0;

  if (changesCount >= resolvedFloor.changes) return true;
  if (acceptanceCount >= resolvedFloor.acceptance) return true;
  if (sizingProfile === ALWAYS_EMIT_SIZING_PROFILE) return true;

  return false;
}
