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
 * {@link rollUpEpicForStory} is invoked from **every edge that changes a
 * child's state**: the `agent::executing` flip in `single-story-init.js`, the
 * post-land tail, and the supersede close in `plan-persist`. Holding at N=1
 * was never the hard part — the gap was that a container only re-derived on
 * the edges someone had remembered to wire, so a cohort superseded by a
 * re-plan left its Epic open with no child that would ever move again.
 * Because every trigger is a child state change, the fallback scan reads
 * `state: 'all'`: "did this reopen work under a container I already closed?"
 * is always a live question.
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
 * @see Story #5280 — every child edge derives; the parent resolves in one
 *   call; the reads carry one declared shape.
 */

import { Logger } from '../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { concurrentMap } from '../util/concurrent-map.js';
import { ColumnSync, LABEL_TO_COLUMN } from './column-sync.js';
import {
  isEpicTicket,
  nativeChildReader,
  readEpicChildIdsFrom,
} from './epic-container.js';
import { resolveOperatorFromCandidates } from './lease-guard-shared.js';
import { anyChildLanded, deriveParentState } from './ticketing/bulk.js';

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
 * How many child reads a rollup keeps in flight.
 *
 * Matches the cap `resolve-stories.js` uses for the same shape of work — a
 * fan-out of independent single-issue GETs against one repo — because the
 * constraint being respected is GitHub's, not this module's: enough overlap to
 * collapse a 58-child Epic from 58 sequential round-trips, well under the
 * burst threshold that earns a secondary rate limit. The children of one Epic
 * are order-independent, so the serial loop this replaces was paying
 * `sum(round-trips)` for nothing.
 *
 * Deliberately not exported. Nothing outside this module reads the number, and
 * an export only tests import fails the production dead-export gate.
 */
