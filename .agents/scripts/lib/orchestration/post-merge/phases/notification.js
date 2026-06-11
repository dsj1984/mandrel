/**
 * phases/notification.js — post-merge story-complete notification phase.
 *
 * Fires a single consolidated story-merged webhook, then a rolled-up
 * `epic-progress` webhook (comment-suppressed) so operators see the
 * Epic's stories-done count tick up at each story-close without
 * subscribing to the per-story `story-merged` channel. The rolled-up
 * dispatch is best-effort — a flaky webhook MUST NOT block story-close.
 */

import { notify } from '../../../../notify.js';
import { Logger } from '../../../Logger.js';

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export async function notificationPhase(ctx, state) {
  const {
    epicId,
    storyId,
    story,
    epicBranch,
    config,
    progress,
    provider,
    notifyFn = notify,
    logger = Logger,
  } = ctx;
  const closedTickets = state.ticketClosure?.closedTickets ?? [];
  const log = reapPhaseLogger(progress);
  log('NOTIFY', `Sending story-complete notification for Story #${storyId}...`);
  await notifyFn(
    epicId,
    {
      severity: 'medium',
      message: `✅ Story #${storyId} — *${story.title}* — has been completed and merged into \`${epicBranch}\`. ${closedTickets.length} ticket(s) closed.`,
      event: 'story-merged',
      level: 'story',
      epicId,
    },
    { config },
  );
  // Fire a rolled-up `epic-progress` webhook so operators see the Epic's
  // overall stories-done count tick up at each story-close, without
  // subscribing to the per-story `story-merged` channel. Comment is
  // suppressed (skipComment: true) — the operator-facing GitHub
  // comment is owned by the wave-record path; this fire is webhook-only.
  // Failures are swallowed by design (warn-then-continue) so a flaky
  // webhook never blocks story-close.
  if (provider && epicId) {
    try {
      const subs = (await provider.getSubTickets?.(epicId)) ?? [];
      const stories = subs.filter(
        (t) => Array.isArray(t.labels) && t.labels.includes('type::story'),
      );
      const total = stories.length;
      const done = stories.filter((s) => s.state === 'closed').length;
      const pct = total === 0 ? 0 : Math.round((done / total) * 100);
      await notifyFn(
        epicId,
        {
          severity: 'medium',
          message: `Epic #${epicId} progress · ${done}/${total} stories done (${pct}%) · Story #${storyId} merged`,
          event: 'epic-progress',
          level: 'epic',
          epicId,
        },
        { config, skipComment: true },
      );
    } catch (err) {
      logger?.warn?.(
        `[notificationPhase] rolled-up epic-progress dispatch failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }
  log('NOTIFY', '✅ Notification sent');
}
