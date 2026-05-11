/**
 * auto-refresh-runner.js — bounded baseline auto-refresh at story-close
 * (Story #1398, Epic #1386).
 *
 * Runs *after* `runPreMergeGatesWithAttribution` returns `{ status: 'ok' }`
 * and *before* the merge into `epic/<id>`. Regenerates the baseline rows
 * scoped to the Story diff, evaluates them against the bounded delta caps
 * via {@link evaluateAutoRefresh}, and either:
 *
 *   - **Under-cap path** — writes the regenerated rows to the on-disk
 *     baseline files, stages them, and amends them into HEAD on the Story
 *     branch (no separate `baseline-refresh:` commit). The merge commit
 *     subsumes the refresh; the Story PR's diff carries one fewer noisy
 *     `baseline-refresh:` row.
 *
 *   - **Over-cap path** — leaves the working tree alone (no baseline write,
 *     no commit) and appends a single `baseline-refresh-regression`
 *     friction signal to the per-Story NDJSON. The signal carries the
 *     offending file/method/delta rows so the operator can route the
 *     refresh to the right Story (or accept the regression manually).
 *
 *   - **Skipped paths** — `enabled: false` in `quality.autoRefresh`, no
 *     baseline-relevant changes in the Story diff (regen produces no rows),
 *     or every regenerated row matches the on-disk baseline byte-for-byte.
 *     The runner returns `{ status: 'skipped', reason }` without touching
 *     the working tree.
 *
 * Dedup contract (AC3 — idempotent re-run):
 *   On re-entry after an over-cap refusal, the runner scans the per-Story
 *   `signals.ndjson` for any prior `baseline-refresh-regression` signal
 *   tagged `source.tool === 'auto-refresh-runner'` and skips the append if
 *   one exists. The runner does not edit the on-disk file — it just doesn't
 *   write a duplicate. Two scenarios produce identical on-disk state:
 *
 *     - First run, over-cap → friction signal appended.
 *     - Second run, same caps + same diff → friction signal NOT re-appended.
 *
 *   The on-disk friction-signal file therefore carries one row per
 *   (story, refusal-cause) regardless of how many times story-close runs.
 *
 * The runner is dependency-injection-friendly: every git invocation, every
 * fs touch, the regen function, the evaluator, and the signal writer are
 * injectable seams. Production callers omit the seams; tests inject mocks.
 *
 * @see .agents/scripts/lib/auto-refresh-baselines.js (evaluator)
 * @see .agents/scripts/lib/baseline-snapshot.js (regenerateMainFromTree —
 *   the regen helper this runner adapts to the Story-diff scope)
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateAutoRefresh as defaultEvaluateAutoRefresh } from '../../auto-refresh-baselines.js';
import { regenerateMainFromTree as defaultRegenerateMainFromTree } from '../../baseline-snapshot.js';
import {
  getBaselines as defaultGetBaselines,
  getQuality as defaultGetQuality,
} from '../../config-resolver.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  appendSignal as defaultAppendSignal,
  forEachLine as defaultForEachLine,
} from '../../observability/signals-writer.js';
import { computeStoryDiffPaths } from './baseline-attribution-wiring.js';

const RUNNER_SOURCE_TOOL = 'auto-refresh-runner';
const FRICTION_CATEGORY = 'baseline-refresh-regression';

/**
 * Read one of the tracked baseline JSON files and return the parsed rows
 * shaped for {@link evaluateAutoRefresh}. The MI baseline is a flat
 * `{ "<path>": <mi> }` object; the CRAP baseline is `{ rows: [...] }`.
 *
 * Returns `null` (not `[]`) when the file is missing or unreadable so the
 * caller can distinguish "no baseline yet" from "baseline empty". A missing
 * file means the Story is the first to commit to that baseline kind, in
 * which case every regenerated row is "new" and the evaluator returns
 * `canAutoRefresh: true` by construction (new rows never breach a cap).
 *
 * @param {{ kind: 'mi' | 'crap', baselinePath: string, fsImpl?: typeof fs }} args
 * @returns {Array<object> | null}
 */
function readBaselineRows({ kind, baselinePath, fsImpl = fs }) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    return null;
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(baselinePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (kind === 'mi') {
    if (!parsed || typeof parsed !== 'object') return [];
    const rows = [];
    for (const [p, mi] of Object.entries(parsed)) {
      if (p === '$schema') continue;
      if (typeof mi === 'number') rows.push({ path: p, mi });
    }
    return rows;
  }
  // crap
  return Array.isArray(parsed?.rows) ? parsed.rows : [];
}

