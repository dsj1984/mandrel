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
 * This module starts with `mayClose` (Task #1512); sibling tasks add
 * `mayUpdate` (Task #1513), `STRUCTURAL_LABELS` plus the diff-time
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
