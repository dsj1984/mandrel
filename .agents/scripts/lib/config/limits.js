/**
 * Limits/budgets/signals accessors (Epic #1720 Story #1739 — top-level reshape).
 *
 * Pre-reshape, every runtime ceiling lived under the legacy `agentSettings.limits.*` bag.
 * Post-reshape, the surviving operator-configurable keys are split across
 * `planning.*` and `delivery.*`:
 *
 *   - `delivery.execution.timeoutMs` (per-process execution timeout)
 *   - `delivery.lease.ttlMs` (assignee-as-lease staleness window — Story #3480)
 *   - `delivery.signals.{rework, retry}` (performance-signal detector
 *     thresholds — `hotspot` retired with Epic #4406; `churn`/`idle` dropped)
 *
 * Framework constants (not operator-tunable via `.agentrc.json`):
 *   - `maxTickets` — decomposer reviewability budget (Story #4163)
 *
 * Dropped entirely: `maxInstructionSteps`, `friction.*`, `executionMaxBuffer`,
 * `signals.{churn, idle}`, `delivery.preflight`, `delivery.maxTokenBudget`
 * (planning no longer sizes against a token-budget envelope; session-mass
 * ceilings are absolute in `DEFAULT_MODEL_CAPACITY`), and
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
 * Default TTL for the assignee-as-lease primitive (Story #3480). A claim
 * whose owner's last heartbeat is older than this window is considered stale
 * and may be reclaimed by another operator.
 *
 * Note: no shipped caller supplies a real heartbeat — the emitter was inert
 * and was deleted (A22), so the guards anchor liveness to `now` and every
 * foreign claim reads live (fail-closed; clear a stranded claim with
 * `--steal`). This value is therefore only consulted by a caller that threads
 * its own `heartbeatAt`, and is kept as the documented default for that seam.
 */
export const LEASE_TTL_MS_DEFAULT = 900000;

/**
 * Framework defaults for the surviving limits surface.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  maxTickets: 80,
  executionTimeoutMs: 600000,
  leaseTtlMs: LEASE_TTL_MS_DEFAULT,
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
 * (post-reshape). `maxTickets` is a framework constant (never read from
 * config); pulls `executionTimeoutMs` from `delivery.*`, pulls signals from
 * `delivery.signals.*`.
 *
 * @param {object|undefined} config
 * @returns {{
 *   maxTickets: number,
 *   executionTimeoutMs: number,
 *   leaseTtlMs: number,
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
  const lease =
    delivery.lease && typeof delivery.lease === 'object' ? delivery.lease : {};
  return {
    maxTickets: LIMITS_DEFAULTS.maxTickets,
    executionTimeoutMs:
      execution.timeoutMs ?? LIMITS_DEFAULTS.executionTimeoutMs,
    leaseTtlMs: lease.ttlMs ?? LIMITS_DEFAULTS.leaseTtlMs,
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

/**
 * Resolve the assignee-as-lease TTL in milliseconds (Story #3480). Standalone
 * accessor so the `ticket-lease` module can import it without dragging the
 * whole limits surface into its bundle. Precedence:
 *
 *   1. An explicit `override` (a positive finite number) — lets a caller or
 *      test pin the TTL directly.
 *   2. `delivery.lease.ttlMs` from the resolved config.
 *   3. `LEASE_TTL_MS_DEFAULT`.
 *
 * A non-positive or non-finite override is ignored (falls through to config /
 * default) so a stray `0` can never collapse every claim to instantly-stale.
 *
 * @param {object | null | undefined} config
 * @param {number} [override]
 * @returns {number}
 */
export function resolveLeaseTtlMs(config, override) {
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override;
  }
  return getLimits(config).leaseTtlMs;
}
