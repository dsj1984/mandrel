#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-close.js — Story Execution Closure
 *
 * Deterministic script that replaces Steps 5, 5b, and 6 of the epic-execute
 * Mode B workflow. Performs all post-implementation orchestration:
 *
 *   1. Validates the Story branch exists and is currently checked out.
 *   2. Merges the Story branch into epic/<epicId> with --no-ff.
 *   3. Pushes the Epic branch.
 *   4. Deletes the Story branch (local + remote).
 *   5. Batch transitions all child Tasks → agent::done (with cascade).
 *   6. Transitions the Story → agent::done (with cascade).
 *   7. Runs health-monitor.js.
 *
 * Usage:
 *   node story-close.js --story <STORY_ID> [--epic <EPIC_ID>]
 *
 * If --epic is omitted, the script resolves it from the Story ticket body.
 *
 * Exit codes:
 *   0 — Story closed and merged successfully.
 *   1 — Error.
 *
 * @see .agents/workflows/story-execute.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  buildDefaultGates,
  formatMaintainabilityProjection,
  projectMaintainabilityRegressions,
  runCloseValidation,
} from './lib/close-validation.js';
import {
  getBaselines,
  getRunners,
  PROJECT_ROOT,
  resolveConfig,
  resolveWorkingPath,
} from './lib/config-resolver.js';
import {
  acquireEpicMergeLock,
  releaseEpicMergeLock,
} from './lib/epic-merge-lock.js';
import { mergeFeatureBranch } from './lib/git-merge-orchestrator.js';
import {
  getEpicBranch,
  getStoryBranch,
  gitSpawn,
  gitSync,
} from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { createFrictionEmitter } from './lib/orchestration/friction-emitter.js';
import { runPostMergePipeline } from './lib/orchestration/post-merge-pipeline.js';
import { dispatchRecovery } from './lib/orchestration/story-close-recovery.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import {
  PushRetryConflictError,
  pushEpicWithRetry,
} from './lib/push-epic-retry.js';
import {
  fetchChildTasks,
  resolveStoryHierarchy,
} from './lib/story-lifecycle.js';
import { createPhaseTimer } from './lib/util/phase-timer.js';
import {
  clearPhaseTimerState,
  loadPhaseTimerState,
} from './lib/util/phase-timer-state.js';
import { forceDrainPendingCleanup } from './lib/worktree/lifecycle/force-drain.js';
import { notify } from './notify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const progress = Logger.createProgress('story-close', { stderr: true });

function resolveWorktreeRoot(repoRoot, orchestration) {
  const configuredRoot = orchestration?.worktreeIsolation?.root ?? '.worktrees';
  return path.join(repoRoot, configuredRoot);
}

export async function drainPendingCleanupAfterClose({
  repoRoot,
  orchestration,
  progress: progressFn,
  logger = Logger,
  git = { gitSpawn },
  drainFn = forceDrainPendingCleanup,
} = {}) {
  const wtConfig = orchestration?.worktreeIsolation;
  if (!wtConfig?.enabled) return null;
  const worktreeRoot = resolveWorktreeRoot(repoRoot, orchestration);
  const result = await drainFn({
    repoRoot,
    worktreeRoot,
    git,
    logger,
  });
  const totalResolved =
    (result.drained?.length ?? 0) +
    (result.persistent?.length ?? 0) +
    (result.stillPending?.length ?? 0);
  if (totalResolved > 0) {
    (progressFn ?? progress)(
      'WORKTREE',
      `Pending cleanup drain: drained=${result.drained.length}, persistent=${result.persistent.length}, stillPending=${result.stillPending.length}`,
    );
  }
  return { worktreeRoot, ...result };
}

