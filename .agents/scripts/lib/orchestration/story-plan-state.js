/**
 * story-plan-state.js — read the v2 Story planning checkpoint.
 *
 * `plan-persist.js` upserts one `story-plan-state` structured comment per
 * created Story carrying the persist receipt (when the plan completed, how many
 * Stories it created, and their ids). Story #4542 removed the risk fields it
 * used to carry: the planner-authored verdict, the envelope derived from it,
 * and the review routing computed from that envelope. Nothing read any of them
 * back — review depth is now derived from the diff at close time
 * (`review-depth.js#deriveChangeLevel`), so no checkpoint read sits on the
 * delivery path at all.
 */

import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment } from './ticketing.js';

/**
 * Read the v2 Story planning checkpoint. Missing/malformed comments degrade
 * to null — an unplanned Story simply has no persist receipt.
 */
export async function readStoryPlanState({
  provider,
  storyId,
  findCommentFn = findStructuredComment,
}) {
  const comment = await findCommentFn(
    provider,
    Number(storyId),
    'story-plan-state',
  );
  const state = parseFencedJsonComment(comment);
  return state && typeof state === 'object' ? state : null;
}
