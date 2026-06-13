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

// Story #1973 / Task #1985 — direct import from the maintainability per-kind
// module under `.agents/scripts/lib/baselines/kinds/`. Replaces the historical
// `child_process.spawn(node check-maintainability.js)` arm of this helper:
// the kernel-version label that used to come from the CLI's stdout is now
// resolved in-process from the per-kind module, and the test suite's
// no-spawn spy proves the projection path never reaches a per-kind CLI
// subprocess.
import * as maintainabilityKind from '../../baselines/kinds/maintainability.js';
import { buildDefaultGates as defaultBuildDefaultGates } from '../../close-validation/gates.js';
import {
  formatMaintainabilityProjection as defaultFormatMaintainabilityProjection,
  projectMaintainabilityRegressions as defaultProjectMaintainabilityRegressions,
} from '../../close-validation/projections/maintainability.js';
import { runCloseValidation as defaultRunCloseValidation } from '../../close-validation/runner.js';
import { getBaselines as defaultGetBaselines } from '../../config-resolver.js';
import { Logger as DefaultLogger } from '../../Logger.js';

/**
 * Story #2250 — lifecycle emits fire only when both a positive epicId and a
 * positive storyId are present (the schema requires both) and a bus exists.
 * Legacy resume fixtures pass `storyId: null` and must run without emits.
 * Story #4075 — extracted from `runPreMergeGates`.
 */
export function lifecycleEmitsActive({ epicId, storyId, bus }) {
  return (
    Number.isInteger(epicId) &&
    epicId > 0 &&
    Number.isInteger(storyId) &&
    storyId > 0 &&
    !!bus
  );
}

/**
 * Build the typed `PRE_MERGE_GATE_FAILED` Error from the first failed gate.
 * Story #2136 / Task #2143 — failure metadata is surfaced as typed Error
 * properties so callers (notably `runPreMergeGatesWithAttribution`)
 * pattern-match exit codes without parsing the human message; the message
 * format is preserved byte-for-byte so existing regex consumers keep
 * matching. Story #4075 — extracted from `runPreMergeGates`.
 */
export function buildGateFailureError({ gate, status, gateCwd }) {
  const err = new Error(
    `Pre-merge validation failed at "${gate.name}" (exit ${status})${gateCwd ? ` in ${gateCwd}` : ''}.` +
      (gate.hint ? ` ${gate.hint}` : ''),
  );
  err.code = 'PRE_MERGE_GATE_FAILED';
  err.gateName = gate.name;
  err.exitCode = status;
  err.gateCwd = gateCwd ?? null;
  return err;
}

/**
 * Run the pre-merge validation gate chain. On failure throws an `Error`
 * whose message embeds the first failed gate's name, exit code, hint, and
 * the working directory the gate ran in — the `runAsCli` boundary in
 * `story-close.js` maps the throw to `process.exit(1)`. (See Story #959 —
 * close-tail scripts must throw rather than route through the logger's
 * fatal sink, so a mocked `process.exit` cannot swallow the failure
 * silently.)
 *
 * Story #1120: pass `worktreePath` (`.worktrees/story-<id>/`) so every
 * gate runs against the Story branch's post-rebase tree, not the main
 * checkout. Without it, gate spawn falls back to `cwd` (the main
 * checkout) — the legacy single-tree path remains intact.
 *
 * `phaseTimer` may be omitted; when present, lint/test starts are timed.
 *
 * Story #2250 — the gate chain is the canonical close-validate sub-phase
 * of the close-tail; this helper emits `close-validate.start` /
 * `close-validate.end` events on the supplied lifecycle bus so the
 * lifecycle ledger captures the sub-phase boundary with non-zero
 * `durationMs`. On gate failure the helper also emits `story.blocked`
 * with a typed `close-validate-failed:<gateName>` reason BEFORE throwing
 * — the existing BlockerHandler listener (Story #2241 / Task #2246)
 * cascades that to `epic.blocked`, so a failed validator routes through
 * the lifecycle cascade rather than being silently swallowed by the
 * caller's try/catch. The throw shape is preserved byte-for-byte so the
 * regex consumers in `runPreMergeGatesWithAttribution` keep matching.
 */
