/**
 * lib/reserved-test-ids.js — the one declaration of the synthetic
 * test-fixture id band, shared by the temp-pollution guard and the retro
 * composer (which must never publish a synthetic id as evidence).
 * Dependency-free on purpose.
 */

const RESERVED_TEST_ID_MIN = 999000;

const RESERVED_TEST_ID_MAX = 999999;

/** For guard messages naming the ids real work may not use. */
export const RESERVED_TEST_ID_BAND = `${RESERVED_TEST_ID_MIN}–${RESERVED_TEST_ID_MAX}`;

/**
 * Exact-band membership: the reaper and the guard act on on-disk dirs, and
 * over-reaching would delete or condemn one the band never claimed.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isReservedTestId(id) {
  return (
    Number.isInteger(id) &&
    id >= RESERVED_TEST_ID_MIN &&
    id <= RESERVED_TEST_ID_MAX
  );
}

/**
 * A plausibility bound, not an existence probe: anything at or above the
 * band floor is synthetic, and non-positive ids are not references.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isPublishableTicketId(id) {
  return Number.isInteger(id) && id > 0 && id < RESERVED_TEST_ID_MIN;
}
