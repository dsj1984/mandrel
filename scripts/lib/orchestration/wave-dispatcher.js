/**
 * wave-dispatcher.js
 *
 * Wave iteration, eligible-task filtering, and per-task dispatch for the
 * orchestration SDK. Split out of dispatch-engine so wave-iteration can be
 * unit-tested without mocking risk gates or health services.
 */

import fs from 'node:fs';
import { PROJECT_ROOT } from '../config-resolver.js';
import { branchExistsLocally } from '../git-branch-lifecycle.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { hydrateContext } from './context-hydration-engine.js';
import { getResolvedBranch } from './manifest-builder.js';
import { STATE_LABELS } from './ticketing.js';

export const AGENT_DONE_LABEL = STATE_LABELS.DONE;
export const AGENT_EXECUTING_LABEL = STATE_LABELS.EXECUTING;
export const AGENT_READY_LABEL = STATE_LABELS.READY;

// Bounded concurrency ceiling for wave dispatch. Mirrors the default used by
// `batchTransitionTickets` in story-lifecycle.js.
const DISPATCH_CONCURRENCY = 10;

/**
 * Collect story IDs whose tasks are not all done. These are the worktrees
 * GC must keep alive; everything else is fair game.
 *
 * @param {object[]} tasks - Parsed task tickets under the Epic.
 * @param {Map<number, object>} allTicketsById - Hierarchy lookup.
 * @param {{ reapOnCancel?: boolean }} [opts]
 * @returns {number[]}
 */
