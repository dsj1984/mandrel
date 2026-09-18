/**
 * epic-expansion.js — turn a container-Epic id into the open Story ids under
 * it; runs strictly before Story resolution.
 *
 * @module lib/orchestration/epic-expansion
 */

import { TYPE_LABELS } from '../label-constants.js';
import { isEpicTicket, readEpicChildIdsFrom } from './epic-container.js';
import { isSatisfiedBlocker } from './resolve-stories.js';

/**
 * @param {{ labels?: unknown }} issue
 * @returns {boolean}
 */
function isStoryTicket(issue) {
  const raw = issue?.labels;
  if (!Array.isArray(raw)) return false;
  return raw
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .includes(TYPE_LABELS.STORY);
}

/**
 * A degraded read and a truly empty Epic need different remedies, so they
 * get different messages.
 *
 * @param {number} id
 * @param {boolean} nativeReadFailed
 * @returns {Error}
 */
function noChildrenError(id, nativeReadFailed) {
  if (nativeReadFailed) {
    return new Error(
      `[resolve-stories] Epic #${id} expanded to no child Stories, but the ` +
        `native sub-issue read failed — the list is incomplete, not empty. ` +
        `Re-run once the GitHub API read succeeds.`,
    );
  }
  return new Error(
    `[resolve-stories] Epic #${id} lists no child Stories. An Epic is a container: ` +
      `link its Stories (a "- [ ] #N" checklist line or a GitHub sub-issue) ` +
      `or deliver the Story ids directly.`,
  );
}

/**
 * Expand container-Epic ids to their open child Stories (deduped, first-seen
 * order; other ids pass through), so everything downstream sees only Story
 * ids. Closed/done children are dropped (dependents treat them as satisfied
 * foreign blockers); non-Story children are dropped with a warning, since a
 * stray link must not wedge the run. Expanding to nothing is an error, never
 * a silent no-op.
 *
 * @param {{
 *   ids: number[],
 *   getTicket: (id: number) => Promise<object|null>,
 *   readNativeChildIds?: (epic: object) => Promise<number[]>,
 *   warn?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{ ids: number[], expansions: Array<{ epicId: number, childIds: number[] }> }>}
 */
export async function expandEpicIds({
  ids,
  getTicket,
  readNativeChildIds,
  warn,
}) {
  const out = [];
  const seen = new Set();
  const expansions = [];

  const push = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const id of ids) {
    const issue = await getTicket(id);
    if (!issue) {
      throw new Error(`[resolve-stories] Issue #${id} was not found.`);
    }
    if (!isEpicTicket(issue)) {
      push(id);
      continue;
    }

    const { ids: childIds, nativeReadFailed } = await readEpicChildIdsFrom({
      epic: issue,
      readNativeChildIds,
      onWarn: warn,
    });
    if (childIds.length === 0) {
      throw noChildrenError(id, nativeReadFailed);
    }

    const open = [];
    for (const childId of childIds) {
      let child;
      try {
        child = await getTicket(childId);
      } catch (err) {
        warn?.(
          `[resolve-stories] Epic #${id}: could not read child #${childId} ` +
            `(${err?.message ?? err}) — skipping it.`,
        );
        continue;
      }
      if (!child) {
        warn?.(
          `[resolve-stories] Epic #${id}: child #${childId} was not found — skipping it.`,
        );
        continue;
      }
      if (!isStoryTicket(child)) {
        warn?.(
          `[resolve-stories] Epic #${id}: child #${childId} is not a ${TYPE_LABELS.STORY} ` +
            `— skipping it. Only Stories are deliverable.`,
        );
        continue;
      }
      if (isSatisfiedBlocker(child)) continue;
      open.push(childId);
    }

    if (open.length === 0) {
      throw new Error(
        `[resolve-stories] Epic #${id} has ${childIds.length} child Story(ies), ` +
          `but none are still open — every one is closed or agent::done. ` +
          `There is nothing left to deliver.`,
      );
    }

    expansions.push({ epicId: id, childIds: open });
    for (const childId of open) push(childId);
  }

  return { ids: out, expansions };
}
