/**
 * lib/orchestration/epic-spec-reconciler-discriminator.js — pure drift
 * discriminator for the epic-spec reconciler (Epic #1182 / Tech Spec
 * #1483 / Story #1493).
 *
 * The reconciler must never clobber state owned by the wave-runner. The
 * spec carries structural fields (title, body, structural labels, parent,
 * dependsOn) while the wave-runner owns execution state (`agent::*`
 * labels, PR linkage, merge state, issue close state). When the spec
 * drops a Story whose branch is already merged — or when a structural
 * diff would touch an `agent::*` label — the reconciler must refuse.
 *
 * The module exports `mayClose` (Task #1512), `mayUpdate` (Task #1513),
 * `STRUCTURAL_LABELS` plus the diff-time assertion (Task #1515), and is
 * exercised by the regression suite in Task #1517.
 *
 * All predicates here are I/O-free and accept plain data objects only.
 * Same inputs → same answer, every time. They do not call GitHub, the
 * file system, the clock, or any provider — the reconciler's apply
 * pipeline is the only place that touches the world.
 *
 * ## `mayClose(story, opts)`
 *
 * @typedef {object} StorySnapshot
 * @property {string}  [status]        Current `agent::*` status string.
 *                                     Compared against AGENT_LABELS.
 * @property {boolean} [hasMergedPr]   True when an associated PR has
 *                                     already merged into the epic branch.
 * @property {number}  [openPrCount]   Open PR count linked to the Story
 *                                     branch. Any positive value blocks.
 *
 * @typedef {object} MayCloseOptions
 * @property {boolean} [explicitDelete]
 *   Operator's explicit intent to delete the Story even if quiescent.
 *   Omitted / false means "only close if every other signal is also
 *   quiescent" — but the discriminator still requires an explicit
 *   acknowledgement (the spec dropping the slug is NOT enough on its
 *   own). When omitted, `mayClose` always returns
 *   `{ allowed: false, reason: 'explicit-delete-required' }` so the diff
 *   cannot accidentally close a Story the operator did not opt in to
 *   deleting.
 *
 * @typedef {object} PredicateResult
 * @property {boolean} allowed
 * @property {string}  [reason]   Structured reason code when allowed=false.
 */

import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';

/**
 * Execution-signal labels that block Close. Stored as a frozen Set for
 * O(1) lookup. Anything in this set counts as live execution state the
 * wave-runner owns — the reconciler must stand back.
 */
const EXECUTION_STATUS_LABELS = Object.freeze(
  new Set([
    AGENT_LABELS.DONE,
    AGENT_LABELS.REVIEW_SPEC,
    AGENT_LABELS.EXECUTING,
  ]),
);

/**
 * Predicate gating Close operations on a Story.
 *
 * Returns `{ allowed: true }` only when:
 *   1. `opts.explicitDelete === true` (operator opted in), AND
 *   2. `story.status` is NOT one of `agent::done|review-spec|executing`, AND
 *   3. `story.hasMergedPr` is not truthy, AND
 *   4. `story.openPrCount` is `0` or absent.
 *
 * The Tech Spec's destructive-replan regression case is the prime mover
 * here: a Story whose branch is already merged must NEVER be closed by
 * the reconciler, no matter what the spec says. Likewise, a Story
 * `agent::executing` is live work the wave-runner is driving and the
 * reconciler must stand back.
 *
 * Execution signals are checked **before** the explicit-delete gate so
 * the reason code reports the most specific blocker rather than the
 * broader opt-in failure.
 *
 * @param {StorySnapshot} [story]
 * @param {MayCloseOptions} [opts]
 * @returns {PredicateResult}
 */
export function mayClose(story = {}, opts = {}) {
  if (story.status && EXECUTION_STATUS_LABELS.has(story.status)) {
    return {
      allowed: false,
      reason: `execution-status:${story.status}`,
    };
  }
  if (story.hasMergedPr) {
    return { allowed: false, reason: 'merged-pr-exists' };
  }
  if (typeof story.openPrCount === 'number' && story.openPrCount > 0) {
    return { allowed: false, reason: 'open-pr-exists' };
  }
  if (opts.explicitDelete !== true) {
    return { allowed: false, reason: 'explicit-delete-required' };
  }
  return { allowed: true };
}

/**
 * Frozen list of the AGENT_LABELS values, used by `mayUpdate` (and, when
 * Task #1515 lands, by the diff-time assertion). Building this once at
 * module load keeps the predicate allocation-free.
 */
const AGENT_LABEL_VALUES = Object.freeze(Object.values(AGENT_LABELS));

/**
 * The structural-field allow-list for `mayUpdate(story, field)`. These
 * are the only fields the spec is authoritative over; anything outside
 * the list is wave-runner state and must not be touched by the
 * reconciler. Stored as a frozen Set for O(1) membership checks.
 *
 * `wave` is included because the reconciler is the only authority for
 * wave numbering — wave-runner state lives in agent::* labels and PR
 * linkage, not in the wave integer.
 */
const STRUCTURAL_FIELDS = Object.freeze(
  new Set(['title', 'body', 'labels', 'parent', 'dependsOn', 'wave']),
);

