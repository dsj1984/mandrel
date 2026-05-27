#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-init.js — Story Execution Initialization
 *
 * Deterministic script that replaces Steps 0-2 of the epic-execute
 * Mode B workflow. Performs all pre-implementation setup by composing six
 * pipeline stages from `lib/story-init/`:
 *
 *   1. context-resolver     — fetch the Story + optionally mark as recut.
 *   2. hierarchy-tracer     — resolve Feature/Epic → PRD / Tech Spec.
 *   3. blocker-validator    — refuse to proceed while dependencies are open.
 *   4. task-graph-builder   — fetch + topologically sort child Tasks.
 *   5. branch-initializer   — materialise the story branch (single-tree
 *                             checkout or isolated worktree).
 *   6. state-transitioner   — flip the Story to `agent::executing` (Tasks
 *                             start via `story-task-progress.js` per Task).
 *
 * Usage:
 *   node story-init.js --story <STORY_ID> [--dry-run]
 *
 * Exit codes:
 *   0 — Initialization complete. Agent can start implementation.
 *   1 — Blocked or error (details in stderr).
 *
 * @see .agents/workflows/story-deliver.md
 */

import path from 'node:path';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  resolveRuntime,
} from './lib/config-resolver.js';
import { parseBlockedBy } from './lib/dependency-parser.js';
import { getEpicBranch, getStoryBranch } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { setActiveStoryEnv } from './lib/observability/active-story-env.js';
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { validateBlockers } from './lib/story-init/blocker-validator.js';
import { initializeBranch } from './lib/story-init/branch-initializer.js';
import { resolveContext } from './lib/story-init/context-resolver.js';
import { runDispatchManifestGuard } from './lib/story-init/dependency-guard.js';
import { writeDispatchStateFile } from './lib/story-init/dispatch-state-writer.js';
import { traceHierarchy } from './lib/story-init/hierarchy-tracer.js';
import { transitionStoryToExecuting } from './lib/story-init/state-transitioner.js';
import { buildTaskGraph } from './lib/story-init/task-graph-builder.js';
import { createPhaseTimer } from './lib/util/phase-timer.js';
import { savePhaseTimerState } from './lib/util/phase-timer-state.js';
import { forceClear as clearValidationEvidence } from './lib/validation-evidence.js';
import { notify } from './notify.js';

// ---------------------------------------------------------------------------
// Progress logger — shared stage-logger passed to every pipeline stage.
// ---------------------------------------------------------------------------

const progress = Logger.createProgress('story-init', { stderr: true });

const stageLogger = {
  progress,
  warn: (msg) => Logger.error(msg),
  error: (msg) => Logger.error(`[story-init] ${msg}`),
};

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

/**
 * Orchestrate the Story initialization as a thin sequential pipeline over
 * the six stage modules in `lib/story-init/`.
 *
 * Exported for testing.
 */
