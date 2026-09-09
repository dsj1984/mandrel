/**
 * epic-rollup.js — derive a container Epic's board state from its children.
 *
 * A container Epic is never delivered, so nothing in the delivery engine
 * ever writes to it. That left it inert on the board for the whole run it
 * was the subject of: `columnForLabels` reads `agent::*` labels and the
 * container carries none by construction, so the Status sync always skipped
 * it; and the only closure lived in the multi-Story run epilogue, which a
 * single-Story delivery never reaches.
 *
 * This module is the one place that answers "what state is this Epic in?"
 * — by asking its children — and the one place that writes the answer.
 * {@link rollUpEpicForStory} is invoked from the two per-Story lifecycle
 * edges (the `agent::executing` flip in `single-story-init.js` and the
 * post-land tail), which is what makes the rollup hold at N=1, and the run
 * epilogue delegates its Epic close here so one closure rule exists.
 *
 * Three invariants shape the writes:
 *
 *   1. **The Epic never gains an `agent::*` label.** That absence keeps the
 *      container out of the bare `/mandrel-deliver` ready list and outside
 *      `lint-issue-body.js`, so the derived column goes to the board
 *      directly via `ColumnSync.setColumn` rather than through a label.
 *   2. **Status recomputes in both directions; closure is one-way.** A
 *      reopened child pulls a closed Epic's Status back to `In Progress`
 *      and MUST NOT reopen the issue — an operator who closed a container
 *      deliberately is not overruled by a reopened child.
 *   3. **Never throws.** Every step degrades with a reason. A stale
 *      container costs tidiness; a delivery failed on a board mutation
 *      costs a landed Story its terminal envelope.
 *   4. **Closure requires an authoritative child list.** Invariant 3 makes
 *      every read degrade rather than fail, which is right for the writes
 *      that recompute next tick and wrong for the one that does not. When
 *      the native sub-issue read fails, the body checklist still answers
 *      "who are the children" — but no longer "are these *all* of them",
 *      and closing on that difference shut an Epic over 23 open children
 *      (Story #5210). Degraded reads keep the Status and assignee writes
 *      and lose only the close.
 *
 * @module lib/orchestration/epic-rollup
 * @see Story #5205
 * @see Story #5210 — fail closed on a degraded child read.
 * @see Story #5255 — a closed child contributes no `agent::*` state.
 */

import { Logger } from '../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { ColumnSync, LABEL_TO_COLUMN } from './column-sync.js';
import {
  isEpicTicket,
  readEpicChildIdsFrom,
  resolveEpicNodeId,
} from './epic-container.js';
import { resolveOperatorFromCandidates } from './lease-guard-shared.js';
import { deriveParentState } from './ticketing/bulk.js';

/**
 * Derived states that mean "children are moving" — the window in which the
 * Epic carries an owner. `agent::blocked` counts: a blocked child is still
 * this operator's problem, and dropping the assignee at the moment someone
 * needs to be found would invert the signal.
 *
 * "Blocked" here means an **open** blocked child. `deriveParentState` stopped
 * reading closed children's `agent::*` labels in Story #5255 — a superseded
 * Story closed while still wearing `agent::blocked` is not someone's problem
 * to pick up, and the stale label used to derive `agent::blocked` forever,
 * which both held an owner on the container and pinned it open past the
 * `derived !== DONE` bail below.
 */
const IN_FLIGHT_STATES = new Set([
  AGENT_LABELS.EXECUTING,
  AGENT_LABELS.BLOCKED,
]);

/**
 * Read an Epic's native sub-issue children as issue numbers.
 *
 * A local adapter rather than an import from `resolve-stories.js`: that
 * module is a CLI entrypoint, and reaching up into one from the lib layer to
 * borrow four lines would invert the dependency direction for no gain. What
 * matters is that the *reader* handed to `readEpicChildIdsFrom` behaves the
 * same on both paths, which is what keeps an Epic from being expandable but
 * unclosable. The shared `resolveEpicNodeId` is what makes "the same" true of
 * the id itself: the Epics reaching this reader come from
 * `listIssuesByLabel`, whose raw REST payload carries `node_id`, while the
 * expansion path's come from `getTicket`, whose mapped ticket carries
 * `nodeId`.
 *
 * @param {object} provider
 * @returns {(epic: object) => Promise<number[]>}
 */
function nativeChildReader(provider) {
  return async (epic) => {
    const nodeId = resolveEpicNodeId(epic);
    if (nodeId === null) return [];
    return (
      provider?._getNativeSubIssues?.(nodeId, epic?.number ?? epic?.id) ?? []
    );
  };
}

