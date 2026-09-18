/**
 * The container-Epic directive both `/audit-to-stories` output paths carry.
 * For a sweep the Epic is the default (shared provenance), declinable at the
 * HITL stop; adoption of an existing Epic is named first so a repeat sweep
 * does not open a second container.
 *
 * @module lib/audit-to-stories/epic-grouping-directive
 */

import { EPIC_SUGGESTION_THRESHOLD } from '../orchestration/plan-persist/epic-ops.js';

/**
 * @param {unknown[]} groups The proposed Stories (only the count is read).
 * @returns {string} Markdown paragraph(s).
 */
export function formatEpicGrouping(groups) {
  const count = Array.isArray(groups) ? groups.length : 0;
  if (count < EPIC_SUGGESTION_THRESHOLD) {
    const noun = count === 1 ? 'Story' : 'Stories';
    return `This sweep proposes ${count} ${noun} — below the ${EPIC_SUGGESTION_THRESHOLD}-Story threshold, so no container Epic is needed.`;
  }
  return [
    `**Group these under a container Epic.** This sweep proposes ${count} Stories from one audit pass, which is exactly the case a container earns: they share a provenance and an operator will want to deliver them as a unit.`,
    '',
    '**Check `epicCandidates[]` first.** A repeat sweep over the same area usually belongs under the Epic the previous sweep opened, not beside it — adopt that one with `--epic <id>` (any Story count) rather than opening a second container for one body of work. Only when no open Epic fits does this directive mean *create*.',
    '',
    'The Epic is a **pure container** — a title, a one-paragraph goal, and the child checklist. It must carry no finding, no path and no rationale that is not already in a child Story, or that information ends up somewhere no delivering agent reads.',
    '',
    'Decline it and file the Stories flat if the operator prefers.',
  ].join('\n');
}
