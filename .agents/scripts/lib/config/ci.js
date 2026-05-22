/**
 * `delivery.ci` accessor + framework defaults — Story #2899 (Epic #2880, F13).
 *
 * `delivery.ci.skipForStoryPushes` defaults to `true` so per-Task Story-branch
 * commits append a `[skip ci]` trailer out of the box. The Epic-branch merge
 * commit produced by `story-close.js`'s merge runner never carries the
 * marker — that path is the one consumers actually want CI to evaluate.
 */

export const CI_DELIVERY_DEFAULTS = Object.freeze({
  skipForStoryPushes: true,
});

/**
 * Read the merged `delivery.ci` block, applying framework defaults for any
 * field the operator omitted. Accepts the full resolved config, the bare
 * delivery bag, or the bare ci bag.
 *
 * @param {object | null | undefined} config
 * @returns {typeof CI_DELIVERY_DEFAULTS}
 */
export function getCiDelivery(config) {
  const ci = config?.delivery?.ci ?? config?.ci ?? config ?? {};
  return {
    skipForStoryPushes:
      typeof ci.skipForStoryPushes === 'boolean'
        ? ci.skipForStoryPushes
        : CI_DELIVERY_DEFAULTS.skipForStoryPushes,
  };
}
