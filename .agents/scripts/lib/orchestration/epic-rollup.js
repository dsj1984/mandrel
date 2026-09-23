/**
 * epic-rollup.js — derive a container Epic's board state from its children
 * and write it. Invoked from every edge that changes a child's state (init,
 * post-land, supersede close), since a never-delivered container has no
 * other writer.
 *
 * Invariants:
 *   1. The Epic never gains an `agent::*` label (keeps it off the ready list
 *      and out of body lint); the column goes straight to the board.
 *   2. Status recomputes both ways; closure is one-way — a reopened child
 *      pulls Status back but never reopens the issue.
 *   3. Never throws: a stale container costs tidiness, a failed delivery
 *      costs a landed Story its terminal envelope.
 *   4. Closure needs an authoritative child list. A degraded native read
 *      keeps the Status/assignee writes (they self-correct) but never closes.
 *
 * @module lib/orchestration/epic-rollup
 */

import { Logger } from '../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { concurrentMap } from '../util/concurrent-map.js';
import { ColumnSync, LABEL_TO_COLUMN } from './column-sync.js';
import {
  isEpicTicket,
  nativeChildReader,
  readEpicChildIds,
  readEpicChildIdsFrom,
} from './epic-container.js';
import { resolveOperatorFromCandidates } from './lease-guard-shared.js';
import { anyChildLanded, deriveParentState } from './ticketing/bulk.js';

/**
 * Derived states in which the Epic carries an owner. An (open) blocked child
 * counts: that is exactly when someone needs to be found.
 */
const IN_FLIGHT_STATES = new Set([
  AGENT_LABELS.EXECUTING,
  AGENT_LABELS.BLOCKED,
]);

/**
 * Child reads in flight; matches `resolve-stories.js`, under GitHub's
 * secondary-rate-limit burst threshold. Not exported: a test-only export
 * fails the production dead-export gate.
 */
const FETCH_CONCURRENCY = 5;

/**
 * Non-throwing, unlike the Story lease: a missing owner is cosmetic and must
 * not cost the Status write and closure.
 *
 * @param {object} config Resolved `.agentrc.json` config.
 * @returns {string|null} Bare login, or null when none is configured.
 */
function resolveEpicOwner(config) {
  return resolveOperatorFromCandidates({
    candidates: [config?.github?.operatorHandle],
    missingHandleBehavior: 'null',
  });
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeAssignees(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => (typeof a === 'string' ? a : a?.login))
    .filter((login) => typeof login === 'string' && login.length > 0);
}

/**
 * @param {{ state?: string }} issue
 * @returns {boolean}
 */
function isClosed(issue) {
  return String(issue?.state ?? '').toLowerCase() === 'closed';
}

/**
 * Fetch one child. Throws on a failed read, since a silently dropped child
 * could let the container close over open work. Exception: an unresolvable
 * body-only id (a checklist typo no re-run fixes) is dropped; an
 * unresolvable native id still fails.
 *
 * @param {{ childId: number, droppable: boolean, provider: object }} opts
 * @returns {Promise<{ childId: number, child: object|null }>}
 */
async function readOneChild({ childId, droppable, provider }) {
  const child = await provider.getTicket(childId);
  if (child) return { childId, child };
  if (droppable) return { childId, child: null };
  throw new Error(`child #${childId} was not found`);
}

/**
 * Read every child; `null` when any claimed child is unreadable. Validates
 * readability of the given ids, never completeness of the list — that is
 * `nativeReadFailed`'s job.
 *
 * @param {{ epicId: number, childIds: number[], bodyOnlyIds?: number[], provider: object }} opts
 * @returns {Promise<{ children: object[], refused: Array<{ childId: number, reason: string }> }|null>}
 */
