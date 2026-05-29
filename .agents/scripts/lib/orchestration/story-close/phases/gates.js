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
 * Story #2995 split the pre-merge body into a pure summarizer
 * (`summarizeGateResults`) plus a side-effecting emitter
 * (`emitGateOutcome`). `runPreMergeValidation` is now a thin sequencer:
 * it runs the format-autofix and attribution gate side effects, hands
 * the raw outcomes to the summarizer, and then routes through the
 * emitter. Output is byte-identical to the pre-refactor function.
 *
 * Public surface:
 *   - shouldSkipValidation(input)
 *   - summarizeGateResults(results)
 *   - emitGateOutcome(summary, ctx)
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
 * Pure aggregator over the raw outcomes produced by the close-validation
 * side effects (Story #2995 split). Consumes the format-autofix outcome
 * and the attribution-aware gate outcome, then classifies the combined
 * result into a verdict + blocker/advisory lists.
 *
 * Verdicts:
 *   - `'blocked-timeout'` — format-autofix spawn watchdog tripped, or the
 *     attribution gate chain itself returned `blocked-timeout`. The
 *     originating outcome is carried on the blocker entry so the emitter
 *     can return the canonical envelope verbatim.
 *   - `'blocked'`         — attribution gate chain reported baseline
 *     drift not attributable to the Story.
 *   - `'ok'`              — gates passed; the maintainability projection
 *     should be emitted and the gate envelope returned to the caller.
 *
 * Inputs are tolerated as `null`/`undefined` so callers that only ran a
 * subset of the chain (resume paths, partial mocks) get a deterministic
 * `'ok'` verdict instead of a thrown error.
 *
 * NO I/O. NO logger calls. NO label transitions. This function is the
 * unit-testable shape of the pre-merge decision.
 */
export function summarizeGateResults({
  formatAutofixOutcome = null,
  gateOutcome = null,
} = {}) {
  if (formatAutofixOutcome?.timedOut) {
    return {
      verdict: 'blocked-timeout',
      blockers: [
        {
          kind: 'format-autofix-timeout',
          formatAutofixOutcome,
        },
      ],
      advisories: [],
    };
  }
  if (gateOutcome?.status === 'blocked') {
    return {
      verdict: 'blocked',
      blockers: [
        {
          kind: 'baseline-drift',
          gateOutcome,
        },
      ],
      advisories: [],
    };
  }
  if (gateOutcome?.status === 'blocked-timeout') {
    return {
      verdict: 'blocked-timeout',
      blockers: [
        {
          kind: 'gate-timeout',
          gateOutcome,
        },
      ],
      advisories: [],
    };
  }
  return {
    verdict: 'ok',
    blockers: [],
    advisories: [],
    gateOutcome,
  };
}

/**
 * Side-effecting emitter: consumes a `summarizeGateResults` summary plus
 * the orchestration context and performs the actions implied by the
 * verdict (Story #2995 split).
 *
 * - `blocked-timeout` from format-autofix → return the canonical
 *   timeout envelope built from `formatAutofixOutcome`.
 * - `blocked` / `blocked-timeout` from the attribution gate chain →
 *   return the gate outcome verbatim (caller routes through
 *   `emitBaselineBlockedResult` / spawn-timeout handler).
 * - `ok` → emit the maintainability projection (Logger side effect) and
 *   return the gate outcome verbatim.
 *
 * Maintaining output byte-equivalence with the pre-refactor function is
 * the contract: the gate-outcome objects flow through unchanged.
 */
export function emitGateOutcome(summary, ctx) {
  if (summary.verdict === 'blocked-timeout') {
    const blocker = summary.blockers[0];
    if (blocker?.kind === 'format-autofix-timeout') {
      const fao = blocker.formatAutofixOutcome;
      return {
        status: 'blocked-timeout',
        gateName: 'format-autofix',
        exitCode: fao.exitCode ?? 124,
        spawnCmd: fao.writeCmdString ?? null,
        timeoutMs: fao.timeoutMs ?? null,
      };
    }
    return blocker?.gateOutcome ?? null;
  }
  if (summary.verdict === 'blocked') {
    return summary.blockers[0]?.gateOutcome ?? null;
  }
  // verdict === 'ok'
  emitMaintainabilityProjection({
    cwd: ctx.cwd,
    epicBranch: ctx.epicBranch,
    storyBranch: ctx.storyBranch,
    config: ctx.config,
    logger: Logger,
  });
  return summary.gateOutcome;
}

/**
 * Run the close-validation gate chain against the Story worktree. The
 * format-autofix self-heal step runs first (Story #2165 — bounded
 * timeout) and short-circuits the chain when the formatter spawn is
 * SIGKILLed. Otherwise the attribution-aware gate chain runs.
 *
 * Story #2995 split this body into a pure summarizer
 * (`summarizeGateResults`) + a side-effecting emitter
 * (`emitGateOutcome`). This function is now a thin sequencer.
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
  // zero diffs on the changed-file set. The scoped step is a strict
  // pre-pass to the whole-tree `runFormatAutofix` below — never a
  // replacement: the whole-tree heal still runs unconditionally and
  // covers files (JSON/YAML/config) outside the changed-file set. The
  // scoped step is skipped only when a resume caller cannot supply both
  // branch refs (the `epicBranch...storyBranch` diff has no anchor), in
  // which case the whole-tree heal alone keeps the close correct.
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
    const summary = summarizeGateResults({ formatAutofixOutcome });
    return emitGateOutcome(summary, {
      cwd,
      epicBranch,
      storyBranch,
      config,
    });
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
  const summary = summarizeGateResults({
    formatAutofixOutcome,
    gateOutcome,
  });
  return emitGateOutcome(summary, {
    cwd,
    epicBranch,
    storyBranch,
    config,
  });
}
