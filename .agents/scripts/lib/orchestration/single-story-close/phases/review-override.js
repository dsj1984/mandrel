/**
 * phases/review-override.js — the sanctioned, logged override of a critical
 * review blocker. It replaces an untraceable hand-merge (the only escape from
 * a false blocker) with a mandatory-reason audit trail.
 */

import { Logger } from '../../../Logger.js';
import {
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../observability/runtime-friction.js';
import {
  postStructuredComment,
  upsertStructuredComment,
} from '../../ticketing.js';

const REASON_SIGNAL_LIMIT = 500;

/**
 * @param {{ prUrl: string, criticalCount: number, reason: string }} args
 * @returns {string}
 */
function buildReviewOverrideBody({ prUrl, criticalCount, reason }) {
  return [
    '### Code-review blocker overridden by operator',
    '',
    `The Story-scope review reported **${criticalCount} critical blocker(s)** on ${prUrl}.`,
    'The operator reviewed and rejected the finding(s) and authorized delivery',
    'with `--override-review-block`; auto-merge was armed.',
    '',
    '**Recorded reason:**',
    '',
    `> ${reason.split('\n').join('\n> ')}`,
    '',
    'The findings comment on the PR is left in place unchanged — this record',
    'sits beside it rather than resolving it.',
  ].join('\n');
}

/**
 * Best-effort: a partly failed trail must not block an authorized delivery.
 *
 * @param {{ post: () => Promise<unknown>, surface: string }} args
 * @returns {Promise<boolean>} true when the record landed.
 */
async function postAuditRecord({ post, surface }) {
  try {
    await post();
    return true;
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to post review-override record on ${surface}: ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Records to the Story (upsert, so re-runs don't stack), the PR (append-only,
 * where reviewers look), and the friction stream.
 *
 * @param {{
 *   provider: object,
 *   storyId: number,
 *   prUrl: string,
 *   prNumber: number|null,
 *   criticalCount: number,
 *   reason: string,
 *   config?: object,
 *   emitFrictionFn?: typeof emitRuntimeFriction,
 * }} args
 * @returns {Promise<{ overridden: true, reason: string, criticalCount: number }>}
 */
export async function handleOverriddenReviewBlock({
  provider,
  storyId,
  prUrl,
  prNumber,
  criticalCount,
  reason,
  config,
  emitFrictionFn = emitRuntimeFriction,
}) {
  const body = buildReviewOverrideBody({ prUrl, criticalCount, reason });
  Logger.warn(
    `[single-story-close] ⚠️ Story-scope review reported ${criticalCount} critical blocker(s) on ` +
      `PR ${prUrl} — OVERRIDDEN by operator: ${reason}`,
  );
  await postAuditRecord({
    post: () => upsertStructuredComment(provider, storyId, 'friction', body),
    surface: `Story #${storyId}`,
  });
  if (Number.isInteger(prNumber)) {
    await postAuditRecord({
      post: () =>
        postStructuredComment(provider, prNumber, 'notification', body),
      surface: `PR #${prNumber}`,
    });
  }
  await emitFrictionFn({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCK_OVERRIDDEN,
    tool: 'single-story-close',
    details: {
      prUrl,
      criticalCount,
      reason: reason.slice(0, REASON_SIGNAL_LIMIT),
    },
    config,
  });
  return { overridden: true, reason, criticalCount };
}
