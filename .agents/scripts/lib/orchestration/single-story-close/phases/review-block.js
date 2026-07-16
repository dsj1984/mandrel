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
    'Remediate the posted findings, then re-run `/deliver`.',
  ].join('\n');
  try {
    await upsertStructuredComment(provider, storyId, 'friction', body);
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to post review-block friction: ${err?.message ?? err}`,
    );
  }
  // Story #4539 — route through the canonical mutator rather than writing
  // labels directly. A bare `provider.updateTicket` skips the Projects v2
  // column sync (Story #2548), leaving the board on the Story's prior
  // status. That is benign today only because agent::blocked and
  // agent::executing happen to map to the same column — a coincidence, not
  // a design, and exactly how the next drift gets in.
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.BLOCKED, {});
  } catch (err) {
    Logger.warn(
      `[single-story-close] failed to block Story after critical review: ${err?.message ?? err}`,
    );
  }
}
