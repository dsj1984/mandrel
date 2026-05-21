/**
 * `delivery.lifecycle` accessor + framework defaults.
 *
 * `TimeoutWatchdog` returns null (no budget) for any timeout key absent from
 * the operator config, meaning phases can hang indefinitely on projects that
 * omit the block. These defaults ensure every Epic run has a watchdog out of
 * the box; projects override individual keys by supplying their own values,
 * which are merged over the defaults.
 */

export const LIFECYCLE_DEFAULTS = Object.freeze({
  timeouts: Object.freeze({
    'acceptance.reconcile': 600,
    'epic.finalize': 600,
    'epic.watch': 1800,
  }),
  heartbeatWarnSeconds: 60,
});

/**
 * Read the merged `delivery.lifecycle` block, applying framework defaults
 * for any field the operator omitted. Accepts the full resolved config or
 * a bare `{ delivery: { lifecycle: ... } }` / `{ lifecycle: ... }` shape.
 *
 * User-supplied timeout keys win over defaults; unknown keys are preserved
 * so projects can define custom phase budgets.
 *
 * @param {object | null | undefined} config
 * @returns {{ timeouts: Record<string, number>, heartbeatWarnSeconds: number }}
 */
export function getLifecycle(config) {
  const lc = config?.delivery?.lifecycle ?? config?.lifecycle ?? config ?? {};
  return {
    timeouts: { ...LIFECYCLE_DEFAULTS.timeouts, ...(lc.timeouts ?? {}) },
    heartbeatWarnSeconds:
      Number.isInteger(lc.heartbeatWarnSeconds) && lc.heartbeatWarnSeconds >= 1
        ? lc.heartbeatWarnSeconds
        : LIFECYCLE_DEFAULTS.heartbeatWarnSeconds,
  };
}