export async function runStoryInit({
  storyId: storyIdParam,
  dryRun: dryRunParam,
  cwd: cwdParam,
  recutOf: recutOfParam,
  injectedProvider,
  injectedConfig,
} = {}) {
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          dryRun: !!dryRunParam,
          cwd: cwdParam ?? null,
          recutOf: recutOfParam ?? null,
        }
      : parseSprintArgs();
  const { storyId, dryRun } = parsed;
  const recutOf = recutOfParam ?? parsed.recutOf ?? null;
  // Worktree-aware cwd resolution: explicit param > --cwd flag > env > PROJECT_ROOT.
  const cwd = path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT);

  if (!storyId) {
    throw new Error('Usage: node story-init.js --story <STORY_ID> [--dry-run]');
  }

  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);
  const _notifyFn = (ticketId, payload, opts = {}) =>
    notify(ticketId, payload, { config, provider, ...opts });
  // Per-Task transition hook: GitHub-comment surface suppressed (the
  // Story-level summary below replaces the N per-Task comments with a
  // single message). The webhook channel is now gated by the
  // `notifications.webhookEvents` allowlist, so per-Task transitions
  // reach Slack only when the operator opts the `task-transition` event
  // into the allowlist — the default curated vocabulary (`epic-*` events)
  // excludes them.
  const notifyWebhookOnly = (ticketId, payload) =>
    notify(ticketId, payload, {
      config,
      provider,
      skipComment: true,
    });

  const runtime = resolveRuntime({ config });
  progress(
    'ENV',
    `worktreeIsolation=${runtime.worktreeEnabled ? 'on' : 'off'} (${runtime.worktreeEnabledSource})`,
  );
  progress(
    'ENV',
    `sessionId=${runtime.sessionId} (${runtime.sessionIdSource})`,
  );

  progress('INIT', `Initializing Story #${storyId}...`);

  // Stage 1 — context.
  const { story, body, epicId, featureId } = await resolveContext({
    provider,
    logger: stageLogger,
    input: { storyId, recutOf, dryRun },
  });

  // Stage 2 — hierarchy.
  const { prdId, techSpecId } = await traceHierarchy({
    provider,
    logger: stageLogger,
    input: { epicId },
  });

  progress(
    'CONTEXT',
    `Epic: #${epicId}, Feature/Parent: #${featureId ?? 'none'}`,
  );
  progress(
    'CONTEXT',
    `PRD: #${prdId ?? 'none'}, Tech Spec: #${techSpecId ?? 'none'}`,
  );

  // Stage 3 — blockers.
  const { openBlockers } = await validateBlockers({
    provider,
    logger: stageLogger,
    input: { body },
  });
  if (openBlockers.length > 0) {
    if (dryRun) {
      progress(
        'BLOCKERS',
        `⚠️ ${openBlockers.length} open blocker(s) detected (dry-run — not blocking):`,
      );
      for (const b of openBlockers) {
        progress('BLOCKERS', `   - #${b.id} "${b.title}" (${b.state})`);
      }
    } else {
      Logger.error(
        `\n❌ BLOCKED: Story #${storyId} is blocked by ${openBlockers.length} incomplete prerequisite(s):`,
      );
      for (const b of openBlockers) {
        Logger.error(`   - #${b.id} "${b.title}" (${b.state})`);
      }
      return { success: false, blocked: true, openBlockers };
    }
  }
  if (parseBlockedBy(body).length > 0)
    progress('BLOCKERS', '✅ All blockers resolved');

  // Stage 3.5 — dispatch-manifest dependency guard. Runs before any git
  // mutation so a halt leaves zero partial state behind.
  if (!dryRun) {
    const guard = await runDispatchManifestGuard({
      epicId,
      storyId,
      cwd,
      provider,
      config,
      logger: stageLogger,
    });
    if (guard.blocked) {
      return {
        success: false,
        blocked: true,
        reason: 'dispatch-manifest-blockers-unmerged',
        openBlockers: guard.openBlockers,
      };
    }
  }

  // Stage 4 — task graph. Pass the Story body and the resolved
  // planning.hierarchy through so buildTaskGraph can distinguish a 3-tier
  // (inline-acceptance) Story from a genuinely empty 4-tier Story when
  // emitting its progress/warn message.
  const { sortedTasks, mode: hierarchyMode } = await buildTaskGraph({
    provider,
    logger: stageLogger,
    input: {
      storyId,
      storyBody: body,
      hierarchy: config.planning?.hierarchy ?? null,
    },
  });

  // Stage 5 + 6 — branch and task-state transitions. Skipped under --dry-run.
  const epicBranch = getEpicBranch(epicId);
  const storyBranch = getStoryBranch(epicId, storyId);

  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'dry-run' };
  const wtConfig = config.delivery?.worktreeIsolation;
  const { worktreeEnabled } = runtime;

  // Per-phase timer. The init-side emits worktree-create / bootstrap /
  // install via the WorktreeManager `onPhase` callback, opens `implement`
  // at the end, and snapshots to `.git/` so story-close can restore
  // the open phase, append lint / test / close / api-sync, and upsert the
  // `phase-timings` structured comment.
  const phaseTimer = !dryRun ? createPhaseTimer(storyId) : null;

  if (!dryRun) {
    const branchResult = await initializeBranch({
      logger: stageLogger,
      input: {
        storyId,
        epicId,
        epicBranch,
        storyBranch,
        baseBranch: config.project?.baseBranch ?? 'main',
        cwd,
        worktreeEnabled,
        wtConfig,
        onPhase: (name) => phaseTimer.mark(name),
      },
    });
    workCwd = branchResult.workCwd;
    worktreeCreated = branchResult.worktreeCreated;
    installStatus = branchResult.installStatus ?? installStatus;

    // Story #2535 — write the per-Story dispatch state file under the
    // main repo's
    // `temp/epic-<id>/stories/story-<storyId>/story-init.state.json` so the
    // host-crash watchdog (`reconcileEpicAgentLabels`) can probe this
    // Story's dispatch PID and classify the Story as live / dead / unknown
    // instead of always falling back to `unknown`. Non-fatal: a failed
    // write only degrades the watchdog signal (the Story will classify as
    // `unknown` until the next dispatch), it must not block init.
    try {
      const stateWrite = writeDispatchStateFile({
        repoRoot: cwd,
        epicId,
        storyId,
        branch: storyBranch,
        worktreePath: workCwd,
      });
      progress(
        'WATCHDOG',
        `📍 Recorded dispatch state at ${stateWrite.path} (pid=${stateWrite.payload.dispatchPid})`,
      );
    } catch (err) {
      stageLogger.warn(
        `[story-init] ⚠️ Failed to record dispatch state: ${err?.message ?? err}`,
      );
    }

    // Propagate Epic + Story ids to the trace hook (Story #1043). The
    // hook in `lib/observability/tool-trace-hook.js` is a no-op when
    // these env vars are unset, so setting them here is what activates
    // the per-tool-call trace stream. We also export to `.env.local`
    // inside the worktree so the harness picks the values up on its
    // next agent spawn.
    try {
      setActiveStoryEnv({
        epicId,
        storyId,
        workCwd,
        logger: stageLogger,
      });
    } catch (err) {
      // Non-fatal: the trace hook degrades to a no-op without these
      // vars, which only loses observability. Warn and continue.
      stageLogger.warn(
        `[story-init] ⚠️ Failed to set active-Story env: ${err?.message ?? err}`,
      );
    }

    // Clear any stale validation-evidence file in the worktree so a re-run
    // of this Story (recut, branch-recreate, manual restart) always starts
    // with an empty evidence ledger. Story 7 / #830.
    try {
      const cleared = clearValidationEvidence(storyId, {
        cwd: workCwd,
        epicId,
      });
      if (cleared.cleared) {
        progress(
          'EVIDENCE',
          `🧹 Cleared stale validation-evidence at ${cleared.path}`,
        );
      }
    } catch (err) {
      // Non-fatal: a stale evidence file at worst forces a redundant gate
      // run. The skip predicate also re-validates SHA + config hash, so
      // staleness cannot mis-skip a real change.
      stageLogger.warn(
        `[story-init] ⚠️ Failed to clear validation evidence: ${err?.message ?? err}`,
      );
    }

    try {
      await transitionStoryToExecuting({
        provider,
        logger: stageLogger,
        input: { storyId, story, notify: notifyWebhookOnly },
      });
      progress('LABELS', `🏷️  Story #${storyId} → agent::executing`);
    } catch (err) {
      Logger.error(
        `\n❌ Story #${storyId} failed to transition to agent::executing: ${err?.message ?? err}`,
      );
      return {
        success: false,
        reason: 'story-transition-failure',
        error: err?.message ?? String(err),
      };
    }

    // Open the `implement` phase last so everything between now and the
    // first close-side mark attributes to agent coding time. Snapshot to
    // disk so close can pick up the open phase across the process gap.
    phaseTimer.mark('implement');
    try {
      savePhaseTimerState(phaseTimer, { mainCwd: cwd, storyId });
    } catch (err) {
      // Non-fatal: losing the snapshot only degrades observability, it
      // does not affect merge correctness. Warn and continue.
      Logger.error(
        `[story-init] ⚠️ Failed to persist phase-timer state: ${err.message}`,
      );
    }
  }

  const result = buildStoryInitResult({
    storyId,
    epicId,
    storyBranch,
    epicBranch,
    story,
    worktreeEnabled,
    workCwd,
    worktreeCreated,
    installStatus,
    sortedTasks,
    featureId,
    prdId,
    techSpecId,
    dryRun,
    recutOf,
    hierarchy: hierarchyMode,
  });

  emitStoryInitResult(result, {
    storyId,
    dryRun,
    taskCount: sortedTasks.length,
  });

  if (!dryRun) {
    await postStoryInitComment({
      provider,
      storyId,
      result,
      logger: stageLogger,
    });
  }

  return { success: true, result };
}

