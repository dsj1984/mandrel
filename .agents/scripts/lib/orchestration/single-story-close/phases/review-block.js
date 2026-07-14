import { Logger } from '../../../Logger.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { upsertStructuredComment } from '../../ticketing.js';

/**
 * Record a critical code-review halt as authoritative blocked state before
 * close releases the Story lease and returns non-zero.
 */
export async function handleCriticalReviewBlock({
  provider,
  storyId,
  prUrl,
  criticalCount,
}) {
  const body = [
    '### Code review blocked delivery',
    '',
    `The Story-scope review reported **${criticalCount} critical blocker(s)** on ${prUrl}.`,
    'Remediate the posted findings, then re-run `/deliver`.',
  ].join('\n');
  try {
    await upsertStructuredComment(provider, storyId, 'friction', body);
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to post review-block friction: ${err?.message ?? err}`,
    );
  }
  try {
    await provider.updateTicket(storyId, {
      labels: {
        add: [AGENT_LABELS.BLOCKED],
        remove: [AGENT_LABELS.EXECUTING, AGENT_LABELS.READY],
      },
    });
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to block Story after critical review: ${err?.message ?? err}`,
    );
  }
}
