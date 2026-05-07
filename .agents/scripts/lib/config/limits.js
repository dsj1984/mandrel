/**
 * `agentSettings.limits` accessor (Epic #730 Story 8; relocated under
 * lib/config/ in Epic #773 Story 6).
 */

/**
 * Framework defaults for `agentSettings.limits` (Epic #730 Story 8). Mirrors
 * the long-standing flat-key fallbacks the framework used before grouping —
 * `maxTickets: 40`, 5-minute exec timeout, 10MB exec buffer, 200k token
 * budget. `friction` defaults match the prior `frictionThresholds` block.
 * `planningContext` (Epic #817 Story 9) caps `--emit-context` JSON payloads
 * at 50KB before switching to a summary representation.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  maxInstructionSteps: 5,
  maxTickets: 40,
  maxTokenBudget: 200000,
  executionTimeoutMs: 300000,
  executionMaxBuffer: 10485760,
  friction: Object.freeze({
    repetitiveCommandCount: 3,
    consecutiveErrorCount: 3,
    stagnationStepCount: 5,
    maxIntegrationRetries: 2,
  }),
  planningContext: Object.freeze({
    maxBytes: 50000,
    summaryMode: 'auto',
  }),
  /**
   * Detector thresholds for the performance-signal taxonomy (Epic #1030).
   * Each nested block tunes one detector; defaults match the values in
   * the Tech Spec configuration block. Operators override individual
   * keys via `agentSettings.limits.signals.<detector>.<key>` in
   * `.agentrc.json`.
   */
  signals: Object.freeze({
    hotspot: Object.freeze({ p95Multiplier: 1.25 }),
    rework: Object.freeze({ editsPerFile: 5 }),
    churn: Object.freeze({ repeatCount: 4 }),
    idle: Object.freeze({ gapSeconds: 120 }),
    retry: Object.freeze({ repeatCount: 3 }),
  }),
});

/**
 * Merge a user-supplied `agentSettings.limits` block with framework defaults.
 * Scalar keys replace; the nested `friction` block is merged shallowly so an
 * operator can override a single threshold without re-listing the others.
 *
 * @param {object|undefined} userLimits
 * @returns {{
 *   maxInstructionSteps: number,
 *   maxTickets: number,
 *   maxTokenBudget: number,
 *   executionTimeoutMs: number,
 *   executionMaxBuffer: number,
 *   friction: {
 *     repetitiveCommandCount: number,
 *     consecutiveErrorCount: number,
 *     stagnationStepCount: number,
 *     maxIntegrationRetries: number,
 *   },
 * }}
 */
export function resolveLimits(userLimits) {
  const block = userLimits && typeof userLimits === 'object' ? userLimits : {};
  const userFriction =
    block.friction && typeof block.friction === 'object' ? block.friction : {};
  const userPlanning =
    block.planningContext && typeof block.planningContext === 'object'
      ? block.planningContext
      : {};
  const userSignals =
    block.signals && typeof block.signals === 'object' ? block.signals : {};
  // Per-detector merge: take each detector's defaults and shallow-overlay
  // any operator-supplied keys, mirroring the friction-block convention.
  const mergedSignals = {};
  for (const detector of Object.keys(LIMITS_DEFAULTS.signals)) {
    const userDetector =
      userSignals[detector] && typeof userSignals[detector] === 'object'
        ? userSignals[detector]
        : {};
    mergedSignals[detector] = {
      ...LIMITS_DEFAULTS.signals[detector],
      ...userDetector,
    };
  }
  return {
    maxInstructionSteps:
      block.maxInstructionSteps ?? LIMITS_DEFAULTS.maxInstructionSteps,
    maxTickets: block.maxTickets ?? LIMITS_DEFAULTS.maxTickets,
    maxTokenBudget: block.maxTokenBudget ?? LIMITS_DEFAULTS.maxTokenBudget,
    executionTimeoutMs:
      block.executionTimeoutMs ?? LIMITS_DEFAULTS.executionTimeoutMs,
    executionMaxBuffer:
      block.executionMaxBuffer ?? LIMITS_DEFAULTS.executionMaxBuffer,
    friction: { ...LIMITS_DEFAULTS.friction, ...userFriction },
    planningContext: {
      ...LIMITS_DEFAULTS.planningContext,
      ...userPlanning,
    },
    signals: mergedSignals,
  };
}

/**
 * Read the merged `agentSettings.limits` block. Accepts either the full
 * resolved config or the bare `agentSettings` bag.
 *
 * @param {{ agentSettings?: { limits?: object } } | object | null | undefined} config
 * @returns {ReturnType<typeof resolveLimits>}
 */
export function getLimits(config) {
  const userLimits =
    config?.agentSettings?.limits ?? config?.limits ?? undefined;
  return resolveLimits(userLimits);
}
