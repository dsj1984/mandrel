/**
 * comment-bodies.js — pure renderers for story-close GitHub comment payloads
 * and operator-facing fatal-message envelopes.
 *
 * Extracted from story-close.js (Story #955, Theme A part 3) so the close
 * orchestrator becomes a thin CLI shell. These three helpers are stateless
 * and format-only:
 *
 *   - renderPhaseTimingsCommentBody — builds the fenced JSON body the
 *     epic-runner progress reporter aggregates into median/p95 rows.
 *   - buildResumeMergeCommitMsg     — the conventional-commit subject the
 *     `--resume` partial-merge path uses to finalize the in-progress merge.
 *   - describeResumePushFailure     — classifies a `pushEpicWithRetry`
 *     outcome into the operator-facing fatal-error string (or returns null
 *     when the push was ok).
 *
 * No I/O, no logging, no hidden globals. Tests import the same symbols and
 * pin behaviour without spawning the close script.
 */

/**
 * Render the `phase-timings` comment body.
 *
 * The payload is emitted inside a fenced ```json block so the epic-runner
 * progress reporter can parse it back out with a single regex + JSON.parse
 * rather than relying on a bespoke marker format. Schema matches tech
 * spec #555 §Data Models (`{ kind, storyId, totalMs, phases }`).
 */
export function renderPhaseTimingsCommentBody(summary) {
  const payload = {
    kind: 'phase-timings',
    storyId: summary.storyId,
    totalMs: summary.totalMs,
    phases: summary.phases,
  };
  return `### Phase timings — story #${summary.storyId}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

/**
 * Pure: build the conventional-commit subject the resume path uses to
 * finalize a partial-merge commit. Exported for tests.
 */
export function buildResumeMergeCommitMsg(storyTitle, storyId) {
  const lc = storyTitle.charAt(0).toLowerCase() + storyTitle.slice(1);
  return `feat: ${lc} (resolves #${storyId})`;
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
