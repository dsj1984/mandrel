/**
 * Strip an authored `AC-<n>:` handle from acceptance items (the body renderer
 * numbers checkboxes itself, so a carried handle doubles or misnumbers) and
 * report each strip rather than refusing.
 *
 * @module lib/orchestration/plan-persist/acceptance-handle-repair
 */

import { stripAcceptanceHandle } from '../../story-body/story-body.js';
import { renderChangeRepair } from './changes-repair.js';

/**
 * @param {object} surface
 * @param {string} slug
 * @param {Set<string>} reported
 * @param {object[]} repairs Mutated.
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
 * Covers the top-level array and a structured body; a string body needs no
 * pass since `parse()` strips with the same grammar, so the fail-closed
 * contract sync sees both agree. Mutates `tickets` in place.
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
    // Both surfaces usually carry the same list; report each item once.
    const reported = new Set();
    repairSurface(ticket, slug, reported, repairs);
    const body = ticket.body;
    if (body && typeof body === 'object') {
      repairSurface(body, slug, reported, repairs);
    }
  }
  return repairs;
}

/**
 * Render one entry of the mixed repair list; non-handle kinds delegate to
 * `changes-repair.js`.
 *
 * @param {{ kind?: string, slug: string, from: string, to?: string }} repair
 * @returns {string}
 */
export function renderRepair(repair) {
  if (repair.kind !== 'acceptance-handle') return renderChangeRepair(repair);
  const { slug, from, to } = repair;
  return `Story "${slug}": acceptance[] item "${from}" carried an AC-<n> handle — normalised to "${to}"; the body renderer numbers the checkboxes.`;
}