/**
 * Filter regenerated baseline rows to the Story's diff footprint. The MI
 * baseline file always carries the *full* projection (the regen helper
 * always rewrites the whole file), so we filter by file path against the
 * Story diff set. The CRAP baseline is filtered by the row's `file` field.
 *
 * Empty `storyDiffPaths` (no diff vs `epic/<id>`) returns the input
 * unchanged so an interactive `story-close --skip-validation` re-run on a
 * branch that already merged still evaluates against every row.
 *
 * @param {{
 *   miRows: Array<{ path: string, mi: number }>,
 *   crapRows: Array<{ file: string, method: string, crap: number, startLine?: number }>,
 *   storyDiffPaths: string[],
 * }} args
 * @returns {{ mi: typeof args.miRows, crap: typeof args.crapRows }}
 */
function filterToStoryDiff({ miRows, crapRows, storyDiffPaths }) {
  if (!Array.isArray(storyDiffPaths) || storyDiffPaths.length === 0) {
    return { mi: miRows ?? [], crap: crapRows ?? [] };
  }
  const scope = new Set(storyDiffPaths);
  const mi = (miRows ?? []).filter((r) => scope.has(r.path));
  const crap = (crapRows ?? []).filter((r) => scope.has(r.file));
  return { mi, crap };
}

/**
 * Stage the on-disk baseline files (whichever the regen produced) and
 * `git commit --amend --no-edit` to fold them into HEAD on the Story
 * branch. Returns the post-amend SHA.
 *
 * Why amend rather than a fresh `baseline-refresh:` commit:
 *   - The Story PR's diff already shows every other Task commit on its own
 *     line; an amend keeps the close PR's commit graph clean.
 *   - The merge commit (`feat: ... (resolves #N)`) carries the refresh as
 *     part of the Story's payload — the close-validation gate sees the
 *     refresh on the Epic branch immediately, no `baseline-refresh:` row
 *     to filter out of `git log`.
 *
 * Pre-conditions enforced by the caller:
 *   - HEAD is the Story branch (story-close holds `withEpicMergeLock` and
 *     `merge-runner.js` already asserted branch identity at gate time).
 *   - At least one baseline file changed on disk (the runner's "skipped:
 *     idempotent" branch returns before this is invoked).
 *
 * Returns `{ ok: true, sha }` on success or `{ ok: false, error }` on the
 * first failed git invocation. The runner translates `ok: false` into
 * `status: 'failed'` so story-close surfaces the failure rather than
 * silently merging stale baselines.
 */
function amendBaselinesIntoHead({ cwd, baselineFiles, gitRunner }) {
  // Stage every baseline file the regen wrote. We add by name (not `-u`)
  // so an unrelated dirty file doesn't sneak into the amend. Paths are
  // POSIX-normalized — git expects forward slashes regardless of platform.
  for (const filePath of baselineFiles) {
    const rel = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath)
      : filePath;
    const posixRel = rel.split(path.sep).join('/');
    const addRes = gitRunner.gitSpawn(cwd, 'add', posixRel);
    if (addRes.status !== 0) {
      return {
        ok: false,
        error: `git add ${rel} failed: ${addRes.stderr || addRes.stdout}`,
      };
    }
  }

  // `--amend --no-edit` keeps the Task commit's subject + body untouched
  // and folds the staged baseline drift into its tree. The Story's last
  // commit subject (e.g. `feat(scope): … (resolves #task)`) is preserved.
  const amendRes = gitRunner.gitSpawn(
    cwd,
    'commit',
    '--amend',
    '--no-edit',
    '--allow-empty',
  );
  if (amendRes.status !== 0) {
    return {
      ok: false,
      error: `git commit --amend failed: ${amendRes.stderr || amendRes.stdout}`,
    };
  }

  const headRes = gitRunner.gitSpawn(cwd, 'rev-parse', '--short', 'HEAD');
  return {
    ok: true,
    sha: headRes.status === 0 ? (headRes.stdout || '').trim() : '',
  };
}

/**
 * Check whether a `baseline-refresh-regression` signal tagged with the
 * runner's `source.tool === 'auto-refresh-runner'` already exists in the
 * Story's signals stream. Backs the AC3 idempotent-re-run contract.
 *
 * Best-effort: a missing signals file or a stream read error returns
 * `false` (no prior signal) so the runner falls through to appending —
 * a duplicate signal is preferable to silently dropping the refusal.
 */
