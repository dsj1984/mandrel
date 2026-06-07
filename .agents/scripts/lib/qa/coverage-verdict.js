// .agents/scripts/lib/qa/coverage-verdict.js
//
// Deterministic per-tier coverage verdict for a single finding surface.
//
// A "finding surface" is the unit of code a quality finding points at — a
// symbol (function / class / module export) together with the set of tests
// that exercise it. This helper answers one question, purely and without I/O:
// for that surface, which of the three test tiers from
// `.agents/rules/testing-standards.md` (unit / contract / acceptance) are
// PRESENT, and which are ABSENT — and why.
//
// The companion process skill is `core/qa-coverage-mapping`, which shows how
// to gather the surface input and act on the verdict. This module is the
// deterministic seam that skill delegates to; it makes no network calls, runs
// no child processes, and reads no environment or files.
//
// Public API:
//
//   coverageVerdict(surface) -> {
//     unit:       { status, note },
//     contract:   { status, note },
//     acceptance: { status, note },
//   }
//
//   status is 'present' when the tier has at least one classified test, or
//   'absent' otherwise. `note` is a short operator-facing string explaining
//   the verdict (always populated, including for present tiers).

/** The three test tiers, in pyramid order (base → top). */
export const TIERS = Object.freeze(['unit', 'contract', 'acceptance']);

const PRESENT = 'present';
const ABSENT = 'absent';

/**
 * Classify a single test descriptor into one of the three tiers, or `null`
 * when it cannot be placed. Tier placement mirrors
 * `.agents/rules/testing-standards.md`:
 *   - unit       — colocated `*.test.*` next to source, or under `__tests__/`.
 *   - contract   — lives under a `tests/contract/**` (or `**\/contract\/**`)
 *                  path.
 *   - acceptance — a Gherkin `.feature` file (e2e / acceptance tier).
 *
 * An explicit `tier` field on the descriptor always wins over path inference,
 * so callers that already know the tier can state it directly.
 */
export function classifyTest(test) {
  if (test == null) return null;

  // 1. Explicit tier wins.
  const explicit =
    typeof test === 'object' && typeof test.tier === 'string'
      ? test.tier.trim().toLowerCase()
      : null;
  if (explicit && TIERS.includes(explicit)) {
    return explicit;
  }

  // 2. Infer from a path string.
  const rawPath =
    typeof test === 'string'
      ? test
      : typeof test === 'object' && typeof test.path === 'string'
        ? test.path
        : null;
  if (!rawPath) return null;

  const p = rawPath.replace(/\\/g, '/').toLowerCase();

  if (p.endsWith('.feature')) return 'acceptance';
  if (/(^|\/)contract\//.test(p) || /\.contract\.test\.[cm]?[jt]sx?$/.test(p)) {
    return 'contract';
  }
  if (/\.test\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\//.test(p)) {
    return 'unit';
  }
  return null;
}

const ABSENT_NOTES = Object.freeze({
  unit: 'no colocated unit test exercises this surface',
  contract: 'no contract test asserts this surface’s wire shape or boundary',
  acceptance: 'no acceptance scenario covers a user-visible journey here',
});

const PRESENT_NOTES = Object.freeze({
  unit: (n) => `${n} unit test${n === 1 ? '' : 's'} present`,
  contract: (n) => `${n} contract test${n === 1 ? '' : 's'} present`,
  acceptance: (n) => `${n} acceptance scenario${n === 1 ? '' : 's'} present`,
});

/**
 * Compute the per-tier coverage verdict for one finding surface.
 *
 * @param {object} surface
 * @param {string} [surface.symbol] - The symbol the finding points at; echoed
 *   into notes for operator context. Optional.
 * @param {Array<string|{path?:string,tier?:string}>} [surface.tests] - The
 *   tests that exercise the surface. Each entry is either a path string or a
 *   descriptor with `path` and/or `tier`. Unclassifiable entries are ignored.
 * @returns {{unit:{status:string,note:string},
 *            contract:{status:string,note:string},
 *            acceptance:{status:string,note:string}}}
 */
export function coverageVerdict(surface = {}) {
  if (surface === null || typeof surface !== 'object') {
    throw new TypeError('coverageVerdict: surface must be an object');
  }

  const tests = Array.isArray(surface.tests) ? surface.tests : [];
  const symbol =
    typeof surface.symbol === 'string' && surface.symbol.trim() !== ''
      ? surface.symbol.trim()
      : null;

  const counts = { unit: 0, contract: 0, acceptance: 0 };
  for (const test of tests) {
    const tier = classifyTest(test);
    if (tier) counts[tier] += 1;
  }

  const verdict = {};
  for (const tier of TIERS) {
    const n = counts[tier];
    if (n > 0) {
      verdict[tier] = {
        status: PRESENT,
        note: PRESENT_NOTES[tier](n),
      };
    } else {
      const base = ABSENT_NOTES[tier];
      verdict[tier] = {
        status: ABSENT,
        note: symbol ? `${base} (${symbol})` : base,
      };
    }
  }

  return verdict;
}
