/**
 * dispatch-pipeline.js
 *
 * Internal pipeline helpers composed by `dispatch-engine.js::dispatch()`.
 * Keeping these out of the coordinator keeps the public entry point compact
 * and focused on the 6-step flow: resolve → fetch → reconcile → graph →
 * scaffold → GC → dispatch.
 */

import { createAdapter } from '../adapter-factory.js';
import { PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { buildGraph, computeWaves, detectCycle } from '../Graph.js';
import { getEpicBranch } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { createProvider } from '../provider-factory.js';
import { WorktreeManager } from '../worktree-manager.js';
import { autoSerializeOverlaps } from './dependency-analyzer.js';
import { reconcileClosedTasks, reconcileHierarchy } from './reconciler.js';
import { parseTasks } from './task-fetcher.js';
import { collectOpenStoryIds } from './wave-dispatcher.js';

export const TYPE_TASK_LABEL = TYPE_LABELS.TASK;

/**
 * Runtime context for a single dispatch cycle.
 *
 * Produced by {@link resolveDispatchContext} and consumed by every pipeline
 * stage (fetch → reconcile → graph → scaffold → GC → dispatch). All fields
 * are resolved once up-front so downstream helpers can stay free of
 * configuration look-ups.
 *
 * @typedef {object} DispatchContext
 * @property {number} epicId                                  Epic ticket number under dispatch.
 * @property {boolean} dryRun                                 When true, mutating side-effects are skipped.
 * @property {object} settings                                Resolved `.agentrc.json` settings block.
 * @property {object} orchestration                           Resolved `.agentrc.json` `orchestration` block.
 * @property {import('../ITicketingProvider.js').ITicketingProvider} provider  Ticketing provider (may come from cache).
 * @property {object} adapter                                 Execution adapter (CLI / MCP / in-process).
 * @property {import('../worktree-manager.js').WorktreeManager | undefined} worktreeManager  Optional worktree manager (only when isolation is enabled and not dry-run).
 * @property {string} baseBranch                              Trunk branch the Epic branches from (default `main`).
 * @property {string} epicBranch                              Epic branch name (`epic/<epicId>`).
 * @property {(branchName: string, baseBranch: string) => void} ensureBranch  Caller-supplied branch-creation helper.
 */

/**
 * The output of {@link fetchEpicContext}.
 *
 * @typedef {object} FetchedEpic
 * @property {object} epic                 The Epic ticket record.
 * @property {object[]} allTickets         Every ticket under the Epic (tasks + stories + features + health).
 * @property {Map<number, object>} allTicketsById  Index of `allTickets` by ticket id.
 * @property {object[]} tasks              Parsed `type::task` records (see {@link parseTasks}).
 */

/**
 * Resolve the runtime context for a dispatch: settings, provider, adapter,
 * worktree manager, base/epic branch names, and the `ensureBranch` bound
 * helper supplied by the caller.
 *
 * @param {object} options                                    Dispatch entry options.
 * @param {number} options.epicId                             Epic ticket number.
 * @param {boolean} [options.dryRun=false]                    When true, skip branch creation and worktree setup.
 * @param {string} [options.executorOverride]                 Optional adapter-factory executor hint.
 * @param {import('../ITicketingProvider.js').ITicketingProvider} [options.provider]  Pre-constructed provider (overrides factory).
 * @param {object} [options.adapter]                          Pre-constructed adapter (overrides factory).
 * @param {import('../worktree-manager.js').WorktreeManager} [options.worktreeManager]  Pre-constructed worktree manager.
 * @param {(branchName: string, baseBranch: string) => void} ensureBranch  Branch-creation helper bound by caller (keeps engine ↔ git-lifecycle coupling at the edge).
 * @returns {DispatchContext}                                 Fully resolved dispatch context.
 */
export function resolveDispatchContext(options, ensureBranch) {
  const { epicId, dryRun = false, executorOverride } = options;

  const { settings, orchestration } = resolveConfig();
  const provider = options.provider ?? createProvider(orchestration);
  const adapter =
    options.adapter ??
    createAdapter(orchestration, { executor: executorOverride });

  const wtConfig = orchestration?.worktreeIsolation;
  let worktreeManager = options.worktreeManager;
  if (!worktreeManager && wtConfig?.enabled && !dryRun) {
    worktreeManager = new WorktreeManager({
      repoRoot: PROJECT_ROOT,
      config: wtConfig,
    });
  }

  return {
    epicId,
    dryRun,
    settings,
    orchestration,
    provider,
    adapter,
    worktreeManager,
    baseBranch: settings.baseBranch ?? 'main',
    epicBranch: getEpicBranch(epicId),
    ensureBranch,
  };
}

/**
 * Fetch Epic + all tickets, prime the provider cache, and parse the Task
 * subset.
 *
 * @param {DispatchContext} ctx  Dispatch context.
 * @returns {Promise<FetchedEpic>}  Epic + ticket graph.
 */
export async function fetchEpicContext(ctx) {
  const { provider, epicId } = ctx;

  Logger.info(`\nFetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  Logger.info(`Fetching all tickets under Epic #${epicId}...`);
  const allTickets = await provider.getTickets(epicId);
  const allTicketsById = new Map(allTickets.map((t) => [t.id, t]));

  provider.primeTicketCache(allTickets);

  Logger.info(`Filtering Tasks under Epic #${epicId}...`);
  const taskTickets = allTickets.filter((t) =>
    (t.labelSet ?? new Set(t.labels)).has(TYPE_TASK_LABEL),
  );
  const tasks = parseTasks(taskTickets);
  Logger.info(`Found ${tasks.length} task(s).`);

  return { epic, allTickets, allTicketsById, tasks };
}

/**
 * Propagate already-done work up the hierarchy so the manifest reflects
 * reality before dispatch.
 *
 * @param {DispatchContext} ctx  Dispatch context.
 * @param {FetchedEpic} fetched  Result of {@link fetchEpicContext}.
 * @returns {Promise<void>}
 */
export async function reconcileEpicState(ctx, fetched) {
  const { provider, dryRun, epicId } = ctx;
  const { epic, allTickets, tasks } = fetched;

  await reconcileClosedTasks(tasks, provider, dryRun);
  await reconcileHierarchy(provider, epicId, epic, tasks, allTickets, dryRun);
}

/**
 * Build the task DAG, serialize focus-area overlaps, and compute dispatch
 * waves.
 *
 * @param {object[]} tasks  Parsed task records (output of {@link parseTasks}).
 * @returns {{ allWaves: object[][], taskMap: Map<number, object> }}  Waves (array of task arrays) and id→task lookup.
 * @throws {Error} When the dependency graph contains a cycle — the error message lists the offending chain.
 */
export function buildDispatchGraph(tasks) {
  const { adjacency, taskMap } = buildGraph(tasks);

  const cycle = detectCycle(adjacency);
  if (cycle) {
    throw new Error(
      `[Dispatcher] Dependency cycle detected: ${cycle.join(' → ')}. ` +
        'Fix the ticket dependencies before re-running.',
    );
  }

  const { finalAdjacency, graphMutated } = autoSerializeOverlaps(
    { tasks },
    adjacency,
  );
  if (graphMutated) {
    Logger.info('Focus-area conflicts detected; serialized overlapping tasks.');
  }

  const allWaves = computeWaves(finalAdjacency, taskMap);
  Logger.info(`Computed ${allWaves.length} execution wave(s).`);
  return { allWaves, taskMap };
}

/**
 * Ensure the Epic base branch exists and capture a lint baseline. Skipped
 * in dry-run.
 *
 * @param {DispatchContext} ctx  Dispatch context.
 * @param {(epicBranch: string, settings: object) => (Promise<void> | void)} captureLintBaseline  Injected baseline-capture implementation (legacy function or `LintBaselineService.capture`-bound closure).
 * @returns {void}
 */
export function ensureEpicScaffolding(ctx, captureLintBaseline) {
  const { dryRun, epicBranch, baseBranch, settings, ensureBranch } = ctx;
  if (dryRun) {
    Logger.info('Dry-run mode: skipping branch creation.');
    return;
  }
  Logger.info(`Ensuring Epic base branch: ${epicBranch}`);
  ensureBranch(epicBranch, baseBranch);
  captureLintBaseline(epicBranch, settings);
}

/**
 * Reap orphaned story worktrees. No-op when isolation is disabled or dry-run.
 *
 * Swallows manager errors — worktree GC must never fail a dispatch cycle.
 *
 * @param {DispatchContext} ctx  Dispatch context.
 * @param {FetchedEpic} fetched  Ticket graph used to compute the set of still-open stories.
 * @returns {Promise<void>}
 */
export async function runWorktreeGc(ctx, fetched) {
  const { worktreeManager, dryRun, epicBranch } = ctx;
  if (!worktreeManager || dryRun) return;
  try {
    const lockSweep = await worktreeManager.sweepStaleLocks();
    if (lockSweep.removed.length > 0) {
      Logger.info(
        `Stale lock sweep removed ${lockSweep.removed.length} file(s).`,
      );
    }
    const openStoryIds = collectOpenStoryIds(
      fetched.tasks,
      fetched.allTicketsById,
      {
        reapOnCancel:
          ctx.orchestration?.worktreeIsolation?.reapOnCancel ?? true,
      },
    );
    const gcResult = await worktreeManager.gc(openStoryIds, { epicBranch });
    if (gcResult.reaped.length > 0) {
      Logger.info(`Worktree GC reaped ${gcResult.reaped.length} orphan(s).`);
    }
  } catch (err) {
    Logger.warn(`Worktree GC failed (non-fatal): ${err.message}`);
  }
}
