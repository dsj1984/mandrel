/**
 * regression-projection.js — phase 2 of baseline-attribution.
 *
 * For each baseline-style gate (`check-maintainability`, `check-crap`),
 * re-derive the per-file/per-method regression rows that `runPreMergeGates`
 * would have surfaced on failure. These rows feed the attribution
 * classifier downstream so attributable rows can trigger a refresh and
 * non-attributable rows can route to a friction comment.
 *
 * Two projectors live here:
 *
 *   - `projectMaintainabilityForGate` — reuses the MI projection from
 *     `close-validation/projections/maintainability.js` (Story #874).
 *   - `projectCrapForGate` / `projectCrapRegressions` — diff CRAP envelopes
 *     at `origin/<epicBranch>` vs `storyBranch`, optionally scoped to the
 *     Story's touched files (Story #1124).
 */

import { readBaselineAtRef as defaultReadBaselineAtRef } from '../../../../baseline-loader.js';
import { projectMaintainabilityRegressions as defaultProjectMaintainabilityRegressions } from '../../../../close-validation/projections/maintainability.js';
import { getBaselines as defaultGetBaselines } from '../../../../config-resolver.js';
import {
  computeStoryDiffPaths,
  validateProjectionContext,
} from './scope-discovery.js';

/**
 * Default CRAP regression tolerance — mirrors `check-crap.js`. Score noise
 * floor is ~0.01 from coverage rounding shifts across Node/V8 builds; a
 * 0.05 tolerance clears that without admitting real regressions (those
 * cross whole-integer thresholds and clear 0.05 trivially).
 */
const DEFAULT_CRAP_TOLERANCE = 0.05;

function coerceScopeSet(touchedFiles) {
  if (touchedFiles == null) return null;
  if (touchedFiles instanceof Set) return touchedFiles;
  return new Set(touchedFiles);
}

// Story #1895: rows from the canonical envelope key by `path`; legacy
// rows key by `file`. Accept either so this attribution layer keeps
// working while the Epic migrates consumers off the legacy shape.
function rowFileKey(row) {
  if (!row) return null;
  if (typeof row.file === 'string') return row.file;
  if (typeof row.path === 'string') return row.path;
  return null;
}

function indexCrapBaselineByMethod(baselineRows) {
  const byMethod = new Map();
  for (const b of baselineRows) {
    const f = rowFileKey(b);
    if (!f || typeof b.method !== 'string') continue;
    const key = `${f}::${b.method}`;
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key).push(b);
  }
  return byMethod;
}

function pickClosestUnseen(candidates, headStartLine, seen) {
  let pick = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const f = rowFileKey(c);
    const k = `${f}::${c.method}@${c.startLine}`;
    if (seen.has(k)) continue;
    const d = Math.abs((c.startLine ?? 0) - (headStartLine ?? 0));
    if (d < bestDist) {
      bestDist = d;
      pick = c;
    }
  }
  return pick;
}

function isValidHeadRow(row) {
  return Boolean(row && rowFileKey(row) && typeof row.method === 'string');
}

function buildCrapRegression(row, pick) {
  const headCrap = typeof row.crap === 'number' ? row.crap : 0;
  const baseCrap = typeof pick.crap === 'number' ? pick.crap : 0;
  const f = rowFileKey(row);
  return {
    file: f,
    path: f,
    method: row.method,
    startLine: row.startLine,
    crap: headCrap,
    projected: headCrap,
    baseline: baseCrap,
    drop: headCrap - baseCrap,
    headCrap,
    baseCrap,
  };
}

/**
 * Pure helper — given two CRAP baseline envelopes (`{ rows: [...] }`), produce
 * the regression rows for methods whose `crap` score increased beyond
 * `tolerance` between `baselineRows` and `headRows`. When `touchedFiles` is
 * supplied (as a Set or array of repo-relative POSIX paths), rows are filtered
 * to functions inside files the Story changed — sibling drift outside the
 * Story's diff is excluded by construction, matching the maintainability
 * projector's "touched-only" contract.
 *
 * Row shape mirrors the maintainability projector — `{ file, method,
 * startLine, crap, baseline, drop, projected }` — so downstream attribution
 * + refresh-commit logic (`classifyBaselineDrift`,
 * `renderBaselineFrictionBody`) can read either projector's output with the
 * same field accessors. `projected` is an alias for `crap` retained for
 * shape compatibility with maintainability rows.
 *
 * Exported so unit tests can pin the diff math against a fixture pair of
 * baseline envelopes without spawning `git`.
 */
export function diffCrapBaselines({
  baselineRows,
  headRows,
  touchedFiles = null,
  tolerance = DEFAULT_CRAP_TOLERANCE,
} = {}) {
  if (!Array.isArray(baselineRows) || !Array.isArray(headRows)) return [];
  const scope = coerceScopeSet(touchedFiles);
  const byMethod = indexCrapBaselineByMethod(baselineRows);
  const seen = new Set();
  const regressions = [];

  for (const row of headRows) {
    if (!isValidHeadRow(row)) continue;
    const rowFile = rowFileKey(row);
    if (scope && !scope.has(rowFile)) continue;
    const candidates = byMethod.get(`${rowFile}::${row.method}`);
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const pick = pickClosestUnseen(candidates, row.startLine, seen);
    if (!pick) continue;
    seen.add(`${rowFileKey(pick)}::${pick.method}@${pick.startLine}`);
    const entry = buildCrapRegression(row, pick);
    if (entry.headCrap <= entry.baseCrap + tolerance) continue;
    const { headCrap: _h, baseCrap: _b, ...publicEntry } = entry;
    regressions.push(publicEntry);
  }
  return regressions;
}

