// Exit-code contract for `check-baselines.js` and the per-kind CLIs. Higher is
// strictly worse, so per-gate codes collapse by maximum in any order:
// 0 pass, 1 floor breach, 2 schema-invalid baseline, 3 config unresolvable,
// 4 head-vs-base regression (new debt outranks pre-existing floor debt).

export const EXIT_PASS = 0;
export const EXIT_FLOOR = 1;
export const EXIT_SCHEMA = 2;
export const EXIT_CONFIG = 3;
export const EXIT_REGRESSION = 4;

export const EXIT_CODES = Object.freeze({
  EXIT_PASS,
  EXIT_FLOOR,
  EXIT_SCHEMA,
  EXIT_CONFIG,
  EXIT_REGRESSION,
});

const VALID = new Set([
  EXIT_PASS,
  EXIT_FLOOR,
  EXIT_SCHEMA,
  EXIT_CONFIG,
  EXIT_REGRESSION,
]);

/**
 * Maximum of the valid codes; invalid codes are dropped so garbage can never
 * lower the signal. No input → `EXIT_PASS`.
 *
 * @param {...number} codes - Per-gate exit codes to collapse.
 * @returns {number} The most severe code in the input, or `EXIT_PASS`.
 */
export function aggregate(...codes) {
  let max = EXIT_PASS;
  for (const c of codes) {
    if (typeof c !== 'number' || !VALID.has(c)) {
      continue;
    }
    if (c > max) {
      max = c;
    }
  }
  return max;
}