function buildStoryInitResult({
  storyId,
  epicId,
  storyBranch,
  epicBranch,
  story,
  worktreeEnabled,
  workCwd,
  worktreeCreated,
  installStatus,
  sortedTasks,
  featureId,
  prdId,
  techSpecId,
  dryRun,
  recutOf,
  hierarchy,
}) {
  const dependenciesInstalled = mapDependenciesInstalled(installStatus);
  return {
    storyId,
    epicId,
    storyBranch,
    epicBranch,
    storyTitle: story.title,
    // Hierarchy mode resolved by buildTaskGraph: `'3-tier'` when the Story
    // has inline acceptance (no child Tasks) under
    // `planning.hierarchy: '3-tier'`, otherwise `'4-tier'`. Threaded through
    // so downstream story-deliver-prepare can emit a Story-phase snapshot
    // shape (`phases[]`) instead of per-Task rows in 3-tier mode.
    hierarchy: hierarchy ?? '4-tier',
    worktreeEnabled,
    workCwd,
    worktreeCreated,
    installStatus,
    dependenciesInstalled,
    // Retained for back-compat with `temp/` artefacts and operator log
    // scrapers — derived from `installStatus.status === 'failed'`.
    installFailed: installStatus?.status === 'failed',
    recutOf: recutOf ?? null,
    tasks: sortedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      labels: t.labels,
      dependencies: t.dependsOn ?? parseBlockedBy(t.body ?? ''),
    })),
    context: { featureId, prdId, techSpecId },
    dryRun,
  };
}

