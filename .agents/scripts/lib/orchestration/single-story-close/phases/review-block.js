import { Logger } from '../../../Logger.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from '../../ticketing.js';

/** What halted: a critical count, or the no-verdict cause and its fix. */
function haltLines({ prUrl, criticalCount, noVerdictReason }) {
  if (noVerdictReason) {
    return [
      `The Story-scope review on ${prUrl} produced **no verdict** for part or all of the diff, and \`delivery.codeReview.onNoVerdict\` is \`block\`.`,
      '',
      noVerdictReason,
    ];
  }
  return [
    `The Story-scope review reported **${criticalCount} critical blocker(s)** on ${prUrl}.`,
    'Remediate the posted findings, then re-run `/mandrel-deliver`.',
  ];
}

/** @param {{ prUrl: string, criticalCount: number, noVerdictReason?: string|null }} halt */
function blockBody(halt) {
  return [
    '### Code review blocked delivery',
    '',
    ...haltLines(halt),
    '',
    'If you have reviewed a finding and judged it wrong, re-run close with',
    '`--override-review-block "<reason>"` rather than merging by hand — see',
    '`phases/review-override.js`. The override is recorded on the Story, on the',
    'PR, and as friction telemetry.',
  ].join('\n');
}

/**
 * Record a code-review halt (critical or no-verdict) as authoritative
 * blocked state before close releases the Story lease and returns non-zero.
 */
export async function handleCriticalReviewBlock({
  provider,
  storyId,
  ...halt
}) {
  const body = blockBody(halt);
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