/**
 * Resolve the handle the Epic is assigned to while its children run.
 *
 * Deliberately the **non-throwing** resolution (`missingHandleBehavior:
 * 'null'`), unlike the Story lease's: a container with no owner recorded is
 * a cosmetic gap, and refusing the whole rollup over it would cost the
 * Status write and the closure too.
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
 * Normalize an issue's assignee list to bare logins.
 *
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
 * Is this issue already closed?
 *
 * @param {{ state?: string }} issue
 * @returns {boolean}
 */
function isClosed(issue) {
  return String(issue?.state ?? '').toLowerCase() === 'closed';
}

/**
 * Read every child of one Epic, freshly.
 *
 * Returns `null` when any child is unreadable. That is the conservative
 * answer, not a lazy one: `deriveParentState` reads "all children done" off
 * the list it is handed, so a silently dropped child could close a container
 * with work still open under it.
 *
 * Note the scope: this validates the **readability of the ids it was given**,
 * never the **completeness of the id list**. Completeness is
 * `nativeReadFailed`'s job in {@link rollUpOneEpic} — checking only this one
 * is what let three readable ids stand in for 58 (Story #5210).
 *
 * @param {{ epicId: number, childIds: number[], provider: object }} opts
 * @returns {Promise<object[]|null>}
 */
async function readChildren({ epicId, childIds, provider }) {
  const children = [];
  for (const childId of childIds) {
    let child;
    try {
      child = await provider.getTicket(childId);
    } catch (err) {
      Logger.warn(
        `[epic-rollup] Epic #${epicId}: could not read child #${childId} ` +
          `(${err?.message ?? err}) — leaving the Epic untouched.`,
      );
      return null;
    }
    if (!child) {
      Logger.warn(
        `[epic-rollup] Epic #${epicId}: child #${childId} was not found — ` +
          'leaving the Epic untouched.',
      );
      return null;
    }
    children.push(child);
  }
  return children;
}

/**
 * Push the derived column onto the Epic's board item.
 *
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
 * Record the operator as the Epic's owner, additively.
 *
 * The additive assignees mutation is the only one that cannot evict a login
 * another run wrote between our read and our write, so it is the only one
 * used here — and the reason the assignee is never removed when the Epic
 * closes. A closed container naming who delivered it is useful; a removal
 * would need the replacing endpoint and would race every concurrent run.
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
 * Close a container whose children have all landed.
 *
 * @param {{ epicId: number, provider: object }} opts
 * @returns {Promise<{ closed: boolean, detail: string|null }>}
 */
async function applyClosure({ epicId, provider }) {
  try {
    await provider.updateTicket(epicId, {
      state: 'closed',
      state_reason: 'completed',
    });
    Logger.info(
      `[epic-rollup] Closed container Epic #${epicId} — every child Story landed.`,
    );
    return { closed: true, detail: null };
  } catch (err) {
    return { closed: false, detail: String(err?.message ?? err) };
  }
}

/**
 * Roll one Epic up from the children it lists.
 *
 * `nativeReadFailed` splits the writes by reversibility. Column and assignee
 * are recomputed from scratch on every later tick, so applying them to a
 * possibly-truncated list costs at most a stale board cell that self-corrects.
 * Closure does not: it is the one write no subsequent tick undoes (invariant 2
 * — a reopened child pulls Status back but MUST NOT reopen the issue), so it
 * requires a child list we know to be complete.
 *
 * @param {{ epic: object, childIds: number[], nativeReadFailed?: boolean, provider: object, columnSync: object, owner: string|null }} opts
 * @returns {Promise<object>} Per-Epic outcome record.
 */
async function rollUpOneEpic({
  epic,
  childIds,
  nativeReadFailed = false,
  provider,
  columnSync,
  owner,
}) {
  const epicId = Number(epic?.number ?? epic?.id);
  const outcome = {
    epicId,
    column: null,
    assigned: false,
    closed: false,
    pending: false,
    detail: null,
  };

  const children = await readChildren({ epicId, childIds, provider });
  if (children === null) {
    outcome.pending = true;
    outcome.detail = 'child-read-failed';
    return outcome;
  }

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
    // Not every child has landed. Reported pending only when the Epic is
    // still open — a closed container with an outstanding child is the
    // reopened-child case, whose Status we just corrected and whose issue
    // state is deliberately left alone.
    outcome.pending = !isClosed(epic);
    return outcome;
  }

  if (isClosed(epic)) return outcome;

  if (nativeReadFailed) {
    // Every child we could see has landed — but the authoritative read threw,
    // so "every child" is exactly the claim we cannot make. `readChildren`
    // above validates that the ids we were handed are *readable*; nothing
    // there validates that the list is *complete*, which is how an Epic with
    // 23 open children closed off the three its body happened to spell in the
    // bare `- [ ] #N` form (Story #5210). Overwrites any column/owner detail
    // deliberately: this is the reason the Epic is still pending.
    outcome.pending = true;
    outcome.detail = 'child-read-degraded';
    Logger.warn(
      `[epic-rollup] Epic #${epicId}: every child read looks done, but the ` +
        'native sub-issue read degraded — refusing to close on a possibly ' +
        'incomplete child list. Re-run once the API read succeeds.',
    );
    return outcome;
  }

  const closure = await applyClosure({ epicId, provider });
  outcome.closed = closure.closed;
  outcome.pending = !closure.closed;
  if (closure.detail) outcome.detail = closure.detail;
  return outcome;
}

