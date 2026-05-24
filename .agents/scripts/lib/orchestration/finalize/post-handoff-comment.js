// .agents/scripts/lib/orchestration/finalize/post-handoff-comment.js
/**
 * post-handoff-comment.js — finalize helper that upserts the
 * `epic-handoff` structured comment on the Epic at the end of the
 * bus-owned finalize flow.
 *
 * The Phase 7.1 prose previously asked operators to leave a free-form
 * "PR opened, see #N" comment after `gh pr create`. Lifting that
 * into a structured-marker upsert means the comment is:
 *
 *   - addressable by the `epic-handoff` marker (operators and tooling
 *     can find the canonical PR pointer without scrolling);
 *   - idempotent under finalize replay (re-invoking the helper edits
 *     the existing comment rather than fanning out duplicates).
 *
 * Story #2894 / Task #2909 (Epic #2880).
 */

import { Logger } from '../../Logger.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';

export const EPIC_HANDOFF_MARKER = 'epic-handoff';

/**
 * Render the `epic-handoff` comment body. Pure helper — exported so the
 * contract tests can assert the rendered shape without standing up a
 * provider.
 *
 * @param {{ epicId: number, prNumber: number, prUrl?: string|null }} input
 * @returns {string} markdown body (without the structured-comment marker
 *   prefix — the marker is prepended by `upsertStructuredComment`).
 */
export function renderHandoffBody({ epicId, prNumber, prUrl = null } = {}) {
  const lines = [];
  lines.push('### 🤝 Epic handoff — PR opened');
  lines.push('');
  lines.push(`Epic: #${epicId}`);
  if (typeof prUrl === 'string' && prUrl.length > 0) {
    lines.push(`Pull request: [#${prNumber}](${prUrl})`);
  } else {
    lines.push(`Pull request: #${prNumber}`);
  }
  lines.push('');
  lines.push(
    'Auto-merge will arm once the watch-and-iterate gate (Phase 8) confirms required checks are green.',
  );
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      { kind: 'epic-handoff', epicId, prNumber, prUrl: prUrl ?? null },
      null,
      2,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}

/**
 * Upsert the `epic-handoff` structured comment on the Epic ticket.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {number} args.prNumber
 * @param {string} [args.prUrl]
 * @param {object} args.provider — ITicketingProvider used by
 *   `upsertStructuredComment`.
 * @param {Function} [args.upsertStructuredCommentFn] — override for
 *   tests.
 * @param {object} [args.logger]
 * @returns {Promise<{ marker: string, commentId: number|null }>}
 */
export async function postHandoffComment({
  epicId,
  prNumber,
  prUrl,
  provider,
  upsertStructuredCommentFn = defaultUpsertStructuredComment,
  logger = Logger,
} = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError(
      'postHandoffComment: epicId must be a positive integer',
    );
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new TypeError(
      'postHandoffComment: prNumber must be a positive integer',
    );
  }
  if (!provider) {
    throw new TypeError('postHandoffComment: provider is required');
  }
  const body = renderHandoffBody({ epicId, prNumber, prUrl: prUrl ?? null });
  try {
    const result = await upsertStructuredCommentFn(
      provider,
      epicId,
      EPIC_HANDOFF_MARKER,
      body,
    );
    const commentId =
      typeof result?.commentId === 'number' ? result.commentId : null;
    return { marker: EPIC_HANDOFF_MARKER, commentId };
  } catch (err) {
    logger.warn?.(
      `[finalize/post-handoff-comment] upsert failed for Epic #${epicId}: ${err?.message ?? err}`,
    );
    throw err;
  }
}
