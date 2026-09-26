/**
 * lib/wave-runner/cross-run-overlap.js — advisory report of probed Stories
 * whose declared footprint shares a concrete path with a Story another
 * session has in flight. Read-only and advisory: nothing here feeds
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
 * Every open Story in one labelled list query. Never rejects: a failed or
 * unsupported read resolves to `{ error }`, so the beat proceeds and the
 * envelope says the advisory is unavailable rather than empty.
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
 * Outside Stories in flight (`agent::executing` or the closing label), with
 * footprints from the ready-set's `## Changes` parser and the assignee lease
 * as holder (`null` when unassigned — never a reason to drop the record).
 *
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
 * Each probed Story paired with each outside Story sharing a concrete path.
 * Uses the cross-beat reservation guard's rule (`concreteOnly`), so the
 * advisory and the guard never disagree about what overlaps — a glob or the
 * UNKNOWN sentinel on either side reports nothing.
 *
 * @param {Array<{id: number}>} probed
 * @param {Array<{id: number, holder: string|null}>} outside
 * @returns {Array<{id: number, otherId: number, holder: string|null, paths: string[]}>}
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
 * @param {Array<{id: number, files: string[], labels: string[]}>} nodes
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
 * Start the outside read now, so it overlaps the per-Story reads, and score
 * it once the probed nodes are known. Stories inside the probed set are
 * excluded — their overlap is the ready-set guard's job.
 *
 * @param {object} provider
 * @returns {{ report: (nodes: Array<{id: number, files: string[], labels: string[]}>) => Promise<object> }}
 *   `{ crossRunOverlaps }` on success, else
 *   `{ crossRunOverlapProbe: 'unavailable', crossRunOverlapProbeReason }`.
 */
export function startCrossRunProbe(provider) {
  const listing = listOpenStories(provider);
  return {
    report: async (nodes) =>
      buildReport(await listing, nodes, new Set(nodes.map((n) => n.id))),
  };
}