/**
 * Find the open container Epics that list a given Story, with their children.
 *
 * The lookup runs child→parent by scanning open Epics because linkage is
 * parent→child only — a Story body carries no pointer back, and adding one
 * would reverse ADR `20260726-v2-story-collapse`. It is cheap: open
 * containers are few, and only one listing this Story is ever read further.
 *
 * @param {{ storyId: number, provider: object, skipEpicIds: Set<number> }} opts
 * @returns {Promise<Array<{ epic: object, childIds: number[], nativeReadFailed: boolean }>>}
 */
async function findEpicsForStory({ storyId, provider, skipEpicIds }) {
  let epics;
  try {
    epics = await provider.listIssuesByLabel({
      state: 'open',
      labels: TYPE_LABELS.EPIC,
    });
  } catch (err) {
    Logger.warn(
      `[epic-rollup] Could not list open Epics (${err?.message ?? err}); ` +
        'skipping the rollup.',
    );
    return [];
  }

  const matches = [];
  for (const epic of Array.isArray(epics) ? epics : []) {
    if (!isEpicTicket(epic)) continue;
    const epicId = Number(epic?.number ?? epic?.id);
    if (!Number.isInteger(epicId)) continue;
    if (skipEpicIds.has(epicId)) continue;
    // Body checklist UNION native sub-issue edges — the same reader the
    // delivery expansion uses. Reading the body alone here is what made an
    // Epic whose children were linked in the GitHub UI expandable but
    // permanently unclosable.
    const { ids: childIds, nativeReadFailed } = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: nativeChildReader(provider),
      onWarn: (message) => Logger.warn(message),
    });
    if (!childIds.includes(storyId)) {
      // A degraded read can truncate this Story out of its own container's
      // child list, which drops the Epic from the run entirely rather than
      // rolling it up wrongly. Non-destructive, but silent — say so, since it
      // is the same root cause as the refusal in `rollUpOneEpic`.
      if (nativeReadFailed) {
        Logger.warn(
          `[epic-rollup] Epic #${epicId}: skipped for Story #${storyId} on a ` +
            'degraded child read — the Story may in fact be linked to it.',
        );
      }
      continue;
    }
    matches.push({ epic, childIds, nativeReadFailed });
  }
  return matches;
}

/**
 * Roll every container Epic listing this Story up from its children.
 *
 * `skipEpicIds` exists for a caller that walks several Stories of one run:
 * siblings share a container, so without it the second Story would re-derive
 * — and re-close — an Epic the first already closed. Live listings filter to
 * open Epics and would eventually hide it, but a caller must not have to rely
 * on a remote read racing its own writes.
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
  if (
    typeof provider?.listIssuesByLabel !== 'function' ||
    typeof provider?.getTicket !== 'function' ||
    typeof provider?.updateTicket !== 'function'
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

    // One ColumnSync across every Epic in the run: it caches the board
    // metadata, so sharing it spends the resolve once instead of per Epic.
    const sync =
      columnSync ??
      (typeof provider.graphql === 'function'
        ? new ColumnSync({ provider, logger: Logger, config })
        : null);
    const resolvedOwner =
      owner === undefined ? resolveEpicOwner(config) : owner;

    const epics = [];
    for (const { epic, childIds, nativeReadFailed } of matches) {
      epics.push(
        await rollUpOneEpic({
          epic,
          childIds,
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
    // The module-level never-throws contract. Both call sites are lifecycle
    // edges of a Story that is otherwise fine; neither may fail on this.
    const detail = String(err?.message ?? err);
    Logger.warn(`[epic-rollup] Rollup for Story #${id} failed: ${detail}`);
    return { ...empty, reason: detail };
  }
}
