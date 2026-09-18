/**
 * Limits accessors (Epic #1720 Story #1739 — top-level reshape).
 *
 * Pre-reshape, every runtime ceiling lived under the legacy `agentSettings.limits.*` bag.
 * The last operator-configurable key, `delivery.execution.timeoutMs`, was
 * folded into a constant by Story #5382.
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
 * The historic combined accessor `getLimits()` is preserved as a
 * compatibility surface so existing call sites that destructured it keep
 * working.
 */

/**
 * The per-process execution timeout (ms) for the long-running spawns
 * delivery drives. Fixed since Story #5382 folded the never-set
 * `delivery.execution.timeoutMs` key into it.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  executionTimeoutMs: 600000,
});

/**
 * Read the limits surface. The config argument is accepted for call-site
 * compatibility; no limit is operator-configurable any more.
 *
 * @returns {{ executionTimeoutMs: number }}
 */
export function getLimits() {
  return { executionTimeoutMs: LIMITS_DEFAULTS.executionTimeoutMs };
}