export function projectCrapRegressions({
  touchedFiles,
  baselineRef,
  headRef,
  cwd,
  baselinePath,
  tolerance = DEFAULT_CRAP_TOLERANCE,
  readBaselineAtRef = defaultReadBaselineAtRef,
  getBaselines = defaultGetBaselines,
  config,
} = {}) {
  if (!baselineRef || !headRef) return [];
  const resolvedPath = baselinePath ?? getBaselines(config)?.crap?.path;
  if (!resolvedPath) return [];

  let baselineEnv;
  let headEnv;
  try {
    baselineEnv = readBaselineAtRef(baselineRef, resolvedPath, { cwd });
  } catch {
    return [];
  }
  try {
    headEnv = readBaselineAtRef(headRef, resolvedPath, { cwd });
  } catch {
    return [];
  }
  const baselineRows = Array.isArray(baselineEnv?.rows) ? baselineEnv.rows : [];
  const headRows = Array.isArray(headEnv?.rows) ? headEnv.rows : [];
  return diffCrapBaselines({
    baselineRows,
    headRows,
    touchedFiles,
    tolerance,
  });
}

/**
 * Maintainability projector — extracts the same regression rows
 * `runPreMergeGates` would have surfaced for `check-maintainability` by
 * re-running the per-file MI ceiling projection against `origin/<epicBranch>`.
 *
 * Behaviour is preserved byte-for-byte from the pre-refactor early-return
 * branch of `projectRegressionsForGate`: missing baseline path → `[]`, and
 * the underlying `projectMaintainabilityRegressions` decides what counts as
 * a regression row.
 *
 * @returns {Array<{ path?: string, file?: string }>}
 */
function projectMaintainabilityForGate({
  cwd,
  epicBranch,
  storyBranch,
  config,
  projectMaintainability = defaultProjectMaintainabilityRegressions,
  getBaselines = defaultGetBaselines,
}) {
  const baselinePath = getBaselines(config)?.maintainability?.path;
  if (!baselinePath) return [];
  const projection = projectMaintainability({
    cwd,
    epicBranch,
    storyBranch,
    baselinePath,
  });
  return projection?.regressions ?? [];
}

function projectCrapForGate({
  cwd,
  epicBranch,
  storyBranch,
  config,
  getBaselines = defaultGetBaselines,
  readBaselineAtRef = defaultReadBaselineAtRef,
  computeTouched = computeStoryDiffPaths,
  projectCrap = projectCrapRegressions,
} = {}) {
  if (!validateProjectionContext({ cwd, epicBranch, storyBranch })) return [];
  const touchedFiles = new Set(
    computeTouched({ cwd, epicBranch, storyBranch }),
  );
  return projectCrap({
    touchedFiles,
    baselineRef: `origin/${epicBranch}`,
    headRef: storyBranch,
    cwd,
    config,
    readBaselineAtRef,
    getBaselines,
  });
}

export const PROJECTORS = {
  'check-maintainability': projectMaintainabilityForGate,
  'check-crap': projectCrapForGate,
};

/**
 * Composite gates fan out to per-kind projectors. The baseline pipeline was
 * unified behind a single `check-baselines` gate (per-kind pipeline: schema →
 * floor → tolerance), but the attribution layer still keys on the original
 * per-kind gate names. Without this map a `check-baselines` failure projects
 * zero regressions, the gate-failure handler sees an empty list, and the
 * auto-refresh path silently no-ops — so a legitimate MI/CRAP regression
 * hard-fails the close instead of self-healing (framework-gap #4377).
 */
export const COMPOSITE_SUBGATES = {
  'check-baselines': ['check-maintainability', 'check-crap'],
};

/** `check-maintainability` → `maintainability`. */
function gateKind(gateName) {
  return gateName.replace(/^check-/, '');
}

export function projectRegressionsForGate({
  gateName,
  cwd,
  epicBranch,
  storyBranch,
  config,
  projectMaintainability = defaultProjectMaintainabilityRegressions,
  getBaselines = defaultGetBaselines,
}) {
  const ctx = {
    cwd,
    epicBranch,
    storyBranch,
    config,
    projectMaintainability,
    getBaselines,
  };
  const subGates = COMPOSITE_SUBGATES[gateName];
  if (subGates) {
    // Union the per-kind regressions, tagging each row with its baseline
    // kind so the gate-failure handler can refresh the right baseline (one
    // kind per attribution cycle; the retry loop converges the rest).
    return subGates.flatMap((sub) => {
      const project = PROJECTORS[sub];
      if (!project) return [];
      const kind = gateKind(sub);
      return project(ctx).map((row) => ({ _gateKind: kind, ...row }));
    });
  }
  const project = PROJECTORS[gateName];
  if (!project) return [];
  return project(ctx);
}
