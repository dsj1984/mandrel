// .agents/scripts/lib/qa/propose-missing-test.js
//
// Deterministic missing-test proposal from a coverage verdict.
//
// Closes the loop on accuracy (f4-accuracy): given the per-tier coverage
// verdict produced by `lib/qa/coverage-verdict.js`, name the single tier that
// should have caught a finding and draft a one-line test suggestion for it.
//
// The verdict's pyramid order is unit < contract < acceptance. The cheapest
// tier that is ABSENT is the one a finding "leaked through" — adding a test
// there is the lowest-cost way to have caught it — so this helper proposes
// the *lowest* absent tier. When every tier is present there is no gap to
// fill, so no proposal is returned.
//
// Pure logic, no I/O: no network, no child processes, no filesystem or env
// reads. The companion process skill is `core/qa-coverage-mapping`.
//
// Public API:
//
//   proposeMissingTest(coverageVerdict) -> null | {
//     tier:        'unit' | 'contract' | 'acceptance',
//     description: string,   // one-line test suggestion
//   }

import { TIERS } from './coverage-verdict.js';

const ABSENT = 'absent';

/**
 * One-line test-suggestion templates, keyed by tier. Each takes the absent
 * tier's verdict note (which already explains *why* the tier is uncovered)
 * and frames it as an actionable suggestion.
 */
const DESCRIPTION_BY_TIER = Object.freeze({
  unit: (note) =>
    `Add a colocated unit test exercising this surface in isolation — ${note}.`,
  contract: (note) =>
    `Add a contract test asserting this surface’s wire shape or boundary — ${note}.`,
  acceptance: (note) =>
    `Add an acceptance scenario covering the user-visible journey — ${note}.`,
});

/**
 * Read the absent-tier note off a verdict entry, falling back to a generic
 * phrase when the entry omits a usable note.
 *
 * @param {{note?:unknown}} entry
 * @returns {string}
 */
function noteFor(entry) {
  return typeof entry.note === 'string' && entry.note.trim() !== ''
    ? entry.note.trim()
    : 'no test currently covers this tier';
}

/**
 * Return true when a verdict entry marks its tier ABSENT.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
function isAbsent(entry) {
  return entry !== null && typeof entry === 'object' && entry.status === ABSENT;
}

/**
 * Propose the single missing test that should have caught a finding.
 *
 * Walks the tiers in pyramid order (unit → contract → acceptance) and returns
 * a proposal for the first ABSENT tier — the lowest-cost gap. Returns `null`
 * when every tier is present (full coverage, nothing to propose).
 *
 * @param {Record<string,{status?:string,note?:string}>} coverageVerdict - The
 *   object produced by `coverageVerdict()` in `lib/qa/coverage-verdict.js`.
 * @returns {null | {tier:string, description:string}}
 */
export function proposeMissingTest(coverageVerdict) {
  if (coverageVerdict === null || typeof coverageVerdict !== 'object') {
    throw new TypeError(
      'proposeMissingTest: coverageVerdict must be an object',
    );
  }

  for (const tier of TIERS) {
    const entry = coverageVerdict[tier];
    if (isAbsent(entry)) {
      return {
        tier,
        description: DESCRIPTION_BY_TIER[tier](noteFor(entry)),
      };
    }
  }

  return null;
}
