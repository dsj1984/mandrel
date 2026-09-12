/**
 * crap-preview-scan.js — the scan → compare → report tail of
 * `preview-gates.js#runCrapPreview`, once its baseline is loaded and judged
 * compatible.
 *
 * Hoisted out of `runCrapPreview` verbatim (Story #4981) so that function's
 * cyclomatic complexity does not grow with the incremental-mode wiring
 * alongside it — this is a relocation of pre-existing logic, not new
 * behaviour; the incremental resolution itself is the only Story #4981
 * addition (see `resolveCrapPreviewIncremental`).
 */
import path from 'node:path';
import { loadCoverage } from '../coverage-utils.js';
import {
  KERNEL_VERSION,
  resolveEscomplexVersion,
  scanAndScore,
} from '../crap-utils.js';
import { CYCLOMATIC_CEILING } from '../cyclomatic-ceiling.js';
import { resolveCrapPreviewIncremental } from './crap-preview-incremental.js';
import { resolveCrapEnvOverrides } from './env-overrides.js';
import {
  assessComparisonBasis,
  buildCrapReport,
  compareCrap,
  filterRowsByFileScope,
  suppressVerdicts,
} from './kinds/crap.js';

/**
 * Narrow a CRAP baseline to the rows whose file path is in `scopeSet`,
 * or return all rows when no diff-scope filter is active.
 *
 * @param {{ rows: object[] }} baseline
 * @param {Set<string>|null|undefined} scopeSet
 * @returns {object[]}
 */
function resolveBaselineRows(baseline, scopeSet) {
  return scopeSet
    ? filterRowsByFileScope(baseline.rows, scopeSet)
    : baseline.rows;
}

/**
 * Return true when the CRAP compare result contains regressions or new
 * violations — i.e. when the preview gate should exit non-zero.
 *
 * @param {{ regressions: number, newViolations: number }} result
 * @returns {boolean}
 */
function hasCrapRegressions(result) {
  return result.regressions > 0 || result.newViolations > 0;
}

/**
 * Scan `crap.targetDirs`, compare against the (already compatibility-judged)
 * baseline, and build the `--json` envelope — the exact pre-#4981 tail of
 * `runCrapPreview`, now including the Story #4981 incremental-join opt-in.
 *
 * @param {{
 *   crap: object,
 *   cwd: string,
 *   scopeSet: Set<string>|null,
 *   scope: string,
 *   diffRef: string|null,
 *   baseline: { rows: object[] },
 * }} opts
 * @returns {Promise<{ exitCode: number, envelope: object }>}
 */
/**
 * The scanned methods at or over the fixed cyclomatic ceiling (Story #5313),
 * as advisories: `quality-preview.js` lists them and exits 0 on them, so the
 * reading reaches the author without the preview ever refusing a commit on
 * complexity alone. Pure.
 *
 * @param {Array<{ file: string, method: string, startLine: number, cyclomatic: number }>} rows
 * @returns {Array<{ file: string, method: string, startLine: number, cyclomatic: number }>}
 */
export function listCyclomaticAdvisories(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => Number(r?.cyclomatic) >= CYCLOMATIC_CEILING)
    .map(({ file, method, startLine, cyclomatic }) => ({
      file,
      method,
      startLine,
      cyclomatic,
    }));
}

export async function computeCrapPreviewScan({
  crap,
  cwd,
  scopeSet,
  scope,
  diffRef,
  baseline,
}) {
  const targetDirs = Array.isArray(crap.targetDirs) ? crap.targetDirs : [];
  const crapIgnoreGlobs = Array.isArray(crap.ignoreGlobs)
    ? crap.ignoreGlobs
    : [];
  const requireCoverage = crap.requireCoverage !== false;
  const coveragePath = crap.coveragePath ?? 'coverage/coverage-final.json';
  const coverage = loadCoverage(path.resolve(cwd, coveragePath));
  // Story #4731 (AC-3) — feed the CRAP regression compare the *configured*
  // crap tolerance (env override → `gates.crap.tolerance` → framework default)
  // so `compareCrap` demotes positive deltas at or under tolerance rather than
  // failing on any positive delta; over-tolerance deltas still fail. This keeps
  // the pre-commit/pre-push preview aligned with the authoritative gate.
  const { newMethodCeiling, tolerance } = resolveCrapEnvOverrides(
    crap,
    process.env,
  );
  const incremental = resolveCrapPreviewIncremental({
    crap,
    diffRef,
    cwd,
    baselineRows: baseline.rows,
  });
  const scan = await scanAndScore({
    targetDirs,
    coverage,
    requireCoverage,
    cwd,
    scopeFiles: scopeSet,
    ignoreGlobs: crapIgnoreGlobs,
    incremental,
  });
  const baselineRows = resolveBaselineRows(baseline, scopeSet);
  const result = compareCrap({
    currentRows: scan.rows,
    baselineRows,
    newMethodCeiling,
    tolerance,
  });
  const envelope = buildCrapReport({
    compareResult: result,
    scanSummary: scan,
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: resolveEscomplexVersion(),
    newMethodCeiling,
    scopeInfo: { scope, diffRef },
  });
  // Story #5313: a method at or over the cyclomatic ceiling is an ADVISORY
  // on the preview — reported, never a verdict. The ratchet in
  // `check-cyclomatic.js` owns enforcement.
  envelope.cyclomaticAdvisories = listCyclomaticAdvisories(scan.rows);
  // Story #4866 (AC-5): above the drifted-row ratio the basis is self-
  // evidently unsound and every per-method verdict below it is an artefact of
  // a mis-keyed join. Say so once, by name, and fail open.
  const basis = assessComparisonBasis(result);
  if (!basis.sound) {
    return {
      exitCode: 0,
      envelope: suppressVerdicts(envelope, basis.diagnostic),
    };
  }
  const exitCode = hasCrapRegressions(result) ? 1 : 0;
  return { exitCode, envelope };
}
