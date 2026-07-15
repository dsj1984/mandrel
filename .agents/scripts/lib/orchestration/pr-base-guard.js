// .agents/scripts/lib/orchestration/pr-base-guard.js
/**
 * pr-base-guard.js — refuse to open a pull request for a Story that still
 * carries an Epic/parent footer (pre-v2 hierarchy). v2 Stories are
 * standalone; Epic-attached bodies are a forward-cutover refusal, not a
 * redirect onto `epic/<N>`.
 */

import { resolveStoryHierarchy } from '../story-lifecycle.js';

/**
 * Inspect a Story's body for an Epic/parent reference and refuse any PR
 * when one is present. Callers must re-plan Epic-attached tickets as v2
 * Stories before delivering.
 *
 * @param {object} args
 * @param {number} args.storyId — Story ticket id (used in the error
 *   message so the operator can grep the failing surface).
 * @param {string|null|undefined} args.storyBody — raw Story body markdown.
 *   When falsy, the guard short-circuits (no body → nothing to enforce).
 * @param {string} args.baseBranch — retained for call-site compatibility;
 *   unused once an Epic/parent footer is detected (any base is refused).
 * @throws {Error} when the Story body declares an Epic or Parent footer.
 */
export function assertStoryPrBaseAllowed({
  storyId,
  storyBody,
  baseBranch: _baseBranch,
}) {
  if (!storyBody) return;
  const { epicId } = resolveStoryHierarchy(storyBody);
  if (epicId == null) return;
  throw new Error(
    `Story #${storyId} still declares Epic/Parent #${epicId}. ` +
      'v2 delivery is Story-only — re-plan as a standalone Story (no Epic footer) before opening a PR.',
  );
}
