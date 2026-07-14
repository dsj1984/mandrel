import { Logger } from '../Logger.js';
import { AGENT_LABELS } from '../label-constants.js';
import { upsertStructuredComment } from './ticketing.js';

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
    try {
      await provider.updateTicket(storyId, {
        labels: {
          add: [AGENT_LABELS.BLOCKED],
          remove: [AGENT_LABELS.READY, AGENT_LABELS.EXECUTING],
        },
      });
    } catch (err) {
      Logger.warn(
        `[single-story-init] failed to block Story after remote verification: ${err?.message ?? err}`,
      );
    }
  }
  throw new Error(message);
}
