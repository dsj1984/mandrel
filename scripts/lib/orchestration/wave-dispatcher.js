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
import { hydrateContext, parseHierarchy } from './context-hydration-engine.js';
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
 * @param {object} ctx - Dispatch context (provider, settings, etc.).
 */
async function dispatchTaskInWave(task, ctx) {
  const { provider, allTicketsById, epicId, epicBranch, dryRun } = ctx;

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
  // story-init (invoked via `/epic-deliver #<storyId>`). If the
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
          `Run \`/epic-deliver #${storyId}\` to begin this story.`,
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

  // Inline dispatch record (Epic #2646 / Story #2688): the IExecutionAdapter
  // abstraction has been deleted. Completion is tracked via GitHub
  // `agent::*` labels, not via the dispatchId/status returned here — but
  // the manifest's `dispatched[]` array still carries the record shape for
  // operator visibility, so we synthesize a monotonic id locally.
  const dispatchId = `${task.id}-${Date.now().toString(36)}`;
  const result = { dispatchId, status: 'dispatched' };
  Logger.info(`✅ Dispatched Task #${task.id} — dispatchId: ${dispatchId}`);
  return { taskId: task.id, ...result };
}

/**
 * Collect the unique (Epic, Tech Spec, Story) ticket IDs referenced by
 * an iterable of Task tickets. Pulls hierarchy keys from each Task body
 * via {@link parseHierarchy} and de-duplicates them. Exported so the
 * per-wave prime path is testable in isolation.
 *
 * Story #1795 — used by `primeWaveHierarchy` to pre-load the hierarchy
 * ticket cache once per wave so subsequent per-Task hydration is served
 * from the provider's in-process ticket cache.
 *
 * @param {Iterable<object>} tasks
 * @param {number} [epicId] — optional fallback when a task body omits
 *   the `Epic: #N` reference (e.g. orphan-recovery paths).
 * @returns {number[]} unique hierarchy IDs in deterministic order.
 */
export function collectHierarchyIds(tasks, epicId) {
  const ids = new Set();
  if (Number.isInteger(epicId) && epicId > 0) ids.add(epicId);
  for (const task of tasks ?? []) {
    const keys = parseHierarchy(task?.body ?? '');
    for (const k of ['epic', 'techspec', 'story']) {
      const v = keys[k];
      if (Number.isInteger(v) && v > 0) ids.add(v);
    }
  }
  return [...ids];
}

/**
 * Pre-load the provider's ticket cache with the Epic, Tech Spec, and
 * Story tickets referenced by every eligible Task in a wave. Issues at
 * most one `getTicket` per unique hierarchy ID end-to-end; subsequent
 * `hydrateContext` calls in `dispatchTaskInWave` serve those reads
 * from cache.
 *
 * Best-effort: a fetch failure for any single ID is logged and the rest
 * of the wave proceeds. The provider's hydration path falls back to a
 * direct (uncached) read in that case, preserving existing behaviour.
 *
 * @param {object[]} eligibleTasks
 * @param {{ provider: object, epicId?: number }} ctx
 * @returns {Promise<{ primed: number[] }>}
 */
export async function primeWaveHierarchy(eligibleTasks, ctx) {
  const provider = ctx?.provider;
  if (!provider || typeof provider.primeTicketCache !== 'function') {
    return { primed: [] };
  }
  if (typeof provider.getTicket !== 'function') {
    return { primed: [] };
  }
  const ids = collectHierarchyIds(eligibleTasks, ctx?.epicId);
  if (ids.length === 0) return { primed: [] };
  const tickets = await Promise.all(
    ids.map((id) =>
      provider.getTicket(id).catch((err) => {
        Logger.warn(
          `[wave-dispatcher] prime fetch failed for #${id}: ${
            err?.message ?? err
          }`,
        );
        return null;
      }),
    ),
  );
  const seeded = tickets.filter((t) => t && typeof t === 'object');
  if (seeded.length > 0) {
    provider.primeTicketCache(seeded);
  }
  return { primed: seeded.map((t) => t.id) };
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

  // Story #1795 — pre-load the (Epic, Tech Spec, Story) hierarchy
  // tickets for every eligible Task in this wave so per-Task hydration
  // (`dispatchTaskInWave` → `hydrateContext`) is served from the
  // provider's in-process cache. Issues at most one `getTicket` per
  // unique hierarchy id end-to-end. Best-effort: a fetch failure
  // logs and the wave proceeds — the existing per-Task fallback path
  // reads the missing ticket uncached.
  await primeWaveHierarchy(eligible, ctx);

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
