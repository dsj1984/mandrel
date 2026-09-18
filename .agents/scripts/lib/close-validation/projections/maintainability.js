// .agents/scripts/lib/close-validation/projections/maintainability.js
/**
 * Advisory pre-merge MI projection: names files that would breach their
 * per-file baseline so a `baseline-refresh:` commit can ship with the PR.
 */

import { getBaseline } from '../../baselines/maintainability-baseline-io.js';
import { diffNameOnly } from '../../changed-files.js';
import { cachedGitFetchSync } from '../../git/cached-fetch.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { calculateForSource } from '../../maintainability-engine.js';
import { MISSING_ARG_REASONS, validateProjectionInputs } from './inputs.js';

/** Absorbs floating-point noise. */
export const DEFAULT_MI_TOLERANCE = 0.001;

/**
 * Collapse `missing-*` to the public `missing-args` reason.
 *
 * @param {string} reason
 * @returns {string}
 */
function normaliseSkipReason(reason) {
  return MISSING_ARG_REASONS.has(reason) ? 'missing-args' : reason;
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
function refreshEpicRef(cwd, baseBranch, git) {
  const fetchRes = cachedGitFetchSync(cwd, baseBranch, {
    gitSpawn: git.gitSpawn,
  });
  if (fetchRes.status !== 0) {
    return {
      ok: false,
      detail: fetchRes.stderr || fetchRes.stdout || `exit ${fetchRes.status}`,
    };
  }
  return { ok: true };
}

/**
 * @param {{ cwd: string, baseBranch: string, storyBranch: string, git: { gitSpawn: typeof defaultGitSpawn } }} opts
 * @returns {{ ok: true, files: string[] } | { ok: false, detail: string }}
 */
function diffChangedFiles({ cwd, baseBranch, storyBranch, git }) {
  try {
    const files = diffNameOnly({
      range: `origin/${baseBranch}...${storyBranch}`,
      cwd,
      gitSpawn: git.gitSpawn,
    });
    return { ok: true, files };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

/**
 * `null` when deleted on the story branch or within tolerance.
 *
 * @param {{
 *   cwd: string,
 *   storyBranch: string,
 *   file: string,
 *   baselineScore: number,
 *   tolerance: number,
 *   git: { gitSpawn: typeof defaultGitSpawn },
 *   scoreSource: (source: string) => number,
 * }} opts
 * @returns {{ file: string, projected: number, baseline: number, drop: number } | null}
 */
function scoreFile({
  cwd,
  storyBranch,
  file,
  baselineScore,
  tolerance,
  git,
  scoreSource,
}) {
  const show = git.gitSpawn(cwd, 'show', `${storyBranch}:${file}`);
  if (show.status !== 0) return null; // deleted/renamed on the story branch
  const projected = scoreSource(show.stdout || '');
  if (projected >= baselineScore - tolerance) return null;
  return {
    file,
    projected,
    baseline: baselineScore,
    drop: baselineScore - projected,
  };
}

/**
 * @param {{
 *   cwd: string,
 *   storyBranch: string,
 *   files: string[],
 *   baseline: Record<string, number>,
 *   tolerance: number,
 *   git: { gitSpawn: typeof defaultGitSpawn },
 *   scoreSource: (source: string) => number,
 * }} opts
 * @returns {Array<{ file: string, projected: number, baseline: number, drop: number }>}
 */
function collectRegressions({
  cwd,
  storyBranch,
  files,
  baseline,
  tolerance,
  git,
  scoreSource,
}) {
  const regressions = [];
  for (const file of files) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const baselineScore = baseline[file];
    if (typeof baselineScore !== 'number') continue;
    const reg = scoreFile({
      cwd,
      storyBranch,
      file,
      baselineScore,
      tolerance,
      git,
      scoreSource,
    });
    if (reg) regressions.push(reg);
  }
  return regressions;
}

/**
 * Scores each changed file's content at the Story branch tip (exact for a
 * clean merge). Never throws; failures resolve to
 * `{ ok: true, regressions: [], skipped }`.
 *
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   baselinePath: string,
 *   tolerance?: number,
 *   git?: { gitSpawn: typeof defaultGitSpawn },
 *   scoreSource?: (source: string) => number,
 *   loadBaseline?: (path: string) => Record<string, number>,
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   regressions: Array<{ file: string, projected: number, baseline: number, drop: number }>,
 *   skipped?: string,
 *   detail?: string,
 * }}
 */
export function projectMaintainabilityRegressions({
  cwd,
  baseBranch,
  storyBranch,
  baselinePath,
  tolerance = DEFAULT_MI_TOLERANCE,
  git = { gitSpawn: defaultGitSpawn },
  scoreSource = calculateForSource,
  loadBaseline = getBaseline,
} = {}) {
  const validation = validateProjectionInputs(
    { cwd, baseBranch, storyBranch, baselinePath },
    { loadBaseline },
  );
  if (!validation.ok) {
    return {
      ok: true,
      regressions: [],
      skipped: normaliseSkipReason(validation.reason),
    };
  }

  const fetchOutcome = refreshEpicRef(cwd, baseBranch, git);
  if (!fetchOutcome.ok) {
    return {
      ok: true,
      regressions: [],
      skipped: 'fetch-failed',
      detail: fetchOutcome.detail,
    };
  }

  const diffOutcome = diffChangedFiles({ cwd, baseBranch, storyBranch, git });
  if (!diffOutcome.ok) {
    return {
      ok: true,
      regressions: [],
      skipped: 'diff-failed',
      detail: diffOutcome.detail,
    };
  }

  const regressions = collectRegressions({
    cwd,
    storyBranch,
    files: diffOutcome.files,
    baseline: validation.baseline,
    tolerance,
    git,
    scoreSource,
  });

  return { ok: regressions.length === 0, regressions };
}

/**
 * `null` when there is nothing to surface.
 *
 * @param {ReturnType<typeof projectMaintainabilityRegressions>} result
 * @returns {string | null}
 */
export function formatMaintainabilityProjection(result) {
  if (!result || !Array.isArray(result.regressions)) return null;
  if (result.regressions.length === 0) return null;
  const lines = [
    `[close-validation] ⚠ Pre-merge MI projection: ${result.regressions.length} file(s) would breach baseline post-merge:`,
  ];
  for (const r of result.regressions) {
    lines.push(
      `  • ${r.file}  projected=${r.projected.toFixed(2)}  baseline=${r.baseline.toFixed(2)}  drop=-${r.drop.toFixed(2)}`,
    );
  }
  lines.push(
    '[close-validation]   To land cleanly, run `npm run maintainability:update` and commit the refreshed baseline with a `baseline-refresh:` tagged subject (non-empty body) on the story branch before re-running close.',
  );
  return lines.join('\n');
}
