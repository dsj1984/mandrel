import { Logger } from '../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './ticketing.js';

/**
 * Fail closed when the repository remote cannot be verified. The Story is
 * blocked before lease/branch/worktree mutation so a host that misses the
 * result envelope cannot strand an executing Story.
 */
export async function handleRemoteVerificationFailure({
  provider,
  storyId,
  remote,
  dryRun = false,
}) {
  if (remote?.remoteVerified) return;
  const message =
    `[single-story-init] remote verification failed for Story #${storyId}: ` +
    `${remote?.detail ?? 'origin is unavailable'}`;
  if (!dryRun) {
    try {
      await upsertStructuredComment(
        provider,
        storyId,
        'friction',
        `### Remote verification blocked delivery\n\n${message}`,
      );
    } catch (err) {
      Logger.warn(
        `[single-story-init] failed to post remote-verification friction: ${err?.message ?? err}`,
      );
    }
    // Use the canonical mutator: a direct label write skips the Projects v2
    // column sync and leaves the board reading To Do for a blocked Story.
    try {
      await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
    } catch (err) {
      Logger.warn(
        `[single-story-init] failed to block Story after remote verification: ${err?.message ?? err}`,
      );
    }
  }
  throw new Error(message);
}
