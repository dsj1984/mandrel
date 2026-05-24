/**
 * phases/gates.js — pre-merge gates phase (Story #2460, Epic #2453 —
 * CLI thinning pilot).
 *
 * Runs the close-validation chain (format-autofix → attribution-aware
 * baseline gates → maintainability projection) against the Story
 * worktree before the merge. Outcomes:
 *
 *   - `{ status: 'ok' }`              — gates passed; caller continues.
 *   - `{ status: 'blocked' }`         — baseline drift not attributable
 *     to the Story; caller emits `emitBaselineBlockedResult`.
 *   - `{ status: 'blocked-timeout' }` — one of the bounded-timeout
 *     spawns tripped its watchdog; caller routes through
 *     `emitSpawnTimeoutBlockedResult`.
 *
 * Public surface:
 *   - shouldSkipValidation(input)
 *   - runPreMergeValidation(input)
 *   - emitBaselineBlockedResult(input)
 */

import { Logger } from '../../../Logger.js';
import { runPreMergeGatesWithAttribution } from '../baseline-attribution-wiring.js';
import { runFormatAutofix } from '../format-autofix.js';
import { runScopedFormatAutofix } from '../format-autofix-scoped.js';
import { emitStoryBlockedSafe } from '../merge-runner.js';
import { emitMaintainabilityProjection } from '../pre-merge-validation.js';

/**
 * Format the `{ status: 'blocked' }` result returned by
 * `runPreMergeGatesWithAttribution` into the canonical close-result
 * envelope + console marker (Story #1124 — non-attributable baseline
 * drift).
 */
export async function emitBaselineBlockedResult({
  storyId,
  gateOutcome,
  progress: log,
  bus = null,
}) {
  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: 'baseline-drift-not-attributable',
    nonAttributable: gateOutcome.nonAttributable ?? [],
    commentId: gateOutcome.commentId ?? null,
  };
  await emitStoryBlockedSafe({
    bus,
    storyId,
    reason: 'baseline-drift-not-attributable',
    logger: Logger,
  });
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  log(
    'BLOCKED',
    `Story #${storyId} blocked: baseline drift on ${result.nonAttributable.length} path(s) not attributable to this Story.`,
  );
  return result;
}

/**
 * Compute whether the pre-merge gate chain should be skipped on this
 * close. Resume-from-anywhere paths skip; an explicit `--skip-validation`
 * also skips.
 */
export function shouldSkipValidation({
  skipValidationParam,
  resumeFromConflict,
  resumeFromMerge,
  resumeFromPostMerge,
}) {
  return (
    !!skipValidationParam ||
    resumeFromConflict ||
    resumeFromMerge ||
    resumeFromPostMerge
  );
}

/**
 * Run the close-validation gate chain against the Story worktree. The
 * format-autofix self-heal step runs first (Story #2165 — bounded
 * timeout) and short-circuits the chain when the formatter spawn is
 * SIGKILLed. Otherwise the attribution-aware gate chain runs.
 *
 * Returns the gate envelope verbatim so the caller can route by
 * `status` (`blocked` vs `blocked-timeout` vs `ok`).
 */
export async function runPreMergeValidation({
  cwd,
  worktreePath,
  epicBranch,
  storyBranch,
  config,
  storyId,
  epicId,
  noEvidenceFlag,
  phaseTimer,
  provider,
  bus = null,
}) {
  // Story #2533: scope-narrowed biome-format auto-apply on the Epic→Story
  // diff *before* the whole-tree autofix runs. The scoped step folds
  // format drift introduced by Story commits into a dedicated
  // `fix(story-close):` commit on the Story branch and emits Logger.warn
  // naming the auto-fixed files, so the subsequent `biome ci` gate finds
  // zero diffs on the changed-file set. Skipped when epic/story branches
  // are not supplied (defensive: keeps the old whole-tree path intact for
  // resume callers that don't pass them).
  if (epicBranch && storyBranch) {
    runScopedFormatAutofix({
      cwd,
      storyId,
      epicBranch,
      storyBranch,
      config,
      logger: Logger,
    });
  }
  const formatAutofixOutcome = runFormatAutofix({
    cwd,
    storyId,
    config,
    logger: Logger,
  });
  if (formatAutofixOutcome?.timedOut) {
    return {
      status: 'blocked-timeout',
      gateName: 'format-autofix',
      exitCode: formatAutofixOutcome.exitCode ?? 124,
      spawnCmd: formatAutofixOutcome.writeCmdString ?? null,
      timeoutMs: formatAutofixOutcome.timeoutMs ?? null,
    };
  }
  const gateOutcome = await runPreMergeGatesWithAttribution({
    cwd,
    worktreePath,
    epicBranch,
    storyBranch,
    config,
    storyId,
    epicId,
    useEvidence: !noEvidenceFlag,
    phaseTimer,
    provider,
    bus,
  });
  if (gateOutcome?.status === 'blocked') return gateOutcome;
  if (gateOutcome?.status === 'blocked-timeout') return gateOutcome;
  emitMaintainabilityProjection({
    cwd,
    epicBranch,
    storyBranch,
    config,
    logger: Logger,
  });
  return gateOutcome;
}
