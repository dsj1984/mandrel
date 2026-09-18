/**
 * epic-checklist.js — amend a live, possibly hand-edited Epic body's child
 * checklist by surgical line insertion, never a re-render: goal prose,
 * markers, order and existing checked state are untouchable.
 *
 * @module lib/orchestration/epic-checklist
 */

import {
  CHECKLIST_ITEM_LINE_RE,
  CHILDREN_HEADING,
  NO_CHILDREN_PLACEHOLDER,
  normalizeChildIds,
  readEpicChildIds,
} from './epic-container.js';

/**
 * Index of the last `- [ ] #N` row in a body's lines, or -1.
 *
 * @param {string[]} lines
 * @returns {number}
 */
function findLastChecklistIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CHECKLIST_ITEM_LINE_RE.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Splice target: replace the empty placeholder, else append after the last
 * row, else open under the heading.
 *
 * @param {string[]} lines
 * @returns {[number, number]|null} `null` when there is no section to extend.
 */
function locateInsertion(lines) {
  const placeholderAt = lines.findIndex(
    (line) => line.trim() === NO_CHILDREN_PLACEHOLDER,
  );
  if (placeholderAt !== -1) return [placeholderAt, 1];

  const lastItemAt = findLastChecklistIndex(lines);
  if (lastItemAt !== -1) return [lastItemAt + 1, 0];

  const headingAt = lines.findIndex((line) => line.trim() === CHILDREN_HEADING);
  if (headingAt === -1) return null;
  // Keep the blank line a composed body puts under the heading.
  const blank = lines[headingAt + 1]?.trim() === '' ? 1 : 0;
  return [headingAt + 1 + blank, 0];
}

/**
 * Append child ids idempotently — a re-run persist passes the same cohort.
 *
 * @param {string} body
 * @param {number[]} childIds
 * @returns {string} The updated body (byte-identical when nothing was added).
 */
export function appendEpicChildIds(body, childIds) {
  const text = typeof body === 'string' ? body : '';
  const existing = new Set(readEpicChildIds(text));
  const additions = normalizeChildIds(childIds).filter(
    (id) => !existing.has(id),
  );
  if (additions.length === 0) return text;

  const rows = additions.map((id) => `- [ ] #${id}`);
  const lines = text.split('\n');
  const target = locateInsertion(lines);

  if (target === null) {
    // No section: add one, since `isEpicTicket` counts this as an Epic.
    return `${text.replace(/\n+$/, '')}\n\n${CHILDREN_HEADING}\n\n${rows.join('\n')}\n`;
  }

  lines.splice(target[0], target[1], ...rows);
  return lines.join('\n');
}
