/**
 * `delivery.ci` accessor + framework defaults — Story #2899 (Epic #2880, F13)
 * and Story #4356 (Epic #4355).
 *
 * `delivery.ci.skipForStoryPushes` defaults to `true` so per-Task Story-branch
 * commits append a `[skip ci]` trailer out of the box. The Epic-branch merge
 * commit produced by `story-close.js`'s merge runner never carries the
 * marker — that path is the one consumers actually want CI to evaluate.
 *
 * Story #4356 adds the CI-aware delivery knobs: `earlyPr` (default `true`)
 * gates whether /deliver opens the Epic PR early so CI warms while later
 * waves run; `watch` tunes the merge/CI watch poll loop; and `autoMerge`
 * (default `"trust-ci"`) selects the merge posture — `"trust-ci"` merges once
 * required checks pass, `"strict"` additionally requires a clean review gate.
 */

export const CI_DELIVERY_DEFAULTS = Object.freeze({
  skipForStoryPushes: true,
  earlyPr: true,
  autoMerge: 'trust-ci',
});

/**
 * Read the merged `delivery.ci` block, applying framework defaults for any
 * field the operator omitted. Accepts the full resolved config, the bare
 * delivery bag, or the bare ci bag. The `watch` sub-block is passed through
 * as-is (undefined when unset) so consumers apply their own poll-loop
 * defaults; only the scalar knobs carry framework defaults here.
 *
 * @param {object | null | undefined} config
 * @returns {{ skipForStoryPushes: boolean, earlyPr: boolean, autoMerge: 'trust-ci' | 'strict', watch: object | undefined }}
 */
export function getCiDelivery(config) {
  const ci = config?.delivery?.ci ?? config?.ci ?? config ?? {};
  return {
    skipForStoryPushes:
      typeof ci.skipForStoryPushes === 'boolean'
        ? ci.skipForStoryPushes
        : CI_DELIVERY_DEFAULTS.skipForStoryPushes,
    earlyPr:
      typeof ci.earlyPr === 'boolean'
        ? ci.earlyPr
        : CI_DELIVERY_DEFAULTS.earlyPr,
    autoMerge:
      ci.autoMerge === 'trust-ci' || ci.autoMerge === 'strict'
        ? ci.autoMerge
        : CI_DELIVERY_DEFAULTS.autoMerge,
    watch:
      ci.watch && typeof ci.watch === 'object' ? { ...ci.watch } : undefined,
  };
}
