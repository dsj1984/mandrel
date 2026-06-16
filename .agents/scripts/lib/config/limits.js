/**
 * Limits/budgets/signals accessors (Epic #1720 Story #1739 — top-level reshape).
 *
 * Pre-reshape, every runtime ceiling lived under the legacy `agentSettings.limits.*` bag.
 * Post-reshape, the surviving operator-configurable keys are split across
 * `planning.*` and `delivery.*`:
 *
 *   - `planning.context.{maxBytes, summaryMode}` (planning-context budget)
 *   - `delivery.maxTokenBudget` (task-prompt hydration cap)
 *   - `delivery.execution.timeoutMs` (per-process execution timeout)
 *   - `delivery.lease.ttlMs` (assignee-as-lease staleness window — Story #3480)
 *   - `delivery.signals.{hotspot, rework, retry}` (performance-signal
 *     detector thresholds — `churn` and `idle` dropped)
 *
 * `maxTickets` (the decomposer reviewability budget) is a **framework
 * constant** — Story #4163 collapsed the never-overridden
 * `planning.maxTickets` operator knob to `LIMITS_DEFAULTS.maxTickets` and
 * removed it from the AJV schema, the published mirror, and the explain
 * map. The persist-time over-budget gate (ADR-20260610) still reads the
 * constant via `getLimits(config).maxTickets`; `resolveLimits` no longer
 * reads `planning.maxTickets`, so setting it in a config is inert.
 *
 * Dropped entirely: `maxInstructionSteps`, `friction.*` (the LLM
 * self-pacing thresholds rewritten as qualitative prose in
 * `.agents/instructions.md`), `executionMaxBuffer` (now a framework-internal
 * constant in the spawn caller modules), `signals.{churn, idle}`.
 *
 * The historic combined accessor `getLimits(config)` is preserved as a
 * compatibility surface: it returns a wrapper carrying the surviving
 * subset so existing call sites that destructured `getLimits` keep
 * working. New call sites should prefer the specific accessors below.
 */

import { getPreflight } from './preflight.js';

/**
 * Framework defaults for the performance-signal detector thresholds. The two
 * dropped detectors (`churn`, `idle`) are omitted entirely.
 */
export const SIGNALS_DEFAULTS = Object.freeze({
  hotspot: Object.freeze({ p95Multiplier: 1.25 }),
  rework: Object.freeze({ editsPerFile: 5 }),
  retry: Object.freeze({ repeatCount: 3 }),
});

/**
 * Default TTL for the assignee-as-lease primitive (Story #3480). A claim
 * whose owner has not emitted a `story.heartbeat` within this window is
 * considered stale and may be reclaimed by another operator. 15 minutes
 * gives a healthy run comfortable headroom over the §2e idle watchdog's
 * 10-minute re-tick while still releasing a genuinely dead claim promptly.
 */
export const LEASE_TTL_MS_DEFAULT = 900000;

/**
 * Framework defaults for the surviving limits surface. `executionTimeoutMs`
 * bumps from 5 min to 10 min per the Story 1 decisions log.
 *
 * `maxTokenBudget` is a **single global value** (Story #3875 — raised once
 * from 200000 to 300000 so capability-sized Stories are not clipped by
 * hydration elision). There is intentionally no per-profile or
 * per-complexity budget branch anywhere in the resolver.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  maxTickets: 80,
  maxTokenBudget: 300000,
  executionTimeoutMs: 600000,
  leaseTtlMs: LEASE_TTL_MS_DEFAULT,
  planningContext: Object.freeze({
    maxBytes: 50000,
    summaryMode: 'auto',
  }),
  signals: SIGNALS_DEFAULTS,
});

/**
 * Per-detector merge of an operator-supplied `delivery.signals.*` block
 * with framework defaults. Each detector is shallow-overlaid so an
 * operator can override a single threshold without re-listing the others.
 *
 * @param {object|undefined} userSignals
 * @returns {{ hotspot: {p95Multiplier: number}, rework: {editsPerFile: number}, retry: {repeatCount: number} }}
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
 * (post-reshape). Accepts the resolved-config wrapper or a partial bag —
 * `maxTickets` is the framework constant `LIMITS_DEFAULTS.maxTickets`
 * (no longer operator-configurable; Story #4163), pulls `planningContext`
 * from `planning.*`, pulls `maxTokenBudget` and `executionTimeoutMs` from
 * `delivery.*`, pulls signals from `delivery.signals.*`.
 *
 * @param {object|undefined} config
 * @returns {{
 *   maxTickets: number,
 *   maxTokenBudget: number,
 *   executionTimeoutMs: number,
 *   leaseTtlMs: number,
 *   planningContext: { maxBytes: number, summaryMode: string },
 *   signals: ReturnType<typeof mergeSignals>,
 * }}
 */
export function resolveLimits(config) {
  const planning =
    config?.planning && typeof config.planning === 'object'
      ? config.planning
      : {};
  const delivery =
    config?.delivery && typeof config.delivery === 'object'
      ? config.delivery
      : {};
  const planningContextUser =
    planning.context && typeof planning.context === 'object'
      ? planning.context
      : {};
  const execution =
    delivery.execution && typeof delivery.execution === 'object'
      ? delivery.execution
      : {};
  const lease =
    delivery.lease && typeof delivery.lease === 'object' ? delivery.lease : {};
  return {
    // `maxTickets` is a framework constant (Story #4163) — never read from
    // `planning.maxTickets`. The persist-time over-budget gate still reads
    // this value via getLimits().maxTickets.
    maxTickets: LIMITS_DEFAULTS.maxTickets,
    maxTokenBudget: delivery.maxTokenBudget ?? LIMITS_DEFAULTS.maxTokenBudget,
    executionTimeoutMs:
      execution.timeoutMs ?? LIMITS_DEFAULTS.executionTimeoutMs,
    leaseTtlMs: lease.ttlMs ?? LIMITS_DEFAULTS.leaseTtlMs,
    planningContext: {
      ...LIMITS_DEFAULTS.planningContext,
      ...planningContextUser,
    },
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
 * Resolve the configured `delivery.preflight.max*` ceilings as a plain
 * object holding **only** the keys the operator actually configured
 * (Story #3875 — plan-time/delivery-time reconciliation). Unconfigured
 * ceilings (`null` floors, meaning "no cap") are omitted entirely so the
 * decomposition context can thread a compact, non-null envelope to the
 * planner. An Epic on a zero-config project yields `{}` — never `null`.
 *
 * @param {object | null | undefined} config
 * @returns {Record<string, number>}
 */
export function resolvePreflightCeilings(config) {
  const resolved = getPreflight(config);
  const ceilings = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== null) ceilings[key] = value;
  }
  return ceilings;
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
