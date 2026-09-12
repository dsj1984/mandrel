/**
 * acceptance-handle-repair.js — repair-before-judging for the `AC-<n>:`
 * presentation handle on authored acceptance items (Story #5323).
 *
 * The handle belongs to the body renderer, which numbers each checkbox from
 * its position in `acceptance[]` (`story-body.js`). An author planning from
 * an existing ticket reads that rendered body as a template and carries the
 * handle forward, so the persisted checkbox reads `- [ ] AC-1: AC-1: …`; a
 * lettered handle copied out of a hand-edited source (`AC-14a:`) misnumbers
 * the rest of the list against its own text.
 *
 * The correction is mechanical and total — strip the handle the renderer
 * will re-apply — so this module applies it and **reports** it, exactly as
 * `changes-repair.js` does for the `{ path, assumption }` formality. Charging
 * the author a re-draft round to paste back text the strip already produced
 * buys nothing.
 *
 * It lives beside the validator rather than inside it for the same reason
 * `changes-repair.js` does: the validator's job is to judge, and mixing a
 * mutating repair pass into a module of pure collectors muddies both.
 * `persist-helpers.js#validateTickets` calls this first, then the validators.
 *
 * @module lib/orchestration/plan-persist/acceptance-handle-repair
 */

import { stripAcceptanceHandle } from '../../story-body/story-body.js';

/**
 * Strip the handle off one surface's `acceptance[]`, recording each distinct
 * strip on `repairs`.
 *
 * @param {object} surface An object that may carry an `acceptance` array.
 * @param {string} slug
 * @param {Set<string>} reported Items already reported for this ticket.
 * @param {object[]} repairs Accumulator, mutated.
 * @returns {void}
 */
function repairSurface(surface, slug, reported, repairs) {
  if (!Array.isArray(surface.acceptance)) return;
  surface.acceptance = surface.acceptance.map((item) => {
    const { text, stripped } = stripAcceptanceHandle(item);
    if (!stripped) return item;
    const from = String(item ?? '');
    if (!reported.has(from)) {
      reported.add(from);
      repairs.push({ kind: 'acceptance-handle', slug, from, to: text });
    }
    return text;
  });
}

/**
 * Strip the presentation `AC-<n>:` handle off every authored `acceptance[]`
 * item, on both surfaces that can carry one: the ticket's top-level array
 * (the machine contract) and a structured body's.
 *
 * A serialized **string** body needs no pass of its own — `parse()` strips
 * the handle with the same grammar this does, so the two surfaces converge
 * on one list whichever carried the handle, and the contract sync (which
 * fails closed on a disagreement) sees them agree.
 *
 * Mutates `tickets` in place — the persist pipeline threads this same array
 * on to assembly. Total: a non-array argument and non-Story tickets are
 * no-ops.
 *
 * @param {object[]} tickets
 * @returns {Array<{ kind: 'acceptance-handle', slug: string, from: string, to: string }>}
 */
export function normalizeAcceptanceHandles(tickets) {
  const repairs = [];
  for (const ticket of Array.isArray(tickets) ? tickets : []) {
    if (!ticket || typeof ticket !== 'object' || ticket.type !== 'story') {
      continue;
    }
    const slug = ticket.slug ?? ticket.title ?? '<unknown>';
    // A ticket normally carries the same list on both surfaces, so report
    // each distinct item once — the operator reads one correction, not two.
    const reported = new Set();
    repairSurface(ticket, slug, reported, repairs);
    const body = ticket.body;
    if (body && typeof body === 'object') {
      repairSurface(body, slug, reported, repairs);
    }
  }
  return repairs;
}
