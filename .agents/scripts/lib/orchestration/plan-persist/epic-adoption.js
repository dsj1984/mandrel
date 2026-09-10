/**
 * epic-adoption.js — join the Stories of this persist run to an Epic that
 * already exists.
 *
 * Story #5155. `epic-ops.js` opens a *new* container and, on a resumed run,
 * re-adopts the one carrying its exact fingerprint. This module covers the
 * case neither does: an operator pointing a fresh plan at an Epic an earlier
 * plan opened, with a different cohort and no fingerprint in common.
 *
 * **The posture is deliberately stricter than creation's.** Creation degrades
 * — an unensurable label just skips the container, because the Stories are the
 * part that matters and a missing Epic costs only tidiness. Adoption cannot
 * degrade the same way: the operator named a specific id, so silently not
 * adopting it would leave them believing their Stories were filed somewhere
 * they were not. A bad target is therefore a **hard error, raised before the
 * first Story is created** (dry run included), when nothing has been written
 * and the fix is free. Once the Stories exist, the posture flips to creation's
 * — a failed checklist write or sub-issue edge warns, because by then refusing
 * would strand live Stories over a cosmetic link.
 *
 * @module lib/orchestration/plan-persist/epic-adoption
 * @see Story #5155
 */

import { Logger } from '../../Logger.js';
import { TYPE_LABELS } from '../../label-constants.js';
import { appendEpicChildIds } from '../epic-checklist.js';
import { isEpicTicket } from '../epic-container.js';
import { mirrorSubIssueEdges } from './epic-ops.js';

/**
 * Resolve and validate the Epic an operator asked to adopt.
 *
 * Called **before any create**, so every refusal below costs the operator a
 * re-run of a command that wrote nothing.
 *
 * A null/absent `epicId` is the ordinary "no adoption requested" case and
 * resolves to `null` — only a *supplied* id can be wrong, and every wrong one
 * throws.
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
 * Link this run's Stories into an already-resolved Epic.
 *
 * Runs **after** the Stories exist, because both halves of the linkage need
 * their real ids: the checklist embeds issue numbers and the sub-issue edges
 * need database ids.
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

  // Dry run reports the intent write-free. `created` carries negative
  // placeholder ids there, so report them as-is rather than filtering to the
  // positives and claiming an empty adoption.
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
 * Write the appended checklist back to the Epic body.
 *
 * **The body is re-read `fresh` immediately before the append.** `target.body`
 * was captured by `resolveAdoptionTarget` before the first Story was created,
 * which on a cohort of any size is many seconds and several writes ago. An
 * append computed against that snapshot and PATCHed wholesale silently drops
 * every checklist row another writer added in between — a concurrent persist
 * run adopting the same Epic, or an operator ticking a child off by hand. The
 * body is a full-document write, so a stale base is not a merge conflict; it
 * is a silent revert.
 *
 * This **narrows** the read-then-PATCH window; it does not close it. Nothing
 * here is atomic, and GitHub's issue API offers no compare-and-swap, so a
 * write landing between this read and this PATCH is still lost. Narrowing it
 * from "the whole create phase" to "one round-trip" is the available fix; a
 * real one needs an API that does not exist.
 *
 * The PATCH is skipped when the append changes nothing, so re-running an
 * adoption that already landed writes nothing at all.
 *
 * Non-fatal: the Stories are already live, and the native sub-issue edges
 * written next are the other half of the linkage. Losing the checklist costs
 * the body-only fallback path, not the grouping.
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
 * Re-read the Epic's body, bypassing any provider cache.
 *
 * `{ fresh: true }` is the whole point: the adoption path already read this
 * issue once, so a cached read would hand back the very snapshot this function
 * exists to replace. Falls back to the snapshot when the re-read fails or the
 * provider has no `getTicket` — a stale base still appends the run's own
 * children, which beats not linking them.
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
