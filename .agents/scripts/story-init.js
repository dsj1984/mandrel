#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-init.js — Story Execution Initialization
 *
 * Deterministic script that replaces Steps 0-2 of the sprint-execute
 * Mode B workflow. Performs all pre-implementation setup by composing six
 * pipeline stages from `lib/story-init/`:
 *
 *   1. context-resolver     — fetch the Story + optionally mark as recut.
 *   2. hierarchy-tracer     — resolve Feature/Epic → PRD / Tech Spec.
 *   3. blocker-validator    — refuse to proceed while dependencies are open.
 *   4. task-graph-builder   — fetch + topologically sort child Tasks.
 *   5. branch-initializer   — materialise the story branch (single-tree
 *                             checkout or isolated worktree).
 *   6. state-transitioner   — batch-flip child Tasks to `agent::executing`.
 *
 * Usage:
 *   node story-init.js --story <STORY_ID> [--dry-run]
 *
 * Exit codes:
 *   0 — Initialization complete. Agent can start implementation.
 *   1 — Blocked or error (details in stderr).
 *
 * @see .agents/workflows/story-execute.md
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
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { validateBlockers } from './lib/story-init/blocker-validator.js';
import { initializeBranch } from './lib/story-init/branch-initializer.js';
import { resolveContext } from './lib/story-init/context-resolver.js';
import { runDispatchManifestGuard } from './lib/story-init/dependency-guard.js';
import { traceHierarchy } from './lib/story-init/hierarchy-tracer.js';
import { transitionTaskStates } from './lib/story-init/state-transitioner.js';
import { buildTaskGraph } from './lib/story-init/task-graph-builder.js';
import { postBatchedTransitionSummary } from './lib/story-init/transition-summary.js';
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
  warn: (msg) => console.error(msg),
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
    Logger.fatal('Usage: node story-init.js --story <STORY_ID> [--dry-run]');
  }

  const config = injectedConfig || resolveConfig({ cwd });
  const { settings, orchestration } = config;
  const provider = injectedProvider || createProvider(orchestration);
  const notifyFn = (ticketId, payload) =>
    notify(ticketId, payload, { orchestration, provider });
  // Per-Task transition hook: keeps the webhook fanout intact (so operators
  // running with `notifications.minLevel: low` still see one webhook per
  // Task) but suppresses the GitHub-comment surface. The Story-level
  // summary below replaces the N per-Task comments with a single message.
  const notifyWebhookOnly = (ticketId, payload) =>
    notify(ticketId, payload, {
      orchestration,
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
      console.error(
        `\n❌ BLOCKED: Story #${storyId} is blocked by ${openBlockers.length} incomplete prerequisite(s):`,
      );
      for (const b of openBlockers) {
        console.error(`   - #${b.id} "${b.title}" (${b.state})`);
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
      orchestration,
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

  // Stage 4 — task graph.
  const { sortedTasks } = await buildTaskGraph({
    provider,
    logger: stageLogger,
    input: { storyId },
  });

  // Stage 5 + 6 — branch and task-state transitions. Skipped under --dry-run.
  const epicBranch = getEpicBranch(epicId);
  const storyBranch = getStoryBranch(epicId, storyId);

  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'dry-run' };
  const wtConfig = orchestration?.worktreeIsolation;
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
        epicBranch,
        storyBranch,
        baseBranch: settings.baseBranch ?? 'main',
        cwd,
        worktreeEnabled,
        wtConfig,
        onPhase: (name) => phaseTimer.mark(name),
      },
    });
    workCwd = branchResult.workCwd;
    worktreeCreated = branchResult.worktreeCreated;
    installStatus = branchResult.installStatus ?? installStatus;

    // Clear any stale validation-evidence file in the worktree so a re-run
    // of this Story (recut, branch-recreate, manual restart) always starts
    // with an empty evidence ledger. Story 7 / #830.
    try {
      const cleared = clearValidationEvidence(storyId, { cwd: workCwd });
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

    const transition = await transitionTaskStates({
      provider,
      logger: stageLogger,
      input: { tasks: sortedTasks, notify: notifyWebhookOnly },
    });
    if (!transition.ok) {
      const failedSummary = transition.failed
        .map((f) => `#${f.id} (${f.attempts}x: ${f.error})`)
        .join(', ');
      const continueOnPartial =
        orchestration?.storyInit?.continueOnPartialTransition === true;
      if (continueOnPartial) {
        progress(
          'TICKETS',
          `⚠️ ${transition.failed.length} task(s) failed to transition after retries: ${failedSummary}. Continuing (continueOnPartialTransition=true) — agent may be working with stale state.`,
        );
      } else {
        console.error(
          `\n❌ ${transition.failed.length} task(s) failed to transition after retries: ${failedSummary}`,
        );
        console.error(
          'Story init aborted. Fix the underlying error and re-run, or set ' +
            '`orchestration.storyInit.continueOnPartialTransition: true` to opt into ' +
            'the old lenient behavior.',
        );
        return {
          success: false,
          reason: 'partial-transition-failure',
          failed: transition.failed,
        };
      }
    }

    // Replace the N per-Task `agent::executing` comments (suppressed above
    // via `notifyWebhookOnly`) with one Story-level summary. Routed through
    // the standard `notifyFn` so `commentMinLevel` / `minLevel` still gate
    // delivery — at the default `medium` threshold this is a no-op.
    try {
      await postBatchedTransitionSummary({
        notify: notifyFn,
        storyId,
        transitioned: transition.transitioned ?? [],
      });
    } catch (err) {
      console.error(
        `[story-init] ⚠️ Failed to post batched transition summary: ${err.message}`,
      );
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
      console.error(
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
}) {
  const dependenciesInstalled = mapDependenciesInstalled(installStatus);
  return {
    storyId,
    epicId,
    storyBranch,
    epicBranch,
    storyTitle: story.title,
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
 * Workflow consumers (`story-execute.md` Step 0.5) read this exact value
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
    worktreeEnabled: result.worktreeEnabled,
    workCwd: result.workCwd,
    worktreeCreated: result.worktreeCreated,
    dependenciesInstalled: result.dependenciesInstalled,
    installStatus: result.installStatus,
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
  console.log('\n--- STORY INIT RESULT ---');
  console.log(JSON.stringify(result, null, 2));
  console.log('--- END RESULT ---\n');

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
