/**
 * Pure helpers used by `retrofit-task-bodies.js`.
 *
 * Kept in a separate module from the CLI entry so the detection,
 * footer-parsing, and diff logic can be unit-tested without bootstrapping
 * a provider or hitting the filesystem.
 */

import { TYPE_LABELS } from '../label-constants.js';
import { hasStructuredHeader } from '../templates/task-body-renderer.js';

export function isTaskTicket(ticket) {
  return (ticket.labels ?? []).includes(TYPE_LABELS.TASK);
}

export function isStoryTicket(ticket) {
  return (ticket.labels ?? []).includes(TYPE_LABELS.STORY);
}

/**
 * Extract the `parent: #<n>` line from the orchestrator footer. Returns
 * `null` when no footer is present or it is malformed (legacy tickets
 * created before the convention landed).
 */
export function parseFooterParent(body) {
  const m = (body ?? '').match(/(?:^|\n)parent:\s*#(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Extract every `blocked by #<n>` reference from the orchestrator footer.
 */
export function parseFooterBlockers(body) {
  return [...(body ?? '').matchAll(/blocked by #(\d+)/g)].map((m) =>
    Number.parseInt(m[1], 10),
  );
}

/**
 * Walk every Task descendant of the Epic, returning ones that are NOT
 * already in four-section format. Each entry includes a reference to the
 * parent Story (when resolvable) so the caller can render an enrichment
 * envelope for the host LLM.
 *
 * `provider.getTickets(epicId)` is the same call the decomposer uses for
 * idempotent re-runs; it covers both the native sub-issue API and the
 * body-text reverse search.
 */
export async function collectNonConformingTasks(epicId, provider) {
  const allChildren = await provider.getTickets(epicId);
  const storiesById = new Map();
  for (const child of allChildren) {
    if (isStoryTicket(child)) storiesById.set(child.id, child);
  }
  const out = [];
  for (const child of allChildren) {
    if (!isTaskTicket(child)) continue;
    if (hasStructuredHeader(child.body)) continue;
    const parentId = parseFooterParent(child.body);
    const parentStory = parentId ? (storiesById.get(parentId) ?? null) : null;
    out.push({ task: child, parentStory });
  }
  return out;
}

/**
 * Naive unified-diff for stdout — good enough for operators eyeballing
 * retrofit output without a diff-library dependency.
 */
export function unifiedDiff(oldText, newText, label) {
  const oldLines = (oldText ?? '').split('\n');
  const newLines = (newText ?? '').split('\n');
  const lines = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push(`  ${oldLines[i] ?? ''}`);
      i++;
      j++;
      continue;
    }
    if (i < oldLines.length) lines.push(`- ${oldLines[i++]}`);
    if (j < newLines.length) lines.push(`+ ${newLines[j++]}`);
  }
  return lines.join('\n');
}