/**
 * Predicate gating Update operations on a Story field.
 *
 * Returns `{ allowed: false }` for any field name that:
 *   - is not a string (defensive — diff engine should never reach here
 *     with a non-string field), OR
 *   - is a label value that intersects AGENT_LABELS (so callers can
 *     pass either a field name like `'title'` or a candidate label like
 *     `'agent::executing'` and the predicate rejects the latter), OR
 *   - is not in the structural allow-list
 *     (`title|body|labels|parent|dependsOn|wave`).
 *
 * The Task #1513 acceptance criteria require:
 *   1. Every AGENT_LABELS value returns `allowed=false`.
 *   2. `title|body|parent|dependsOn` return `allowed=true`.
 *   3. The implementation imports AGENT_LABELS from label-constants.js
 *      rather than maintaining a local copy.
 *
 * Reason codes are structured strings prefixed by the failure mode so
 * callers can pattern-match without keeping the constant set in sync:
 *
 *   - `invalid-field`            — non-string / empty.
 *   - `agent-label:<name>`       — field is an agent::* label.
 *   - `non-structural-field:<n>` — field is not in the allow-list.
 *
 * @param {StorySnapshot} [_story]  Reserved for future signal-aware
 *                                   predicates. Currently unused —
 *                                   structural fields are universally
 *                                   updatable regardless of story state.
 * @param {string} field
 * @returns {PredicateResult}
 */
export function mayUpdate(_story, field) {
  if (typeof field !== 'string' || field.length === 0) {
    return { allowed: false, reason: 'invalid-field' };
  }
  if (AGENT_LABEL_VALUES.includes(field)) {
    return { allowed: false, reason: `agent-label:${field}` };
  }
  if (!STRUCTURAL_FIELDS.has(field)) {
    return { allowed: false, reason: `non-structural-field:${field}` };
  }
  return { allowed: true };
}

/**
 * STRUCTURAL_LABELS — the structural side of the project label namespace
 * (complement of AGENT_LABELS).
 *
 * The Tech Spec wording — "STRUCTURAL_LABELS is the complement of
 * AGENT_LABELS within the project's label namespace" — does not pin a
 * static enumeration: the structural label set is open (type::*,
 * persona::*, context::*, status::*, and bespoke per-Epic tags), while
 * the agent set is closed and small. We therefore expose the membership
 * filter rather than a static enumeration; consumers pass their full
 * label list and the helper returns the complement.
 *
 * Helpers:
 *
 *   - `isStructuralLabel(label)` — true iff the label is NOT in AGENT_LABELS.
 *   - `partitionLabels(labels)`  — split a label array into
 *                                  `{ structural, agent }` buckets.
 *   - `AGENT_LABEL_VALUES`       — the deny-list (frozen array).
 *
 * Tests assert `isStructuralLabel(agent::*)` is false for every entry of
 * AGENT_LABELS and `partitionLabels(['type::story', 'agent::executing'])`
 * splits cleanly, which is the closest finite assertion of the
 * complement contract.
 *
 * @type {{
 *   isStructuralLabel: (label: string) => boolean,
 *   partitionLabels: (labels: string[]) => { structural: string[], agent: string[] },
 *   AGENT_LABEL_VALUES: readonly string[],
 * }}
 */
export const STRUCTURAL_LABELS = Object.freeze({
  AGENT_LABEL_VALUES,
  isStructuralLabel(label) {
    return typeof label === 'string' && !AGENT_LABEL_VALUES.includes(label);
  },
  partitionLabels(labels) {
    const structural = [];
    const agent = [];
    for (const label of labels ?? []) {
      if (typeof label !== 'string') continue;
      if (AGENT_LABEL_VALUES.includes(label)) {
        agent.push(label);
      } else {
        structural.push(label);
      }
    }
    return { structural, agent };
  },
});

/**
 * Error class thrown synchronously by the diff-time assertion when a
 * plan operation targets an `agent::*` label. Named so callers can
 * `instanceof`-check and so the apply pipeline distinguishes it from
 * generic `TypeError`s emitted by the operation factories.
 *
 * The class carries structured metadata (`slug`, `field`,
 * `offendingLabels`) so the dispatch manifest / wave-runner logs can
 * route the failure back to the offending Story without re-parsing the
 * message string.
 */
