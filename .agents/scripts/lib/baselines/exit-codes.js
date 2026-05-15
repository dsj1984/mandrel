// .agents/scripts/lib/baselines/exit-codes.js
//
// Story #1962 / Task #1968 — Unified exit-code contract for the baseline
// dispatcher (`check-baselines.js`) and every per-kind regression CLI that
// will land in Epic #1943.
//
// One shared source of truth keeps the dispatcher, the per-kind CLIs, and
// the test suites in lock-step. Numeric precedence is intentional: a
// higher number is a strictly worse outcome, so `aggregate(...)` collapses
// per-gate exit codes by taking the maximum. That contract lets the
// dispatcher fan out per-kind work in any order (parallel, sequential,
// streamed) and still produce a single deterministic process exit code.
//
// Precedence (lowest → highest severity):
//
//   0 EXIT_PASS        — every enabled gate is green.
//   1 EXIT_FLOOR       — at least one gate breached its floor / tolerance.
//   2 EXIT_SCHEMA      — at least one baseline file failed schema
//                        validation (JSON shape / required fields wrong).
//   3 EXIT_CONFIG      — config could not be resolved (missing
//                        `.agentrc.json`, unknown gate kind, malformed
//                        scope, etc). The gate could not even start.
//   4 EXIT_REGRESSION  — head-vs-base regression detected on at least one
//                        gate. Highest severity because regression
//                        signals new debt being introduced rather than
//                        pre-existing debt failing a static floor.
//
// `aggregate(...codes)` takes the highest code in the input list and
// returns 0 (`EXIT_PASS`) for an empty input. It never throws — invalid
// codes are silently treated as 0 because the only sane response to a
// caller passing a garbage code is "do not regress the exit signal".

export const EXIT_PASS = 0;
export const EXIT_FLOOR = 1;
export const EXIT_SCHEMA = 2;
export const EXIT_CONFIG = 3;
export const EXIT_REGRESSION = 4;

/**
 * The full set of valid exit codes, frozen so callers can use it as a
 * lookup without worrying about mutation.
 */
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
 * Collapse any number of per-gate exit codes into a single dispatcher
 * exit code. The contract:
 *
 *   - With no arguments, returns `EXIT_PASS` (0). An empty dispatcher run
 *     is success — there was nothing to fail.
 *   - With one or more arguments, returns the maximum of the valid codes.
 *     Higher numbers are strictly worse outcomes (see precedence table at
 *     the top of this file).
 *   - Unknown / non-numeric / negative codes are dropped from the input
 *     so a single garbage caller cannot lower the dispatcher's exit code
 *     past a real failure. If every input is invalid, the result is
 *     `EXIT_PASS` (the caller signalled nothing to report).
 *
 * Pure. No I/O. Cheap to call from a hot loop.
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
