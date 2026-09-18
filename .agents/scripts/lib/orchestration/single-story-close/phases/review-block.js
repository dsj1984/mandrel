import { Logger } from '../../../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../../ticketing.js';

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
    'Remediate the posted findings, then re-run `/mandrel-deliver`.',
    '',
    'If you have reviewed a finding and judged it wrong, re-run close with',
    '`--override-review-block "<reason>"` rather than merging by hand — see',
    '`phases/review-override.js`. The override is recorded on the Story, on the',
    'PR, and as friction telemetry.',
  ].join('\n');
  try {
    await upsertStructuredComment(provider, storyId, 'friction', body);
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to post review-block friction: ${err?.message ?? err}`,
    );
  }
  // Canonical mutator, not a bare label write, so the Projects v2 column syncs.
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to block Story after critical review: ${err?.message ?? err}`,
    );
  }
}