async function readChildren({ epicId, childIds, bodyOnlyIds = [], provider }) {
  const droppable = new Set(bodyOnlyIds);
  let read;
  try {
    read = await concurrentMap(
      childIds,
      (childId) =>
        readOneChild({
          childId,
          droppable: droppable.has(childId),
          provider,
        }),
      { concurrency: FETCH_CONCURRENCY },
    );
  } catch (err) {
    Logger.warn(
      `[epic-rollup] Epic #${epicId}: could not read every child ` +
        `(${err?.message ?? err}) — leaving the Epic untouched.`,
    );
    return null;
  }

  // Classify in input order so output is independent of fetch timing.
  const children = [];
  const refused = [];
  for (const { childId, child } of read) {
    if (child === null) {
      Logger.warn(
        `[epic-rollup] Epic #${epicId}: checklist row cites #${childId}, which ` +
          'resolves to no issue and is not a native sub-issue edge — dropping ' +
          'it from the child set. Fix or remove the row.',
      );
      continue;
    }
    if (isEpicTicket(child)) {
      // A nested container has no `agent::*` label and would stall the parent.
      refused.push({ childId, reason: 'epic-typed-child' });
      Logger.warn(
        `[epic-rollup] Epic #${epicId}: child #${childId} is itself a container ` +
          'Epic — refused (epic-typed-child). Nested containers derive no ' +
          "state, so it neither blocks nor advances this Epic's.",
      );
      continue;
    }
    children.push(child);
  }
  return { children, refused };
}

/**
 * @param {{ epicId: number, column: string|null, columnSync: object }} opts
 * @returns {Promise<{ column: string|null, detail: string|null }>}
 */
async function applyColumn({ epicId, column, columnSync }) {
  if (!column || !columnSync) return { column: null, detail: null };
  try {
    const result = await columnSync.setColumn(epicId, column);
    if (result?.status === 'synced') return { column, detail: null };
    return { column: null, detail: result?.reason ?? 'column-not-synced' };
  } catch (err) {
    return { column: null, detail: String(err?.message ?? err) };
  }
}

/**
 * Add the owner. Additive only: it cannot evict a concurrent run's login,
 * which is also why the assignee is never removed on close.
 *
 * @param {{ epicId: number, epic: object, owner: string|null, provider: object }} opts
 * @returns {Promise<{ assigned: boolean, detail: string|null }>}
 */
async function applyOwner({ epicId, epic, owner, provider }) {
  if (!owner) return { assigned: false, detail: 'no-operator-handle' };
  if (normalizeAssignees(epic?.assignees).includes(owner)) {
    return { assigned: false, detail: null };
  }
  try {
    await provider.updateTicket(epicId, { addAssignees: [owner] });
    return { assigned: true, detail: null };
  } catch (err) {
    return { assigned: false, detail: String(err?.message ?? err) };
  }
}

/**
 * Close a finished container: `completed` only if a child landed, else
 * `not_planned` (e.g. an all-superseded cohort).
 *
 * @param {{ epicId: number, landed: boolean, provider: object }} opts
 * @returns {Promise<{ closed: boolean, detail: string|null }>}
 */
async function applyClosure({ epicId, landed, provider }) {
  try {
    await provider.updateTicket(epicId, {
      state: 'closed',
      state_reason: landed ? 'completed' : 'not_planned',
    });
    Logger.info(
      landed
        ? `[epic-rollup] Closed container Epic #${epicId} — every child Story landed.`
        : `[epic-rollup] Closed container Epic #${epicId} as not_planned — every ` +
            'child is closed and none landed.',
    );
    return { closed: true, detail: null };
  } catch (err) {
    return { closed: false, detail: String(err?.message ?? err) };
  }
}

/**
 * Roll one Epic up. `nativeReadFailed` blocks only closure, the one write no
 * later tick undoes (invariant 4).
 *
 * @param {{ epic: object, childIds: number[], bodyOnlyIds?: number[], nativeReadFailed?: boolean, provider: object, columnSync: object, owner: string|null }} opts
 * @returns {Promise<object>} Per-Epic outcome record.
 */
