/**
 * baseline-attribution-wiring.js — glue between the close-validation gate
 * chain and the diff-based attribution classifier (Story #1124).
 *
 * `runPreMergeGates` throws on the first failed gate but does not surface
 * regression rows. For baseline gates (`check-maintainability`, `check-crap`)
 * the post-#1120 contract is to:
 *
 *   1. Compute the regressions list ourselves (the pre-merge MI projection
 *      already knows how — Story #874).
 *   2. Compute the Story's diff vs `epic/<id>` so the classifier can split
 *      attributable from non-attributable rows.
 *   3. If every regression is attributable, run the gate's refresh command
 *      (`npm run maintainability:update` / `npm run crap:update`) inside
 *      the worktree, stage the changed baseline file, and commit on the
 *      Story branch with a `baseline-refresh: ...` subject. The caller
 *      then re-runs the gate chain — drift is now committed, gate passes.
 *   4. If any regression is non-attributable, render the friction body
 *      (`renderBaselineFrictionBody`) and upsert it via
 *      `upsertStructuredComment`. Return a status that signals story-close
 *      to short-circuit with `{ status: 'blocked', phase: 'closing' }`.
 *
 * The wiring is gate-agnostic at the API level — every dependency is
 * injected — but ships with a default gate registry covering the two
 * baseline gates we own today. Adding a new baseline gate is a registry
 * append; the orchestration here doesn't change.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { projectMaintainabilityRegressions as defaultProjectMaintainabilityRegressions } from '../../close-validation.js';
import { getBaselines as defaultGetBaselines } from '../../config-resolver.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';
import { classifyBaselineDrift as defaultClassifyBaselineDrift } from './baseline-attribution.js';
import { renderBaselineFrictionBody as defaultRenderBaselineFrictionBody } from './baseline-friction-body.js';
import { runPreMergeGates as defaultRunPreMergeGates } from './pre-merge-validation.js';

/**
 * Map gate names → metadata used to project regressions and refresh the
 * baseline. Only baseline-style gates appear here; non-baseline gates
 * (typecheck, lint, test, format) fall through and the orchestrator
 * re-throws the original gate error.
 *
 * The `refreshCmd` shape is `{ cmd: string, args: string[] }` so the
 * caller can spawn it without re-parsing a shell string. Both `--prefix`-
 * style monorepo overrides and direct `node` invocations work.
 */
const DEFAULT_GATE_REGISTRY = {
  'check-maintainability': {
    refreshCmd: { cmd: 'npm', args: ['run', 'maintainability:update'] },
    refreshSubject: 'baseline-refresh: maintainability',
    baselineHint: 'maintainability',
  },
  'check-crap': {
    refreshCmd: { cmd: 'npm', args: ['run', 'crap:update'] },
    refreshSubject: 'baseline-refresh: crap',
    baselineHint: 'crap',
  },
};

/**
 * Compute repo-relative paths the Story branch changed vs `origin/<epicBranch>`.
 * Best-effort: a non-zero diff exit returns an empty array so the caller
 * conservatively treats every regression as non-attributable (the safer
 * default — the close blocks rather than absorbs sibling drift).
 */
