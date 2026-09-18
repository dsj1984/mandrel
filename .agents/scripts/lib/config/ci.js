/**
 * `delivery.ci`. `autoMerge: 'strict'` also requires a clean review gate.
 * Native auto-merge waits on required checks only, so
 * `blockOnAdvisoryFailure` stops a red advisory gate being merged past
 * (`advisoryAllowlist` exempts named jobs). `rerunAdvisory` defaults to 0
 * deliberately: a rerun spends CI minutes and mutates GitHub state.
 */

export const CI_DELIVERY_DEFAULTS = Object.freeze({
  autoMerge: 'trust-ci',
  blockOnAdvisoryFailure: true,
  advisoryAllowlist: Object.freeze([]),
  rerunAdvisory: 0,
});

/** An invalid value degrades to the same-keyed default. */
const CI_KNOB_VALIDATORS = Object.freeze({
  autoMerge: (value) => value === 'trust-ci' || value === 'strict',
  blockOnAdvisoryFailure: (value) => typeof value === 'boolean',
  rerunAdvisory: (value) => Number.isInteger(value) && value >= 0,
});

/**
 * Accepts the full config, the `delivery` bag, or the `ci` bag.
 *
 * @param {object | null | undefined} config
 * @returns {{ autoMerge: 'trust-ci' | 'strict', blockOnAdvisoryFailure: boolean,
 *   advisoryAllowlist: string[], rerunAdvisory: number }}
 */
export function getCiDelivery(config) {
  const ci = config?.delivery?.ci ?? config?.ci ?? config ?? {};
  const knobs = {};
  for (const [key, isValid] of Object.entries(CI_KNOB_VALIDATORS)) {
    knobs[key] = isValid(ci[key]) ? ci[key] : CI_DELIVERY_DEFAULTS[key];
  }
  return {
    ...knobs,
    advisoryAllowlist: Array.isArray(ci.advisoryAllowlist)
      ? ci.advisoryAllowlist.filter(
          (entry) => typeof entry === 'string' && entry,
        )
      : [...CI_DELIVERY_DEFAULTS.advisoryAllowlist],
  };
}
