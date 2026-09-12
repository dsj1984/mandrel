/**
 * Limits accessors (Epic #1720 Story #1739 — top-level reshape).
 *
 * Pre-reshape, every runtime ceiling lived under the legacy `agentSettings.limits.*` bag.
 * Post-reshape, the surviving operator-configurable key is
 * `delivery.execution.timeoutMs` (per-process execution timeout).
 *
 * Dropped entirely: `maxTickets` (Story #5312 — the reviewability budget
 * never fired on a real plan and duplicated the default-single split policy),
 * `delivery.signals.{rework, retry}` with `SIGNALS_DEFAULTS` (Story #5313 —
 * the detector thresholds bounded execution by count, not by risk),
 * `maxInstructionSteps`, `friction.*`, `executionMaxBuffer`,
 * `signals.{churn, idle, hotspot}`, `delivery.preflight`,
 * `delivery.lease.ttlMs` (Story #5006 deleted the lease TTL: with no
 * heartbeat source every foreign claim read live, so the window decided
 * nothing), `delivery.maxTokenBudget` (planning no longer sizes against a
 * token-budget envelope), and `planning.context.{maxBytes, summaryMode}`
 * (Story #4541 — the `applyBudget` pass they fed lost its last caller in the
 * v2 cutover; the live bound on planner-context size is the fixed
 * `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` in `lib/orchestration/plan-context.js`).
 *
 * The historic combined accessor `getLimits(config)` is preserved as a
 * compatibility surface: it returns a wrapper carrying the surviving
 * subset so existing call sites that destructured `getLimits` keep
 * working. New call sites should prefer the specific accessors below.
 */

/**
 * Framework defaults for the surviving limits surface.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  executionTimeoutMs: 600000,
});

/**
 * Resolve the surviving limits surface against a `.agentrc.json` shape
 * (post-reshape): `executionTimeoutMs` from `delivery.execution.*`.
 *
 * @param {object|undefined} config
 * @returns {{ executionTimeoutMs: number }}
 */
export function resolveLimits(config) {
  const delivery =
    config?.delivery && typeof config.delivery === 'object'
      ? config.delivery
      : {};
  const execution =
    delivery.execution && typeof delivery.execution === 'object'
      ? delivery.execution
      : {};
  return {
    executionTimeoutMs:
      execution.timeoutMs ?? LIMITS_DEFAULTS.executionTimeoutMs,
  };
}

/**
 * Read the merged limits surface. Accepts the full resolved config bag.
 * Returns the wrapper described in `resolveLimits`.
 *
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveLimits>}
 */
export function getLimits(config) {
  return resolveLimits(config ?? undefined);
}