export function computeStoryDiffPaths({
  cwd,
  epicBranch,
  storyBranch,
  gitRunner = { gitSpawn: defaultGitSpawn },
}) {
  if (!cwd || !epicBranch || !storyBranch) return [];
  const diff = gitRunner.gitSpawn(
    cwd,
    'diff',
    '--name-only',
    `origin/${epicBranch}...${storyBranch}`,
  );
  if (diff.status !== 0) return [];
  return (diff.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'));
}

/**
 * Run the gate's refresh command (`npm run maintainability:update`, etc.)
 * inside the supplied worktree, stage the resulting baseline drift, and
 * commit on the Story branch with the canonical `baseline-refresh: ...`
 * subject. Returns the new commit SHA (short) on success.
 *
 * The caller must already have asserted `cwd === worktreePath` is on the
 * Story branch — this helper does NOT re-check the branch. story-close.js
 * holds that invariant via `withEpicMergeLock`.
 *
 * @returns {{ ok: true, sha: string } | { ok: false, error: string }}
 */
export function runRefreshCommit({
  cwd,
  refreshCmd,
  refreshSubject,
  spawnSync = defaultSpawnSync,
  gitRunner = { gitSpawn: defaultGitSpawn },
}) {
  const refresh = spawnSync(refreshCmd.cmd, refreshCmd.args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if ((refresh.status ?? 1) !== 0) {
    return {
      ok: false,
      error: `refresh command "${refreshCmd.cmd} ${refreshCmd.args.join(' ')}" exited ${refresh.status}`,
    };
  }
  // Stage every modified path in the working tree — the refresh command
  // overwrites the baseline JSON file(s); restricting to a known glob
  // would silently drop new baselines a future gate adds.
  const addRes = gitRunner.gitSpawn(cwd, 'add', '-u');
  if (addRes.status !== 0) {
    return {
      ok: false,
      error: `git add -u failed: ${addRes.stderr || addRes.stdout}`,
    };
  }

  // Empty refresh diff is a real failure — the gate flagged regressions
  // but the refresh command produced no changes, which means our gate
  // model is out of sync with the refresh tooling. Surface it.
  const statusRes = gitRunner.gitSpawn(cwd, 'status', '--porcelain');
  if (statusRes.status !== 0 || (statusRes.stdout || '').trim().length === 0) {
    return {
      ok: false,
      error:
        'refresh command produced no diff — baseline gate would still fail',
    };
  }

  const commitRes = gitRunner.gitSpawn(cwd, 'commit', '-m', refreshSubject);
  if (commitRes.status !== 0) {
    return {
      ok: false,
      error: `git commit failed: ${commitRes.stderr || commitRes.stdout}`,
    };
  }
  const headRes = gitRunner.gitSpawn(cwd, 'rev-parse', '--short', 'HEAD');
  return {
    ok: true,
    sha: headRes.status === 0 ? (headRes.stdout || '').trim() : '',
  };
}

/**
 * Top-level: handle a baseline gate failure by classifying drift and
 * either auto-refreshing (attributable-only) or posting friction (any
 * non-attributable). Non-baseline gates short-circuit with `{ action:
 * 'rethrow' }` and the caller re-throws the original gate error so
 * compile/lint/test failures still hard-fail the close.
 *
 * @param {object} input
 * @param {string} input.gateName
 *   The failed gate's `name` (from `runPreMergeGates` error).
 * @param {Array<{ path?: string, file?: string }>} input.regressions
 *   Projected regression rows (e.g. from
 *   `projectMaintainabilityRegressions`). Empty array → `{ action: 'rethrow' }`
 *   so a baseline gate that failed for a non-regression reason
 *   (e.g. baseline file missing) bubbles up rather than being silently
 *   swallowed as "all attributable, refresh".
 * @param {string} input.cwd Worktree path (where refresh + commit run).
 * @param {string} input.epicBranch e.g. `epic/1114` (no `origin/` prefix).
 * @param {string} input.storyBranch e.g. `story-1124`.
 * @param {number|string} input.storyId
 * @param {number|string} input.epicId
 * @param {object} input.provider Ticketing provider for friction post.
 * @param {object} [input.gateRegistry]
 * @param {object} [input.deps] Injected seams for tests.
 * @returns {Promise<{
 *   action: 'refreshed' | 'blocked' | 'rethrow',
 *   sha?: string,
 *   nonAttributable?: Array,
 *   commentId?: number|string|null,
 * }>}
 */
export async function handleBaselineGateFailure({
  gateName,
  regressions,
  cwd,
  epicBranch,
  storyBranch,
  storyId,
  epicId,
  provider,
  gateRegistry = DEFAULT_GATE_REGISTRY,
  deps = {},
} = {}) {
  const meta = gateRegistry[gateName];
  if (!meta) return { action: 'rethrow' };
  if (!Array.isArray(regressions) || regressions.length === 0) {
    return { action: 'rethrow' };
  }

  const classify = deps.classifyBaselineDrift ?? defaultClassifyBaselineDrift;
  const renderBody =
    deps.renderBaselineFrictionBody ?? defaultRenderBaselineFrictionBody;
  const upsertComment =
    deps.upsertStructuredComment ?? defaultUpsertStructuredComment;
  const gitRunner = deps.gitRunner ?? { gitSpawn: defaultGitSpawn };
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const computePaths = deps.computeStoryDiffPaths ?? computeStoryDiffPaths;

  const storyDiffPaths = computePaths({
    cwd,
    epicBranch,
    storyBranch,
    gitRunner,
  });

  const epicRef = `origin/${epicBranch}`;
  const { attributable, nonAttributable } = classify({
    regressions,
    storyDiffPaths,
    epicRef,
    cwd,
    gitRunner,
  });

  if (nonAttributable.length > 0) {
    const body = renderBody({ rows: nonAttributable, epicId, storyId });
    let commentId = null;
    try {
      const res = await upsertComment(provider, storyId, 'friction', body);
      commentId = res?.commentId ?? null;
    } catch (err) {
      // The post failure is logged but does not flip the action — we
      // still want story-close to surface `blocked`, just without a
      // comment receipt the operator can link to.
      deps.logger?.warn?.(
        `[baseline-attribution-wiring] failed to upsert friction comment: ${err?.message ?? err}`,
      );
    }
    return { action: 'blocked', nonAttributable, commentId };
  }

  // All attributable → run the gate's refresh + commit on the Story branch.
  if (attributable.length === 0) return { action: 'rethrow' };
  const refresh = runRefreshCommit({
    cwd,
    refreshCmd: meta.refreshCmd,
    refreshSubject: meta.refreshSubject,
    spawnSync,
    gitRunner,
  });
  if (!refresh.ok) {
    return { action: 'rethrow', error: refresh.error };
  }
  return { action: 'refreshed', sha: refresh.sha };
}

export { DEFAULT_GATE_REGISTRY };

/**
 * Project the regression rows for the failed gate. Today only
 * `check-maintainability` has a projection helper (`projectMaintainabilityRegressions`);
 * `check-crap` falls through with an empty rows list, which makes
 * `handleBaselineGateFailure` re-throw — the existing crap hint chain still
 * surfaces.
 *
 * Exported so tests can pin the dispatch table without spawning `git`.
 *
 * @returns {Array<{ path: string }>}
 */
export function projectRegressionsForGate({
  gateName,
  cwd,
  epicBranch,
  storyBranch,
  settings,
  projectMaintainability = defaultProjectMaintainabilityRegressions,
  getBaselines = defaultGetBaselines,
}) {
  if (gateName !== 'check-maintainability') return [];
  const baselinePath = getBaselines({ agentSettings: settings })
    ?.maintainability?.path;
  if (!baselinePath) return [];
  const projection = projectMaintainability({
    cwd,
    epicBranch,
    storyBranch,
    baselinePath,
  });
  return projection?.regressions ?? [];
}

/**
 * Wrap `runPreMergeGates` with the Story #1124 baseline-attribution flow.
 *
 * On a baseline-gate failure (`check-maintainability` today; the registry
 * also covers `check-crap`) we project the regressions, classify them
 * against the Story's diff vs `epic/<id>`, and either:
 *
 *   - `refreshed` → attributable-only drift; the helper committed
 *     `baseline-refresh: ...` on the Story branch. We re-run the gate
 *     chain once (bounded retry) so the rest of the close sees a green
 *     pre-merge.
 *   - `blocked`   → at least one path the Story never touched failed.
 *     We've upserted a friction comment on the Story; return so
 *     `runStoryCloseLocked` short-circuits the close.
 *   - `rethrow`   → non-baseline gate, empty regressions, or refresh
 *     command itself failed. Re-throw the original gate error so the
 *     close fails loudly the way it always has.
 *
 * @returns {Promise<
 *   | { status: 'ok' }
 *   | { status: 'blocked', nonAttributable: Array, commentId: string|number|null }
 * >}
 */
export async function runPreMergeGatesWithAttribution({
  cwd,
  worktreePath,
  epicBranch,
  storyBranch,
  settings,
  storyId,
  epicId,
  useEvidence,
  phaseTimer,
  provider,
  // Injected for tests — production callers omit these.
  runPreMergeGates = defaultRunPreMergeGates,
  handleBaselineGateFailureFn = handleBaselineGateFailure,
  projectRegressionsFn = projectRegressionsForGate,
  logger = DefaultLogger,
  maxAttempts = 2,
} = {}) {
  let attempt = 0;
  // The worktree path is where every gate spawns + where attribution
  // commits land. When worktree isolation is off, the helper still
  // works against the main checkout via `cwd`.
  const gateCwd = worktreePath || cwd;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await runPreMergeGates({
        cwd,
        worktreePath,
        epicBranch,
        settings,
        storyId,
        epicId,
        useEvidence,
        phaseTimer,
        logger,
      });
      return { status: 'ok' };
    } catch (err) {
      const m = /failed at "([^"]+)"/.exec(err?.message ?? '');
      const gateName = m ? m[1] : null;
      const regressions = projectRegressionsFn({
        gateName,
        cwd: gateCwd,
        epicBranch,
        storyBranch,
        settings,
      });
      const outcome = await handleBaselineGateFailureFn({
        gateName,
        regressions,
        cwd: gateCwd,
        epicBranch,
        storyBranch,
        storyId,
        epicId,
        provider,
      });
      if (outcome.action === 'refreshed') {
        logger.info?.(
          `[baseline-attribution-wiring] baseline-refresh committed (${outcome.sha}); re-running pre-merge gates.`,
        );
        continue;
      }
      if (outcome.action === 'blocked') {
        return {
          status: 'blocked',
          nonAttributable: outcome.nonAttributable ?? [],
          commentId: outcome.commentId ?? null,
        };
      }
      // 'rethrow' — and any unexpected action — surfaces the original error.
      throw err;
    }
  }
  // Two attempts still failing → re-run so the throw propagates with the
  // canonical hint.
  await runPreMergeGates({
    cwd,
    worktreePath,
    epicBranch,
    settings,
    storyId,
    epicId,
    useEvidence,
    phaseTimer,
    logger,
  });
  return { status: 'ok' };
}
