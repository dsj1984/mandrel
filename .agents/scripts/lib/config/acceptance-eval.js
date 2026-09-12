/**
 * Acceptance self-eval accessor (Story #3819, Story #5313).
 *
 * Resolves `.agentrc.json → delivery.acceptanceEval` into the canonical
 * shape the per-Story acceptance self-eval loop consumes. The loop scores
 * the caller-injected change set against each inline `acceptance[]` item,
 * redrafts the unmet items, and re-evaluates — capped at `maxRounds`
 * redraft rounds, then escalates to `agent::blocked` when criteria remain
 * unmet.
 *
 * Story #5313 dropped the hard ceiling (`ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING`)
 * and the floor-of-one clamp: `maxRounds` is any non-negative integer, and
 * `0` means the verdict is scored **once** with no redraft round. The
 * scoring pass itself is always on — there is intentionally no `enabled`
 * flag (hard cutover per `rules/git-conventions.md`); only the redraft
 * budget is tunable.
 */

/**
 * Default redraft-round budget applied when `.agentrc.json` omits
 * `delivery.acceptanceEval.maxRounds`. Frozen so downstream callers cannot
 * mutate the resolver's defaults across processes.
 *
 * Keep in lockstep with the schema mirror in
 * `agentrc.schema.json → $defs.acceptanceEval` and the AJV schema in
 * `config-settings-schema-delivery.js → ACCEPTANCE_EVAL_SCHEMA`.
 */
export const ACCEPTANCE_EVAL_DEFAULTS = Object.freeze({
  maxRounds: 2,
});

/**
 * Normalize a candidate round count: a non-negative integer is taken as-is
 * (including `0`); anything else — negative, non-integer, non-finite,
 * missing — falls back to the documented default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeRounds(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

/**
 * Read the merged acceptance-eval block. Returns the canonical shape:
 *
 *   { maxRounds: number }  // non-negative integer; 0 = scored once
 *
 * @param {object | null | undefined} config
 * @returns {{ maxRounds: number }}
 */
export function getAcceptanceEval(config) {
  const user = config?.delivery?.acceptanceEval ?? {};
  return {
    maxRounds: normalizeRounds(
      user.maxRounds,
      ACCEPTANCE_EVAL_DEFAULTS.maxRounds,
    ),
  };
}
