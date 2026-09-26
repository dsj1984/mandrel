/**
 * Advisory report of probed Stories whose declared footprint shares a
 * concrete path with a Story another session has in flight. Never feeds
 * selection, ordering or the exit code.
 *
 * @module lib/wave-runner/cross-run-overlap
 */

import { TYPE_LABELS } from '../label-constants.js';
import { storyFootprintPaths } from '../orchestration/resolve-stories.js';
import { currentOwner } from '../orchestration/ticket-lease.js';
import { detectCollision } from './footprint.js';
import { classifyStory, storyIdOf } from './ready-set.js';

/**
 * One labelled list query. Never rejects, so a failed read reports
 * "unavailable" instead of an empty list.
 *
 * @param {object} provider
 * @returns {Promise<{ tickets?: object[], error?: string }>}
 */
async function listOpenStories(provider) {
  if (typeof provider?.listTicketsByLabel !== 'function') {
    return { error: 'the provider cannot list issues by label' };
  }
  try {
    const tickets = await provider.listTicketsByLabel({
      state: 'open',
      labels: TYPE_LABELS.STORY,
    });
    return { tickets: Array.isArray(tickets) ? tickets : [] };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

/**
 * @param {object[]} tickets
 * @param {Set<number>} inSetIds
 * @returns {Array<{id: number, files: string[], holder: string|null}>}
 */
function outsideInFlight(tickets, inSetIds) {
  const outside = [];
  for (const ticket of tickets) {
    const id = storyIdOf(ticket);
    if (id === null || inSetIds.has(id)) continue;
    if (classifyStory(ticket) !== 'executing') continue;
    outside.push({
      id,
      files: storyFootprintPaths(ticket.body, id),
      holder: currentOwner(ticket.assignees),
    });
  }
  return outside;
}

/**
 * The reservation guard's `concreteOnly` rule, so advisory and guard never
 * disagree: a glob or the UNKNOWN sentinel reports nothing.
 *
 * @param {Array<{id: number}>} probed
 * @param {Array<{id: number, holder: string|null}>} outside
 * @returns {object[]}
 */
function findCrossRunOverlaps(probed, outside) {
  const overlaps = [];
  for (const rec of probed) {
    for (const other of outside) {
      const hit = detectCollision(rec, other, { concreteOnly: true });
      if (!hit) continue;
      overlaps.push({
        id: rec.id,
        otherId: other.id,
        holder: other.holder,
        paths: hit.paths,
      });
    }
  }
  return overlaps;
}

/**
 * @param {{ tickets?: object[], error?: string }} listing
 * @param {object[]} nodes
 * @param {Set<number>} inSetIds
 * @returns {object}
 */
function buildReport(listing, nodes, inSetIds) {
  if (listing.error) {
    return {
      crossRunOverlapProbe: 'unavailable',
      crossRunOverlapProbeReason: `Could not list in-flight Stories outside this run: ${listing.error}`,
    };
  }
  const candidates = nodes.filter((node) => {
    const cls = classifyStory(node);
    return cls === 'ready' || cls === 'executing';
  });
  return {
    crossRunOverlaps: findCrossRunOverlaps(
      candidates,
      outsideInFlight(listing.tickets, inSetIds),
    ),
  };
}

/**
 * Starts the read now so it overlaps the per-Story reads; probed-set Stories
 * are excluded (their overlap is the ready-set guard's job).
 *
 * @param {object} provider
 * @returns {{ report: (nodes: object[]) => Promise<object> }}
 */
export function startCrossRunProbe(provider) {
  const listing = listOpenStories(provider);
  return {
    report: async (nodes) =>
      buildReport(await listing, nodes, new Set(nodes.map((n) => n.id))),
  };
}
