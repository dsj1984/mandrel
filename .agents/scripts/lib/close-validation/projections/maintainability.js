// .agents/scripts/lib/close-validation/projections/maintainability.js
/**
 * maintainability.js — pre-merge MI ceiling projection helper.
 *
 * Extracted from close-validation.js (Story #1850) and refactored to use
 * the shared `validateProjectionInputs` predicate so the guard cascade
 * lives in exactly one place. Public contract is unchanged — the parent
 * `close-validation.js` re-exports this function and every existing call
 * site continues to import from there.
 *
 * The projection is advisory only: story-close logs it before the merge
 * runs so the operator sees, by name, the files that would breach their
 * per-file MI baseline post-merge and can ship a `baseline-refresh:`
 * commit atomically with the Story PR. The hard MI gate still runs at
 * pre-push time.
 */

import { getBaseline } from '../../baselines/maintainability-baseline-io.js';
import { diffNameOnly } from '../../changed-files.js';
import { cachedGitFetchSync } from '../../git/cached-fetch.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { calculateForSource } from '../../maintainability-engine.js';
import { MISSING_ARG_REASONS, validateProjectionInputs } from './inputs.js';

/**
 * Default tolerance shared with check-maintainability.js: small floating-
 * point variances must not register as a regression.
 */
export const DEFAULT_MI_TOLERANCE = 0.001;

/**
 * Map the predicate's fine-grained `missing-*` reason to the historical
 * `missing-args` skipped-reason so the public contract of
 * `projectMaintainabilityRegressions` is preserved byte-for-byte.
 *
 * @param {string} reason
 * @returns {string}
 */
function normaliseSkipReason(reason) {
  return MISSING_ARG_REASONS.has(reason) ? 'missing-args' : reason;
}

/**
 * Refresh `origin/<baseBranch>` so the diff range resolves even when the
 * close script hasn't reached its own pull/rebase step yet. Routed through
 * the shared `(cwd, ref, windowMs)` cache so a story-init fetch in the same
 * wave satisfies the projection without re-hitting origin.
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
 * Run `git diff --name-only` against the epic-branch fork point and parse
 * the changed-files list. Normalises Windows-style backslash paths to
 * forward slashes so the baseline lookup is platform-agnostic.
 *
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
 * Score a single changed file and return a regression record when the
 * projected MI breaches `baselineScore - tolerance`. Returns `null` when
 * the file is non-JS, absent from baseline, deleted on the story branch,
 * or within tolerance.
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
 * Walk the changed-files list and collect regression records.
 *
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
 * Project the post-merge maintainability scores for every file changed on
 * the Story branch relative to the Epic branch, and return the subset whose
 * projected score breaches the per-file baseline ceiling.
 *
 * Advisory only — the result is rendered as a log line by story-close
 * before the merge runs. The hard MI gate still runs at pre-push time via
 * the husky hook. The point of this projection is to surface the breach
 * **before** the merge so the operator can ship a `baseline-refresh:`
 * commit atomically with the Story PR rather than as a follow-on after the
 * push.
 *
 * The "post-merge body" of each file is approximated by the file content
 * at the tip of the Story branch — a `--no-ff` merge into the Epic branch
 * does not modify file contents, so this is exact when the merge applies
 * cleanly and a close-enough projection when it auto-resolves minor
 * conflicts.
 *
 * The helper never throws and never has side effects beyond running `git`
 * subcommands via the injected interface. Any failure path resolves to
 * `{ ok: true, regressions: [], skipped: '<reason>' }` so the caller
 * treats the advisory as best-effort.
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
 * Render the pre-merge MI advisory as a human-readable multi-line log
 * block. Returns `null` when there are no regressions to surface so
 * callers can `if` past the log call without a string-empty check.
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
