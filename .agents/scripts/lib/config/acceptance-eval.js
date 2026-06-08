/**
 * Acceptance self-eval accessor (Story #3819).
 *
 * Resolves `.agentrc.json → delivery.acceptanceEval` into the canonical
 * shape the per-Story acceptance self-eval loop consumes. The loop scores
 * the working diff against each inline `acceptance[]` item, redrafts the
 * unmet items, and re-evaluates — capped at `maxRounds` redraft rounds,
 * then escalates to `agent::blocked` when criteria remain unmet.
 *
 * ## The undisableable cap
 *
 * `maxRounds` is operator-tunable, but the cap itself can never be turned
 * off. Two invariants enforce the open-loop token-burn guard:
 *
 *   1. A configured value is clamped into
 *      `[1, ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING]`. `maxRounds: 0` (which
 *      would disable the loop) clamps up to 1; a pathological
 *      `maxRounds: 9999` clamps down to the ceiling.
 *   2. Non-integer / non-finite / missing values fall back to the
 *      documented default. The AJV schema already rejects `maxRounds < 1`
 *      and non-integers before they reach this accessor, but the resolver
 *      stays defensive so unit-test fixtures and degraded configs never
 *      produce an unbounded or zero-round loop.
 *
 * There is intentionally no `enabled` flag — the loop is a hard cutover
 * (always on) per `rules/git-conventions.md` (no parallel old-shape path,
 * no toggle between "loop" and "no loop").
 */

/**
 * Default redraft-round ceiling applied when `.agentrc.json` omits
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
 * Hard, undisableable ceiling on the number of redraft rounds. No
 * configuration can exceed this value — it is the open-loop token-burn
 * guard. A configured `maxRounds` larger than the ceiling is clamped down
 * to it.
 *
 * @type {number}
 */
export const ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING = 5;

/**
 * Clamp a candidate round count into the inviolable `[1, ceiling]` range.
 * Non-integer / non-finite inputs fall back to the documented default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampRounds(value, fallback) {
  const candidate =
    typeof value === 'number' && Number.isInteger(value) ? value : fallback;
  if (candidate < 1) return 1;
  if (candidate > ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING) {
    return ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING;
  }
  return candidate;
}

/**
 * Read the merged acceptance-eval block. Returns the canonical shape:
 *
 *   {
 *     maxRounds: number,   // clamped into [1, ceiling]
 *     ceiling: number,     // the undisableable hard cap
 *   }
 *
 * `maxRounds` is always a positive integer no greater than `ceiling`,
 * regardless of what the resolved config carried.
 *
 * @param {object | null | undefined} config
 * @returns {{ maxRounds: number, ceiling: number }}
 */
export function getAcceptanceEval(config) {
  const user = config?.delivery?.acceptanceEval ?? {};
  const maxRounds = clampRounds(
    user.maxRounds,
    ACCEPTANCE_EVAL_DEFAULTS.maxRounds,
  );
  return {
    maxRounds,
    ceiling: ACCEPTANCE_EVAL_MAX_ROUNDS_CEILING,
  };
}
