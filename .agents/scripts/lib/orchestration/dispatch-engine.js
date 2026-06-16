/**
 * lib/orchestration/dispatch-engine.js — Core Dispatch Engine (SDK coordinator)
 *
 * Thin facade composing:
 *   - `dispatch-pipeline.js` — internal resolve/fetch/reconcile/graph helpers
 *
 * Every Epic is 2-tier (Epic → Story); `dispatch()` computes a
 * Story-level wave plan and emits a 2-tier manifest. The legacy Task-tier
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
  isTwoTierDispatch,
  resolveDispatchContext,
} from './dispatch-pipeline.js';
import { buildManifest } from './manifest-builder.js';
import { STATE_LABELS } from './ticketing.js';

export const AGENT_DONE_LABEL = STATE_LABELS.DONE;

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

  if (isStory) {
    throw new Error(
      `[Dispatcher] Ticket #${ticketId} is a **Story**. Stories are dispatched ` +
        'through the Story delivery path, not directly via the dispatcher. ' +
        `Run \`/deliver ${ticketId}\` to execute this Story, ` +
        `or dispatch its parent Epic with \`/deliver #<epicId>\`.`,
    );
  }

  if (isEpic) {
    return dispatch({ epicId: ticketId, dryRun, provider });
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

  // Every Epic is 2-tier (Epic → Story). Compute Story-level
  // waves directly from the Story tickets and emit a 2-tier-shaped
  // manifest with `waves[].stories[]` so downstream consumers (manifest
  // renderer, /deliver wave planner) see the correct execution plan.
  // Per-Story execution is owned by `/deliver` (story-init →
  // story-close), not by this dispatcher.
  if (isTwoTierDispatch(fetched.allTickets)) {
    Logger.info(
      'Detected 2-tier hierarchy — computing Story-level execution waves.',
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
      hierarchy: '2-tier',
    });
  }

  // No Story tickets under the Epic — throw loudly rather than emit an
  // empty manifest, matching the wave-loop's behavior (build-wave-dag.js
  // throws the same message shape on this input). A silently-empty
  // manifest masks a pre-cutover Epic whose children are legacy Features.
  const typedChildren = (fetched.allTickets ?? [])
    .map((t) => (t.labels ?? []).find((l) => l.startsWith('type::')))
    .filter(Boolean);
  const legacyHint =
    typedChildren.length > 0
      ? ` Found ${typedChildren.length} non-Story child ticket(s) ` +
        `(${[...new Set(typedChildren)].join(', ')}) — this Epic looks ` +
        `pre-cutover (legacy Feature children) and needs migration to the ` +
        `2-tier (Epic → Story) hierarchy before dispatch.`
      : '';
  throw new Error(
    `Epic #${epicId} has no child stories to dispatch.${legacyHint}`,
  );
}
