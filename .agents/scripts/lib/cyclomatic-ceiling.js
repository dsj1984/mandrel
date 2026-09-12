/**
 * cyclomatic-ceiling.js — the enforcing core behind the cyclomatic ceiling
 * ratchet (Story #4923; fixed ceiling since Story #5313).
 *
 * The two `codingGuardrails` cyclomatic knobs shipped schema-validated,
 * bootstrap-defaulted and resolver-resolved, and were then read by nothing:
 * `cyclomaticMustFix` had no consumer at all, and `cyclomaticFlag` was
 * shadowed by a hardcoded `8` in a `quality-preview` display column. A ceiling
 * nothing enforces is worse than no ceiling, because the workflow docs promise
 * the merge will be refused.
 *
 * Story #5313 retired the `cyclomaticMustFix` config key: the ratchet's
 * ceiling is the fixed {@link CYCLOMATIC_CEILING} (12), so a consumer cannot
 * bound this gate by tuning a number, and `cyclomaticFlag` is the one
 * advisory knob — `quality-preview.js` reports over-flag methods and exits 0
 * on them.
 *
 * This module is that enforcement, shaped as a **ratchet** rather than a
 * cliff. The repository already carries dozens of functions above the
 * must-fix ceiling; failing every one of them at once would have made the
 * gate un-landable and it would have been disabled the same day. So the
 * committed `baselines/cyclomatic.json` records the existing breaches per
 * file, and the gate fails only when a change **adds** an over-ceiling
 * function to a file that had none, adds one **beyond** that file's recorded
 * count, or pushes a file's worst function **higher** than recorded. Burning
 * the recorded breaches down is a separate, always-permitted motion — a
 * shrinking baseline is the success signal.
 *
 * Scope: the module walks the `maintainability` gate's `targetDirs` /
 * `ignoreGlobs`. Both instruments read the same coverage-free escomplex
 * surface, so re-declaring the scope under `codingGuardrails` would have
 * added two config keys whose only correct value is "whatever maintainability
 * says".
 *
 * @module lib/cyclomatic-ceiling
 */

import path from 'node:path';
import { selectFilesToScore } from './cyclomatic-scope.js';
import { calculateReportForFile } from './maintainability-engine.js';
import { scanDirectory } from './maintainability-utils.js';

/** Default location of the committed breach baseline. */
export const DEFAULT_CYCLOMATIC_BASELINE = 'baselines/cyclomatic.json';

/**
 * The per-function cyclomatic ceiling the ratchet enforces. Fixed — not a
 * config key — since Story #5313.
 * @type {number}
 */
export const CYCLOMATIC_CEILING = 12;

/** Baseline `$schema` marker, matching the sibling ratchet baselines. */
const CYCLOMATIC_BASELINE_SCHEMA =
  'https://mandrel.dev/baselines/cyclomatic.schema.json';

/**
 * Resolve the enforcement policy from a resolved `delivery.quality` block.
 *
 * `mustFix` is the fixed {@link CYCLOMATIC_CEILING}; `flag` comes from
 * `resolveCodingGuardrails` (advisory only). `targetDirs` / `ignoreGlobs`
 * are borrowed from the maintainability gate (see the module note).
 *
 * @param {object | null | undefined} quality resolved `delivery.quality`
 * @returns {{ mustFix: number, flag: number, targetDirs: string[], ignoreGlobs: string[] }}
 */
export function resolveCyclomaticPolicy(quality) {
  const guardrails = quality?.codingGuardrails ?? {};
  const mi = quality?.maintainability ?? {};
  return {
    mustFix: CYCLOMATIC_CEILING,
    flag: Number(guardrails.cyclomaticFlag ?? 8),
    targetDirs: Array.isArray(mi.targetDirs) ? mi.targetDirs : [],
    ignoreGlobs: Array.isArray(mi.ignoreGlobs) ? mi.ignoreGlobs : [],
  };
}

/**
 * Reduce one file's escomplex method list to a breach row, or `null` when the
 * file carries no function above `ceiling`.
 *
 * Pure. Module-private: tests reach it through `scanCyclomatic`'s `scoreFile`
 * seam, which keeps the row math exercised without adding an export whose only
 * importer is a test (the `--production` dead-export pass discounts those).
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
 * Walk the configured scope and score every file, returning the breach rows
 * sorted by path.
 *
 * `scoreFile` is a seam so tests can drive the reduction without the kernel;
 * production callers omit it.
 *
 * **Scoped scoring (Story #5109).** The directory walk is cheap — a few
 * `readdir` calls — but scoring is an escomplex parse per file, and re-parsing
 * the whole tree on every CI run cost 0.94 s to re-derive rows that could not
 * have moved. `scopeFiles`, when supplied, is the set of repo-relative POSIX
 * paths that are still *scored*; everything else is walked, counted, and
 * skipped. That is sound precisely because this gate is a ratchet: a verdict
 * exists only for a file that either changed (so it must be re-scored) or is
 * already recorded in the baseline (so its recorded count must be re-derived
 * to detect an improvement or a removal). A file that is neither cannot
 * produce `added` or `worsened`, and `removed` is computed from baseline files
 * — all of which are in scope by construction. `scannedFiles` therefore keeps
 * reporting the **whole walk**, so the reported scan surface does not shrink
 * just because the scoring did. Callers pass `null` (the default) for the
 * whole-tree scan, which `--update` and `BASELINE_SCOPE=full` always do.
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
 * Diff current breach rows against the committed baseline.
 *
 * Four buckets, only the first two of which fail the gate:
 *
 *   - `added`    — a file whose over-ceiling function count rose (including
 *                  0 → 1, i.e. a brand-new breach in new or changed code).
 *   - `worsened` — a file whose worst function got worse than recorded.
 *   - `removed`  — a file that no longer breaches at all.
 *   - `improved` — a file that breaches less than recorded.
 *
 * Pure; identity is the repo-relative file path.
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
 * Assemble the committed baseline envelope. The rollup is deliberately
 * derived, never hand-written: a zero-row baseline here reports zero breaches
 * because the repository has none, not because nobody produced it.
 *
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
 * Render the human-readable diff. Emits a summary line even on a clean run so
 * operators see the "no drift" signal rather than silence.
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
