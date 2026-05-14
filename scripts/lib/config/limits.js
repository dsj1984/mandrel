/**
 * Limits/budgets/signals accessors (Epic #1720 Story #1739 — top-level reshape).
 *
 * Pre-reshape, every runtime ceiling lived under `agentSettings.limits.*`.
 * Post-reshape, the surviving keys are split across `planning.*` and
 * `delivery.*`:
 *
 *   - `planning.maxTickets` (decomposer ceiling)
 *   - `planning.context.{maxBytes, summaryMode}` (planning-context budget)
 *   - `delivery.maxTokenBudget` (task-prompt hydration cap)
 *   - `delivery.execution.timeoutMs` (per-process execution timeout)
 *   - `delivery.signals.{hotspot, rework, retry}` (performance-signal
 *     detector thresholds — `churn` and `idle` dropped)
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
 * Framework defaults for the surviving limits surface. `executionTimeoutMs`
 * bumps from 5 min to 10 min per the Story 1 decisions log.
 */
export const LIMITS_DEFAULTS = Object.freeze({
  maxTickets: 60,
  maxTokenBudget: 200000,
  executionTimeoutMs: 600000,
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
 * pulls `maxTickets` and `planningContext` from `planning.*`, pulls
 * `maxTokenBudget` and `executionTimeoutMs` from `delivery.*`, pulls
 * signals from `delivery.signals.*`.
 *
 * @param {object|undefined} config
 * @returns {{
 *   maxTickets: number,
 *   maxTokenBudget: number,
 *   executionTimeoutMs: number,
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
  return {
    maxTickets: planning.maxTickets ?? LIMITS_DEFAULTS.maxTickets,
    maxTokenBudget: delivery.maxTokenBudget ?? LIMITS_DEFAULTS.maxTokenBudget,
    executionTimeoutMs:
      execution.timeoutMs ?? LIMITS_DEFAULTS.executionTimeoutMs,
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