export function reconcileCleanupState({
  storyId,
  worktreeReap,
  branchCleanup,
  pendingCleanupDrain,
}) {
  const normalizedStoryId = Number(storyId);
  const nextWorktreeReap = worktreeReap ? { ...worktreeReap } : null;
  const nextBranchCleanup = branchCleanup ? { ...branchCleanup } : null;
  if (!pendingCleanupDrain || !nextWorktreeReap || !nextBranchCleanup) {
    return { worktreeReap: nextWorktreeReap, branchCleanup: nextBranchCleanup };
  }

  const drainedEntry =
    pendingCleanupDrain.drainedDetails?.find(
      (entry) => Number(entry.storyId) === normalizedStoryId,
    ) ?? null;
  const isStillPending =
    pendingCleanupDrain.stillPending?.includes(normalizedStoryId) ?? false;
  const isPersistent =
    pendingCleanupDrain.persistent?.includes(normalizedStoryId) ?? false;

  if (drainedEntry) {
    if (drainedEntry.localBranchDeleted !== null) {
      nextBranchCleanup.localDeleted =
        nextBranchCleanup.localDeleted || !!drainedEntry.localBranchDeleted;
    }
    if (drainedEntry.remoteBranchDeleted !== null) {
      nextBranchCleanup.remoteDeleted =
        nextBranchCleanup.remoteDeleted || !!drainedEntry.remoteBranchDeleted;
    }
    nextWorktreeReap.status =
      nextWorktreeReap.status === 'deferred-to-sweep'
        ? 'removed-after-drain'
        : nextWorktreeReap.status;
    nextWorktreeReap.pendingCleanup = null;
    nextWorktreeReap.closeDrainStatus = 'drained';
    return {
      worktreeReap: nextWorktreeReap,
      branchCleanup: nextBranchCleanup,
    };
  }

  if (nextWorktreeReap.status === 'deferred-to-sweep') {
    nextWorktreeReap.closeDrainStatus = getCloseDrainStatus({
      isPersistent,
      isStillPending,
    });
  }

  return { worktreeReap: nextWorktreeReap, branchCleanup: nextBranchCleanup };
}

/**
 * Pre-flight check that refuses to close while the operator's shell is still
 * cd'd into the per-story worktree being reaped. On Windows this surfaces as
 * `EBUSY: resource busy or locked, rmdir` during reap; cross-platform it
 * makes `--cwd` semantics impossible to honour because git operations target
 * the main repo while the filesystem mutation targets the worktree the
 * caller is sitting inside.
 *
 * Fires only when `--cwd` is set explicitly. Single-tree closures resolve
 * `workCwd` to the main repo, so the equality check is a tautology there
 * and we don't reject those.
 *
 * Pure: takes inputs, returns a verdict. Exported so the rejection path is
 * unit-testable without spawning the script.
 *
 * @param {object} opts
 * @param {boolean} opts.cwdExplicit       True when `--cwd` (or AGENT_WORKTREE_ROOT) was set.
 * @param {string} opts.mainCwd            Resolved main repo path.
 * @param {number|string} opts.storyId
 * @param {string} [opts.worktreeRoot]     `orchestration.worktreeIsolation.root` (defaults to `.worktrees`).
 * @param {string} [opts.currentCwd]       Defaults to `process.cwd()`.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkCdOutGuard({
  cwdExplicit,
  mainCwd,
  storyId,
  worktreeRoot = '.worktrees',
  currentCwd = process.cwd(),
}) {
  if (!cwdExplicit) return { ok: true };
  const workCwd = path.resolve(mainCwd, worktreeRoot, `story-${storyId}`);
  const cwd = path.resolve(currentCwd);
  if (cwd !== workCwd) return { ok: true };
  return {
    ok: false,
    message:
      `Refusing to close while CWD is the worktree being reaped.\n` +
      `   Current cwd:  ${cwd}\n` +
      `   Main repo:    ${mainCwd}\n` +
      `   Run instead:  cd "${mainCwd}" && node .agents/scripts/story-close.js --story ${storyId}`,
  };
}

/**
 * Resolve the deferred-to-sweep close-drain status when the current Story's
 * pending-cleanup entry was *not* drained on this close. Three outcomes:
 *
 *   - `'persistent'`   — the entry has hit the persistent-lock threshold
 *                        (`MAX_SWEEP_ATTEMPTS` reached). `isPersistent` wins
 *                        regardless of whether the entry is also still in
 *                        the live pending list, because operator-action is
 *                        the authoritative outcome.
 *   - `'still-pending'`— the entry is in the pending list but has not yet
 *                        crossed the persistent threshold. The next sweep
 *                        run will retry.
 *   - `'not-found'`    — the entry is in neither list. Either the drain
 *                        cleared it before this reconcile saw it, or this
 *                        Story never had a pending entry. Treated as a
 *                        clean state for downstream callers.
 *
 * Extracted from a nested ternary so the truth table is greppable and each
 * branch carries an explicit name.
 *
 * @param {{ isPersistent: boolean, isStillPending: boolean }} flags
 * @returns {'persistent' | 'still-pending' | 'not-found'}
 */
