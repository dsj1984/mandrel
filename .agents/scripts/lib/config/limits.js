/** Fixed runtime limits; none is operator-configurable. */

/** Timeout (ms) for delivery's long-running spawns. */
export const LIMITS_DEFAULTS = Object.freeze({
  executionTimeoutMs: 600000,
});

/**
 * @returns {{ executionTimeoutMs: number }}
 */
export function getLimits() {
  return { executionTimeoutMs: LIMITS_DEFAULTS.executionTimeoutMs };
}
