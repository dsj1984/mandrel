/**
 * Limits/budgets/signals accessors (Epic #1720 Story #1739 — top-level reshape).
 *
 * Pre-reshape, every runtime ceiling lived under the legacy `agentSettings.limits.*` bag.
 * Post-reshape, the surviving operator-configurable keys are split across
 * `planning.*` and `delivery.*`:
 *
 *   - `delivery.execution.timeoutMs` (per-process execution timeout)
 *   - `delivery.signals.{rework, retry}` (performance-signal detector
 *     thresholds — `hotspot` retired with Epic #4406; `churn`/`idle` dropped)
 *
 * Dropped entirely: `maxTickets` (Story #5312 — the reviewability budget
 * never fired on a real plan and duplicated the default-single split policy),
 * `maxInstructionSteps`, `friction.*`, `executionMaxBuffer`,
 * `signals.{churn, idle}`, `delivery.preflight`, `delivery.lease.ttlMs`
 * (Story #5006 deleted the lease TTL: with no heartbeat source every foreign
 * claim read live, so the window decided nothing), `delivery.maxTokenBudget`
 * (planning no longer sizes against a token-budget envelope), and
 * `planning.context.{maxBytes, summaryMode}` (Story #4541 — the `applyBudget`
 * pass they fed lost its last caller in the v2 cutover, and it bounded a field
 * the envelope builders discarded; the live bound on planner-context size is
 * the fixed `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` in
 * `lib/orchestration/plan-context.js`).
 *
 * The historic combined accessor `getLimits(config)` is preserved as a
 * compatibility surface: it returns a wrapper carrying the surviving
 * subset so existing call sites that destructured `getLimits` keep
 * working. New call sites should prefer the specific accessors below.
 */

/**
 * Framework defaults for the performance-signal detector thresholds.
 * `hotspot` was retired with its detector (Epic #4406); `churn` and `idle`
 * were dropped earlier.
 */
export const SIGNALS_DEFAULTS = Object.freeze({
  rework: Object.freeze({ editsPerFile: 5 }),
  retry: Object.freeze({ repeatCount: 3 }),
});

/**
 * Framework defaults for the surviving limits surface.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  executionTimeoutMs: 600000,
  signals: SIGNALS_DEFAULTS,
});

/**
 * Per-detector merge of an operator-supplied `delivery.signals.*` block
 * with framework defaults. Each detector is shallow-overlaid so an
 * operator can override a single threshold without re-listing the others.
 *
 * @param {object|undefined} userSignals
 * @returns {{ rework: {editsPerFile: number}, retry: {repeatCount: number} }}
 */
function mergeSignals(userSignals) {
  const user =
    userSignals && typeof userSignals === 'object' ? userSignals : {};
  const merged = {};
  for (const detector of Object.keys(SIGNALS_DEFAULTS)) {
    const userDetector =
      user[detector] && typeof user[detector] === 'object'
        ? user[detector]
        : {};
    merged[detector] = { ...SIGNALS_DEFAULTS[detector], ...userDetector };
  }
  return merged;
}

/**
 * Resolve the surviving limits surface against a `.agentrc.json` shape
 * (post-reshape): `executionTimeoutMs` from `delivery.*`, signals from
 * `delivery.signals.*`.
 *
 * @param {object|undefined} config
 * @returns {{
 *   executionTimeoutMs: number,
 *   signals: ReturnType<typeof mergeSignals>,
 * }}
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
    signals: mergeSignals(delivery.signals),
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

/**
 * Read the merged `delivery.signals` block. Equivalent to
 * `getLimits(config).signals` but exposed as a standalone accessor so
 * detector wiring can import it without dragging the whole limits
 * surface into their bundle.
 *
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveLimits>['signals']}
 */
export function getSignals(config) {
  return getLimits(config).signals;
}
