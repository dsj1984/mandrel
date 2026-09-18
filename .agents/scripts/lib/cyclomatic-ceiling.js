/**
 * Cyclomatic ceiling as a ratchet, not a cliff: `baselines/cyclomatic.json`
 * records existing breaches per file, and the gate fails only when a change
 * adds an over-ceiling function beyond a file's recorded count or raises its
 * worst one. Scope is borrowed from the maintainability gate.
 *
 * @module lib/cyclomatic-ceiling
 */

import path from 'node:path';
import { CODING_GUARDRAILS } from './config/quality.js';
import { selectFilesToScore } from './cyclomatic-scope.js';
import { calculateReportForFile } from './maintainability-engine.js';
import { scanDirectory } from './maintainability-utils.js';

export const DEFAULT_CYCLOMATIC_BASELINE = 'baselines/cyclomatic.json';

/**
 * Fixed, not configurable, so a consumer cannot loosen the gate.
 * @type {number}
 */
export const CYCLOMATIC_CEILING = 12;

const CYCLOMATIC_BASELINE_SCHEMA =
  'https://mandrel.dev/baselines/cyclomatic.schema.json';

/**
 * @param {object | null | undefined} quality resolved `delivery.quality`
 * @returns {{ mustFix: number, flag: number, targetDirs: string[], ignoreGlobs: string[] }}
 */
export function resolveCyclomaticPolicy(quality) {
  const mi = quality?.maintainability ?? {};
  return {
    mustFix: CYCLOMATIC_CEILING,
    flag: CODING_GUARDRAILS.cyclomaticFlag,
    targetDirs: Array.isArray(mi.targetDirs) ? mi.targetDirs : [],
    ignoreGlobs: Array.isArray(mi.ignoreGlobs) ? mi.ignoreGlobs : [],
  };
}

/**
 * `null` when no function exceeds `ceiling`. Tested via the `scoreFile` seam.
 *
 * @param {string} file repo-relative POSIX path
 * @param {Array<{ cyclomatic?: number }>} methods
 * @param {number} ceiling
 * @returns {{ file: string, methodsAboveCeiling: number, maxCyclomatic: number } | null}
 */
function breachRowFor(file, methods, ceiling) {
  let count = 0;
  let max = 0;
  for (const method of methods ?? []) {
    const c = Number(method?.cyclomatic ?? 0);
    if (!Number.isFinite(c)) continue;
    if (c > ceiling) count += 1;
    if (c > max) max = c;
  }
  return count === 0
    ? null
    : { file, methodsAboveCeiling: count, maxCyclomatic: max };
}

/**
 * Breach rows sorted by path. `scopeFiles` limits which walked files are
 * scored — sound for a ratchet, since only a changed or baseline-recorded
 * file can yield a verdict. `scannedFiles` still reports the whole walk;
 * `null` scope scores everything.
 *
 * @param {{
 *   targetDirs: string[],
 *   ignoreGlobs?: string[],
 *   ceiling: number,
 *   cwd?: string,
 *   scopeFiles?: Set<string> | null,
 *   scoreFile?: (absPath: string) => { methods?: Array<{ cyclomatic?: number }>, parseError?: boolean },
 * }} args
 * @returns {{ rows: Array<object>, scannedFiles: number, scoredFiles: number, parseErrors: number }}
 */
