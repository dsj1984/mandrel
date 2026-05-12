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
 * This module starts with `mayClose` (Task #1512) and `mayUpdate` (Task
 * #1513); sibling tasks add `STRUCTURAL_LABELS` plus the diff-time
 * assertion (Task #1515), and the regression coverage (Task #1517).
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

import { AGENT_LABELS } from '../label-constants.js';

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