async function priorRefusalSignalExists({
  epicId,
  storyId,
  forEachLine = defaultForEachLine,
}) {
  let found = false;
  await forEachLine(epicId, storyId, (record) => {
    if (
      record &&
      typeof record === 'object' &&
      record.kind === 'friction' &&
      record.category === FRICTION_CATEGORY &&
      record?.source?.tool === RUNNER_SOURCE_TOOL
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * Compose the friction-signal record. Stable shape so the analyzer +
 * `diagnose-friction` pattern-matchers can pin against fixed inputs.
 */
function buildRefusalSignal({
  epicId,
  storyId,
  miOverCap,
  crapOverCap,
  refusalReasons,
  caps,
}) {
  return {
    kind: 'friction',
    timestamp: new Date().toISOString(),
    epicId,
    storyId,
    category: FRICTION_CATEGORY,
    source: { tool: RUNNER_SOURCE_TOOL },
    details: `Auto-refresh refused: ${refusalReasons.length} row(s) breach configured caps (miDropCap=${caps.miDropCap}, crapJumpCap=${caps.crapJumpCap}).`,
    refusalReasons,
    miOverCap,
    crapOverCap,
    caps: { miDropCap: caps.miDropCap, crapJumpCap: caps.crapJumpCap },
  };
}

/**
 * Top-level: run the bounded baseline auto-refresh after pre-merge gates
 * have passed. See module header for the under-cap / over-cap / skipped
 * contracts.
 *
 * @param {object} input
 * @param {string|number} input.storyId
 * @param {string|number} input.epicId
 * @param {string} input.cwd  Worktree path (where regen + amend run).
 * @param {string} input.epicBranch e.g. `epic/1386` (no `origin/` prefix).
 * @param {string} input.storyBranch e.g. `story-1398`.
 * @param {object} input.agentSettings  Resolved agent settings (from
 *   `resolveCloseInputs`); the runner reads
 *   `agentSettings.quality.autoRefresh` for `enabled` + caps.
 * @param {object} [input.deps] Injected seams for tests.
 * @returns {Promise<
 *   | { status: 'skipped', reason: string }
 *   | { status: 'amended', sha: string, files: string[] }
 *   | { status: 'refused', refusalReasons: string[], signalAppended: boolean, dedup: boolean, miOverCap: Array, crapOverCap: Array }
 *   | { status: 'failed', reason: string, detail?: string }
 * >}
 */
export async function runAutoRefresh({
  storyId,
  epicId,
  cwd,
  epicBranch,
  storyBranch,
  agentSettings,
  deps = {},
} = {}) {
  const logger = deps.logger ?? DefaultLogger;
  const getQuality = deps.getQuality ?? defaultGetQuality;
  const getBaselines = deps.getBaselines ?? defaultGetBaselines;
  const evaluateAutoRefresh =
    deps.evaluateAutoRefresh ?? defaultEvaluateAutoRefresh;
  const regenerateMainFromTree =
    deps.regenerateMainFromTree ?? defaultRegenerateMainFromTree;
  const gitRunner = deps.gitRunner ?? { gitSpawn: defaultGitSpawn };
  const fsImpl = deps.fsImpl ?? fs;
  const appendSignal = deps.appendSignal ?? defaultAppendSignal;
  const forEachLine = deps.forEachLine ?? defaultForEachLine;
  const computeDiffPaths = deps.computeStoryDiffPaths ?? computeStoryDiffPaths;
  // Allow tests to substitute a stub config wrapper.
  const config = { agentSettings };

  const quality = getQuality(config);
  const autoRefresh = quality?.autoRefresh;
  if (!autoRefresh || autoRefresh.enabled === false) {
    return { status: 'skipped', reason: 'disabled' };
  }
  const caps = {
    miDropCap: autoRefresh.miDropCap,
    crapJumpCap: autoRefresh.crapJumpCap,
  };

  // Capture the *current* on-disk baselines BEFORE regen so the evaluator
  // can compare regenerated vs. previously committed rows. The regen helper
  // overwrites these files in place.
  const baselines = getBaselines({ agentSettings: config.agentSettings });
  const miPath = baselines?.maintainability?.path;
  const crapPath = baselines?.crap?.path;
  const miAbs =
    typeof miPath === 'string' && miPath.length > 0
      ? path.isAbsolute(miPath)
        ? miPath
        : path.resolve(cwd, miPath)
      : null;
  const crapAbs =
    typeof crapPath === 'string' && crapPath.length > 0
      ? path.isAbsolute(crapPath)
        ? crapPath
        : path.resolve(cwd, crapPath)
      : null;

  const baselineMi = miAbs
    ? readBaselineRows({ kind: 'mi', baselinePath: miAbs, fsImpl })
    : null;
  const baselineCrap = crapAbs
    ? readBaselineRows({ kind: 'crap', baselinePath: crapAbs, fsImpl })
    : null;

  // Regenerate via the same helper /epic-deliver uses for post-merge
  // reconciliation. The helper writes the canonical envelope (sorted keys,
  // trailing newline) so a re-run with no real change is a byte-equal
  // no-op — the runner's idempotency rests on this property.
  let regen;
  try {
    regen = await regenerateMainFromTree({ cwd });
  } catch (err) {
    return {
      status: 'failed',
      reason: 'regen-threw',
      detail: err?.message ?? String(err),
    };
  }

  if (!regen?.didChange) {
    return { status: 'skipped', reason: 'no-baseline-drift' };
  }

  // Read the regenerated rows back from disk. We do NOT trust the regen
  // helper's in-memory result shape — disk is the source of truth for the
  // amend, and we want the evaluator to compare what's about to be
  // committed against what was previously committed.
  const scoredMi = miAbs
    ? readBaselineRows({ kind: 'mi', baselinePath: miAbs, fsImpl })
    : null;
  const scoredCrap = crapAbs
    ? readBaselineRows({ kind: 'crap', baselinePath: crapAbs, fsImpl })
    : null;

  // Default scope: 'diff' restricts evaluation to files the Story changed.
  // 'full' evaluates every regenerated row vs the previous baseline.
  const scope = autoRefresh.scope ?? 'diff';
  let scoped;
  if (scope === 'full') {
    scoped = { mi: scoredMi ?? [], crap: scoredCrap ?? [] };
  } else {
    const storyDiffPaths = computeDiffPaths({
      cwd,
      epicBranch,
      storyBranch,
      gitRunner,
    });
    scoped = filterToStoryDiff({
      miRows: scoredMi ?? [],
      crapRows: scoredCrap ?? [],
      storyDiffPaths,
    });
  }

  const verdict = evaluateAutoRefresh({
    scoredRows: scoped,
    baseline: { mi: baselineMi ?? [], crap: baselineCrap ?? [] },
    caps,
  });

  if (!verdict.canAutoRefresh) {
    // Over-cap → check for a prior refusal signal first to honour AC3
    // (idempotent re-run does not duplicate the friction signal).
    let dedup = false;
    try {
      dedup = await priorRefusalSignalExists({
        epicId,
        storyId,
        forEachLine,
      });
    } catch (err) {
      // Best-effort dedup — a stream read failure means we'll write a
      // possibly-duplicate signal, which is preferable to silently
      // dropping the refusal.
      logger.warn?.(
        `[auto-refresh-runner] dedup probe failed: ${err?.message ?? err}`,
      );
    }

    let signalAppended = false;
    if (!dedup) {
      const signal = buildRefusalSignal({
        epicId,
        storyId,
        miOverCap: verdict.miOverCap,
        crapOverCap: verdict.crapOverCap,
        refusalReasons: verdict.refusalReasons,
        caps,
      });
      try {
        signalAppended = await appendSignal({
          epicId,
          storyId,
          signal,
          config,
        });
      } catch (err) {
        logger.warn?.(
          `[auto-refresh-runner] friction signal append failed: ${err?.message ?? err}`,
        );
      }
    }

    // Roll back the on-disk baseline writes — we refused to amend, so the
    // working tree must match HEAD again. `git checkout HEAD -- <path>`
    // restores each baseline file to its committed state. Best-effort —
    // a checkout failure logs and continues; the merge will still see
    // dirty files but the amend never ran so the merge tree is unchanged.
    for (const filePath of [miAbs, crapAbs].filter(Boolean)) {
      const rel = path.isAbsolute(filePath)
        ? path.relative(cwd, filePath)
        : filePath;
      const posixRel = rel.split(path.sep).join('/');
      const res = gitRunner.gitSpawn(cwd, 'checkout', 'HEAD', '--', posixRel);
      if (res.status !== 0) {
        logger.warn?.(
          `[auto-refresh-runner] failed to restore ${rel} after refusal: ${res.stderr || res.stdout}`,
        );
      }
    }

    logger.info?.(
      `[auto-refresh-runner] refused — ${verdict.refusalReasons.length} cap breach(es); friction signal ${dedup ? 'already present (dedup)' : signalAppended ? 'appended' : 'append failed'}.`,
    );
    return {
      status: 'refused',
      refusalReasons: verdict.refusalReasons,
      signalAppended,
      dedup,
      miOverCap: verdict.miOverCap,
      crapOverCap: verdict.crapOverCap,
    };
  }

  // Under-cap → amend the regenerated baseline files into HEAD.
  const baselineFiles = [miAbs, crapAbs].filter(Boolean);
  const amend = amendBaselinesIntoHead({
    cwd,
    baselineFiles,
    gitRunner,
  });
  if (!amend.ok) {
    return { status: 'failed', reason: 'amend-failed', detail: amend.error };
  }
  logger.info?.(
    `[auto-refresh-runner] amended baseline drift into HEAD (${amend.sha}); no separate baseline-refresh: commit.`,
  );
  return { status: 'amended', sha: amend.sha, files: baselineFiles };
}

export {
  amendBaselinesIntoHead,
  buildRefusalSignal,
  FRICTION_CATEGORY,
  // exported for unit-test introspection
  filterToStoryDiff,
  priorRefusalSignalExists,
  RUNNER_SOURCE_TOOL,
  readBaselineRows,
};
