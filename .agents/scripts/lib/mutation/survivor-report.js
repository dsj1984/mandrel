/**
 * lib/mutation/survivor-report.js — enumerate actionable surviving mutants
 * from a Stryker JSON report (Story #3428).
 *
 * The mutation gate (`stryker-runner.js` → `summariseReport`) collapses the
 * report into a single score. That score tells you *whether* the suite is
 * leaky, not *where*. This helper does the complementary job: it walks the
 * same `files[].mutants[].status` surface and enumerates the mutants that
 * the suite failed to kill — `Survived` (a mutation that the tests ran over
 * but never caught) and `NoCoverage` (a mutation in a line no test exercises
 * at all) — grouped per file so the survivor-kill loop has concrete targets.
 *
 * It is **pure**: no network, no child process, no filesystem reads. The
 * caller hands in an already-parsed report object (the same JSON that
 * `stryker-runner.js` reads from `reports/mutation/mutation.json`). This
 * keeps the helper trivially unit-testable with inline fixtures and lets
 * remediation tooling reuse a report it already loaded for scoring.
 *
 * Output contract:
 *
 *   {
 *     ok: true,
 *     totals: { survived, noCoverage, actionable, files },
 *     files: [
 *       {
 *         file: "src/a.js",
 *         survived: [{ id, line, mutatorName, status, ... }],
 *         noCoverage: [{ ... }],
 *         count: <survived.length + noCoverage.length>,
 *       },
 *       ...
 *     ],
 *   }
 *   { ok: false, error: <string> }
 *
 * Files with no actionable survivors are omitted from `files`. The `files`
 * array is sorted by descending actionable count (worst offenders first),
 * ties broken by file path for stable output.
 */

/** Mutant statuses this helper treats as actionable survivors. */
export const ACTIONABLE_STATUSES = Object.freeze(['Survived', 'NoCoverage']);

/**
 * Fields copied verbatim from each Stryker mutant onto the enumerated
 * survivor record. We deliberately keep a fixed allowlist (rather than
 * spreading the raw mutant) so the output shape is stable and never leaks
 * unexpected report internals.
 */
const MUTANT_FIELDS = Object.freeze([
  'id',
  'mutatorName',
  'status',
  'location',
  'replacement',
]);

/**
 * Pure: enumerate `Survived` and `NoCoverage` mutants per file from a
 * parsed Stryker mutation report.
 *
 * @param {unknown} report Parsed Stryker JSON report (an object with a
 *   top-level `files` map). Passing the raw JSON string is **not**
 *   supported — parse it first (mirrors `summariseReport`).
 * @returns {(
 *   { ok: true, totals: { survived: number, noCoverage: number, actionable: number, files: number }, files: Array<{ file: string, survived: object[], noCoverage: object[], count: number }> }
 *   | { ok: false, error: string }
 * )}
 */
export function enumerateSurvivors(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, error: 'Stryker report must be a JSON object' };
  }

  const files = /** @type {Record<string, unknown> | undefined} */ (
    /** @type {Record<string, unknown>} */ (report).files
  );
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, error: "Stryker report missing 'files' map" };
  }

  const perFile = [];
  let survivedTotal = 0;
  let noCoverageTotal = 0;

  for (const [filePath, entry] of Object.entries(files)) {
    if (!entry || typeof entry !== 'object') continue;
    const mutants = /** @type {{ mutants?: unknown }} */ (entry).mutants;
    if (!Array.isArray(mutants)) continue;

    const survived = [];
    const noCoverage = [];
    for (const mutant of mutants) {
      if (!mutant || typeof mutant !== 'object') continue;
      const status = /** @type {{ status?: unknown }} */ (mutant).status;
      if (status === 'Survived') {
        survived.push(pickMutant(mutant));
      } else if (status === 'NoCoverage') {
        noCoverage.push(pickMutant(mutant));
      }
    }

    if (survived.length === 0 && noCoverage.length === 0) continue;

    survivedTotal += survived.length;
    noCoverageTotal += noCoverage.length;
    perFile.push({
      file: filePath,
      survived,
      noCoverage,
      count: survived.length + noCoverage.length,
    });
  }

  perFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  return {
    ok: true,
    totals: {
      survived: survivedTotal,
      noCoverage: noCoverageTotal,
      actionable: survivedTotal + noCoverageTotal,
      files: perFile.length,
    },
    files: perFile,
  };
}

/**
 * Copy the stable allowlist of fields off a raw Stryker mutant. The `line`
 * convenience field is derived from `location.start.line` when present so
 * callers can sort/print without re-walking the nested location shape.
 *
 * @param {Record<string, unknown>} mutant
 * @returns {Record<string, unknown>}
 */
function pickMutant(mutant) {
  const out = {};
  for (const field of MUTANT_FIELDS) {
    if (mutant[field] !== undefined) out[field] = mutant[field];
  }
  const line = extractLine(mutant.location);
  if (line !== null) out.line = line;
  return out;
}

/**
 * Pull the 1-based start line out of a Stryker `location` object, or null
 * when the shape is missing or malformed.
 *
 * @param {unknown} location
 * @returns {number | null}
 */
function extractLine(location) {
  if (!location || typeof location !== 'object') return null;
  const start = /** @type {{ start?: unknown }} */ (location).start;
  if (!start || typeof start !== 'object') return null;
  const line = /** @type {{ line?: unknown }} */ (start).line;
  return typeof line === 'number' && Number.isFinite(line) ? line : null;
}
