/**
 * pre-merge-validation.js — shift-left close-validation gate runner +
 * maintainability projection advisory.
 *
 * Extracted from story-close.js (Story #956, Theme A finishing touch) so the
 * close orchestrator becomes a thin CLI shell. Two responsibilities:
 *
 *   - runPreMergeGates       — drives `runCloseValidation` over the
 *                              canonical gate list (typecheck, lint, test,
 *                              format, maintainability, crap), routes
 *                              `lint`/`test` start events into the supplied
 *                              phase-timer, and throws on the first failed
 *                              gate with the gate-specific hint embedded in
 *                              the error message.
 *   - emitMaintainabilityProjection — runs the per-file MI ceiling projection
 *                              and emits the `baseline-refresh:` advisory
 *                              before the merge so the operator can ship the
 *                              refresh atomically with the Story PR.
 *
 * Both helpers take their dependencies as injectable seams so unit tests
 * pin behaviour without spawning the close script.
 */

import {
  buildDefaultGates as defaultBuildDefaultGates,
  formatMaintainabilityProjection as defaultFormatMaintainabilityProjection,
  projectMaintainabilityRegressions as defaultProjectMaintainabilityRegressions,
  runCloseValidation as defaultRunCloseValidation,
} from '../../close-validation.js';
import { getBaselines as defaultGetBaselines } from '../../config-resolver.js';
import { Logger as DefaultLogger } from '../../Logger.js';

/**
 * Run the pre-merge validation gate chain. On failure throws an `Error`
 * whose message embeds the first failed gate's name, exit code, hint, and
 * the working directory the gate ran in — the `runAsCli` boundary in
 * `story-close.js` maps the throw to `process.exit(1)`. (See Story #959 —
 * orchestration scripts must throw rather than route through the logger's
 * fatal sink, so a mocked `process.exit` cannot swallow the failure
 * silently.)
 *
 * Story #1120: pass `worktreePath` (`.worktrees/story-<id>/`) so every
 * gate runs against the Story branch's post-rebase tree, not the main
 * checkout. Without it, gate spawn falls back to `cwd` (the main
 * checkout) — the legacy single-tree path remains intact.
 *
 * `phaseTimer` may be omitted; when present, lint/test starts are timed.
 */
export function runPreMergeGates({
  cwd,
  worktreePath,
  settings,
  storyId,
  epicId,
  useEvidence = true,
  phaseTimer,
  logger = DefaultLogger,
  buildDefaultGates = defaultBuildDefaultGates,
  runCloseValidation = defaultRunCloseValidation,
}) {
  logger.info?.(
    `[close-validation] Running pre-merge gates (typecheck, lint, test, format, maintainability)${worktreePath ? ` in ${worktreePath}` : ''}...`,
  );
  const validation = runCloseValidation({
    cwd,
    worktreePath,
    gates: buildDefaultGates({ settings }),
    log: (m) => logger.info(m),
    onGateStart: (gate) => {
      // Only the canonical phase-enum gates drive `mark()`. Non-enum gates
      // (`typecheck`, `format`, `check-maintainability`) share the
      // currently-open phase's wall clock — a deliberate choice so the
      // `phase-timings` schema stays stable against future gate churn.
      if (phaseTimer && (gate.name === 'lint' || gate.name === 'test')) {
        phaseTimer.mark(gate.name);
      }
    },
    storyId,
    epicId,
    useEvidence,
  });
  if (!validation.ok) {
    const [first] = validation.failed;
    const { gate, status, cwd: gateCwd } = first;
    throw new Error(
      `Pre-merge validation failed at "${gate.name}" (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
        (gate.hint ? ` ${gate.hint}` : ''),
    );
  }
  return validation;
}

/**
 * Emit the per-file MI ceiling projection advisory. Failure is non-fatal
 * (logged through `logger.warn`) — the projection is informational only,
 * and a missing baseline path skips the helper entirely.
 */
export function emitMaintainabilityProjection({
  cwd,
  epicBranch,
  storyBranch,
  settings,
  logger = DefaultLogger,
  getBaselines = defaultGetBaselines,
  projectMaintainabilityRegressions = defaultProjectMaintainabilityRegressions,
  formatMaintainabilityProjection = defaultFormatMaintainabilityProjection,
}) {
  try {
    const baselinePath = getBaselines({ agentSettings: settings })
      ?.maintainability?.path;
    if (!baselinePath) return;
    const projection = projectMaintainabilityRegressions({
      cwd,
      epicBranch,
      storyBranch,
      baselinePath,
    });
    const advisory = formatMaintainabilityProjection(projection);
    if (advisory) {
      for (const line of advisory.split('\n')) logger.info(line);
    } else if (projection.skipped) {
      logger.info(
        `[close-validation] Pre-merge MI projection skipped (${projection.skipped}).`,
      );
    }
  } catch (err) {
    logger.warn?.(
      `[close-validation] Pre-merge MI projection failed: ${err?.message ?? err}`,
    );
  }
}
