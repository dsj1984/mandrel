/**
 * confirm-merge-follow-ups.js — post-land follow-up capture seam for
 * `single-story-confirm-merge.js` (keeps the CLI entry under the MI ceiling).
 */

import { captureFollowUpsAfterConfirm } from '../orchestration/story-follow-ups.js';

/**
 * @param {object} args
 * @param {object} args.confirmation
 * @param {number} args.storyId
 * @param {number|null} args.prNumber
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} args.cwd
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @returns {Promise<object>}
 */
export async function withConfirmFollowUps({
  confirmation,
  storyId,
  prNumber,
  provider,
  config,
  cwd,
  progress,
}) {
  const followUps = await captureFollowUpsAfterConfirm(confirmation, {
    storyId,
    provider,
    config,
    cwd,
    progress,
  });
  return { standalone: true, prNumber, ...confirmation, followUps };
}
