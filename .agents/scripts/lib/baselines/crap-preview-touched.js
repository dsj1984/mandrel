/**
 * `crap.previewScope: touched-methods`: which regressions the preview judges,
 * from the hunks of the diff against the base; and the preview's own absence
 * when no fresh artifact exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_CAPTURE_DEFAULTS } from '../config/gates/coverage.schema.js';
import { loadCoverage } from '../coverage-utils.js';
import { COORDINATE_ORIGINAL } from '../crap-coordinates.js';
import { KERNEL_VERSION, resolveEscomplexVersion } from '../crap-utils.js';
import { gitSpawn } from '../git-utils.js';
import {
  buildCrapReport,
  compareCrap,
  suppressVerdicts,
} from './kinds/crap.js';
import { isCaptureFresh } from './seat-missing.js';

function previewCoveragePath(crap) {
  return crap.coveragePath ?? COVERAGE_CAPTURE_DEFAULTS.coveragePath;
}

/** Why the artifact cannot be joined, or `null` when it matches the tree. */
function coverageAbsence(crap, targetDirs, cwd) {
  const coveragePath = previewCoveragePath(crap);
  if (isCaptureFresh({ coveragePath, targetDirs }, { cwd })) return null;
  return fs.existsSync(path.resolve(cwd, coveragePath))
    ? `${coveragePath} does not match the current tree`
    : `no coverage artifact at ${coveragePath}`;
}

/** The verdict-free report of a preview that scored nothing. */
function notRunResult({ reason, scope, diffRef, newMethodCeiling }) {
  const envelope = buildCrapReport({
    compareResult: compareCrap({ currentRows: [], baselineRows: [] }),
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: resolveEscomplexVersion(),
    newMethodCeiling,
    scopeInfo: { scope, diffRef },
  });
  const diagnostic = {
    name: 'crap-coverage-not-fresh',
    message: `CRAP half did not run: ${reason}`,
  };
  return { exitCode: 0, envelope: suppressVerdicts(envelope, diagnostic) };
}

/** The not-run result when no artifact matches the tree, else `null`. */
function previewNotRun({ crap, targetDirs, cwd, scope, diffRef }) {
  const reason = coverageAbsence(crap, targetDirs, cwd);
  if (!reason) return null;
  const { newMethodCeiling } = crap;
  return notRunResult({ reason, scope, diffRef, newMethodCeiling });
}

/** The coverage to score, or the not-run result; a named artifact skips the stamp check. */
export function resolvePreviewCoverage({
  coverageArtifact,
  crap,
  cwd,
  ...rest
}) {
  if (coverageArtifact) return { coverage: loadCoverage(coverageArtifact) };
  const notRun = previewNotRun({ crap, cwd, ...rest });
  if (notRun) return { notRun };
  const configured = path.resolve(cwd, previewCoveragePath(crap));
  return { coverage: loadCoverage(configured) };
}

/**
 * New-side line ranges per file of a `-U0` diff. Hunk bodies are skipped by
 * count, so an added line reading `+++ b/x` opens no file.
 *
 * @param {string} text
 * @returns {Map<string, Array<[number, number]>>}
 */
function parseDiffHunks(text) {
  const hunks = new Map();
  let ranges = null;
  let body = 0;
  for (const line of text.split(/\r?\n/)) {
    if (body > 0) {
      body -= 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const file = /^\+\+\+ b\/(.+)$/.exec(line)?.[1];
      ranges = file ? [] : null;
      if (file) hunks.set(file, ranges);
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const [removed, start, added] = [m[1] ?? 1, m[2], m[3] ?? 1].map(Number);
    body = removed + added;
    // A pure deletion names the line before it.
    ranges?.push([start, start + Math.max(added - 1, 0)]);
  }
  return hunks;
}

/** The hunks of the diff from `ref`'s merge-base; `null` when unreadable. */
function readDiffHunks(ref, cwd, git) {
  const base = git(cwd, 'merge-base', ref, 'HEAD');
  if (base?.status !== 0) return null;
  const diff = git(
    cwd,
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    String(base.stdout).trim(),
  );
  return diff?.status === 0 ? parseDiffHunks(String(diff.stdout)) : null;
}

/**
 * The `compareCrap` predicate for `previewScope`. Fails closed: a row with
 * no original-coordinate span, or a file with no readable hunks, is judged.
 *
 * @returns {((row: object) => boolean)|undefined}
 */
export function resolveIsJudged({
  crap,
  diffRef,
  baseBranch,
  cwd,
  git = gitSpawn,
}) {
  if (crap.previewScope !== 'touched-methods') return undefined;
  const hunks = readDiffHunks(diffRef ?? `origin/${baseBranch}`, cwd, git);
  if (!hunks) return undefined;
  return (row) => {
    const ranges = hunks.get(row.file);
    if (
      !ranges ||
      row.coordinateSystem !== COORDINATE_ORIGINAL ||
      !Number.isFinite(row.endLine)
    ) {
      return true;
    }
    return ranges.some(([s, e]) => s <= row.endLine && e >= row.startLine);
  };
}

export function outsideDiffDiagnostics(informational) {
  return informational.map((v) => ({
    name: 'crap-regression-outside-diff',
    message: `informational: ${v.file}::${v.method} crap ${v.crap.toFixed(2)} > baseline ${v.baseline.toFixed(2)}, outside this diff's hunks`,
  }));
}
