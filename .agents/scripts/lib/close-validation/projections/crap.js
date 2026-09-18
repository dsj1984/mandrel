// .agents/scripts/lib/close-validation/projections/crap.js
/**
 * Advisory pre-merge CRAP projection: names the methods the post-merge tree
 * would breach and the `crap:update` + `baseline-refresh:` remedy
 * (`check-baselines` already gates the real regression). Never throws;
 * failures resolve to `{ ok: true, breaches: [], skipped }`. Scores the
 * worktree (CRAP needs a coverage join), which at the branch tip is exactly
 * what a clean squash-merge lands.
 */

import path from 'node:path';
import {
  compareCrap,
  filterRowsByFileScope,
} from '../../baselines/kinds/crap.js';
import { loadFile as loadBaselineFile } from '../../baselines/reader.js';
import { diffNameOnly } from '../../changed-files.js';
import { loadCoverage } from '../../coverage-utils.js';
import { scanAndScore } from '../../crap-utils.js';
import { cachedGitFetchSync } from '../../git/cached-fetch.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { SCORABLE_SOURCE_EXT_RE } from '../../source-extensions.js';
import { MISSING_ARG_REASONS, validateProjectionInputs } from './inputs.js';

/** Absorbs floating-point noise. */
export const DEFAULT_CRAP_TOLERANCE = 0.001;

export const DEFAULT_NEW_METHOD_CEILING = 30;

/**
 * Collapse `missing-*` to `missing-args`, matching the MI projection.
 *
 * @param {string} reason
 * @returns {string}
 */
function normaliseSkipReason(reason) {
  return MISSING_ARG_REASONS.has(reason) ? 'missing-args' : reason;
}

/**
 * Re-keys on-disk `path` to the `file` field `compareCrap` matches on;
 * `[]` when absent or unreadable.
 *
 * @param {string} baselinePath
 * @returns {Array<{file: string, method: string, startLine: number, crap: number}>}
 */