export class LabelAllowListViolation extends Error {
  /**
   * @param {string} message
   * @param {{slug?: string, field?: string, offendingLabels?: string[]}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LabelAllowListViolation';
    if (meta.slug !== undefined) this.slug = meta.slug;
    if (meta.field !== undefined) this.field = meta.field;
    if (meta.offendingLabels !== undefined) {
      this.offendingLabels = [...meta.offendingLabels];
    }
  }
}

/**
 * Error class thrown synchronously by `assertStoryTypeLabel` when a Story
 * create operation carries no `type::story` label. Named distinctly from
 * `LabelAllowListViolation` so callers can route it separately.
 *
 * The class carries structured metadata (`slug`, `title`) so the error
 * message can name the offending Story clearly.
 */
export class MissingTypeLabelError extends Error {
  /**
   * @param {string} message
   * @param {{slug?: string, title?: string}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MissingTypeLabelError';
    if (meta.slug !== undefined) this.slug = meta.slug;
    if (meta.title !== undefined) this.title = meta.title;
  }
}

/**
 * Diff-time assertion. Throws `MissingTypeLabelError` synchronously when a
 * Story create operation is missing the mandatory `type::story` label.
 *
 * Symmetric with `assertNoAgentLabels`: both fire at diff time so the plan
 * fails loudly before the apply pipeline touches GitHub.
 *
 * Only validates Story create ops — Epic creates carry a different mandatory
 * label (`type::epic`) that the caller already hard-codes at issue-creation
 * time; the assertion is not needed there.
 *
 * @param {{slug?: string, title?: string, entity?: string, labels?: string[]}} op
 * @returns {void}
 */
export function assertStoryTypeLabel(op) {
  if (!op || typeof op !== 'object') return;
  if (op.entity !== 'story') return;
  // A create op for a Story MUST carry type::story. An absent or empty labels
  // array means the mandatory label is missing — fail loud so the operator
  // sees a named Story rather than a silent unlabeled issue on GitHub.
  if (!Array.isArray(op.labels) || !op.labels.includes(TYPE_LABELS.STORY)) {
    throw new MissingTypeLabelError(
      `create plan for story slug=${op.slug ?? '?'} ("${op.title ?? ''}") is ` +
        `missing the mandatory "${TYPE_LABELS.STORY}" label. Add it to the ` +
        `spec's labels array for this Story and re-run.`,
      { slug: op.slug, title: op.title },
    );
  }
}

/**
 * Diff-time assertion. Throws `LabelAllowListViolation` synchronously
 * when an operation targets an `agent::*` label. The assertion is the
 * safety net for the apply pipeline: plans fail loudly at construction
 * time, not silently mis-apply at runtime.
 *
 * Accepts the change-key list either via `op.changes` (UpdateOp) or via
 * a `labels` array (CreateOp). Other op kinds (Close, Relink) carry no
 * label payload and are no-ops.
 *
 * @param {{kind?: string, slug?: string, changes?: Record<string, unknown>, labels?: string[]}} op
 * @returns {void}
 */
export function assertNoAgentLabels(op) {
  if (!op || typeof op !== 'object') return;

  // UpdateOp — every key in `changes` must be either a structural field
  // or a structural label name. The diff engine currently emits
  // `title|body|labels|wave`, but the assertion also catches an apply-
  // pipeline bug that would route an `agent::*` rename through here.
  if (op.changes && typeof op.changes === 'object') {
    const offending = Object.keys(op.changes).filter((key) =>
      AGENT_LABEL_VALUES.includes(key),
    );
    if (offending.length > 0) {
      throw new LabelAllowListViolation(
        `update plan for slug=${op.slug ?? '?'} targets agent label(s): ${offending.join(', ')}`,
        { slug: op.slug, field: offending[0], offendingLabels: offending },
      );
    }
    // The `labels` change set itself must not write an agent::* into
    // labels.after — an update that adds an agent label is just as bad
    // as one keyed by the agent label name.
    const labelChange = /** @type {{after?: unknown}} */ (op.changes.labels);
    if (
      labelChange &&
      typeof labelChange === 'object' &&
      Array.isArray(labelChange.after)
    ) {
      const after = /** @type {string[]} */ (labelChange.after);
      const agentInAfter = after.filter((label) =>
        AGENT_LABEL_VALUES.includes(label),
      );
      if (agentInAfter.length > 0) {
        throw new LabelAllowListViolation(
          `update plan for slug=${op.slug ?? '?'} writes agent label(s) into labels.after: ${agentInAfter.join(', ')}`,
          {
            slug: op.slug,
            field: 'labels',
            offendingLabels: agentInAfter,
          },
        );
      }
    }
  }

  // CreateOp — labels array must not contain any agent::* value.
  if (Array.isArray(op.labels)) {
    const offending = op.labels.filter((label) =>
      AGENT_LABEL_VALUES.includes(label),
    );
    if (offending.length > 0) {
      throw new LabelAllowListViolation(
        `create plan for slug=${op.slug ?? '?'} carries agent label(s): ${offending.join(', ')}`,
        {
          slug: op.slug,
          field: 'labels',
          offendingLabels: offending,
        },
      );
    }
  }
}

/**
 * Assert the same invariant over an entire plan. Convenience wrapper for
 * the diff engine — iterates every bucket and throws on the first
 * violation. Pure; raises synchronously.
 *
 * @param {{creates?: object[], updates?: object[], closes?: object[], relinks?: object[]}} plan
 * @returns {void}
 */
export function assertPlanLabelAllowList(plan) {
  if (!plan || typeof plan !== 'object') return;
  for (const op of plan.creates ?? []) {
    assertNoAgentLabels(op);
    assertStoryTypeLabel(op);
  }
  for (const op of plan.updates ?? []) assertNoAgentLabels(op);
  // closes/relinks do not carry label payloads — nothing to assert.
}
