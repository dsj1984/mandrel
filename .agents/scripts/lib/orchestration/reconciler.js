/**
 * lib/orchestration/reconciler.js — Ticket Hierarchy Reconciliation
 */

import { Logger } from '../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { concurrentMap } from '../util/concurrent-map.js';
import { STATE_LABELS } from './ticketing.js';

const AGENT_DONE_LABEL = STATE_LABELS.DONE;

// Inlined parent-id parser. The reconciler only needs the direct parent
// reference scraped from a ticket body's `parent: #N` trailer; pulling the
// helper inline keeps reconciler.js self-contained for the 3-tier
// hierarchy walk (Tasks → Stories → Features).
const PARENT_ID_PATTERN = /^parent:\s*#(\d+)/m;

function parseParentIdFromBody(body) {
  const match = (body ?? '').match(PARENT_ID_PATTERN);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Cap=4 — bounded parallelism for ticket-update fan-outs. Reconciliation
// iterates an Epic-sized set of independent GitHub mutations; cap matches
// the established pattern across the orchestration layer (wave-gate,
// progress-reporter, sub-issue link reconcile) and stays well under the
// secondary rate-limit ceiling observed for issue PATCHes.
const RECONCILE_CONCURRENCY = 4;

/**
 * Reconcile closed GitHub issues that still have stale `agent::` labels.
 *
 * For every task that is already closed (`status === agent::done`) but
 * missing the `agent::done` label, rewrites labels to the canonical set and
 * sets `state_reason: completed`. Provider failures are logged and swallowed
 * — reconciliation must never break the dispatch cycle.
 *
 * @param {object[]} tasks                                              Parsed task records.
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider  Ticketing provider.
 * @param {boolean} dryRun                                              When true, log intent without mutating.
 * @returns {Promise<void>}
 */
export async function reconcileClosedTasks(tasks, provider, dryRun) {
  const ALL_AGENT_STATES = Object.values(STATE_LABELS);

  // Filter to the work-units first so concurrentMap sees only candidates
  // and the bounded fan-out reflects real provider load.
  const candidates = tasks.filter(
    (task) =>
      task.status === AGENT_DONE_LABEL &&
      !(task.labelSet ?? new Set(task.labels)).has(AGENT_DONE_LABEL),
  );

  // cap=4 — independent ticket updates, no ordering required; matches the
  // RECONCILE_CONCURRENCY house cap (see top of file).
  await concurrentMap(
    candidates,
    async (task) => {
      Logger.info(
        `Reconciling closed issue #${task.id} "${task.title}" → agent::done`,
      );

      if (dryRun) {
        Logger.info(`[DRY-RUN] Would sync labels and close issue #${task.id}`);
        return;
      }

      try {
        await provider.updateTicket(task.id, {
          labels: {
            add: [AGENT_DONE_LABEL],
            remove: [
              ...ALL_AGENT_STATES.filter((s) => s !== AGENT_DONE_LABEL),
              AGENT_LABELS.BLOCKED,
            ],
          },
          state: 'closed',
          state_reason: 'completed',
        });
        Logger.info(`✅ Synced #${task.id} to agent::done`);
      } catch (err) {
        Logger.warn(`Failed to reconcile #${task.id}: ${err.message}`);
      }
    },
    { concurrency: RECONCILE_CONCURRENCY },
  );
}

/**
 * Reconcile the ticket hierarchy bottom-up (Tasks → Stories → Features).
 *
 * Walks every Story and Feature under the Epic; if all children of a
 * container are done, closes the container and applies `agent::done`.
 *
 * Epic auto-closure is intentionally excluded — Epics close only through
 * the formal `/epic-deliver` workflow.
 *
 * Per-ticket provider failures are logged and swallowed so a single bad
 * ticket cannot halt reconciliation across the rest of the graph.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider  Ticketing provider.
 * @param {number} _epicId                                               Epic id (reserved — currently unused; kept for call-site stability).
 * @param {object} _epic                                                 Epic ticket record (reserved — currently unused).
 * @param {object[]} tasks                                               Parsed task records.
 * @param {object[]} allTickets                                          Every ticket under the Epic.
 * @param {boolean} dryRun                                               When true, mutate nothing.
 * @returns {Promise<void>}
 */
export async function reconcileHierarchy(
  provider,
  _epicId,
  _epic,
  tasks,
  allTickets,
  dryRun,
) {
  const ticketMap = new Map(allTickets.map((t) => [t.id, t]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const childrenOf = new Map();
  for (const ticket of allTickets) {
    const parentId = parseParentIdFromBody(ticket.body);
    if (parentId != null) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(ticket.id);
    }
  }

  function isDone(ticketId) {
    if (taskById.has(ticketId)) {
      return taskById.get(ticketId).status === AGENT_DONE_LABEL;
    }
    const t = ticketMap.get(ticketId);
    if (!t) return false;
    return (
      t.state === 'closed' ||
      (t.labelSet ?? new Set(t.labels)).has(AGENT_DONE_LABEL)
    );
  }

  function shouldClose(id) {
    const ticket = ticketMap.get(id);
    if (!ticket || ticket.state === 'closed') return null;
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return null;
    if (!children.every((cid) => isDone(cid))) return null;
    return ticket;
  }

  async function applyClose(id, typeName, ticket) {
    try {
      await provider.updateTicket(id, {
        labels: {
          add: [AGENT_DONE_LABEL],
          remove: [AGENT_LABELS.READY, AGENT_LABELS.EXECUTING],
        },
        state: 'closed',
        state_reason: 'completed',
      });
      ticket.state = 'closed';
      Logger.info(`✅ ${typeName} #${id} closed and marked agent::done.`);
    } catch (err) {
      Logger.warn(`Failed to close ${typeName} #${id}: ${err.message}`);
    }
  }

  async function maybeClose(id, typeName) {
    const ticket = shouldClose(id);
    if (!ticket) return;
    Logger.info(
      `All children of ${typeName} #${id} "${ticket.title}" are done. Closing...`,
    );
    if (dryRun) {
      Logger.info(
        `[DRY-RUN] Would close ${typeName} #${id} and set agent::done.`,
      );
      ticket.state = 'closed';
      return;
    }
    await applyClose(id, typeName, ticket);
  }

  const storyIds = allTickets
    .filter((t) => (t.labelSet ?? new Set(t.labels)).has(TYPE_LABELS.STORY))
    .map((t) => t.id);
  const featureIds = allTickets
    .filter((t) => (t.labelSet ?? new Set(t.labels)).has(TYPE_LABELS.FEATURE))
    .map((t) => t.id);

  // cap=4 — Stories are container leaves of this reconcile (their children
  // are Tasks already settled by reconcileClosedTasks); independent close
  // mutations can fan out without ordering. Features stay sequential because
  // a Feature may parent another Feature, and bottom-up close depends on
  // child-Feature state already being mutated in the same pass.
  await concurrentMap(storyIds, (id) => maybeClose(id, 'Story'), {
    concurrency: RECONCILE_CONCURRENCY,
  });
  for (const id of featureIds) await maybeClose(id, 'Feature');

  // EXCLUSION: Epic auto-closure removed.
  // The Epic ticket now stays open until the formal /epic-deliver workflow is executed.
}
