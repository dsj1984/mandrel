import { buildMergeMessageWithCap } from './merge-subject.js';

/**
 * comment-bodies.js — pure renderers for story-close GitHub comment payloads
 * and operator-facing fatal-message envelopes.
 *
 * Extracted from story-close.js (Story #955, Theme A part 3) so the close
 * orchestrator becomes a thin CLI shell. These helpers are stateless and
 * format-only:
 *
 *   - buildResumeMergeCommitMsg     — the conventional-commit subject the
 *     `--resume` partial-merge path uses to finalize the in-progress merge.
 *   - describeResumePushFailure     — classifies a `pushEpicWithRetry`
 *     outcome into the operator-facing fatal-error string (or returns null
 *     when the push was ok).
 *
 * Epic #1030 Story #1046 — `renderPhaseTimingsCommentBody` was removed; the
 * legacy `<!-- structured:phase-timings -->` post is now produced by
 * `analyze-execution.js` as the unified `<!-- structured:story-perf-summary -->`
 * comment. The `perf-summary` phase in post-merge-pipeline.js is the call
 * site.
 *
 * No I/O, no logging, no hidden globals. Tests import the same symbols and
 * pin behaviour without spawning the close script.
 */

/**
 * Pure: build the conventional-commit subject the resume path uses to
 * finalize a partial-merge commit. When `headerMaxLength` is provided
 * and the assembled subject would exceed it, the title is truncated on
 * a word boundary (Conventional-Commits prefix and `(resolves #N)` suffix
 * preserved verbatim) and a `truncated-from: <original>` body trailer is
 * appended. Exported for tests.
 *
 * @param {string} storyTitle
 * @param {number|string} storyId
 * @param {{ headerMaxLength?: number, logger?: { warn?: Function } }} [opts]
 */
export function buildResumeMergeCommitMsg(storyTitle, storyId, opts = {}) {
  return buildMergeMessageWithCap({
    type: 'feat',
    title: storyTitle,
    storyId,
    headerMaxLength: opts.headerMaxLength,
    logger: opts.logger,
  }).message;
}

/**
 * Pure: classify a `pushEpicWithRetry` outcome into the operator-facing
 * fatal-error message. Returns `null` when the push was ok.
 */
export function describeResumePushFailure(pushOutcome) {
  if (pushOutcome.ok) return null;
  const reasonLabel =
    pushOutcome.reason === 'retry-exhausted'
      ? `retries exhausted after ${pushOutcome.attempts} attempt(s)`
      : pushOutcome.reason;
  const detail =
    pushOutcome.result?.stderr || pushOutcome.result?.stdout || 'unknown';
  return `Push failed (${reasonLabel}): ${detail}`;
}
