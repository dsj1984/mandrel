/** `delivery.deliverRunner` / `delivery.codeReview` accessor. */

export const DEFAULT_DECOMPOSER = Object.freeze({
  concurrencyCap: 3,
});

/**
 * `concurrencyCap` 3 keeps host quota and concurrent GitHub label writes
 * predictable. `footprintGuard: 'enforce'` stays the default: the overlap
 * guard knows delivery-time state (open windows, foreign leases) no plan-time
 * `depends_on` edge can carry; `advisory` reports would-be withholds but
 * dispatches on declared edges alone.
 */
const DEFAULT_DELIVER_RUNNER = Object.freeze({
  concurrencyCap: 3,
  footprintGuard: 'enforce',
});

export const DEFAULT_CODE_REVIEW = Object.freeze({
  autoFixSeverity: 'medium',
});

/**
 * @param {object | null | undefined} config
 * @returns {{
 *   deliverRunner: { concurrencyCap: number, footprintGuard: 'enforce'|'advisory' },
 *   codeReview: { autoFixSeverity: 'high'|'medium' },
 *   decomposer: { concurrencyCap: number },
 * }}
 */
export function getRunners(config) {
  return {
    deliverRunner: withDefaults(
      DEFAULT_DELIVER_RUNNER,
      config?.delivery?.deliverRunner,
    ),
    codeReview: withDefaults(DEFAULT_CODE_REVIEW, config?.delivery?.codeReview),
    decomposer: DEFAULT_DECOMPOSER,
  };
}

/**
 * Iterates the defaults' keys, so the shape stays closed: an unknown key
 * never reaches a caller even if it survived AJV.
 *
 * @template {Record<string, unknown>} T
 * @param {T} defaults
 * @param {object|null|undefined} user
 * @returns {T}
 */
function withDefaults(defaults, user) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (user?.[key] != null) out[key] = user[key];
  }
  return out;
}