export async function runPreMergeGates({
  cwd,
  worktreePath,
  epicBranch,
  config,
  storyId,
  epicId,
  useEvidence = true,
  phaseTimer,
  bus,
  now = Date.now,
  logger = DefaultLogger,
  buildDefaultGates = defaultBuildDefaultGates,
  runCloseValidation = defaultRunCloseValidation,
}) {
  // Epic #2646 Story C (Task #2700) — `bus` is a hard input. The
  // previous guarded `emitLifecycleSafe` helper that tolerated a null
  // bus is gone. The `emitsActive` outer guard below still skips emits
  // for legacy resume fixtures that pass `storyId: null` (those rows
  // have no Story-scoped lifecycle), but bus must be present.
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError(
      'runPreMergeGates: bus is required (object with emit()).',
    );
  }
  logger.info?.(
    `[close-validation] Running pre-merge gates (typecheck, lint, test, format, maintainability, crap, baselines)${worktreePath ? ` in ${worktreePath}` : ''}${epicBranch ? ` against baseline ref ${epicBranch}` : ''}...`,
  );
  // `buildDefaultGates` reads the canonical resolved config directly:
  // gate commands resolve from `project.commands` and the CRAP toggle
  // from `delivery.quality.gates.crap.enabled`.
  const gates = buildDefaultGates({ config, epicBranch });
  const gateCount = Array.isArray(gates) ? gates.length : 0;
  // Story #2250 — emit `close-validate.start` only when both an epicId
  // and a storyId are present; the schema requires both, and unit
  // fixtures that drive the helper with `storyId: null` (legacy resume
  // tests) must continue to operate without lifecycle observability.
  const emitsActive = lifecycleEmitsActive({ epicId, storyId, bus });
  const startedAt = typeof now === 'function' ? now() : Date.now();

  // Emit the `close-validate.end` boundary, plus the `story.blocked`
  // cascade trigger on failure (Story #2250). No-op when emits are
  // inactive (legacy resume fixtures with `storyId: null`).
  const emitEnd = async ({ ok, extra = {}, blockedReason } = {}) => {
    if (!emitsActive) return;
    const endedAt = typeof now === 'function' ? now() : Date.now();
    await bus.emit('close-validate.end', {
      epicId,
      storyId,
      ok,
      gateCount,
      ...extra,
      durationMs: Math.max(0, endedAt - startedAt),
    });
    if (blockedReason) {
      await bus.emit('story.blocked', { storyId, reason: blockedReason });
    }
  };

  if (emitsActive) {
    await bus.emit('close-validate.start', { epicId, storyId });
  }
  let validation;
  try {
    validation = await runCloseValidation({
      cwd,
      worktreePath,
      gates,
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
  } catch (err) {
    // Reach this branch only when `runCloseValidation` itself throws
    // (spawn-level catastrophe — the per-gate failures route through
    // `validation.failed` below). Emit the matching `close-validate.end`
    // with `ok:false` so the ledger always carries the boundary, then
    // re-throw.
    await emitEnd({
      ok: false,
      extra: { failedGate: 'runner-error' },
      blockedReason: 'close-validate-failed:runner-error',
    });
    throw err;
  }
  if (!validation.ok) {
    const { gate, status, cwd: gateCwd } = validation.failed[0];
    // Story #2250 — emit the boundary + `story.blocked` cascade BEFORE
    // throwing so the lifecycle ledger captures the boundary even when the
    // caller's try/catch swallows the throw, and the BlockerHandler
    // listener cascades to `epic.blocked`.
    await emitEnd({
      ok: false,
      extra: { failedGate: gate.name, exitCode: status },
      blockedReason: `close-validate-failed:${gate.name}`,
    });
    throw buildGateFailureError({ gate, status, gateCwd });
  }
  await emitEnd({ ok: true });
  return validation;
}

/**
 * Resolve the maintainability kernel version from the per-kind module so
 * the projection log header can name the kernel currently in scope. Reads
 * are best-effort — a sentinel `'0.0.0'` from the kernel-version
 * resolver (e.g. when typhonjs-escomplex is missing under a partial
 * install) collapses to `null` so the helper never injects a misleading
 * label into the log.
 *
 * Story #1973 / Task #1985 — this is the only call site outside the
 * `baselines/` tree that touches `kinds/maintainability.js` directly; the
 * import is the load-bearing acceptance hook for "no per-kind CLI spawn"
 * because referencing `kindModule.kernelVersion` proves the helper does
 * not need to fork a subprocess to learn what kernel it is running under.
 *
 * @param {object} kindModule - Per-kind maintainability module.
 * @returns {string | null}
 */
function resolveKernelLabel(kindModule) {
  try {
    const v = kindModule?.kernelVersion?.();
    if (typeof v !== 'string' || v === '0.0.0') return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Emit the per-file MI ceiling projection advisory. Failure is non-fatal
 * (logged through `logger.warn`) — the projection is informational only,
 * and a missing baseline path skips the helper entirely.
 *
 * Story #1973 / Task #1985 — the projection no longer fans out a
 * per-kind `child_process.spawn(node check-maintainability.js)` to learn
 * the kernel context: the per-kind module under `baselines/kinds/` is
 * imported directly. The `kindModule` collaborator is injectable so unit
 * tests can pin the kernel label without touching the on-disk module.
 */
export function emitMaintainabilityProjection({
  cwd,
  epicBranch,
  storyBranch,
  config,
  logger = DefaultLogger,
  getBaselines = defaultGetBaselines,
  projectMaintainabilityRegressions = defaultProjectMaintainabilityRegressions,
  formatMaintainabilityProjection = defaultFormatMaintainabilityProjection,
  kindModule = maintainabilityKind,
}) {
  try {
    const baselinePath = getBaselines(config)?.maintainability?.path;
    if (!baselinePath) return;
    const projection = projectMaintainabilityRegressions({
      cwd,
      epicBranch,
      storyBranch,
      baselinePath,
    });
    const advisory = formatMaintainabilityProjection(projection);
    if (advisory) {
      const kernel = resolveKernelLabel(kindModule);
      if (kernel) {
        logger.info(
          `[close-validation] Pre-merge MI projection (kernel=${kernel}):`,
        );
      }
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
