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
 * @see .agents/workflows/story-execute.md
 */

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { checkCdOutGuard } from './lib/orchestration/story-close/cd-out-guard.js';
import { resolveCloseInputs } from './lib/orchestration/story-close/close-inputs.js';
import { runFormatAutofix } from './lib/orchestration/story-close/format-autofix.js';
import {
  runFinalizeMerge,
  runResumeMerge,
} from './lib/orchestration/story-close/merge-runner.js';
import { runPostMergeClose } from './lib/orchestration/story-close/post-merge-close.js';
import {
  emitMaintainabilityProjection,
  runPreMergeGates,
} from './lib/orchestration/story-close/pre-merge-validation.js';
import { dispatchRecovery } from './lib/orchestration/story-close-recovery.js';
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
    skipDashboard,
    resumeFlag,
    restartFlag,
    noEvidenceFlag,
    orchestration,
    settings,
    provider,
    story,
    epicBranch,
    storyBranch,
  } = await resolveCloseInputs({
    storyIdParam,
    epicIdParam,
    skipDashboardParam,
    cwdParam,
    resumeParam,
    restartParam,
    injectedProvider,
  });

  const notifyFn = (ticketId, payload, opts = {}) =>
    notify(ticketId, payload, { orchestration, provider, ...opts });

  progress('INIT', `Closing Story #${storyId}...`);

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
  const skipValidation =
    !!skipValidationParam ||
    resumeFromConflict ||
    resumeFromMerge ||
    resumeFromPostMerge;
  if (!skipValidation) {
    // Self-heal format drift carried in from upstream waves before the
    // check-only gate fails the close. Lint-staged misses files outside
    // its glob (notably JSON), so a JSON edit in wave N can fail every
    // wave N+1 close until an operator runs `biome format --write` and
    // commits the result. The autofix step does that automatically on
    // a clean tree; on a dirty tree it bails out and lets the gate
    // surface the drift with the canonical hint.
    runFormatAutofix({ cwd, storyId, settings, logger: Logger });
    runPreMergeGates({
      cwd,
      settings,
      storyId,
      useEvidence: !noEvidenceFlag,
      phaseTimer,
      logger: Logger,
    });
    emitMaintainabilityProjection({
      cwd,
      epicBranch,
      storyBranch,
      settings,
      logger: Logger,
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
    provider,
    notify: notifyFn,
    tasks,
    skipDashboard,
    progress,
    logger: Logger,
    phaseTimer,
    clearPhaseTimerState,
  });

  console.log(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress(
    'DONE',
    `✅ Story #${storyId} merged into ${epicBranch}. ${result.ticketsClosed.length} ticket(s) closed.`,
  );
  return { success: true, result };
}

runAsCli(import.meta.url, runStoryClose, {
  source: 'story-close',
  onError: (err) => {
    // exitCode=2 means dispatchRecovery printed prior-state body to stderr
    // and the operator must pass --resume / --restart; skip stack trace.
    if (err?.exitCode === 2) process.exit(2);
    Logger.error(`[phase=fatal] [story-close] ${err.stack || err.message}`);
    process.exit(1);
  },
});