function loadCrapBaselineRows(baselinePath) {
  let envelope;
  try {
    envelope = loadBaselineFile(baselinePath, { kind: 'crap' });
  } catch {
    return [];
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  return rows.map((row) => ({
    file: row.path,
    method: row.method,
    startLine: row.startLine,
    crap: row.crap,
  }));
}

/**
 * The scorer resolves `null` when coverage is missing under
 * `requireCoverage` (a `no-coverage` skip, not a clean run).
 *
 * @param {{
 *   cwd: string,
 *   targetDirs?: string[],
 *   ignoreGlobs?: string[],
 *   requireCoverage?: boolean,
 *   coveragePath?: string,
 * }} opts
 * @returns {(files: string[]) => Promise<Array<object>|null>}
 */
export function createCrapScorer({
  cwd,
  targetDirs = [],
  ignoreGlobs = [],
  requireCoverage = true,
  coveragePath = 'coverage/coverage-final.json',
} = {}) {
  return async (files) => {
    const abs = path.isAbsolute(coveragePath)
      ? coveragePath
      : path.resolve(cwd, coveragePath);
    const coverage = loadCoverage(abs);
    if (!coverage && requireCoverage) return null;
    const { rows } = await scanAndScore({
      targetDirs,
      coverage,
      requireCoverage,
      cwd,
      ignoreGlobs,
      scopeFiles: files,
    });
    return rows ?? [];
  };
}

/**
 * Close may not have base-synced yet; the fetch cache makes this free when
 * story-init already fetched.
 *
 * @param {string} cwd
 * @param {string} baseBranch
 * @param {{ gitSpawn: typeof defaultGitSpawn }} git
 * @returns {{ ok: true } | { ok: false, detail: string }}
 */
function refreshBaseRef(cwd, baseBranch, git) {
  const res = cachedGitFetchSync(cwd, baseBranch, { gitSpawn: git.gitSpawn });
  if (res.status !== 0) {
    return {
      ok: false,
      detail: res.stderr || res.stdout || `exit ${res.status}`,
    };
  }
  return { ok: true };
}

/**
 * @param {{ cwd: string, baseBranch: string, storyBranch: string, git: { gitSpawn: typeof defaultGitSpawn } }} opts
 * @returns {{ ok: true, files: string[] } | { ok: false, detail: string }}
 */
function diffScorableFiles({ cwd, baseBranch, storyBranch, git }) {
  try {
    const files = diffNameOnly({
      range: `origin/${baseBranch}...${storyBranch}`,
      cwd,
      gitSpawn: git.gitSpawn,
    });
    return {
      ok: true,
      files: files.filter((f) => SCORABLE_SOURCE_EXT_RE.test(f)),
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/**
 * Breaches are vs the baseline row, or `newMethodCeiling` for new methods.
 * Baseline rows are narrowed to changed files so untouched rows do not read
 * as removed.
 *
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   baselinePath: string,
 *   newMethodCeiling?: number,
 *   tolerance?: number,
 *   git?: { gitSpawn: typeof defaultGitSpawn },
 *   loadBaseline?: (path: string) => Array<object>,
 *   scoreFiles?: (files: string[]) => Promise<Array<object>|null>|Array<object>|null,
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   breaches: Array<object>,
 *   skipped?: string,
 *   detail?: string,
 * }>}
 */
export async function projectCrapBreaches({
  cwd,
  baseBranch,
  storyBranch,
  baselinePath,
  newMethodCeiling = DEFAULT_NEW_METHOD_CEILING,
  tolerance = DEFAULT_CRAP_TOLERANCE,
  git = { gitSpawn: defaultGitSpawn },
  loadBaseline = loadCrapBaselineRows,
  scoreFiles,
} = {}) {
  const skip = (reason, detail) => ({
    ok: true,
    breaches: [],
    skipped: reason,
    ...(detail === undefined ? {} : { detail }),
  });

  const validation = validateProjectionInputs({
    cwd,
    baseBranch,
    storyBranch,
    baselinePath,
  });
  if (!validation.ok) return skip(normaliseSkipReason(validation.reason));

  const baselineRows = loadBaseline(baselinePath);
  if (!Array.isArray(baselineRows) || baselineRows.length === 0) {
    return skip('no-baseline');
  }

  const fetched = refreshBaseRef(cwd, baseBranch, git);
  if (!fetched.ok) return skip('fetch-failed', fetched.detail);

  const diffed = diffScorableFiles({ cwd, baseBranch, storyBranch, git });
  if (!diffed.ok) return skip('diff-failed', diffed.detail);
  if (diffed.files.length === 0) return skip('no-scorable-files');

  const scorer =
    typeof scoreFiles === 'function' ? scoreFiles : createCrapScorer({ cwd });
  let currentRows;
  try {
    currentRows = await scorer(diffed.files);
  } catch (err) {
    return skip('score-failed', err?.message ?? String(err));
  }
  if (currentRows === null || currentRows === undefined) {
    return skip('no-coverage');
  }
  if (currentRows.length === 0) return skip('no-scored-methods');

  const scopeSet = new Set(diffed.files);
  const result = compareCrap({
    currentRows,
    baselineRows: filterRowsByFileScope(baselineRows, scopeSet),
    newMethodCeiling,
    tolerance,
  });
  const breaches = result.violations ?? [];
  return { ok: breaches.length === 0, breaches };
}

/**
 * @param {object} b
 * @returns {string}
 */
function formatBreach(b) {
  const where = `${b.file}::${b.method} (line ${b.startLine})`;
  const projected = Number(b.crap ?? 0).toFixed(2);
  if (b.kind === 'new') {
    return `  • ${where}  projected=${projected}  ceiling=${b.ceiling}  [new method]`;
  }
  const baseline = Number(b.baseline ?? 0).toFixed(2);
  return `  • ${where}  projected=${projected}  baseline=${baseline}  [${b.kind}]`;
}

/**
 * `null` when there is nothing to surface.
 *
 * @param {Awaited<ReturnType<typeof projectCrapBreaches>>} result
 * @returns {string | null}
 */
export function formatCrapProjection(result) {
  if (!result || !Array.isArray(result.breaches)) return null;
  if (result.breaches.length === 0) return null;
  const lines = [
    `[close-validation] ⚠ Pre-merge CRAP projection: ${result.breaches.length} method(s) would breach post-merge:`,
  ];
  for (const b of result.breaches) lines.push(formatBreach(b));
  lines.push(
    '[close-validation]   To land cleanly, run `npm run crap:update` and commit the refreshed baseline with a `baseline-refresh:` tagged subject (non-empty body) on the story branch before re-running close.',
  );
  return lines.join('\n');
}
