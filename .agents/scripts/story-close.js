#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-close.js — Story Execution Closure (CLI shell).
 *
 * Replaces Steps 5/5b/6 of epic-execute Mode B: validate, merge into
 * `epic/<id>` --no-ff, push, delete branches, transition Tasks/Story →
 * agent::done, refresh dashboard / health monitor. Merge orchestration,
 * pre-merge validation, post-merge pipeline, cleanup-reconciler, cd-out
 * guard, and input resolution live under `lib/orchestration/story-close/*`
 * (Stories #955 + #956); this file wires those modules.
 *
 * Usage: `node story-close.js --story <ID> [--epic <ID>]`. Exit codes:
 * 0 ok; 1 error; 2 prior-state (pass --resume / --restart).
 *
 * @see .agents/workflows/story-deliver.md
 */

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { runAutoRefresh } from './lib/orchestration/story-close/auto-refresh-runner.js';
import { runPreMergeGatesWithAttribution } from './lib/orchestration/story-close/baseline-attribution-wiring.js';
import { checkCdOutGuard } from './lib/orchestration/story-close/cd-out-guard.js';
import { resolveCloseInputs } from './lib/orchestration/story-close/close-inputs.js';
import { runFormatAutofix } from './lib/orchestration/story-close/format-autofix.js';
import {
  runFinalizeMerge,
  runResumeMerge,
  withEpicMergeLock,
} from './lib/orchestration/story-close/merge-runner.js';
import { runPostMergeClose } from './lib/orchestration/story-close/post-merge-close.js';
import { emitMaintainabilityProjection } from './lib/orchestration/story-close/pre-merge-validation.js';
import { dispatchRecovery } from './lib/orchestration/story-close-recovery.js';
import {
  PREFLIGHT_REFUSED_EXIT_CODE,
  runPreflight,
} from './lib/preflight-runner.js';
import { fetchChildTasks } from './lib/story-lifecycle.js';
import { createPhaseTimer } from './lib/util/phase-timer.js';
import {
  clearPhaseTimerState,
  loadPhaseTimerState,
} from './lib/util/phase-timer-state.js';
import { notify } from './notify.js';

// `checkCdOutGuard` is re-exported so tests/story-close-cd-out-guard.test.js
// keeps its `import { checkCdOutGuard } from '.../story-close.js'` surface.
export { checkCdOutGuard };

const progress = Logger.createProgress('story-close', { stderr: true });
const progressLog = (tag, msg) => progress(tag, msg);

/**
 * Format the `{ status: 'blocked' }` result returned by
 * `runPreMergeGatesWithAttribution` into the canonical close-result envelope
 * + console marker that `runStoryCloseLocked` returns when baseline drift
 * is not attributable to the running Story (Story #1124).
 */
function emitBaselineBlockedResult({ storyId, gateOutcome, progress: log }) {
  const result = {
    success: false,
    status: 'blocked',
    phase: 'closing',
    reason: 'baseline-drift-not-attributable',
    nonAttributable: gateOutcome.nonAttributable ?? [],
    commentId: gateOutcome.commentId ?? null,
  };
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
 * Run the story-close preflight gate. Exported so tests can drive it
 * with an inline registry / probe spies without re-entering the full
 * close orchestrator. Returns `{ ok: true }` on a clean preflight and
 * `{ ok: false, findings, fixed }` when at least one blocker survives —
 * the caller is responsible for translating `ok: false` into exit-code 2
 * (or, in test harnesses, returning a `{ status: 'blocked' }` envelope).
 *
 * Story #1289: this is the only writer for the `scope: 'story-close'`
 * preflight surface. Adding new checks happens by dropping a file into
 * `.agents/scripts/lib/checks/` — no edit here.
 *
 * @param {object} opts
 * @param {string|number} opts.storyId
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]   Test-only probe injection.
 * @param {object} [opts.registry] Test-only inline registry.
 * @param {string} [opts.dir]      Test-only fixture dir.
 * @param {object} [opts.logger]   Spy logger.
 * @returns {Promise<{ ok: boolean, findings: Array, fixed: Array }>}
 */
export async function runStoryClosePreflight({
  storyId,
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger,
} = {}) {
  Logger.info(
    `[story-close] Running preflight checks (scope=story-close) for Story #${storyId ?? '?'}...`,
  );
  const preflight = await runPreflight({
    scope: 'story-close',
    autoFix: true,
    cwd,
    probes,
    registry,
    dir,
    logger,
  });
  return {
    ok: !preflight.blocked,
    findings: preflight.findings,
    fixed: preflight.fixed,
  };
}

/**
 * Emit the canonical close-result envelope for the "preflight refused"
 * exit. Shape mirrors `emitBaselineBlockedResult` so the wave aggregator's
 * label-derivation fallback sees a consistent envelope.
 */
function emitPreflightBlockedResult({ storyId, preflight }) {
  const result = {
    success: false,
    status: 'blocked',
    phase: 'preflight',
    reason: 'preflight-refused',
    findings: preflight.findings,
  };
  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress(
    'BLOCKED',
    `Story #${storyId} blocked: preflight refused — ${preflight.findings.length} blocker finding(s).`,
  );
  return result;
}

/** Orchestrate the Story closure. Exported for testing. */
export async function runStoryClose({
  storyId: storyIdParam,
  epicId: epicIdParam,
  skipDashboard: skipDashboardParam,
  skipValidation: skipValidationParam,
  cwd: cwdParam,
  resume: resumeParam,
  restart: restartParam,
  injectedProvider,
} = {}) {
  const {
    storyId,
    epicId,
    cwd,
    worktreePath,
    skipDashboard,
    skipValidation: skipValidationResolved,
    resumeFlag,
    restartFlag,
    noEvidenceFlag,
    orchestration,
    agentSettings,
    provider,
    story,
    epicBranch,
    storyBranch,
  } = await resolveCloseInputs({
    storyIdParam,
    epicIdParam,
    skipDashboardParam,
    skipValidationParam,
    cwdParam,
    resumeParam,
    restartParam,
    injectedProvider,
  });

  const notifyFn = (ticketId, payload, opts = {}) =>
    notify(ticketId, payload, { orchestration, provider, ...opts });

  progress('INIT', `Closing Story #${storyId}...`);

  // Preflight guard (Story #1289): assemble state, run the registry,
  // auto-correct what can be, and refuse the close on any surviving
  // blocker finding. Runs BEFORE `withEpicMergeLock` so we don't
  // acquire the per-Epic lock just to release it on a refused preflight.
  // Exit code 2 is reserved project-wide for "preflight refused".
  const preflightOutcome = await runStoryClosePreflight({ storyId, cwd });
  if (!preflightOutcome.ok) {
    const blockedResult = emitPreflightBlockedResult({
      storyId,
      preflight: preflightOutcome,
    });
    // The CLI entry's runAsCli wrapper translates this `success: false,
    // reason: 'preflight-refused'` envelope into exit-code 2 via
    // `onError` below. In-process callers receive the envelope directly.
    return {
      success: false,
      result: blockedResult,
      exitCode: PREFLIGHT_REFUSED_EXIT_CODE,
    };
  }

  // Hold the per-Epic merge lock across the entire close flow — pre-merge
  // gates, dispatchRecovery, merge, and post-merge pipeline. The narrower
  // lock that previously wrapped only the merge+push step let two concurrent
  // closes interleave validation/post-merge work against a shifting
  // `origin/<epic>` tip, producing the `merged:true`-but-HEAD-stale failure
  // mode that mimics a push-hook cascade. Serializing per Epic at script
  // entry costs wave-close parallelism but eliminates the race outright.
  return withEpicMergeLock(
    epicId,
    { repoRoot: cwd, timeoutMs: 60_000, log: progressLog },
    () =>
      runStoryCloseLocked({
        storyId,
        epicId,
        cwd,
        worktreePath,
        skipDashboard,
        skipValidationParam: skipValidationResolved,
        resumeFlag,
        restartFlag,
        noEvidenceFlag,
        orchestration,
        agentSettings,
        provider,
        story,
        epicBranch,
        storyBranch,
        notifyFn,
      }),
  );
}

function shouldSkipValidation({
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

async function runPreMergeValidation({
  cwd,
  worktreePath,
  epicBranch,
  storyBranch,
  agentSettings,
  storyId,
  epicId,
  noEvidenceFlag,
  phaseTimer,
  provider,
}) {
  // Self-heal format drift carried in from upstream waves before the
  // check-only gate fails the close. Lint-staged misses files outside
  // its glob (notably JSON), so a JSON edit in wave N can fail every
  // wave N+1 close until an operator runs `biome format --write` and
  // commits the result.
  runFormatAutofix({ cwd, storyId, agentSettings, logger: Logger });
  // Story #1120: gates spawn in the worktree, not main. Story #1124:
  // baseline-gate failures route through the attribution classifier.
  const gateOutcome = await runPreMergeGatesWithAttribution({
    cwd,
    worktreePath,
    epicBranch,
    storyBranch,
    agentSettings,
    storyId,
    epicId,
    useEvidence: !noEvidenceFlag,
    phaseTimer,
    provider,
  });
  if (gateOutcome?.status === 'blocked') return gateOutcome;
  emitMaintainabilityProjection({
    cwd,
    epicBranch,
    storyBranch,
    agentSettings,
    logger: Logger,
  });
  return gateOutcome;
}

/**
 * Pure: render the AUTO-REFRESH status into a `{channel, message}` log
 * envelope, or `null` for statuses we don't surface. Extracted so the
 * branching lives behind a tested boundary and `reportAutoRefreshOutcome`
 * stays at CC ≤ 2.
 */
export function describeAutoRefreshOutcome(refreshResult) {
  if (refreshResult?.status === 'amended') {
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Amended bounded baseline drift into HEAD (${refreshResult.sha}).`,
    };
  }
  if (refreshResult?.status === 'refused') {
    const sig = refreshResult.dedup
      ? 'already present'
      : refreshResult.signalAppended
        ? 'appended'
        : 'not written';
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Refused — ${refreshResult.refusalReasons.length} cap breach(es); friction signal ${sig}.`,
    };
  }
  if (refreshResult?.status === 'failed') {
    return {
      channel: 'warn',
      message: `[auto-refresh] ${refreshResult.reason}: ${refreshResult.detail ?? ''}`,
    };
  }
  return null;
}

function reportAutoRefreshOutcome(refreshResult) {
  const envelope = describeAutoRefreshOutcome(refreshResult);
  if (!envelope) return;
  if (envelope.channel === 'warn') Logger.warn(envelope.message);
  else progress(envelope.label, envelope.message);
}

/**
 * Story #1398 (Epic #1386) — bounded baseline auto-refresh. Pre-merge
 * gates have passed; regenerate baseline rows scoped to the Story diff
 * and amend them into HEAD if every row's delta is at or below the
 * configured caps. Failure modes are advisory: a regen / amend / signal-
 * write failure is logged but does not block the close.
 */
async function runAutoRefreshSafely(args) {
  try {
    const refreshResult = await runAutoRefresh(args);
    reportAutoRefreshOutcome(refreshResult);
  } catch (err) {
    Logger.warn(
      `[auto-refresh] runner threw: ${err?.stack || err?.message || err}`,
    );
  }
}

async function runStoryCloseLocked({
  storyId,
  epicId,
  cwd,
  worktreePath,
  skipDashboard,
  skipValidationParam,
  resumeFlag,
  restartFlag,
  noEvidenceFlag,
  orchestration,
  agentSettings,
  provider,
  story,
  epicBranch,
  storyBranch,
  notifyFn,
}) {
  // Prior-state detection + --resume / --restart dispatch.
  const { resumeFromConflict, resumeFromMerge, resumeFromPostMerge } =
    dispatchRecovery({
      cwd,
      storyId,
      epicId,
      epicBranch,
      storyBranch,
      orchestration,
      resume: resumeFlag,
      restart: restartFlag,
      progress,
      logger: Logger,
    });

  const tasks = await fetchChildTasks(provider, storyId);
  // Prime the cache so cascadeCompletion + transitionTicketState reuse the
  // already-hydrated tickets instead of re-reading them via REST.
  provider.primeTicketCache([story, ...tasks]);
  progress('TASKS', `Found ${tasks.length} child Task(s)`);

  // Restore the phase timer from the snapshot story-init left in
  // `<mainCwd>/.git/`; missing — fall back to a fresh timer.
  const prior = loadPhaseTimerState({ mainCwd: cwd, storyId });
  const phaseTimer = createPhaseTimer(storyId, prior ? { restore: prior } : {});

  // Pre-merge gates surface formatting / MI drift in the worktree rather
  // than on the Epic at pre-push time. Skipped on resume-from-* paths
  // because the gates already ran on the original close; re-running them
  // against a possibly-reaped worktree is wasted work and may itself fail.
  const skipValidation = shouldSkipValidation({
    skipValidationParam,
    resumeFromConflict,
    resumeFromMerge,
    resumeFromPostMerge,
  });
  if (!skipValidation) {
    const gateOutcome = await runPreMergeValidation({
      cwd,
      worktreePath,
      epicBranch,
      storyBranch,
      agentSettings,
      storyId,
      epicId,
      noEvidenceFlag,
      phaseTimer,
      provider,
    });
    if (gateOutcome?.status === 'blocked') {
      return emitBaselineBlockedResult({ storyId, gateOutcome, progress });
    }
    await runAutoRefreshSafely({
      storyId,
      epicId,
      cwd: worktreePath || cwd,
      epicBranch,
      storyBranch,
      agentSettings,
    });
  }

  // Everything past validation is the `close` phase; runPostMergeClose
  // marks `api-sync` once the merge lands.
  phaseTimer.mark('close');

  // Skip the merge runner entirely on the already-merged path — the merge
  // already landed on `origin/epic/<id>` during the prior close attempt; the
  // only remaining work is the post-merge pipeline (ticket transitions,
  // cascade, health, dashboard regen).
  if (!resumeFromPostMerge) {
    const mergeArgs = {
      cwd,
      epicBranch,
      storyBranch,
      storyTitle: story.title,
      storyId,
      epicId,
      orchestration,
      log: progressLog,
    };
    await (resumeFromConflict ? runResumeMerge : runFinalizeMerge)(mergeArgs);
  } else {
    progress(
      'MERGE',
      `Skipping rebase + merge — story tip already reachable from ${epicBranch}`,
    );
  }

  const result = await runPostMergeClose({
    orchestration,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    cwd,
    projectRoot: PROJECT_ROOT,
    config: { agentSettings, orchestration },
    provider,
    notify: notifyFn,
    tasks,
    skipDashboard,
    progress,
    logger: Logger,
    phaseTimer,
    clearPhaseTimerState,
  });

  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress(
    'DONE',
    `✅ Story #${storyId} merged into ${epicBranch}. ${result.ticketsClosed.length} ticket(s) closed.`,
  );
  return { success: true, result };
}

runAsCli(
  import.meta.url,
  async () => {
    const envelope = await runStoryClose();
    // Story #1289: preflight refusal returns `{ exitCode: 2, success: false }`
    // synchronously rather than throwing — translate that to a process exit so
    // the CLI surface honours the project-wide "preflight refused" reservation.
    if (envelope?.exitCode === PREFLIGHT_REFUSED_EXIT_CODE) {
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
    return envelope;
  },
  {
    source: 'story-close',
    onError: (err) => {
      // exitCode=2 also covers two prior reservations: dispatchRecovery's
      // prior-state refusal (printed to stderr; operator passes --resume /
      // --restart) and now Story #1289's preflight refusal (printed by
      // preflight-runner; operator runs the listed fix commands). Both paths
      // suppress the stack trace and exit cleanly.
      if (err?.exitCode === 2) process.exit(2);
      Logger.error(`[phase=fatal] [story-close] ${err.stack || err.message}`);
      process.exit(1);
    },
  },
);
