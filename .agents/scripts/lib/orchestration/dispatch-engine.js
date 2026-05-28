/**
 * lib/orchestration/dispatch-engine.js — Core Dispatch Engine (SDK coordinator)
 *
 * Thin facade composing:
 *   - `dispatch-pipeline.js` — internal resolve/fetch/reconcile/graph helpers
 *
 * Every Epic is 3-tier (Epic → Feature → Story); `dispatch()` computes a
 * Story-level wave plan and emits a 3-tier manifest. The legacy Task-tier
 * dispatch runtime (Task fetcher, single-Story executor, the per-Task
 * wave fan-out, and the Epic-completion detector) was removed in Epic
 * #3163.
 */

import { PROJECT_ROOT, resolveConfig } from '../config-resolver.js';
import { ConflictingTypeLabelsError } from '../errors/index.js';
import { ensureLocalBranch } from '../git-branch-lifecycle.js';
import { Logger } from '../Logger.js';
import { TYPE_LABELS } from '../label-constants.js';
import { createProvider } from '../provider-factory.js';
import {
  buildStoryDispatchGraph,
  fetchEpicContext,
  isThreeTierDispatch,
  reconcileEpicState,
  resolveDispatchContext,
} from './dispatch-pipeline.js';
import { buildManifest } from './manifest-builder.js';
import { STATE_LABELS } from './ticketing.js';

export const AGENT_DONE_LABEL = STATE_LABELS.DONE;
export const AGENT_EXECUTING_LABEL = STATE_LABELS.EXECUTING;
export const AGENT_READY_LABEL = STATE_LABELS.READY;

/* node:coverage ignore next */
export function ensureBranch(branchName, baseBranch) {
  ensureLocalBranch(branchName, baseBranch, PROJECT_ROOT, {
    log: (msg) => Logger.info(msg),
  });
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
    throw new Error(
      `[Dispatcher] Ticket #${ticketId} is a **Story**. Stories are dispatched ` +
        'through the 3-tier Story path, not directly via the dispatcher. ' +
        `Run \`/story-deliver ${ticketId}\` to execute this Story, ` +
        `or dispatch its parent Epic with \`/epic-deliver #<epicId>\`.`,
    );
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
  const { epicId, dryRun } = ctx;

  const fetched = await fetchEpicContext(ctx);
  await reconcileEpicState(ctx, fetched);

  // Every Epic is 3-tier (Epic → Feature → Story). Compute Story-level
  // waves directly from the Story tickets and emit a 3-tier-shaped
  // manifest with `waves[].stories[]` so downstream consumers (manifest
  // renderer, /epic-deliver wave planner) see the correct execution plan.
  // Per-Story execution is owned by `/story-deliver` (story-init →
  // story-close), not by this dispatcher.
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

  // No Story tickets under the Epic — nothing to dispatch. Emit an empty
  // manifest so callers (renderer, /epic-deliver) get a well-formed
  // artifact instead of a throw.
  Logger.info('No Story tickets found under the Epic. Nothing to dispatch.');
  return buildManifest({
    epicId,
    epic: fetched.epic,
    tasks: [],
    allTickets: fetched.allTickets,
    waves: [],
    dispatched: [],
    dryRun,
    hierarchy: '3-tier',
  });
}
