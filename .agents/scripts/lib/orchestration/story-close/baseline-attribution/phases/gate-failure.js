/**
 * gate-failure.js — phase 4 of baseline-attribution.
 *
 * The per-failure classifier wired between the close-validation gate chain
 * and the rest of the baseline-attribution pipeline:
 *
 *   - `handleBaselineGateFailure` — given a baseline-style gate name and
 *     its projected regressions, classify the drift against the Story's
 *     diff and either refresh-and-retry, post a friction comment, or
 *     rethrow.
 *
 * The bounded retry driver that wraps this classifier
 * (`runPreMergeGatesWithAttribution`) lives in the sibling
 * `pre-merge-attribution.js` (split out under refs #3685 so each module
 * scores at or above the maintainability floor).
 */

import fs from 'node:fs';
import { refreshBaseline as defaultRefreshBaseline } from '../../../../baselines/refresh-service.js';
import { gitSpawn as defaultGitSpawn } from '../../../../git-utils.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../../../ticketing.js';
import { classifyBaselineDrift as defaultClassifyBaselineDrift } from '../../baseline-attribution.js';
import { renderBaselineFrictionBody as defaultRenderBaselineFrictionBody } from '../../baseline-friction-body.js';
import { buildKindScorer, runRefreshCommit } from './refresh-commit.js';
import { computeStoryDiffPaths } from './scope-discovery.js';

/**
 * Map gate names → metadata used to project regressions and refresh the
 * baseline. Only baseline-style gates appear here; non-baseline gates
 * (typecheck, lint, test, format) fall through and the orchestrator
 * re-throws the original gate error.
 *
 * Story #2205 — the `refreshCmd` shell-out is gone. Each gate now declares
 * the `kind` (matching `refreshBaseline`'s supported kinds) and the
 * timeout block is retained as informational metadata only.
 */
export const DEFAULT_GATE_REGISTRY = {
  'check-maintainability': {
    kind: 'maintainability',
    baselineHint: 'maintainability',
    timeoutBlockKey: 'maintainability',
  },
  'check-crap': {
    kind: 'crap',
    baselineHint: 'crap',
    timeoutBlockKey: 'crap',
  },
};

/**
 * Top-level: handle a baseline gate failure by classifying drift and
 * either auto-refreshing (attributable-only) or posting friction (any
 * non-attributable). Non-baseline gates short-circuit with `{ action:
 * 'rethrow' }` and the caller re-throws the original gate error so
 * compile/lint/test failures still hard-fail the close.
 *
 * @param {object} input
 * @param {string} input.gateName
 * @param {Array<{ path?: string, file?: string }>} input.regressions
 * @param {string} input.cwd Worktree path (where refresh + commit run).
 * @param {string} input.epicBranch e.g. `epic/1114` (no `origin/` prefix).
 * @param {string} input.storyBranch e.g. `story-1124`.
 * @param {number|string} input.storyId
 * @param {number|string} input.epicId
 * @param {object} input.provider Ticketing provider for friction post.
 * @param {{ refreshedKinds?: Set<string>, lastRefreshSha?: string|null } | null} [input.cycleState]
 * @param {object} [input.gateRegistry]
 * @param {object} [input.deps] Injected seams for tests.
 * @returns {Promise<{
 *   action: 'refreshed' | 'blocked' | 'rethrow',
 *   sha?: string,
 *   skipped?: boolean,
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
  config,
  provider,
  cycleState = null,
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
  const refreshBaseline = deps.refreshBaseline ?? defaultRefreshBaseline;
  const scorerBuilder = deps.scorerBuilder ?? buildKindScorer;
  const fsImpl = deps.fsImpl ?? fs;
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
      deps.logger?.warn?.(
        `[baseline-attribution-wiring] failed to upsert friction comment: ${err?.message ?? err}`,
      );
    }
    return { action: 'blocked', nonAttributable, commentId };
  }

  if (attributable.length === 0) return { action: 'rethrow' };

  const refresh = await runRefreshCommit({
    cwd,
    kind: meta.kind,
    storyId,
    epicBranch,
    storyBranch,
    config,
    cycleState,
    refreshBaseline,
    scorerBuilder,
    fsImpl,
    gitRunner,
    logger: deps.logger,
  });
  if (!refresh.ok) {
    return { action: 'rethrow', error: refresh.error };
  }
  return {
    action: 'refreshed',
    sha: refresh.sha,
    skipped: refresh.skipped === true,
    reason: refresh.reason,
  };
}
