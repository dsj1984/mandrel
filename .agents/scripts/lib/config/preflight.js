/**
 * `delivery.preflight` accessor + framework defaults — Story #2899
 * (Epic #2880, F13).
 *
 * Thresholds consumed by `.agents/scripts/epic-deliver-preflight.js`.
 * The defaults are intentionally generous so that a brand-new Epic on a
 * zero-config project does not trip a breach. Operators tighten thresholds
 * per project in `.agentrc.json`. A `null` floor means "no cap" — used by
 * the preflight runner to skip the corresponding breach check.
 */

export const PREFLIGHT_DEFAULTS = Object.freeze({
  maxStories: null,
  maxWaves: null,
  maxInstallCostSeconds: null,
  maxGithubApiRequests: null,
  maxClaudeQuotaTokens: null,
});

/**
 * Read the merged `delivery.preflight` block, applying framework defaults
 * for any field the operator omitted. Accepts the full resolved config,
 * the bare delivery bag, or the bare preflight bag.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   maxStories: number | null,
 *   maxWaves: number | null,
 *   maxInstallCostSeconds: number | null,
 *   maxGithubApiRequests: number | null,
 *   maxClaudeQuotaTokens: number | null,
 * }}
 */
export function getPreflight(config) {
  const pf = config?.delivery?.preflight ?? config?.preflight ?? config ?? {};
  return {
    maxStories: normaliseFloor(pf.maxStories, PREFLIGHT_DEFAULTS.maxStories),
    maxWaves: normaliseFloor(pf.maxWaves, PREFLIGHT_DEFAULTS.maxWaves),
    maxInstallCostSeconds: normaliseFloor(
      pf.maxInstallCostSeconds,
      PREFLIGHT_DEFAULTS.maxInstallCostSeconds,
    ),
    maxGithubApiRequests: normaliseFloor(
      pf.maxGithubApiRequests,
      PREFLIGHT_DEFAULTS.maxGithubApiRequests,
    ),
    maxClaudeQuotaTokens: normaliseFloor(
      pf.maxClaudeQuotaTokens,
      PREFLIGHT_DEFAULTS.maxClaudeQuotaTokens,
    ),
  };
}

function normaliseFloor(value, fallback) {
  if (value === null) return null;
  if (Number.isInteger(value) && value >= 1) return value;
  return fallback;
}