export function scanCyclomatic({
  targetDirs,
  ignoreGlobs = [],
  ceiling,
  cwd = process.cwd(),
  scopeFiles = null,
  scoreFile = calculateReportForFile,
}) {
  const files = [];
  for (const dir of targetDirs ?? []) {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
    scanDirectory(abs, files, { cwd, ignoreGlobs });
  }
  files.sort();
  const selected = selectFilesToScore(files, { cwd, ignoreGlobs, scopeFiles });
  const rows = [];
  let parseErrors = 0;
  for (const { abs, rel } of selected) {
    const report = scoreFile(abs);
    if (!report || report.parseError) {
      parseErrors += 1;
      continue;
    }
    const row = breachRowFor(rel, report.methods, ceiling);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  return {
    rows,
    scannedFiles: files.length,
    scoredFiles: selected.length,
    parseErrors,
  };
}

/**
 * Only `added` (count rose) and `worsened` (worst function rose) fail.
 *
 * @param {Array<{file: string, methodsAboveCeiling: number, maxCyclomatic: number}>} baselineRows
 * @param {Array<{file: string, methodsAboveCeiling: number, maxCyclomatic: number}>} currentRows
 * @returns {{ added: Array<object>, worsened: Array<object>, removed: Array<object>, improved: Array<object> }}
 */
export function diffCyclomaticRows(baselineRows, currentRows) {
  const base = new Map(
    (baselineRows ?? [])
      .filter((r) => typeof r?.file === 'string')
      .map((r) => [r.file, r]),
  );
  const added = [];
  const worsened = [];
  const improved = [];
  const seen = new Set();
  for (const row of currentRows ?? []) {
    if (typeof row?.file !== 'string') continue;
    seen.add(row.file);
    const prior = base.get(row.file);
    const priorCount = Number(prior?.methodsAboveCeiling ?? 0);
    const priorMax = Number(prior?.maxCyclomatic ?? 0);
    if (row.methodsAboveCeiling > priorCount) {
      added.push({ ...row, baselineCount: priorCount });
      continue;
    }
    if (row.maxCyclomatic > priorMax) {
      worsened.push({ ...row, baselineMax: priorMax });
      continue;
    }
    if (row.methodsAboveCeiling < priorCount || row.maxCyclomatic < priorMax) {
      improved.push({
        ...row,
        baselineCount: priorCount,
        baselineMax: priorMax,
      });
    }
  }
  const removed = (baselineRows ?? []).filter(
    (r) => typeof r?.file === 'string' && !seen.has(r.file),
  );
  const byFile = (a, b) => a.file.localeCompare(b.file);
  return {
    added: added.sort(byFile),
    worsened: worsened.sort(byFile),
    removed: removed.sort(byFile),
    improved: improved.sort(byFile),
  };
}

/**
 * @param {{ rows: Array<object>, ceiling: number, generatedAt?: string }} args
 * @returns {object}
 */
export function buildCyclomaticEnvelope({ rows, ceiling, generatedAt }) {
  const safeRows = rows ?? [];
  let methods = 0;
  let max = 0;
  for (const row of safeRows) {
    methods += Number(row.methodsAboveCeiling ?? 0);
    if (Number(row.maxCyclomatic ?? 0) > max) max = Number(row.maxCyclomatic);
  }
  return {
    $schema: CYCLOMATIC_BASELINE_SCHEMA,
    generatedAt: generatedAt ?? new Date().toISOString(),
    ceiling,
    rollup: {
      '*': {
        filesAboveCeiling: safeRows.length,
        methodsAboveCeiling: methods,
        maxCyclomatic: max,
      },
    },
    rows: safeRows,
  };
}

/**
 * Always ends with a summary line, even on a clean run.
 *
 * @param {{ added: Array, worsened: Array, removed: Array, improved: Array }} diff
 * @param {number} ceiling
 * @returns {string}
 */
export function renderCyclomaticDiff(diff, ceiling) {
  const lines = [];
  for (const r of diff.added) {
    lines.push(
      `+ ${r.file}: ${r.methodsAboveCeiling} function(s) over c=${ceiling} (recorded ${r.baselineCount}), worst c=${r.maxCyclomatic}`,
    );
  }
  for (const r of diff.worsened) {
    lines.push(
      `! ${r.file}: worst function c=${r.maxCyclomatic} (recorded ${r.baselineMax})`,
    );
  }
  for (const r of diff.improved) {
    lines.push(
      `~ ${r.file}: ${r.methodsAboveCeiling} over c=${ceiling} (recorded ${r.baselineCount}), worst c=${r.maxCyclomatic} (recorded ${r.baselineMax})`,
    );
  }
  for (const r of diff.removed) {
    lines.push(`- ${r.file}: no longer over c=${ceiling}`);
  }
  const failing = diff.added.length + diff.worsened.length;
  lines.push(
    `[cyclomatic] ceiling=${ceiling} added=${diff.added.length} worsened=${diff.worsened.length} improved=${diff.improved.length} removed=${diff.removed.length} ${
      failing > 0 ? '(gate fail)' : '(ok)'
    }`,
  );
  return lines.join('\n');
}