export function getCloseDrainStatus({ isPersistent, isStillPending }) {
  if (isPersistent) return 'persistent';
  if (isStillPending) return 'still-pending';
  return 'not-found';
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Pre-merge rebase of the Story branch onto `origin/<epicBranch>`.
 *
 * Parallel wave execution lets two Stories land on the Epic between the time
 * a later Story branched off and the time it closes. Rebasing the Story on
 * the latest Epic before the close-merge shrinks the conflict surface to the
 * Story's real delta and lets `mergeFeatureBranch`'s minor-conflict auto-
 * resolve apply surgically instead of against stale base content.
 *
 * Runs inside the per-story worktree so it does not disturb the main
 * checkout. On any failure (fetch error, rebase conflict) the rebase is
 * aborted and the caller falls through to the plain merge path, which will
 * surface the same conflict via triage.
 *
 * @returns {{ rebased: boolean, reason?: string }}
 */
function rebaseStoryOnEpic({
  orchestration,
  storyId,
  epicBranch,
  storyBranch,
  repoRoot,
}) {
  const wtConfig = orchestration?.worktreeIsolation;
  if (!wtConfig?.enabled) {
    return { rebased: false, reason: 'isolation-disabled' };
  }
  const wtPath = resolveWorkingPath({
    worktreeEnabled: true,
    repoRoot,
    storyId,
    worktreeRoot: wtConfig.root,
  });
  if (!fs.existsSync(wtPath)) {
    return { rebased: false, reason: 'worktree-missing' };
  }

  progress('GIT', `Rebasing ${storyBranch} onto origin/${epicBranch}...`);
  const fetch = gitSpawn(wtPath, 'fetch', 'origin', epicBranch);
  if (fetch.status !== 0) {
    progress(
      'GIT',
      `⚠️ fetch origin ${epicBranch} failed; skipping pre-merge rebase`,
    );
    return { rebased: false, reason: 'fetch-failed' };
  }
  const rebase = gitSpawn(wtPath, 'rebase', `origin/${epicBranch}`);
  if (rebase.status !== 0) {
    gitSpawn(wtPath, 'rebase', '--abort');
    progress(
      'GIT',
      '⚠️ rebase conflicted; aborted — merge triage will handle overlap',
    );
    return { rebased: false, reason: 'rebase-conflict' };
  }
  progress('GIT', `✅ Rebased ${storyBranch} onto origin/${epicBranch}`);
  return { rebased: true };
}

async function finalizeMerge(
  epicBranch,
  storyBranch,
  storyTitle,
  storyId,
  cwd,
  orchestration,
  epicId,
) {
  // Acquire the per-Epic filesystem merge lock before any rebase/merge/push
  // activity so two concurrent story closures cannot race on the Epic
  // branch. Lock is always released in the `finally` block. Acquisition
  // failure must halt hard — prior to this fix, the catch called
  // `Logger.fatal` and relied on its internal `process.exit(1)` to stop the
  // run, which silently fell through under a mocked `process.exit`. Throwing
  // ensures the rebase/merge/push block below cannot run without the lock.
  progress('LOCK', `Acquiring epic-merge lock for epic #${epicId}...`);
  let lockHandle;
  try {
    lockHandle = await acquireEpicMergeLock(epicId, {
      repoRoot: cwd,
      timeoutMs: 60_000,
    });
  } catch (err) {
    throw new Error(
      `Could not acquire epic-merge lock for epic #${epicId}: ${err.message}. ` +
        `Another story closure may be in progress, or a stale lock is present at ` +
        `${lockPathDisplay(cwd, epicId)} — inspect and remove it manually if no ` +
        `other process is running.`,
    );
  }
  progress('LOCK', `🔒 Acquired ${path.basename(lockHandle.filePath)}`);

  try {
    rebaseStoryOnEpic({
      orchestration,
      storyId,
      epicBranch,
      storyBranch,
      repoRoot: cwd,
    });

    progress('GIT', `Checking out ${epicBranch}...`);
    gitSync(cwd, 'checkout', epicBranch);
    gitSpawn(cwd, 'pull', '--rebase', 'origin', epicBranch);

    progress('GIT', `Merging ${storyBranch} into ${epicBranch} (--no-ff)...`);
    const mergeMsg = `feat: ${storyTitle.charAt(0).toLowerCase() + storyTitle.slice(1)} (resolves #${storyId})`;
    const vlog = (_level, _ctx, msg, meta) => {
      const tail = meta ? ` ${JSON.stringify(meta)}` : '';
      Logger.error(`[merge] ${msg}${tail}`);
    };
    const result = mergeFeatureBranch(cwd, storyBranch, vlog, {
      message: mergeMsg,
    });

    if (!result.merged && result.major) {
      Logger.fatal(
        `Major merge conflict on story close: ` +
          `${result.conflicts.files} file(s), ${result.conflicts.lines} marker(s). ` +
          `Conflicting files: ${result.conflicts.fileList.join(', ')}. ` +
          `Merge has been aborted. Resolve manually on ${epicBranch}, then ` +
          `re-run this script.`,
      );
    }
    if (result.autoResolved) {
      progress(
        'GIT',
        `✅ Merge completed with auto-resolved minor conflicts ` +
          `(${result.conflicts.files} file(s) resolved to theirs)`,
      );
      for (const f of result.autoResolvedFiles ?? []) {
        progress(
          'GIT',
          `  ↳ auto-resolved ${f.file} (${f.discardedLines} base line(s) discarded; trailer in merge commit)`,
        );
      }
    } else {
      progress('GIT', '✅ Merge successful');
    }

    progress('GIT', `Pushing ${epicBranch}...`);
    let pushOutcome;
    try {
      pushOutcome = await pushEpicWithRetry({
        cwd,
        epicBranch,
        storyBranch,
        closeRetry: getRunners(orchestration).closeRetry,
        git: { gitSpawn },
        log: (msg) => progress('GIT', msg),
      });
    } catch (err) {
      if (err instanceof PushRetryConflictError) {
        Logger.fatal(err.message);
      }
      throw err;
    }
    if (!pushOutcome.ok) {
      const reasonLabel =
        pushOutcome.reason === 'retry-exhausted'
          ? `retries exhausted after ${pushOutcome.attempts} attempt(s)`
          : pushOutcome.reason;
      Logger.fatal(
        `Push failed (${reasonLabel}): ${pushOutcome.result?.stderr || pushOutcome.result?.stdout || 'unknown'}`,
      );
    }
    if (pushOutcome.attempts > 1) {
      progress(
        'GIT',
        `✅ Push succeeded on attempt ${pushOutcome.attempts} after sibling session landed on ${epicBranch}`,
      );
    }

    // Branch cleanup is deferred to after worktree reap: git refuses to
    // delete a branch that's still "checked out" by a worktree, and the
    // per-story worktree still has storyBranch checked out at this point.
    // See runStoryClose for the ordering.
  } finally {
    releaseEpicMergeLock(lockHandle);
    progress('LOCK', '🔓 Released epic-merge lock');
  }
}

function lockPathDisplay(cwd, epicId) {
  return path.join(cwd, '.git', `epic-${epicId}.merge.lock`);
}

/**
 * Render the `phase-timings` comment body.
 *
 * The payload is emitted inside a fenced ```json block so the epic-runner
 * progress reporter can parse it back out with a single regex + JSON.parse
 * rather than relying on a bespoke marker format. Schema matches tech
 * spec #555 §Data Models (`{ kind, storyId, totalMs, phases }`).
 */
export function renderPhaseTimingsCommentBody(summary) {
  const payload = {
    kind: 'phase-timings',
    storyId: summary.storyId,
    totalMs: summary.totalMs,
    phases: summary.phases,
  };
  return `### Phase timings — story #${summary.storyId}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

/**
 * Pure: build the conventional-commit subject the resume path uses to
 * finalize a partial-merge commit. Exported for tests.
 */
export function buildResumeMergeCommitMsg(storyTitle, storyId) {
  const lc = storyTitle.charAt(0).toLowerCase() + storyTitle.slice(1);
  return `feat: ${lc} (resolves #${storyId})`;
}

/**
 * Pure: classify a `pushEpicWithRetry` outcome into the operator-facing
 * fatal-error message. Returns `null` when the push was ok.
 */
export function describeResumePushFailure(pushOutcome) {
  if (pushOutcome.ok) return null;
  const reasonLabel =
    pushOutcome.reason === 'retry-exhausted'
      ? `retries exhausted after ${pushOutcome.attempts} attempt(s)`
      : pushOutcome.reason;
  const detail =
    pushOutcome.result?.stderr || pushOutcome.result?.stdout || 'unknown';
  return `Push failed (${reasonLabel}): ${detail}`;
}

async function finalizeMergeIfPending({
  cwd,
  epicBranch,
  storyBranch,
  storyTitle,
  storyId,
}) {
  const mergeHeadPath = path.join(cwd, '.git', 'MERGE_HEAD');
  if (!fs.existsSync(mergeHeadPath)) {
    progress(
      'GIT',
      '⚠️ No MERGE_HEAD found — merge already committed; proceeding to push',
    );
    return;
  }
  progress('GIT', 'Finalizing in-progress merge (git commit --no-verify)');
  const commit = gitSpawn(
    cwd,
    'commit',
    '--no-verify',
    '-m',
    buildResumeMergeCommitMsg(storyTitle, storyId),
  );
  if (commit.status !== 0) {
    Logger.fatal(
      `Failed to finalize merge commit: ${commit.stderr || commit.stdout || 'unknown'}. ` +
        `Check that all conflicts are resolved and staged on ${epicBranch}.`,
    );
  }
  progress('GIT', `✅ Merge of ${storyBranch} finalized on ${epicBranch}`);
}

async function pushEpicAfterResume({
  cwd,
  epicBranch,
  storyBranch,
  orchestration,
}) {
  progress('GIT', `Pushing ${epicBranch}...`);
  let pushOutcome;
  try {
    pushOutcome = await pushEpicWithRetry({
      cwd,
      epicBranch,
      storyBranch,
      closeRetry: getRunners(orchestration).closeRetry,
      git: { gitSpawn },
      log: (msg) => progress('GIT', msg),
    });
  } catch (err) {
    if (err instanceof PushRetryConflictError) Logger.fatal(err.message);
    throw err;
  }
  const fatal = describeResumePushFailure(pushOutcome);
  if (fatal) Logger.fatal(fatal);
}

/**
 * Complete an in-progress merge whose conflicts have been resolved by the
 * operator, then push. Used by the `--resume` path when prior state is
 * `partial-merge`.
 */
async function completeInProgressMerge({
  cwd,
  epicBranch,
  storyBranch,
  storyTitle,
  storyId,
  epicId,
  orchestration,
}) {
  let lockHandle;
  try {
    progress('LOCK', `Acquiring epic-merge lock for epic #${epicId}...`);
    lockHandle = await acquireEpicMergeLock(epicId, {
      repoRoot: cwd,
      timeoutMs: 60_000,
    });
    progress('LOCK', `🔒 Acquired ${path.basename(lockHandle.filePath)}`);

    await finalizeMergeIfPending({
      cwd,
      epicBranch,
      storyBranch,
      storyTitle,
      storyId,
    });
    await pushEpicAfterResume({
      cwd,
      epicBranch,
      storyBranch,
      orchestration,
    });
  } finally {
    if (lockHandle) {
      releaseEpicMergeLock(lockHandle);
      progress('LOCK', '🔓 Released epic-merge lock');
    }
  }
}

/**
 * Orchestrate the Story initialization.
 * Exported for testing.
 */
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
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          epicId: epicIdParam,
          skipDashboard: !!skipDashboardParam,
          cwd: cwdParam ?? null,
          resume: !!resumeParam,
          restart: !!restartParam,
        }
      : parseSprintArgs();
  const {
    storyId,
    epicId: argEpicId,
    skipDashboard,
    resume: resumeFlag,
    restart: restartFlag,
    noEvidence: noEvidenceFlag,
  } = parsed;
  // Worktree-aware cwd resolution: explicit param > --cwd flag > env > PROJECT_ROOT.
  const cwd = path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT);

  if (!storyId) {
    Logger.fatal(
      'Usage: node story-close.js --story <STORY_ID> [--epic <EPIC_ID>]',
    );
  }

  let epicId = argEpicId;

  const { orchestration, settings } = resolveConfig({ cwd });

  // Pre-flight cd-out guard — runs after argument parsing and config load
  // but before any git/filesystem mutation. Converts the recurring Windows
  // EBUSY-on-reap friction (5 events in #730) into a zero-friction abort
  // with an exact remediation command.
  const guard = checkCdOutGuard({
    cwdExplicit: parsed.cwd != null,
    mainCwd: cwd,
    storyId,
    worktreeRoot: orchestration?.worktreeIsolation?.root,
  });
  if (!guard.ok) Logger.fatal(guard.message);

  const provider = injectedProvider || createProvider(orchestration);
  const notifyFn = (ticketId, payload) =>
    notify(ticketId, payload, { orchestration, provider });

  progress('INIT', `Closing Story #${storyId}...`);

  // -------------------------------------------------------------------------
  // Resolve Epic ID if not provided
  // -------------------------------------------------------------------------

  const story = await provider.getTicket(storyId);

  if (!epicId) {
    const resolved = resolveStoryHierarchy(story.body);
    if (!resolved.epicId) {
      Logger.fatal(
        `Story #${storyId} has no "Epic: #N" reference. Pass --epic <id> explicitly.`,
      );
    }
    epicId = resolved.epicId;
  }

  const epicBranch = getEpicBranch(epicId);
  const storyBranch = getStoryBranch(epicId, storyId);

  // -------------------------------------------------------------------------
  // Prior-state detection + --resume / --restart dispatch
  // -------------------------------------------------------------------------

  const { resumeFromConflict, resumeFromMerge } = dispatchRecovery({
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

  // -------------------------------------------------------------------------
  // Enumerate child Tasks
  // -------------------------------------------------------------------------

  const tasks = await fetchChildTasks(provider, storyId);

  // Prime the provider's per-instance ticket cache: cascadeCompletion and
  // transitionTicketState will re-read these same ids, so feeding the
  // already-hydrated list prevents redundant REST round-trips.
  if (typeof provider.primeTicketCache === 'function') {
    provider.primeTicketCache([story, ...tasks]);
  }

  progress('TASKS', `Found ${tasks.length} child Task(s)`);

  // Restore the phase timer from the snapshot story-init left in
  // `<mainCwd>/.git/`. Missing or unparseable — fall back to a fresh timer
  // so close still emits whatever phases it observes (lint, test, close,
  // api-sync). See lib/util/phase-timer-state.js for the persistence
  // contract.
  const prior = loadPhaseTimerState({ mainCwd: cwd, storyId });
  const phaseTimer = createPhaseTimer(storyId, prior ? { restore: prior } : {});

  // -------------------------------------------------------------------------
  // Pre-merge validation — shift-left gates so formatting drift or
  // maintainability regressions surface in the worktree rather than on the
  // Epic branch at pre-push time.
  // -------------------------------------------------------------------------

  const skipValidation =
    !!skipValidationParam || resumeFromConflict || resumeFromMerge;
  if (!skipValidation) {
    progress(
      'VALIDATE',
      'Running pre-merge gates (typecheck, lint, test, format, maintainability)...',
    );
    const validation = runCloseValidation({
      cwd,
      gates: buildDefaultGates({ settings }),
      log: (m) => Logger.info(m),
      onGateStart: (gate) => {
        // Only the canonical phase-enum gates drive `mark()`. Non-enum
        // gates (`typecheck`, `biome format`, `check-maintainability`)
        // share the currently-open phase's wall clock — a deliberate
        // choice so the `phase-timings` schema stays stable against
        // future gate churn.
        if (gate.name === 'lint' || gate.name === 'test') {
          phaseTimer.mark(gate.name);
        }
      },
      storyId,
      useEvidence: !noEvidenceFlag,
    });
    if (!validation.ok) {
      const [{ gate, status }] = validation.failed;
      Logger.fatal(
        `Pre-merge validation failed at "${gate.name}" (exit ${status}).` +
          (gate.hint ? ` ${gate.hint}` : ''),
      );
    }

    // -----------------------------------------------------------------------
    // Pre-merge MI ceiling projection — advisory signal that lists every
    // changed file whose post-merge MI score would breach the per-file
    // baseline. Surfaces the exact files + the `baseline-refresh:` workflow
    // before the merge so the operator can ship the refresh atomically with
    // the Story PR rather than as a follow-on after the push.
    // -----------------------------------------------------------------------
    try {
      const baselinePath = getBaselines({ agentSettings: settings })
        ?.maintainability?.path;
      if (baselinePath) {
        const projection = projectMaintainabilityRegressions({
          cwd,
          epicBranch,
          storyBranch,
          baselinePath,
        });
        const advisory = formatMaintainabilityProjection(projection);
        if (advisory) {
          for (const line of advisory.split('\n')) Logger.info(line);
        } else if (projection.skipped) {
          Logger.info(
            `[close-validation] Pre-merge MI projection skipped (${projection.skipped}).`,
          );
        }
      }
    } catch (err) {
      Logger.warn?.(
        `[close-validation] Pre-merge MI projection failed: ${err?.message ?? err}`,
      );
    }
  }

  // Everything after validation — the merge, branch cleanup, worktree reap,
  // and push — is the `close` phase. The post-merge pipeline's ticket
  // transitions + cascade + health + manifest regeneration is the
  // `api-sync` phase. We mark boundaries inline below.
  phaseTimer.mark('close');

  // -------------------------------------------------------------------------
  // Step 5 — Merge
  // -------------------------------------------------------------------------

  if (resumeFromConflict) {
    await completeInProgressMerge({
      cwd,
      epicBranch,
      storyBranch,
      storyTitle: story.title,
      storyId,
      epicId,
      orchestration,
    });
  } else {
    await finalizeMerge(
      epicBranch,
      storyBranch,
      story.title,
      storyId,
      cwd,
      orchestration,
      epicId,
    );
  }

  // Reap must precede branch cleanup: git refuses to delete a branch that
  // is still checked out by a live worktree. The pipeline runs the phases
  // in this order — see post-merge-pipeline.js.
  phaseTimer.mark('api-sync');
  const frictionEmitter = createFrictionEmitter({
    provider,
    logger: { warn: (m) => Logger.warn?.(m), debug: () => {} },
  });
  const pipelineState = await runPostMergePipeline({
    orchestration,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    repoRoot: cwd,
    projectRoot: PROJECT_ROOT,
    provider,
    notify: notifyFn,
    frictionEmitter,
    tasks,
    skipDashboard,
    progress,
    logger: Logger,
  });
  if (
    orchestration?.worktreeIsolation?.enabled &&
    !pipelineState.worktreeReap
  ) {
    throw new Error(
      'story-close invariant violated: worktreeReap state missing while worktree isolation is enabled.',
    );
  }
  const pendingCleanupDrain = await drainPendingCleanupAfterClose({
    repoRoot: cwd,
    orchestration,
    progress,
    logger: Logger,
  });
  const reconciledCleanup = reconcileCleanupState({
    storyId,
    worktreeReap: pipelineState.worktreeReap,
    branchCleanup: pipelineState.branchCleanup,
    pendingCleanupDrain,
  });
  const branchCleanup = reconciledCleanup.branchCleanup;
  const worktreeReap = reconciledCleanup.worktreeReap;
  const { closedTickets, cascadedTo, cascadeFailed } =
    pipelineState.ticketClosure;
  const healthUpdated = pipelineState.healthUpdated;
  const manifestUpdated = pipelineState.manifestUpdated;

  // -------------------------------------------------------------------------
  // Phase-timings summary — post the structured comment that the epic
  // runner's progress reporter aggregates into median/p95 rows. Finish the
  // timer here so `api-sync` closes with the full post-merge-pipeline
  // wall-clock included. Failure to post is non-fatal — the merge has
  // already succeeded and we would rather log than roll back closure.
  // -------------------------------------------------------------------------

  const timingSummary = phaseTimer.finish();
  try {
    await upsertStructuredComment(
      provider,
      storyId,
      'phase-timings',
      renderPhaseTimingsCommentBody(timingSummary),
    );
  } catch (err) {
    Logger.warn?.(
      `[story-close] ⚠️ Failed to post phase-timings comment: ${err.message}`,
    );
  }
  try {
    clearPhaseTimerState({ mainCwd: cwd, storyId });
  } catch (err) {
    Logger.warn?.(
      `[story-close] ⚠️ Failed to clear phase-timer state file: ${err.message}`,
    );
  }

  // -------------------------------------------------------------------------
  // Output — structured result
  // -------------------------------------------------------------------------

  const result = {
    storyId,
    epicId,
    action: 'merged',
    merged: true,
    branchDeleted: branchCleanup.localDeleted && branchCleanup.remoteDeleted,
    branchLocalDeleted: branchCleanup.localDeleted,
    branchRemoteDeleted: branchCleanup.remoteDeleted,
    worktreeReap,
    pendingCleanupDrain,
    ticketsClosed: closedTickets,
    cascadedTo: cascadedTo ?? [],
    cascadeFailed: cascadeFailed ?? [],
    healthUpdated,
    manifestUpdated,
  };

  console.log('\n--- STORY CLOSE RESULT ---');
  console.log(JSON.stringify(result, null, 2));
  console.log('--- END RESULT ---\n');

  progress(
    'DONE',
    `✅ Story #${storyId} merged into ${epicBranch}. ` +
      `${closedTickets.length} ticket(s) closed.`,
  );

  return { success: true, result };
}

// ---------------------------------------------------------------------------
// Main guard
// ---------------------------------------------------------------------------

runAsCli(import.meta.url, runStoryClose, {
  source: 'story-close',
  onError: (err) => {
    // Prior-state detection throws with `exitCode: 2` to signal "operator
    // must choose --resume / --restart" — the body was already printed to
    // stderr, so skip the default stack trace and just propagate the code.
    if (err?.exitCode === 2) {
      process.exit(2);
    }
    Logger.error(`[phase=fatal] [story-close] ${err.stack || err.message}`);
    process.exit(1);
  },
});
