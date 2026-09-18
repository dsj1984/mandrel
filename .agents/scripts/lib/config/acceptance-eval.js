/**
 * `delivery.acceptanceEval`: redraft rounds before `agent::blocked`. `0`
 * scores once with no redraft; the scoring pass itself cannot be disabled.
 */

/**
 * Keep in lockstep with `agentrc.schema.json` and
 * `config-settings-schema-delivery.js#ACCEPTANCE_EVAL_SCHEMA`.
 */
export const ACCEPTANCE_EVAL_DEFAULTS = Object.freeze({
  maxRounds: 2,
});

/**
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