const FETCH_CONCURRENCY = 5;

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
 * Fetch one child, or say why it does not count as one.
 *
 * Throws on a genuine read failure so the bounded fan-out around it rejects on
 * the first — the conservative answer, not a lazy one: `deriveParentState`
 * reads "all children done" off the list it is handed, so a silently dropped
 * child could close a container with work still open under it.
 *
 * The one id it declines to fail on is a **body-only** one that resolves to
 * nothing. The checklist is hand-editable prose, so a row can cite an issue
 * that was deleted, transferred or mistyped, and no re-run will ever make it
 * resolve — treating that as a failed read pins the container `pending`
 * forever over a typo. A *native* id that will not resolve keeps failing the
 * batch: the backend vouched for that edge, so its absence is a real read
 * problem and next tick may well answer.
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
 * Read every child of one Epic, freshly, bounded.
 *
 * Returns `null` when any child the Epic genuinely claims is unreadable, and
 * otherwise the children that count plus the ones refused by name.
 *
 * Note the scope: this validates the **readability of the ids it was given**,
 * never the **completeness of the id list**. Completeness is
 * `nativeReadFailed`'s job in {@link rollUpOneEpic} — checking only this one
 * is what let three readable ids stand in for 58 (Story #5210).
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

  // Classified after the fan-out, in input order, so the warnings an operator
  // reads and the `refused` list a caller reports do not depend on which
  // round-trip happened to finish first.
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
      // A container under a container. It has no `agent::*` label by
      // construction, so `deriveParentState` would read it as neither done nor
      // in flight and stall the parent on a child that is itself derived.
      // Nesting containers is out of scope entirely; say so and move on.
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
 * Close a container whose children are all finished.
 *
 * `landed` picks the reason and the sentence, and the two must agree. A cohort
 * re-planned out of existence closes every child as superseded — finished, so
 * the container is finished too, but nothing merged. Reporting that as
 * `completed` over "every child Story landed" is a false claim in the one
 * place an operator goes to find out what a run actually delivered.
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
 * Roll one Epic up from the children it lists.
 *
 * `nativeReadFailed` splits the writes by reversibility. Column and assignee
 * are recomputed from scratch on every later tick, so applying them to a
 * possibly-truncated list costs at most a stale board cell that self-corrects.
 * Closure does not: it is the one write no subsequent tick undoes (invariant 2
 * — a reopened child pulls Status back but MUST NOT reopen the issue), so it
 * requires a child list we know to be complete.
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
  // `epic.id` and nothing else: every read that reaches here now returns the
  // declared ticket shape, in which `id` IS the issue number.
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
 * Resolve this Story's container in **one** request, via the native edge.
 *
 * `getParentIssue` reads the sub-issue link backwards, which is the question
 * this module actually asks. The scan below is what it replaces: listing every
 * candidate Epic and reading each one's children until one of them mentions
 * the Story — O(containers) requests, all but one of them discarded.
 *
 * Returns `null` — never throws — when the provider has no such port, when the
 * Story has no parent, or when the parent is not a container Epic. Each of
 * those is "no answer *here*", and the caller's checklist scan is the other
 * half: linkage can legitimately exist as a body row with no native edge
 * behind it.
 *
 * @param {{ storyId: number, provider: object }} opts
 * @returns {Promise<object|null>} Mapped parent Epic, or null.
 */
async function parentEpicFor({ storyId, provider }) {
  if (typeof provider?.getParentIssue !== 'function') return null;
  let parent;
  try {
    parent = await provider.getParentIssue(storyId);
  } catch (err) {
    Logger.warn(
      `[epic-rollup] Parent lookup for Story #${storyId} degraded ` +
        `(${err?.message ?? err}); falling back to the label scan.`,
    );
    return null;
  }
  if (!parent || !isEpicTicket(parent)) return null;
  return parent;
}

/**
 * Every container Epic on the board, as the fallback for a Story whose parent
 * edge the native read could not answer.
 *
 * **`state: 'all'`, deliberately.** The scan used to be `state: 'open'`, which
 * made two of this module's documented behaviours unreachable: a closed
 * container was never listed, so a *reopened* child could never pull its
 * Status back to `In Progress`, and the `isClosed(epic)` branches downstream
 * were dead code asserting a rule nothing could exercise. Every edge that
 * invokes this rollup is a child's own state change — init, post-land, the
 * supersede close, the epilogue — so "did this change reopen work under a
 * container I already closed?" is always a live question, and an open-only
 * listing answers it wrongly rather than partially.
 *
 * Closing stays one-way regardless: {@link rollUpOneEpic} corrects a closed
 * Epic's Status and never writes its issue state.
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
 * Find the container Epics that hold a given Story, with their children.
 *
 * The lookup runs child→parent because linkage is parent→child only — a Story
 * body carries no pointer back, and adding one would reverse ADR
 * `20260726-v2-story-collapse`. It resolves the native edge first and scans
 * only when that answers nothing.
 *
 * The two paths differ in one thing: an Epic the *native* read named is this
 * Story's parent by construction, so its child list is read to derive state,
 * not to confirm the link. A *scanned* Epic still has to prove it lists the
 * Story.
 *
 * @param {{ storyId: number, provider: object, skipEpicIds: Set<number> }} opts
 * @returns {Promise<Array<{ epic: object, childIds: number[], nativeReadFailed: boolean, bodyOnlyIds: number[] }>>}
 */
async function findEpicsForStory({ storyId, provider, skipEpicIds }) {
  const parent = await parentEpicFor({ storyId, provider });
  const epics = parent ? [parent] : await scanContainerEpics({ provider });
  const authoritative = parent !== null;

  const matches = [];
  for (const epic of epics) {
    const epicId = Number(epic?.id);
    if (!Number.isInteger(epicId)) continue;
    if (skipEpicIds.has(epicId)) continue;
    // Body checklist UNION native sub-issue edges — the same reader the
    // delivery expansion uses, now literally the same function. Reading the
    // body alone here is what made an Epic whose children were linked in the
    // GitHub UI expandable but permanently unclosable.
    const {
      ids: childIds,
      nativeReadFailed,
      bodyOnlyIds,
    } = await readEpicChildIdsFrom({
      epic,
      readNativeChildIds: nativeChildReader(provider),
      onWarn: (message) => Logger.warn(message),
    });
    if (!authoritative && !childIds.includes(storyId)) {
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
    matches.push({ epic, childIds, nativeReadFailed, bodyOnlyIds });
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
  // One of the two lookup ports is enough: `getParentIssue` answers directly
  // and `listTicketsByLabel` answers by scanning, and `findEpicsForStory`
  // degrades from either to the other. Both absent means no way to reach a
  // container at all.
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
    // The module-level never-throws contract. Both call sites are lifecycle
    // edges of a Story that is otherwise fine; neither may fail on this.
    const detail = String(err?.message ?? err);
    Logger.warn(`[epic-rollup] Rollup for Story #${id} failed: ${detail}`);
    return { ...empty, reason: detail };
  }
}
