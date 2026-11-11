/**
 * The scan → compare → report tail of `preview-gates.js#runCrapPreview`, once
 * its baseline is loaded and judged compatible.
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
import {
  outsideDiffDiagnostics,
  previewCoveragePath,
  previewNotRun,
  resolveIsJudged,
} from './crap-preview-touched.js';
import { resolveCrapEnvOverrides } from './env-overrides.js';
import {
  buildCrapReport,
  compareCrap,
  filterRowsByFileScope,
} from './kinds/crap.js';

/**
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
 * @param {{ regressions: number, newViolations: number }} result
 * @returns {boolean}
 */
function hasCrapRegressions(result) {
  return result.regressions > 0 || result.newViolations > 0;
}

/**
 * Methods at or over the cyclomatic ceiling, as advisories only: the preview
 * never refuses a commit on complexity; `check-cyclomatic.js` enforces. Pure.
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

/**
 * @param {{
 *   crap: object,
 *   cwd: string,
 *   scopeSet: Set<string>|null,
 *   scope: string,
 *   diffRef: string|null,
 *   baseline: { rows: object[] },
 *   baseBranch?: string,
 *   git?: Function,
 *   coverageArtifact?: string|null,
 * }} opts
 * @returns {Promise<{ exitCode: number, envelope: object }>}
 */
export async function computeCrapPreviewScan({
  crap,
  cwd,
  scopeSet,
  scope,
  diffRef,
  baseline,
  baseBranch,
  git,
  coverageArtifact = null,
}) {
  const targetDirs = Array.isArray(crap.targetDirs) ? crap.targetDirs : [];
  const crapIgnoreGlobs = Array.isArray(crap.ignoreGlobs)
    ? crap.ignoreGlobs
    : [];
  const requireCoverage = crap.requireCoverage !== false;
  // The configured tolerance keeps the preview aligned with the authoritative
  // gate: deltas at or under it are demoted, not failed.
  const { newMethodCeiling, tolerance } = resolveCrapEnvOverrides(
    crap,
    process.env,
  );
  // A named artifact is vouched for by its caller: no capture-stamp check.
  const notRun = coverageArtifact
    ? null
    : previewNotRun({ crap, targetDirs, cwd, scope, diffRef });
  if (notRun) return notRun;
  const coverage = loadCoverage(
    coverageArtifact ?? path.resolve(cwd, previewCoveragePath(crap)),
  );
  const incremental = resolveCrapPreviewIncremental({
    crap,
    diffRef,
    baseBranch,
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
    isJudged: resolveIsJudged({ crap, diffRef, baseBranch, cwd, git }),
  });
  const envelope = buildCrapReport({
    compareResult: result,
    scanSummary: scan,
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: resolveEscomplexVersion(),
    newMethodCeiling,
    scopeInfo: { scope, diffRef },
  });
  envelope.cyclomaticAdvisories = listCyclomaticAdvisories(scan.rows);
  if (result.informational.length > 0) {
    envelope.diagnostics = outsideDiffDiagnostics(result.informational);
  }
  const exitCode = hasCrapRegressions(result) ? 1 : 0;
  return { exitCode, envelope };
}
