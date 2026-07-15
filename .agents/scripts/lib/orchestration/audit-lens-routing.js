/**
 * audit-lens-routing.js — risk-envelope → audit-lens roster helpers.
 *
 * Extracted from `code-review.js` so the review runner stays focused on
 * executing a review pass, while callers that only need risk→lens mapping
 * (ceremony routing, plan-run epilogue consumers, unit tests) import a
 * smaller pure module.
 */

import { selectAuditStrategy } from '../dynamic-workflow/capability.js';

/**
 * The axes whose presence (at `high` risk) routes a specific post-delivery
 * audit lens. Mirrors the audit-workflow names under
 * `.agents/workflows/audit-*.md`. Story #3939 broadened the routing so every
 * high-risk REQUIRED axis maps to a lens rather than leaving three of them
 * (`data-migration`, `destructive-mutation`, `billing`) routing nothing:
 *
 *   - `security`             → `audit-security`     (auth/secret boundary)
 *   - `public-api`           → `audit-architecture` (the canonical
 *                              architectural axis; a breaking public surface)
 *   - `data-migration`       → `audit-quality`      (migration correctness +
 *                              regression coverage)
 *   - `destructive-mutation` → `audit-security`     (irreversible mutation is
 *                              an auth/abuse boundary; co-routes with
 *                              `security`, de-duplicated)
 *   - `billing`              → `audit-privacy`      (money + the PII/consent
 *                              surface that travels with it)
 *   - `critical-workflow`    → `audit-quality`      (the load-bearing path
 *                              warrants the deepest coverage pass)
 *
 * The `visible-behavior` axis intentionally routes NO lens: it forces the
 * acceptance-spec disposition at plan time and no audit lens maps cleanly to
 * it. Any other axis (or a low/medium-risk axis) contributes no lens.
 *
 * Every key here MUST be a value in the `axis` enum of
 * `.agents/schemas/risk-verdict.schema.json` — the verdict-derived envelope
 * can only ever carry schema-valid axes, so a key absent from that enum is
 * unreachable dead routing (Story #3889 removed the unreachable
 * `architecture` key; the architectural axis is `public-api`).
 */
const AXIS_TO_LENS = Object.freeze({
  security: 'audit-security',
  'public-api': 'audit-architecture',
  'data-migration': 'audit-quality',
  'destructive-mutation': 'audit-security',
  billing: 'audit-privacy',
  'critical-workflow': 'audit-quality',
});

/**
 * Stable output order for routed lenses so the lens list is deterministic
 * regardless of axis ordering in the verdict. Every lens any axis can route
 * appears here exactly once; `resolveAuditLenses` filters this canonical
 * order down to the matched set (Story #3939).
 */
const LENS_ORDER = Object.freeze([
  'audit-security',
  'audit-architecture',
  'audit-quality',
  'audit-privacy',
]);

/**
 * Resolve the set of post-delivery audit lenses a judged risk envelope routes.
 *
 * High-risk axes map to their audit lens via {@link AXIS_TO_LENS}; only axes
 * judged `high` contribute (a `low`/`medium` axis carries no lens). The result
 * is de-duplicated and stably ordered by {@link LENS_ORDER} so an envelope
 * listing the `public-api` axis more than once routes `['audit-architecture']`
 * once, not twice — and two distinct axes routing the same lens (e.g.
 * `security` + `destructive-mutation` both → `audit-security`) collapse to a
 * single entry. A low-risk envelope — or any envelope with no high-risk routed
 * axis — resolves to an empty array (no lens beyond the existing baseline
 * gates).
 *
 * Pure function — no I/O, no side effects.
 *
 * @param {{ axes?: Array<{ axis?: string, level?: string }> }} [envelope]
 * @returns {string[]} Ordered, de-duplicated audit-lens identifiers.
 */
export function resolveAuditLenses(envelope = {}) {
  const axes = Array.isArray(envelope?.axes) ? envelope.axes : [];
  const matched = new Set();
  for (const entry of axes) {
    if (!entry || entry.level !== 'high') continue;
    const lens = AXIS_TO_LENS[entry.axis];
    if (lens) matched.add(lens);
  }
  return LENS_ORDER.filter((lens) => matched.has(lens));
}

/**
 * Build the post-delivery audit-lens execution plan for a judged risk
 * envelope. Each routed lens (see {@link resolveAuditLenses}) is paired with a
 * strategy decision from the **existing** `selectAuditStrategy` engine — no new
 * audit machinery is introduced. A low-risk envelope resolves to an empty
 * `lenses` array and runs no audit beyond the baseline gates (Story #3876).
 *
 * Pure with respect to the injected `selectAuditStrategyFn` (default is the
 * shared dynamic-workflow engine, which is itself pure over its snapshot).
 *
 * @param {{ axes?: Array<{ axis?: string, level?: string }> }} [envelope]
 * @param {{
 *   snapshot?: object,
 *   forceStrategy?: ('orchestrated'|'sequential'|null),
 *   selectAuditStrategyFn?: typeof selectAuditStrategy,
 * }} [opts]
 * @returns {{ lenses: string[], plan: Array<{ lens: string, strategy: string, reason: string, forced: boolean }> }}
 */
export function planAuditLenses(envelope = {}, opts = {}) {
  const {
    snapshot = {},
    forceStrategy = null,
    selectAuditStrategyFn = selectAuditStrategy,
  } = opts;
  const lenses = resolveAuditLenses(envelope);
  const plan = lenses.map((lens) => {
    const decision = selectAuditStrategyFn({ snapshot, forceStrategy });
    return {
      lens,
      strategy: decision.strategy,
      reason: decision.reason,
      forced: decision.forced,
    };
  });
  return { lenses, plan };
}