/**
 * Map the structured install status to the workflow-facing tri-state string.
 * Workflow consumers (`story-deliver.md` Step 0.5) read this exact value
 * out of the `story-init` structured comment via
 * `gh issue view --json comments`.
 *
 * @param {{ status?: string }} installStatus
 * @returns {'true' | 'false' | 'skipped'}
 */
function mapDependenciesInstalled(installStatus) {
  switch (installStatus?.status) {
    case 'installed':
      return 'true';
    case 'failed':
      return 'false';
    default:
      return 'skipped';
  }
}

async function postStoryInitComment({ provider, storyId, result, logger }) {
  const body = renderStoryInitCommentBody(result);
  try {
    await upsertStructuredComment(provider, storyId, 'story-init', body);
    logger?.progress?.(
      'COMMENT',
      `📝 Upserted story-init structured comment on #${storyId} (dependenciesInstalled=${result.dependenciesInstalled})`,
    );
  } catch (err) {
    // Non-fatal: the structured comment is observability for downstream
    // workflow steps. Failing to post it must not block the agent's
    // implementation work — it can fall back to `installStatus` from the
    // stdout JSON. Surface the error so operators can investigate.
    logger?.warn?.(
      `[story-init] ⚠️ Failed to upsert story-init structured comment: ${err?.message ?? err}`,
    );
  }
}

/**
 * Render the markdown body for the `story-init` structured comment. Pure so
 * tests can assert the shape without a provider stub.
 *
 * @param {object} result Output of `buildStoryInitResult`.
 * @returns {string}
 */
export function renderStoryInitCommentBody(result) {
  const payload = {
    storyId: result.storyId,
    epicId: result.epicId,
    storyBranch: result.storyBranch,
    epicBranch: result.epicBranch,
    // Hierarchy mode (`'3-tier'` | `'4-tier'`) is persisted so
    // `story-deliver-prepare.js` can choose the snapshot shape without
    // re-resolving config + Story body in the worker.
    hierarchy: result.hierarchy ?? '4-tier',
    worktreeEnabled: result.worktreeEnabled,
    workCwd: result.workCwd,
    worktreeCreated: result.worktreeCreated,
    dependenciesInstalled: result.dependenciesInstalled,
    installStatus: result.installStatus,
    // Embed the canonical task list so `story-deliver-prepare.js` can seed the
    // initial `story-run-progress` snapshot without re-fetching the task graph.
    // Without this field, the prepare CLI silently seeded an empty snapshot,
    // breaking every subsequent `story-task-progress.js` call (it asserts the
    // task id is present in the snapshot).
    tasks: Array.isArray(result.tasks)
      ? result.tasks.map((t) => ({ id: t.id, title: t.title }))
      : [],
  };
  return [
    '## Story init',
    '',
    `- **dependenciesInstalled:** \`${result.dependenciesInstalled}\``,
    `- **installStatus.status:** \`${result.installStatus?.status ?? 'unknown'}\``,
    `- **installStatus.reason:** \`${result.installStatus?.reason ?? 'n/a'}\``,
    `- **worktreeEnabled:** \`${result.worktreeEnabled}\``,
    `- **worktreeCreated:** \`${result.worktreeCreated}\``,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n');
}

function emitStoryInitResult(result, { storyId, dryRun, taskCount }) {
  Logger.info('\n--- STORY INIT RESULT ---');
  Logger.info(JSON.stringify(result, null, 2));
  Logger.info('--- END RESULT ---\n');

  progress(
    'DONE',
    dryRun
      ? '✅ Dry-run complete. No git or ticket changes made.'
      : `✅ Story #${storyId} initialized. ${taskCount} Task(s) ready for implementation.`,
  );
}

// ---------------------------------------------------------------------------
// Main guard
// ---------------------------------------------------------------------------

runAsCli(import.meta.url, runStoryInit, { source: 'story-init' });
