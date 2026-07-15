/**
 * `delivery.ci` accessor + framework defaults — Story #4356 (Epic #4355).
 *
 * Story #4356 adds the CI-aware delivery knobs: `earlyPr` (default `true`)
 * gates whether /deliver opens the Epic PR early so CI warms while later
 * waves run; `watch` tunes the merge/CI watch poll loop; and `autoMerge`
 * (default `"trust-ci"`) selects the merge posture — `"trust-ci"` merges once
 * required checks pass, `"strict"` additionally requires a clean review gate.
 *
 * Story #4472 adds `requireChecks` (default `false`): when `true` the
 * AutomergePredicate treats a checks-less repo ("no checks reported") as a
 * hard block rather than green, so a consumer that wants fail-closed-without-
 * checks as policy opts into it explicitly instead of the framework blocking
 * implicitly.
 */

export const CI_DELIVERY_DEFAULTS = Object.freeze({
  earlyPr: true,
  autoMerge: 'trust-ci',
  requireChecks: false,
});

/**
 * Read the merged `delivery.ci` block, applying framework defaults for any
 * field the operator omitted. Accepts the full resolved config, the bare
 * delivery bag, or the bare ci bag. The `watch` sub-block is passed through
 * as-is (undefined when unset) so consumers apply their own poll-loop
 * defaults; only the scalar knobs carry framework defaults here.
 *
 * @param {object | null | undefined} config
 * @returns {{ earlyPr: boolean, autoMerge: 'trust-ci' | 'strict', requireChecks: boolean, watch: object | undefined }}
 */
export function getCiDelivery(config) {
  const ci = config?.delivery?.ci ?? config?.ci ?? config ?? {};
  return {
    earlyPr:
      typeof ci.earlyPr === 'boolean'
        ? ci.earlyPr
        : CI_DELIVERY_DEFAULTS.earlyPr,
    autoMerge:
      ci.autoMerge === 'trust-ci' || ci.autoMerge === 'strict'
        ? ci.autoMerge
        : CI_DELIVERY_DEFAULTS.autoMerge,
    requireChecks:
      typeof ci.requireChecks === 'boolean'
        ? ci.requireChecks
        : CI_DELIVERY_DEFAULTS.requireChecks,
    watch:
      ci.watch && typeof ci.watch === 'object' ? { ...ci.watch } : undefined,
  };
}
