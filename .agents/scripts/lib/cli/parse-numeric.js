/**
 * parse-numeric.js — shared CLI integer-flag validators (Story #2993).
 *
 * Extracted from `lifecycle-emit-story-dispatch.js` so future scripts that
 * need a strict positive-integer or non-negative-integer flag value share
 * a single validator instead of hand-rolling another `Number.parseInt`
 * dance. Both helpers throw with a clear "required" / "must be …" message
 * shape so a `runAsCli` boundary surfaces a clean exit-1.
 *
 * Contract:
 *   - Empty / `null` / `undefined` raw values throw "is required".
 *   - Non-integer or out-of-range values throw "must be a … integer".
 *   - A leading `#` on the raw value is stripped (matches the ticket-ID
 *     ergonomic on the rest of the framework).
 *
 * @module lib/cli/parse-numeric
 */

/**
 * Parse a flag value as a strict positive integer (≥ 1). Leading `#` is
 * stripped to match the `parseTicketId` ergonomic.
 *
 * @param {string|number|null|undefined} raw
 * @param {string} flag  Flag label used in the thrown error message.
 * @param {string} [tool='cli'] Optional tool prefix for the error message.
 * @returns {number}
 */
export function parseRequiredPositiveInt(raw, flag, tool = 'cli') {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`${tool}: ${flag} is required`);
  }
  const n = Number.parseInt(String(raw).replace(/^#/, ''), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${tool}: ${flag} must be a positive integer (got ${raw})`);
  }
  return n;
}

/**
 * Parse a flag value as a strict non-negative integer (≥ 0). Leading `#`
 * is NOT stripped — non-negative use cases (wave index, attempt offset)
 * do not carry the ticket-ID convention.
 *
 * @param {string|number|null|undefined} raw
 * @param {string} flag
 * @param {string} [tool='cli']
 * @returns {number}
 */
export function parseRequiredNonNegativeInt(raw, flag, tool = 'cli') {
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`${tool}: ${flag} is required`);
  }
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `${tool}: ${flag} must be a non-negative integer (got ${raw})`,
    );
  }
  return n;
}
