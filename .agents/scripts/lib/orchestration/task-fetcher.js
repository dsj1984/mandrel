/**
 * lib/orchestration/task-fetcher.js — Task Fetching and Parsing Helpers
 */

import { parseBlockedBy, parseTaskMetadata } from '../dependency-parser.js';
import { AGENT_LABELS } from '../label-constants.js';
import { STATE_LABELS } from './ticketing.js';

const AGENT_DONE_LABEL = STATE_LABELS.DONE;

/**
 * Parses normal ticket objects into task representations.
 *
 * @param {object[]} tickets
 * @returns {object[]}
 */
export function parseTasks(tickets) {
  return tickets.map((t) => {
    const metadata = parseTaskMetadata(t.body ?? '');
    const blockedBy = parseBlockedBy(t.body ?? '');
    const labels = t.labels;
    // Reuse the provider-attached Set when present, otherwise materialise
    // one so every downstream consumer can use O(1) `labelSet.has(...)`
    // instead of array `.includes(...)`.
    const labelSet = t.labelSet ?? new Set(labels);

    const status =
      t.state === 'closed'
        ? AGENT_DONE_LABEL
        : (labels.find((l) => l.startsWith('agent::')) ?? AGENT_LABELS.READY);

    return {
      id: t.id,
      title: t.title,
      labels,
      labelSet,
      status,
      dependsOn: blockedBy,
      body: t.body ?? '',
      ...metadata,
    };
  });
}

/**
 * Fetch all Task-level tickets under an Epic, normalised for the dispatcher.
 *
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @param {number} epicId
 * @returns {Promise<object[]>}
 */
export async function fetchTasks(provider, epicId) {
  const tickets = await provider.getTickets(epicId, { label: 'type::task' });
  provider.primeTicketCache(tickets);
  return parseTasks(tickets);
}