async function rollUpOneEpic({
  epic,
  childIds,
  bodyOnlyIds = [],
  nativeReadFailed = false,
  provider,
  columnSync,
  owner,
}) {
  const epicId = Number(epic?.id);
  const outcome = {
    epicId,
    column: null,
    assigned: false,
    closed: false,
    pending: false,
    refused: [],
    detail: null,
  };

  const read = await readChildren({
    epicId,
    childIds,
    bodyOnlyIds,
    provider,
  });
  if (read === null) {
    outcome.pending = true;
    outcome.detail = 'child-read-failed';
    return outcome;
  }
  const { children, refused } = read;
  outcome.refused = refused;

  const derived = deriveParentState(children);
  const applied = await applyColumn({
    epicId,
    column: derived ? (LABEL_TO_COLUMN[derived] ?? null) : null,
    columnSync,
  });
  outcome.column = applied.column;
  if (applied.detail) outcome.detail = applied.detail;

  if (IN_FLIGHT_STATES.has(derived)) {
    const ownership = await applyOwner({ epicId, epic, owner, provider });
    outcome.assigned = ownership.assigned;
    if (ownership.detail) outcome.detail = ownership.detail;
  }

  if (derived !== AGENT_LABELS.DONE) {
    // A closed Epic here is the reopened-child case: Status corrected, issue
    // state left alone.
    outcome.pending = !isClosed(epic);
    return outcome;
  }

  if (isClosed(epic)) return outcome;

  if (nativeReadFailed) {
    // Every visible child landed, but the list may be incomplete. This
    // detail deliberately overwrites any column/owner detail.
    outcome.pending = true;
    outcome.detail = 'child-read-degraded';
    Logger.warn(
      `[epic-rollup] Epic #${epicId}: every child read looks done, but the ` +
        'native sub-issue read degraded — refusing to close on a possibly ' +
        'incomplete child list. Re-run once the API read succeeds.',
    );
    return outcome;
  }

  const closure = await applyClosure({
    epicId,
    landed: anyChildLanded(children),
    provider,
  });
  outcome.closed = closure.closed;
  outcome.pending = !closure.closed;
  if (closure.detail) outcome.detail = closure.detail;
  return outcome;
}

/**
 * Resolve this Story's container in one request via the native parent edge.
 * `authoritative` is true only when the lookup answered: then a missing
 * parent means no native edge exists, and the only linkage left to find is a
 * body checklist row. A throw (or a provider without the port) is degraded.
 *
 * @param {{ storyId: number, provider: object }} opts
 * @returns {Promise<{ parent: object|null, authoritative: boolean }>}
 */
async function parentEpicFor({ storyId, provider }) {
  if (typeof provider?.getParentIssue !== 'function') {
    return { parent: null, authoritative: false };
  }
  let parent;
  try {
    parent = await provider.getParentIssue(storyId);
  } catch (err) {
    Logger.warn(
      `[epic-rollup] Parent lookup for Story #${storyId} degraded ` +
        `(${err?.message ?? err}); falling back to the full label scan.`,
    );
    return { parent: null, authoritative: false };
  }
  return {
    parent: parent && isEpicTicket(parent) ? parent : null,
    authoritative: true,
  };
}

/**
 * Fallback: every container Epic. `state: 'all'` so a reopened child can
 * pull a closed container's Status back (closure itself stays one-way).
 *
 * @param {{ provider: object }} opts
 * @returns {Promise<object[]>}
 */
async function scanContainerEpics({ provider }) {
  if (typeof provider?.listTicketsByLabel !== 'function') return [];
  let epics;
  try {
    epics = await provider.listTicketsByLabel({
      state: 'all',
      labels: TYPE_LABELS.EPIC,
    });
  } catch (err) {
    Logger.warn(
      `[epic-rollup] Could not list Epics (${err?.message ?? err}); ` +
        'skipping the rollup.',
    );
    return [];
  }
  return (Array.isArray(epics) ? epics : []).filter(isEpicTicket);
}

/**
 * Scan candidates. With an authoritative "no native parent", only an Epic
 * whose body checklist names the Story can hold it, so the rest are dropped
 * here with zero per-Epic requests; a degraded lookup keeps every Epic so the
 * native read can still find a natively-linked Story.
 *
 * @param {{ storyId: number, provider: object, bodyOnly: boolean }} opts
 * @returns {Promise<object[]>}
 */
async function candidateEpics({ storyId, provider, bodyOnly }) {
  const epics = await scanContainerEpics({ provider });
  if (!bodyOnly) return epics;
  return epics.filter((epic) => readEpicChildIds(epic?.body).includes(storyId));
}

