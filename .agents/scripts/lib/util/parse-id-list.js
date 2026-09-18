/**
 * parse-id-list — expand a Story-id list that may contain dash ranges
 * (an id with optional `#` prefix, or `A - B`, en/em dash accepted). Anything else is a
 * hard error, never a silent drop: a wrong list dispatches against the wrong
 * graph. Backwards ranges and spans above the cap are refused too.
 */

// Catches `1-4926` as the typo it is. Module-private because the number is a
// published contract (`helpers/deliver-reference.md` § Ranges).
const MAX_RANGE_SPAN = 50;

const DASH = '[-–—]';
const SINGLE_RE = /^#?(\d+)$/;
const RANGE_RE = new RegExp(`^#?(\\d+)\\s*${DASH}\\s*#?(\\d+)$`);

/**
 * Empty input yields `[]`; the caller decides whether that is an error.
 *
 * @param {string|undefined|null} raw
 * @param {object} [options]
 * @param {string} [options.flag] Flag name, for the error message.
 * @param {string} [options.prefix] Message prefix.
 * @param {number} [options.maxSpan] Inclusive-span ceiling per range token.
 * @returns {{ ids: number[]|null, error: string|null }}
 */
export function expandIdList(raw, options = {}) {
  const { flag = '--ids', prefix = '', maxSpan = MAX_RANGE_SPAN } = options;
  const fail = (message) => ({ ids: null, error: `${prefix}${message}` });

  const ids = [];
  const seen = new Set();
  const push = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    ids.push(n);
  };

  for (const token of String(raw ?? '').split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;

    const range = RANGE_RE.exec(trimmed);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start <= 0 || end <= 0) {
        return fail(
          `${flag} range "${trimmed}" must use positive issue numbers.`,
        );
      }
      if (end < start) {
        return fail(
          `${flag} range "${trimmed}" runs backwards — write it low-to-high (e.g. 4922-4926).`,
        );
      }
      const span = end - start + 1;
      if (span > maxSpan) {
        return fail(
          `${flag} range "${trimmed}" spans ${span} ids, above the ${maxSpan}-id cap. Narrow it, or list the ids.`,
        );
      }
      for (let n = start; n <= end; n++) push(n);
      continue;
    }

    const single = SINGLE_RE.exec(trimmed);
    const n = single ? Number(single[1]) : Number.NaN;
    if (!Number.isInteger(n) || n <= 0) {
      return fail(
        `${flag} must be a comma-separated list of positive issue numbers or A-B ranges (got "${trimmed}").`,
      );
    }
    push(n);
  }

  return { ids, error: null };
}
