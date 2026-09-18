/**
 * `quality-preview` / `quality-watch` per-kind runners: scan, compare, and
 * return `{ exitCode, envelope }` (1 = regression or floor break). No
 * friction signals and no `process.exit`.
 */

import path from 'node:path';

import { resolvePreviewScope } from '../changed-files.js';
import { getBaselines, getQuality, resolveConfig } from '../config-resolver.js';
import { KERNEL_VERSION, resolveEscomplexVersion } from '../crap-utils.js';
import { calculateAll, scanDirectory } from '../maintainability-utils.js';
import { computeCrapPreviewScan } from './crap-preview-scan.js';
import {
  assertBaselineCompatible,
  INCOMPATIBLE_BASELINE_DIAGNOSTIC,
  loadCrapBaseline,
  suppressVerdicts,
} from './kinds/crap.js';
import {
  buildMaintainabilityReport,
  loadMaintainabilityBaseline,
  MAINTAINABILITY_EXCLUSIONS,
} from './kinds/maintainability.js';

export const MI_PREVIEW_DEFAULT_TOLERANCE = 0.5;

/**
 * Explicit override, then configured tolerance, then the default — so the
 * preview agrees with `check-baselines`.
 *
 * @param {{ explicit?: number | null, configured?: number, fallback?: number }} opts
 * @returns {number}
 */
export function resolvePreviewTolerance({
  explicit = null,
  configured,
  fallback = MI_PREVIEW_DEFAULT_TOLERANCE,
} = {}) {
  if (Number.isFinite(explicit)) return explicit;
  if (Number.isFinite(configured)) return configured;
  return fallback;
}

/**
 * Pure: replicate the legacy `check-maintainability.js compareScores`
 * behavior so the preview runner can build the stats block the report
 * builder expects.
 *
 * @param {Record<string, number>} scores
 * @param {Record<string, number>} baseline
 * @param {number} tolerance
 */
function compareScores(scores, baseline, tolerance) {
  let regressions = 0;
  let newFiles = 0;
  let improvements = 0;
  const regressedFiles = [];
  for (const [file, score] of Object.entries(scores ?? {})) {
    const baselineScore = baseline?.[file];
    if (baselineScore === undefined) {
      newFiles += 1;
      continue;
    }
    if (score < baselineScore - tolerance) {
      const drop = baselineScore - score;
      regressions += 1;
      regressedFiles.push({
        file,
        current: score,
        baseline: baselineScore,
        drop,
      });
    } else if (score > baselineScore + tolerance) {
      improvements += 1;
    }
  }
  return { regressions, newFiles, improvements, regressedFiles };
}

/**
 * Build the zero-row CRAP envelope the preview returns when it has nothing to
 * compare against — no baseline, or the gate disabled.
 *
 * @param {{scope: string, diffRef: string|null}} scopeInfo
 * @returns {object}
 */
function emptyCrapEnvelope({ scope, diffRef }) {
  return {
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: resolveEscomplexVersion(),
    summary: {
      total: 0,
      regressions: 0,
      newViolations: 0,
      drifted: 0,
      incomparable: 0,
      provenanceMismatched: 0,
      unscorable: 0,
      removed: 0,
      skippedNoCoverage: 0,
      scope,
      diffRef,
    },
    violations: [],
  };
}

function applyDiffScopeMi({ files, baseline, scopeSet, cwd }) {
  if (!scopeSet) {
    return { scopedFiles: files, scopedBaseline: baseline ?? {} };
  }
  const scopedFiles = files.filter((abs) => {
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    return scopeSet.has(rel);
  });
  const scopedBaseline = Object.fromEntries(
    Object.entries(baseline ?? {}).filter(([file]) => scopeSet.has(file)),
  );
  return { scopedFiles, scopedBaseline };
}

/**
 * Run the maintainability gate in preview mode.
 *
 * @param {{
 *   cwd?: string,
 *   changedSinceRef?: string | null,
 *   staged?: boolean,
 *   tolerance?: number,
 * }} [opts]
 */
export async function runMaintainabilityPreview({
  cwd = process.cwd(),
  changedSinceRef = null,
  staged = false,
  tolerance = null,
} = {}) {
  const config = resolveConfig({ cwd });
  const baselinePath = getBaselines(config).maintainability.path;
  const baseline = loadMaintainabilityBaseline({
    baselinePath: path.isAbsolute(baselinePath)
      ? baselinePath
      : path.resolve(cwd, baselinePath),
    epicRef: null,
  });

  const miQuality = getQuality(config).maintainability;
  const effectiveTolerance = resolvePreviewTolerance({
    explicit: tolerance,
    configured: miQuality.tolerance,
  });
  const targetDirs = miQuality.targetDirs;
  const ignoreGlobs = miQuality.ignoreGlobs ?? [];
  const files = [];
  for (const dir of targetDirs) {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    scanDirectory(abs, files, { cwd, ignoreGlobs });
  }
  const { scopeSet, scope, diffRef } = resolvePreviewScope({
    staged,
    changedSinceRef,
    cwd,
  });
  const { scopedFiles, scopedBaseline } = applyDiffScopeMi({
    files,
    baseline,
    scopeSet,
    cwd,
  });

  const rawScores = await calculateAll(scopedFiles);
  // Excluded files would surface as phantom MI=0 regressions.
  const scores = {};
  for (const [key, mi] of Object.entries(rawScores)) {
    const rel = path.isAbsolute(key) ? path.relative(cwd, key) : key;
    const posixRel = rel.split(path.sep).join('/');
    if (!MAINTAINABILITY_EXCLUSIONS.has(posixRel)) scores[key] = mi;
  }
  const stats = compareScores(scores, scopedBaseline, effectiveTolerance);
  const envelope = buildMaintainabilityReport(scores, stats, {
    scope,
    diffRef,
  });
  const exitCode = stats.regressions > 0 ? 1 : 0;
  return { exitCode, envelope };
}

/**
 * Run the CRAP gate in preview mode.
 */
export async function runCrapPreview({
  cwd = process.cwd(),
  changedSinceRef = null,
  staged = false,
} = {}) {
  const { scopeSet, scope, diffRef } = resolvePreviewScope({
    staged,
    changedSinceRef,
    cwd,
  });
  const config = resolveConfig({ cwd });
  const baselinePath = getBaselines(config).crap.path;
  const baseline = loadCrapBaseline({
    baselinePath: path.isAbsolute(baselinePath)
      ? baselinePath
      : path.resolve(cwd, baselinePath),
    epicRef: null,
  });
  const quality = getQuality(config);
  const crap = quality.crap;
  if (!baseline || crap.enabled === false) {
    return { exitCode: 0, envelope: emptyCrapEnvelope({ scope, diffRef }) };
  }

  // An incompatible baseline yields no meaningful verdict. Fail open:
  // `check-baselines` still gates the merge.
  const incompatible = assertBaselineCompatible(baseline);
  if (incompatible) {
    return {
      exitCode: 0,
      envelope: suppressVerdicts(emptyCrapEnvelope({ scope, diffRef }), {
        name: INCOMPATIBLE_BASELINE_DIAGNOSTIC,
        message: incompatible,
      }),
    };
  }

  return computeCrapPreviewScan({
    crap,
    cwd,
    scopeSet,
    scope,
    diffRef,
    baseline,
  });
}