/**
 * Find the container Epics holding a Story (Story bodies carry no parent
 * pointer). Native edge first, scan otherwise; a scanned Epic must prove it
 * lists the Story, a native parent need not.
 *
 * @param {{ storyId: number, provider: object, skipEpicIds: Set<number> }} opts
 * @returns {Promise<Array<{ epic: object, childIds: number[], nativeReadFailed: boolean, bodyOnlyIds: number[] }>>}
 */
async function findEpicsForStory({ storyId, provider, skipEpicIds }) {
  const { parent, authoritative } = await parentEpicFor({ storyId, provider });
  const epics = parent
    ? [parent]
    : await candidateEpics({ storyId, provider, bodyOnly: authoritative });

  const matches = [];
  for (const epic of epics) {
    const epicId = Number(epic?.id);
    if (!Number.isInteger(epicId)) continue;
    if (skipEpicIds.has(epicId)) continue;
    // Body checklist UNION native edges — the same reader delivery expansion
    // uses; body alone misses children linked in the GitHub UI.
    const {
      ids: childIds,
      nativeReadFailed,
      bodyOnlyIds,
    } = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: nativeChildReader(provider),
      onWarn: (message) => Logger.warn(message),
    });
    if (!parent && !childIds.includes(storyId)) {
      // A degraded read may have truncated this Story out; skip, but say so.
      if (nativeReadFailed) {
        Logger.warn(
          `[epic-rollup] Epic #${epicId}: skipped for Story #${storyId} on a ` +
            'degraded child read — the Story may in fact be linked to it.',
        );
      }
      continue;
    }
    matches.push({ epic, childIds, nativeReadFailed, bodyOnlyIds });
  }
  return matches;
}

/**
 * Roll up every container Epic listing this Story. `skipEpicIds` lets a
 * caller walking sibling Stories avoid re-closing a shared Epic without
 * relying on a remote read racing its own writes.
 *
 * @param {{
 *   storyId: number,
 *   provider: object,
 *   config?: object,
 *   columnSync?: object,
 *   owner?: string|null,
 *   skipEpicIds?: Iterable<number>,
 * }} opts
 * @returns {Promise<{ epics: object[], closed: number[], pending: number[], reason: string|null }>}
 */
export async function rollUpEpicForStory({
  storyId,
  provider,
  config,
  columnSync,
  owner,
  skipEpicIds,
}) {
  const empty = { epics: [], closed: [], pending: [], reason: null };
  const id = Number(storyId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ...empty, reason: 'invalid-story-id' };
  }
  // Either lookup port suffices.
  if (
    typeof provider?.getTicket !== 'function' ||
    typeof provider?.updateTicket !== 'function' ||
    (typeof provider?.getParentIssue !== 'function' &&
      typeof provider?.listTicketsByLabel !== 'function')
  ) {
    return { ...empty, reason: 'provider-unsupported' };
  }

  try {
    const matches = await findEpicsForStory({
      storyId: id,
      provider,
      skipEpicIds: new Set(skipEpicIds ?? []),
    });
    if (matches.length === 0) return { ...empty, reason: 'no-container-epic' };

    // Shared so board metadata resolves once.
    const sync =
      columnSync ??
      (typeof provider.graphql === 'function'
        ? new ColumnSync({ provider, logger: Logger, config })
        : null);
    const resolvedOwner =
      owner === undefined ? resolveEpicOwner(config) : owner;

    const epics = [];
    for (const { epic, childIds, nativeReadFailed, bodyOnlyIds } of matches) {
      epics.push(
        await rollUpOneEpic({
          epic,
          childIds,
          bodyOnlyIds,
          nativeReadFailed,
          provider,
          columnSync: sync,
          owner: resolvedOwner,
        }),
      );
    }
    return {
      epics,
      closed: epics.filter((e) => e.closed).map((e) => e.epicId),
      pending: epics.filter((e) => e.pending).map((e) => e.epicId),
      reason: null,
    };
  } catch (err) {
    const detail = String(err?.message ?? err);
    Logger.warn(`[epic-rollup] Rollup for Story #${id} failed: ${detail}`);
    return { ...empty, reason: detail };
  }
}
