/**
 * dispatch-pipeline.js
 *
 * Internal pipeline helpers composed by `dispatch-engine.js::dispatch()`.
 * Keeping these out of the coordinator keeps the public entry point compact
 * and focused on the 2-tier flow: resolve → fetch → Story-graph.
 */

import { PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { getEpicBranch } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { createProvider } from '../provider-factory.js';
import { buildStoryAdjacency } from '../story-adjacency.js';
import { WorktreeManager } from '../worktree-manager.js';
import { computeStoryWaves } from './dependency-analyzer.js';

/**
 * Runtime context for a single dispatch cycle.
 *
 * Produced by {@link resolveDispatchContext} and consumed by every pipeline
 * stage (fetch → graph → scaffold → GC → dispatch). All fields
 * are resolved once up-front so downstream helpers can stay free of
 * configuration look-ups.
 *
 * @typedef {object} DispatchContext
 * @property {number} epicId                                  Epic ticket number under dispatch.
 * @property {boolean} dryRun                                 When true, mutating side-effects are skipped.
 * @property {object} config                                  Resolved canonical `.agentrc.json` (with `project`, `github`, `planning`, `delivery` blocks).
 * @property {import('../ITicketingProvider.js').ITicketingProvider} provider  Ticketing provider (may come from cache).
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
 * @property {object[]} allTickets         Every ticket under the Epic (stories + health).
 * @property {Map<number, object>} allTicketsById  Index of `allTickets` by ticket id.
 */

/**
 * Resolve the runtime context for a dispatch: canonical config, provider, adapter,
 * worktree manager, base/epic branch names, and the `ensureBranch` bound
 * helper supplied by the caller.
 *
 * @param {object} options                                    Dispatch entry options.
 * @param {number} options.epicId                             Epic ticket number.
 * @param {boolean} [options.dryRun=false]                    When true, skip branch creation and worktree setup.
 * @param {import('../ITicketingProvider.js').ITicketingProvider} [options.provider]  Pre-constructed provider (overrides factory).
 * @param {import('../worktree-manager.js').WorktreeManager} [options.worktreeManager]  Pre-constructed worktree manager.
 * @param {(branchName: string, baseBranch: string) => void} ensureBranch  Branch-creation helper bound by caller (keeps engine ↔ git-lifecycle coupling at the edge).
 * @returns {DispatchContext}                                 Fully resolved dispatch context.
 */
export function resolveDispatchContext(options, ensureBranch) {
  const { epicId, dryRun = false } = options;

  const config = resolveConfig();
  const provider = options.provider ?? createProvider(config);

  const wtConfig = config?.delivery?.worktreeIsolation;
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
    config,
    provider,
    worktreeManager,
    baseBranch: config?.project?.baseBranch ?? 'main',
    epicBranch: getEpicBranch(epicId),
    ensureBranch,
  };
}

/**
 * Fetch Epic + all tickets and prime the provider cache.
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

  return { epic, allTickets, allTicketsById };
}

/**
 * Detect 2-tier hierarchy from the fetched ticket graph. After Epic #3163's
 * hard cutover deleted the `type::task` ticket layer, shape selection is
 * purely structural: any Epic carrying at least one `type::story` ticket
 * resolves to 2-tier.
 *
 * @param {object[]} allTickets
 * @returns {boolean}
 */
export function isTwoTierDispatch(allTickets) {
  if (!Array.isArray(allTickets) || allTickets.length === 0) return false;
  return allTickets.some((t) =>
    (t.labelSet ?? new Set(t.labels ?? [])).has(TYPE_LABELS.STORY),
  );
}

/**
 * Build the Story-level dispatch graph for a 2-tier Epic. Reads story
 * tickets from `allTickets`, parses cross-Story `blocked by` references
 * from each Story body (also honoring an optional `dependencies[]`
 * field set by fixture providers), and computes wave indices via
 * {@link computeStoryWaves}.
 *
 * The returned `allWaves` is an array of Story-ticket arrays, ordered by
 * wave index. `storyMap` indexes the same Story tickets by id for downstream
 * lookups (mirrors the `taskMap` returned by {@link buildDispatchGraph}).
 *
 * Stories with no resolvable wave (cycle pre-filter, missing in groups)
 * are placed in their own trailing wave so they remain visible in the
 * manifest output.
 *
 * @param {object[]} allTickets  Fetched ticket graph (Epic + Stories).
 * @returns {{ allWaves: object[][], storyMap: Map<number, object> }}
 * @throws {Error} When the Story dependency graph contains a cycle.
 */
export function buildStoryDispatchGraph(allTickets) {
  const stories = (allTickets ?? []).filter((t) =>
    (t.labelSet ?? new Set(t.labels ?? [])).has(TYPE_LABELS.STORY),
  );
  const storyMap = new Map(stories.map((s) => [s.id, s]));

  // Shared story-level adjacency builder (lib/story-adjacency.js) owns the
  // dependency-source ordering contract: body `blocked by` references via
  // `parseBlockedBy`, then explicit `dependencies[]`, foreign edges dropped.
  const explicitDeps = buildStoryAdjacency(stories);

  // computeStoryWaves expects a Map<storyId, { tasks: [] }>; with no Tasks
  // present, only explicitDeps + focus-area rollup (no-op for empty
  // task lists) drive wave assignment.
  const storyGroups = new Map(
    stories.map((s) => [s.id, { storyId: s.id, tasks: [] }]),
  );
  const waveAssignment = computeStoryWaves(storyGroups, explicitDeps);

  // Bucket stories by wave index. `computeStoryWaves` returns -1 for any
  // story it could not place; route those into a trailing bucket so they
  // still surface in the manifest.
  const byWave = new Map();
  let maxWave = -1;
  for (const story of stories) {
    const wave = waveAssignment.get(story.id) ?? -1;
    if (wave > maxWave) maxWave = wave;
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push(story);
  }

  const allWaves = [];
  for (let i = 0; i <= maxWave; i++) {
    if (byWave.has(i)) allWaves.push(byWave.get(i));
  }
  if (byWave.has(-1)) allWaves.push(byWave.get(-1));

  Logger.info(
    `Computed ${allWaves.length} Story-level execution wave(s) (2-tier).`,
  );
  return { allWaves, storyMap };
}
