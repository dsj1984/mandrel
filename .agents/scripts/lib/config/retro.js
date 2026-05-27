/**
 * Retro accessor (Story #3042 / Task #3043 — Epic #3019).
 *
 * Resolves `.agentrc.json → delivery.retro` into the canonical shape the
 * retro-runner consumes. Currently exposes only `perfThresholds`, the
 * operator-tunable gates for the perf-signals classifier in
 * `lib/orchestration/retro-perf-heuristics.js`.
 *
 * Defaults mirror `DEFAULT_RETRO_PERF_THRESHOLDS` in the heuristics module
 * (single source of behavioural truth; this resolver is a thin merge layer).
 */

/**
 * Default perf-threshold trio applied when `.agentrc.json` omits
 * `delivery.retro.perfThresholds` (or any of its sub-keys). Frozen so
 * downstream callers cannot accidentally mutate the resolver's defaults
 * across processes.
 *
 * Keep in lockstep with `DEFAULT_RETRO_PERF_THRESHOLDS` in
 * `lib/orchestration/retro-perf-heuristics.js` and the schema mirror in
 * `agentrc.schema.json → $defs.retro.properties.perfThresholds`.
 */
export const DEFAULT_RETRO = Object.freeze({
  perfThresholds: Object.freeze({
    utilisation: 0.6,
    bootstrapShare: 0.4,
    capBindingRunLength: 2,
  }),
});

/**
 * Read the merged retro block. Returns the canonical shape:
 *
 *   {
 *     perfThresholds: {
 *       utilisation: number,
 *       bootstrapShare: number,
 *       capBindingRunLength: number,
 *     },
 *   }
 *
 * Each sub-key falls back to its documented default when the resolved
 * `.agentrc.json` omits it. Out-of-range values fall back to defaults too —
 * the AJV schema rejects them before they reach this accessor, but the
 * resolver stays defensive so unit-test fixtures and degraded configs
 * never produce nonsensical thresholds.
 *
 * @param {object | null | undefined} config
 * @returns {{ perfThresholds: { utilisation: number, bootstrapShare: number, capBindingRunLength: number } }}
 */
export function getRetro(config) {
  const user = config?.delivery?.retro?.perfThresholds ?? {};
  const defaults = DEFAULT_RETRO.perfThresholds;
  return {
    perfThresholds: {
      utilisation: resolveUnit(user.utilisation, defaults.utilisation),
      bootstrapShare: resolveUnit(user.bootstrapShare, defaults.bootstrapShare),
      capBindingRunLength: resolvePositiveInt(
        user.capBindingRunLength,
        defaults.capBindingRunLength,
      ),
    },
  };
}

function resolveUnit(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

function resolvePositiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return value;
}
