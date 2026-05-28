/**
 * lib/orchestration/dispatch-engine.js — Core Dispatch Engine (SDK coordinator)
 *
 * Thin facade composing:
 *   - `wave-dispatcher.js`          — wave iteration + per-task dispatch
 *   - `epic-lifecycle-detector.js`  — epic-completion + bookend fire
 *   - `dispatch-pipeline.js`        — internal resolve/fetch/reconcile/graph/scaffold/GC helpers
 *
 * Consumers (dispatcher.js, tests) import the same public symbols from this
 * path as before — the split is an internal code re-organisation only.
 */

import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { ConflictingTypeLabelsError } from '../errors/index.js';
import { ensureLocalBranch } from '../git-branch-lifecycle.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { createProvider } from '../provider-factory.js';
import {
  buildDispatchGraph,
  buildStoryDispatchGraph,
  ensureEpicScaffolding,
  fetchEpicContext,
  isThreeTierDispatch,
  reconcileEpicState,
  resolveDispatchContext,
  runWorktreeGc,
} from './dispatch-pipeline.js';
import { detectEpicCompletion } from './epic-lifecycle-detector.js';
import { LintBaselineService } from './lint-baseline-service.js';
import { buildManifest } from './manifest-builder.js';
import { executeStory } from './story-executor.js';
import { STATE_LABELS } from './ticketing.js';
import { collectOpenStoryIds, dispatchNextWave } from './wave-dispatcher.js';

export const AGENT_DONE_LABEL = STATE_LABELS.DONE;
export const AGENT_EXECUTING_LABEL = STATE_LABELS.EXECUTING;
export const AGENT_READY_LABEL = STATE_LABELS.READY;
export { collectOpenStoryIds, detectEpicCompletion };

/* node:coverage ignore next */
export function ensureBranch(branchName, baseBranch) {
  ensureLocalBranch(branchName, baseBranch, PROJECT_ROOT, {
    log: (msg) => Logger.info(msg),
  });
}

/**
 * Default exec adapter used by the orchestrator's {@link LintBaselineService}.
 * Thin wrapper around `execFileSync` — kept here (not inside the service)
 * so the service stays unaware of `node:child_process` and unit tests can
 * substitute a mocked adapter.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {void}
 */
/* node:coverage ignore next */
function defaultLintBaselineExec(file, args, options) {
  execFileSync(file, args, options);
}

/**
 * Back-compat shim. Constructs a throwaway {@link LintBaselineService} with
 * the default exec adapter and invokes `capture()`. New call-sites should
 * instantiate the service directly and inject the exec adapter.
 *
 * @param {string} epicBranch
 * @param {object} settings
 * @returns {Promise<void>}
 */
/* node:coverage ignore next */
export async function captureLintBaseline(epicBranch, settings) {
  const service = new LintBaselineService({
    exec: defaultLintBaselineExec,
    logger: Logger,
    settings,
  });
  await service.capture(epicBranch);
}

/**
 * Resolve a single ticket ID, detect its type, and delegate to the
 * appropriate execution pipeline. Single entry point shared by the CLI
 * wrapper and the MCP `dispatch_wave` tool.
 */
export async function resolveAndDispatch(options) {
  const { ticketId, dryRun = false } = options;
  const config = resolveConfig();
  const provider = options.provider ?? createProvider(config);

  const ticket = await provider.getTicket(ticketId);
  const labels = ticket.labels || [];

  const typeLabels = labels.filter((l) => l.startsWith('type::'));
  if (typeLabels.length > 1) {
    throw new ConflictingTypeLabelsError(
      `Ticket #${ticketId} has conflicting type labels: ${typeLabels.join(', ')}. Exactly one type::* label is required.`,
    );
  }

  const isStory = labels.includes(TYPE_LABELS.STORY);
  const isEpic = labels.includes(TYPE_LABELS.EPIC);
  const isFeature = labels.includes(TYPE_LABELS.FEATURE);

  if (isStory) {
    return executeStory({ story: ticket, provider, dryRun });
  }

  if (isEpic) {
    return dispatch({ epicId: ticketId, dryRun, provider });
  }

  if (isFeature) {
    throw new Error(
      `[Dispatcher] Ticket #${ticketId} is a **Feature**. Features are containers and cannot be executed directly. ` +
        `Please execute individual Stories within this Feature using \`/epic-deliver #[Story ID]\`, ` +
        `or dispatch the entire Epic using \`/epic-deliver #${ticket.body?.match(/^parent:\s*#(\d+)/m)?.[1] || 'ID'}\`.`,
    );
  }

  const typeLabel = labels.find((l) => l.startsWith('type::')) || 'unknown';
  throw new Error(
    `[Dispatcher] Ticket #${ticketId} has type "${typeLabel.replace('type::', '')}". ` +
      `Only "epic" or "story" tickets can be dispatched. ` +
      `Please ensure the ticket is correctly categorized before execution.`,
  );
}

/**
 * Main dispatcher. Orchestrates one dispatch cycle for an Epic.
 * Primary public export of the orchestration SDK.
 */
export async function dispatch(options) {
  const ctx = resolveDispatchContext(options, ensureBranch);
  const { epicId, dryRun, provider } = ctx;

  const fetched = await fetchEpicContext(ctx);
  await reconcileEpicState(ctx, fetched);

  // 3-tier hierarchy: compute Story-level waves directly from Story
  // tickets. The runtime fan-out (`dispatchNextWave`) is Task-centric and
  // does not yet handle Story-level dispatch — that wiring lands in a
  // follow-on Story (S3.3+). For now we still emit a 3-tier-shaped
  // manifest with `waves[].stories[]` so downstream consumers
  // (manifest renderer, /epic-deliver wave planner) see the correct
  // execution plan without dispatching any Tasks.
  if (isThreeTierDispatch(fetched.allTickets)) {
    Logger.info(
      'Detected 3-tier hierarchy — computing Story-level execution waves.',
    );
    const { allWaves: storyWaves } = buildStoryDispatchGraph(
      fetched.allTickets,
    );
    return buildManifest({
      epicId,
      epic: fetched.epic,
      tasks: [],
      allTickets: fetched.allTickets,
      waves: storyWaves,
      dispatched: [],
      dryRun,
      hierarchy: '3-tier',
    });
  }

  if (fetched.tasks.length === 0) {
    Logger.info('No tasks found. Nothing to dispatch.');
    return buildManifest({
      epicId,
      epic: fetched.epic,
      tasks: [],
      allTickets: [],
      waves: [],
      dispatched: [],
      dryRun,
    });
  }

  const { allWaves, taskMap } = buildDispatchGraph(fetched.tasks);
  const lintBaselineService =
    options.lintBaselineService ??
    new LintBaselineService({
      exec: defaultLintBaselineExec,
      logger: Logger,
      settings: {
        paths: ctx.config?.project?.paths,
        quality: ctx.config?.delivery?.quality,
      },
    });
  ensureEpicScaffolding(ctx, (epicBranch) =>
    lintBaselineService.capture(epicBranch),
  );
  await runWorktreeGc(ctx, fetched);

  const { dispatched } = await dispatchNextWave(
    ctx,
    fetched,
    allWaves,
    taskMap,
  );

  const manifest = buildManifest({
    epicId,
    epic: fetched.epic,
    tasks: fetched.tasks,
    allTickets: fetched.allTickets,
    waves: allWaves,
    dispatched,
    dryRun,
  });

  await detectEpicCompletion({
    epicId,
    epic: fetched.epic,
    tasks: fetched.tasks,
    manifest,
    provider,
    dryRun,
  });

  return manifest;
}
