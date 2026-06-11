/**
 * pre-merge-attribution.js — phase 4 (retry driver) of baseline-attribution.
 *
 * Houses `runPreMergeGatesWithAttribution`, the public wrapper around
 * `runPreMergeGates` that drives the bounded retry loop. Extracted from
 * `gate-failure.js` (refs #3685) so the per-failure classifier
 * (`handleBaselineGateFailure`) and the retry driver each live in a
 * file that scores at or above the restored maintainability floor; the
 * two were previously fused in a single module whose aggregate volume
 * sat below 70.
 *
 * The retry loop wears a single mutable `cycleState` object so the
 * idempotency token enforces AC-9 (one refresh commit per kind per close
 * cycle).
 */

import { COVERAGE_TIMEOUT_EXIT_CODE } from '../../../../coverage-capture.js';
import { Logger as DefaultLogger } from '../../../../Logger.js';
import { runPreMergeGates as defaultRunPreMergeGates } from '../../pre-merge-validation.js';
import { handleBaselineGateFailure } from './gate-failure.js';
import { projectRegressionsForGate } from './regression-projection.js';

/**
 * Wrap `runPreMergeGates` with the Story #1124 baseline-attribution flow.
 *
 * On a baseline-gate failure we project the regressions, classify them
 * against the Story's diff vs `epic/<id>`, and either refresh-and-retry,
 * post a friction comment, or rethrow.
 *
 * Story #2205 — the retry-loop wears a single mutable `cycleState` object
 * carrying `refreshedKinds` (the idempotency token enforcing AC-9). Each
 * `runRefreshCommit` call short-circuits when its kind is already in that
 * set, so a fail-then-pass sequence emits at most one
 * `chore(baselines): refresh <kind> for story-<id>` commit per cycle.
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
  config,
  storyId,
  epicId,
  useEvidence,
  phaseTimer,
  provider,
  bus = null,
  runPreMergeGates = defaultRunPreMergeGates,
  handleBaselineGateFailureFn = handleBaselineGateFailure,
  projectRegressionsFn = projectRegressionsForGate,
  logger = DefaultLogger,
  maxAttempts = 2,
  cycleState: cycleStateParam = null,
} = {}) {
  let attempt = 0;
  const gateCwd = worktreePath || cwd;
  // Story #2205: single mutable cycle state object — `refreshedKinds`
  // gates the idempotency token enforcing AC-9 (one refresh commit per
  // kind per close cycle). Story #4017: the caller may thread the close
  // cycle's shared object so the post-gates auto-refresh sees the kinds
  // already refreshed by this retry loop and never re-scores them.
  const cycleState = cycleStateParam ?? {
    refreshedKinds: new Set(),
    lastRefreshSha: null,
  };
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await runPreMergeGates({
        cwd,
        worktreePath,
        epicBranch,
        config,
        storyId,
        epicId,
        useEvidence,
        phaseTimer,
        bus,
        logger,
      });
      return { status: 'ok' };
    } catch (err) {
      // Story #2136 / Task #2143 — short-circuit when coverage-capture
      // tripped the bounded-timeout watchdog (exit 124).
      const errGateName = err?.gateName ?? null;
      const errExitCode = err?.exitCode ?? null;
      if (
        errGateName === 'coverage-capture' &&
        errExitCode === COVERAGE_TIMEOUT_EXIT_CODE
      ) {
        return {
          status: 'blocked-timeout',
          gateName: errGateName,
          exitCode: errExitCode,
        };
      }
      const m = /failed at "([^"]+)"/.exec(err?.message ?? '');
      const gateName = m ? m[1] : null;
      const regressions = projectRegressionsFn({
        gateName,
        cwd: gateCwd,
        epicBranch,
        storyBranch,
        config,
      });
      const outcome = await handleBaselineGateFailureFn({
        gateName,
        regressions,
        cwd: gateCwd,
        epicBranch,
        storyBranch,
        storyId,
        epicId,
        config,
        provider,
        cycleState,
      });
      if (outcome.action === 'refreshed') {
        const verb = outcome.skipped
          ? `baseline-refresh skipped (${outcome.reason ?? 'no drift'})`
          : 'baseline-refresh committed';
        logger.info?.(
          `[baseline-attribution-wiring] ${verb} (${outcome.sha}); re-running pre-merge gates.`,
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
  // maxAttempts exhausted → re-run so the throw propagates with the
  // canonical hint.
  await runPreMergeGates({
    cwd,
    worktreePath,
    epicBranch,
    config,
    storyId,
    epicId,
    useEvidence,
    phaseTimer,
    bus,
    logger,
  });
  return { status: 'ok' };
}
