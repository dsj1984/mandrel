/**
 * Join this run's Stories to an existing Epic the operator named (`--epic`).
 * A bad target is a hard error raised before the first create — silently not
 * adopting would misfile the plan. Once Stories exist, link failures only
 * warn.
 *
 * @module lib/orchestration/plan-persist/epic-adoption
 */

import { Logger } from '../../Logger.js';
import { TYPE_LABELS } from '../../label-constants.js';
import { appendEpicChildIds } from '../epic-checklist.js';
import { isEpicTicket } from '../epic-container.js';
import { mirrorSubIssueEdges } from './epic-ops.js';

/**
 * Called before any create. An absent `epicId` resolves to `null`.
 *
 * @param {{ provider: object, epicId: number|null }} opts
 * @returns {Promise<{ id: number, title: string, body: string }|null>}
 * @throws {Error} When a supplied id is missing, closed, or not a container Epic.
 */
export async function resolveAdoptionTarget({ provider, epicId }) {
  if (epicId === null || epicId === undefined) return null;
  const id = Number(epicId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[plan-persist] --epic expects a positive issue id (got "${epicId}").`,
    );
  }
  if (typeof provider?.getTicket !== 'function') {
    throw new Error(
      '[plan-persist] provider exposes no getTicket — cannot verify the Epic to adopt.',
    );
  }

  let issue;
  try {
    issue = await provider.getTicket(id);
  } catch (err) {
    throw new Error(
      `[plan-persist] --epic #${id} could not be read (${err?.message ?? err}). ` +
        'Adoption needs an existing open container Epic.',
    );
  }
  if (!issue) {
    throw new Error(`[plan-persist] --epic #${id} does not exist.`);
  }

  const state = String(issue.state ?? 'open').toLowerCase();
  if (state !== 'open') {
    throw new Error(
      `[plan-persist] --epic #${id} is ${state}. A closed Epic is a finished body of ` +
        'work and is never reopened by a plan — open a new container, or reopen it by hand first.',
    );
  }
  if (!isEpicTicket(issue)) {
    throw new Error(
      `[plan-persist] --epic #${id} does not carry "${TYPE_LABELS.EPIC}" — it is not a ` +
        'container Epic. Adopting an ordinary Story would file this plan under a work item.',
    );
  }

  return {
    id,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
  };
}

/**
 * Runs after the Stories exist — the linkage needs their real ids.
 *
 * @param {{
 *   provider: object,
 *   target: { id: number, title: string, body: string },
 *   created: Array<{ id: number }>,
 *   opts?: { dryRun?: boolean },
 * }} args
 * @returns {Promise<{
 *   id: number,
 *   title: string,
 *   childIds: number[],
 *   adopted: true,
 *   edges: { added: number, skipped: number, failed: number }|null,
 * }|null>}
 */
export async function adoptContainerEpic({
  provider,
  target,
  created,
  opts = {},
}) {
  const { dryRun = false } = opts;
  if (!target) return null;

  const all = Array.isArray(created) ? created : [];

  // Dry-run ids are negative placeholders; report them as-is.
  if (dryRun) {
    return {
      id: target.id,
      title: target.title,
      childIds: all.map((s) => s.id),
      adopted: true,
      edges: null,
    };
  }

  const childIds = all
    .map((s) => s.id)
    .filter((id) => Number.isInteger(id) && id > 0);
  if (childIds.length === 0) return null;

  await appendChecklist({ provider, target, childIds });
  const edges = await mirrorSubIssueEdges({
    provider,
    epicNumber: target.id,
    childIds,
    created: all,
  });

  Logger.info(
    `[plan-persist] adopted container Epic #${target.id} — it now groups ` +
      `${childIds.length} more Story(ies): /mandrel-deliver ${target.id}`,
  );

  return {
    id: target.id,
    title: target.title,
    childIds,
    adopted: true,
    edges,
  };
}

/**
 * The body is re-read fresh right before the append: the body PATCH is a
 * whole-document write, so appending to the pre-create snapshot would
 * silently revert rows another writer added since. This narrows the window
 * to one round-trip; GitHub offers no compare-and-swap to close it. Skips the
 * PATCH when nothing changes. Non-fatal.
 *
 * @param {{ provider: object, target: { id: number, body: string }, childIds: number[] }} opts
 * @returns {Promise<void>}
 */
async function appendChecklist({ provider, target, childIds }) {
  if (typeof provider?.updateTicket !== 'function') {
    Logger.warn(
      '[plan-persist] provider exposes no updateTicket — the adopted Epic body was not ' +
        'updated. The native sub-issue edges still record the grouping.',
    );
    return;
  }
  const base = await readFreshEpicBody({ provider, target });
  const next = appendEpicChildIds(base, childIds);
  if (next === base) return;
  try {
    await provider.updateTicket(target.id, { body: next });
  } catch (err) {
    Logger.warn(
      `[plan-persist] could not update Epic #${target.id}'s checklist ` +
        `(${err?.message ?? err}). The native sub-issue edges still record the grouping.`,
    );
  }
}

/**
 * `{ fresh: true }` bypasses the cache that holds the stale snapshot. Falls
 * back to the snapshot, which still links this run's children.
 *
 * @param {{ provider: object, target: { id: number, body: string } }} opts
 * @returns {Promise<string>}
 */
async function readFreshEpicBody({ provider, target }) {
  if (typeof provider?.getTicket !== 'function') return target.body;
  try {
    const fresh = await provider.getTicket(target.id, { fresh: true });
    if (typeof fresh?.body === 'string') return fresh.body;
  } catch (err) {
    Logger.warn(
      `[plan-persist] could not re-read Epic #${target.id} before appending its ` +
        `checklist (${err?.message ?? err}); appending to the body read earlier. ` +
        'A child linked by another writer since then may be dropped.',
    );
  }
  return target.body;
}