export function collectOpenStoryIds(tasks, allTicketsById, opts = {}) {
  const reapOnCancel = opts.reapOnCancel ?? true;
  const open = new Set();
  for (const task of tasks) {
    if (task.status === AGENT_DONE_LABEL) continue;
    const parentMatch = task.body?.match(/parent:\s*#(\d+)/i);
    if (!parentMatch) continue;
    const parentId = Number.parseInt(parentMatch[1], 10);
    const parent = allTicketsById.get(parentId);
    if (!parent?.labels.includes(TYPE_LABELS.STORY)) continue;

    // Cancelled story: ticket is closed but was not completed via agent::done.
    // When reapOnCancel is enabled, treat it as no longer live so GC can reap
    // its worktree. When disabled, keep the worktree alive for manual recovery.
    const isCancelledStory =
      parent.state === 'closed' && !parent.labels.includes(AGENT_DONE_LABEL);
    if (isCancelledStory && reapOnCancel) continue;

    open.add(parentId);
  }
  return [...open];
}

/**
 * Dispatch a single eligible task within a wave.
 *
 * @param {object} task
 * @param {object} ctx - Dispatch context (provider, adapter, settings, etc.).
 */
async function dispatchTaskInWave(task, ctx) {
  const { provider, adapter, allTicketsById, epicId, epicBranch, dryRun } = ctx;

  const taskBranch = getResolvedBranch(task, allTicketsById, epicId);
  const storyMatch = taskBranch.match(/^story-(\d+)$/);

  const hydratedPrompt = await hydrateContext(
    task,
    provider,
    epicBranch,
    taskBranch,
    epicId,
  );

  const taskDispatch = {
    taskId: task.id,
    epicId,
    branch: taskBranch,
    epicBranch,
    prompt: hydratedPrompt,
    persona: task.persona,
    mode: task.mode,
    skills: task.skills,
    focusAreas: task.focusAreas,
    metadata: {
      title: task.title,
      protocolVersion: task.protocolVersion,
      dispatchedAt: new Date().toISOString(),
    },
  };

  if (dryRun) {
    Logger.info(`[DRY-RUN] Would dispatch Task #${task.id}: ${task.title}`);
    return {
      taskId: task.id,
      dispatchId: `dry-run-${task.id}`,
      status: 'dispatched',
    };
  }

  // JIT-only: story branches and worktrees are created exclusively by
  // story-init (invoked via `/epic-execute #<storyId>`). If the
  // story hasn't been initialized yet, skip its tasks so the operator can
  // start that story explicitly — never create it as a side effect of
  // Epic-level dispatch.
  if (storyMatch) {
    const storyId = Number.parseInt(storyMatch[1], 10);
    const wm = ctx.worktreeManager;
    const initialized = wm
      ? fs.existsSync(wm.pathFor(storyId))
      : branchExistsLocally(taskBranch, PROJECT_ROOT);

    if (!initialized) {
      Logger.info(
        `⏭️  Skipping Task #${task.id}: Story #${storyId} not initialized. ` +
          `Run \`/epic-execute #${storyId}\` to begin this story.`,
      );
      return { taskId: task.id, status: 'skipped-not-initialized' };
    }

    if (wm) {
      taskDispatch.cwd = wm.pathFor(storyId);
    }
  } else {
    // Non-story (task-level) branches remain eligible for JIT creation at
    // dispatch time — they have no separate init step.
    ctx.ensureBranch(taskBranch, epicBranch);
  }

  await provider.updateTicket(task.id, {
    labels: { add: [AGENT_EXECUTING_LABEL], remove: [AGENT_READY_LABEL] },
  });

  const result = await adapter.dispatchTask(taskDispatch);
  Logger.info(
    `✅ Dispatched Task #${task.id} — dispatchId: ${result.dispatchId}`,
  );
  return { taskId: task.id, ...result };
}

/**
 * Dispatch one wave. Returns `{ dispatched, shouldHalt, empty }`.
 * `shouldHalt=true` means upstream deps not complete; caller stops iterating.
 *
 * @param {object[]} wave
 * @param {Map<number, object>} taskMap
 * @param {object} ctx
 */
export async function dispatchWave(wave, taskMap, ctx) {
  const eligible = wave.filter(
    (t) => t.status !== AGENT_DONE_LABEL && t.status !== AGENT_EXECUTING_LABEL,
  );

  if (eligible.length === 0) {
    Logger.info('Wave fully complete, moving to next...');
    return {
      dispatched: [],
      shouldHalt: false,
      empty: true,
    };
  }

  const waveDepsComplete = eligible.every((task) =>
    task.dependsOn.every((depId) => {
      const dep = taskMap.get(depId);
      return dep?.status === AGENT_DONE_LABEL;
    }),
  );
  if (!waveDepsComplete) {
    Logger.info('Wave dependencies not yet complete. Halting.');
    return {
      dispatched: [],
      shouldHalt: true,
      empty: false,
    };
  }

  const dispatched = [];

  // Tasks in the same wave have their dependencies satisfied, so they are
  // independent by construction. Dispatch them concurrently (bounded) so a
  // 10-task wave takes ~max(dispatch time) instead of ~sum(dispatch times).
  const concurrency = ctx.dispatchConcurrency ?? DISPATCH_CONCURRENCY;
  const results = new Array(eligible.length);
  for (let i = 0; i < eligible.length; i += concurrency) {
    const slice = eligible.slice(i, i + concurrency);
    const sliceResults = await Promise.all(
      slice.map(async (task) => {
        return {
          kind: 'dispatched',
          value: await dispatchTaskInWave(task, ctx),
        };
      }),
    );
    for (let k = 0; k < sliceResults.length; k++) {
      results[i + k] = sliceResults[k];
    }
  }

  for (const entry of results) {
    dispatched.push(entry.value);
  }
  return { dispatched, shouldHalt: false, empty: false };
}

/**
 * Walk the wave list, dispatching the first non-empty, dependency-ready
 * wave. Returns the list of dispatched tasks.
 *
 * @param {object} ctx
 * @param {{ tasks: object[], allTicketsById: Map<number, object> }} fetched
 * @param {object[][]} allWaves
 * @param {Map<number, object>} taskMap
 */
export async function dispatchNextWave(ctx, fetched, allWaves, taskMap) {
  const dispatched = [];

  const waveCtx = {
    provider: ctx.provider,
    adapter: ctx.adapter,
    allTicketsById: fetched.allTicketsById,
    epicId: ctx.epicId,
    epicBranch: ctx.epicBranch,
    dryRun: ctx.dryRun,
    worktreeManager: ctx.worktreeManager,
    orchestration: ctx.orchestration,
    ensureBranch: ctx.ensureBranch,
  };

  for (const wave of allWaves) {
    const waveResult = await dispatchWave(wave, taskMap, waveCtx);
    if (waveResult.empty) continue;
    if (waveResult.shouldHalt) break;
    dispatched.push(...waveResult.dispatched);
    // Only dispatch one wave per invocation
    break;
  }

  return { dispatched };
}
