/**
 * phases/ticket-closure.js — post-merge ticket transition + cascade phase.
 *
 * Transitions the Story to `agent::done`, then runs cascade completion
 * so any parent Epic-side rollup that is now fully resolved closes too.
 *
 * **2-tier closure (Story #3127).** Under the 2-tier hierarchy a Story
 * is the leaf unit of execution and has no child tickets — `tasks`
 * arrives as an empty array. `batchTransitionTickets` handles the empty
 * input cleanly (the loop trivially completes), the Story is
 * transitioned alone, and cascade completion walks upward to
 * parent. No branch on hierarchy mode is required here.
 *
 * Notifications are intentionally
 * NOT routed through the per-ticket transitions here — `notificationPhase`
 * fires a single rolled-up story-complete message immediately after this
 * phase, so threading `notify` through would double-emit events on every
 * close (Story #2534 / Task #2539).
 */

import { batchTransitionTickets } from '../../../story-lifecycle.js';
import { toDone } from '../../label-transitions.js';
import { cascadeCompletion, STATE_LABELS } from '../../ticketing.js';

function reapPhaseLogger(progress) {
  return progress ?? (() => {});
}

export async function ticketClosurePhase(ctx) {
  const { provider, tasks, storyId, progress, logger } = ctx;
  const log = reapPhaseLogger(progress);

  // The `notify` function is intentionally NOT forwarded to per-ticket
  // transitions here. `notificationPhase` fires a single consolidated
  // story-complete message immediately after this phase; passing notify
  // through would emit redundant state-transition events (one from the
  // cascade-up triggered by any child ticket, one from the explicit
  // Story toDone below) that show up as duplicate Slack/webhook lines per
  // story close.
  log(
    'TICKETS',
    `Transitioning ${tasks.length} child ticket(s) to agent::done...`,
  );
  const batch = await batchTransitionTickets(
    provider,
    tasks,
    STATE_LABELS.DONE,
    { progress: log },
  );
  const closedTickets = [...batch.transitioned, ...batch.skipped];

  // Story #2534 / Task #2539 — auto-transition `agent::closing →
  // agent::done` deterministically and idempotently on every successful
  // merge. The pre-Story #2534 path silently swallowed transport errors
  // here, which made an already-merged-but-not-labelled Story look closed
  // in the close-result envelope. We now:
  //   - read the Story snapshot first to detect an "already done" state
  //     (label `agent::done` AND issue state `closed`) and treat re-runs
  //     as a no-op record, satisfying the idempotency contract;
  //   - otherwise call `toDone` unconditionally — there is no other
  //     conditional skip in any normal exit path;
  //   - rethrow transport errors so the surrounding
  //     `runPhase('ticket-closure', ...)` logs the failure loudly via
  //     `[phase=ticket-closure] <message>` instead of letting the close
  //     report success on a half-failed transition.
  log('TICKETS', `Transitioning Story #${storyId} to agent::done...`);
  let storySnapshot = null;
  try {
    storySnapshot = await provider.getTicket(storyId);
  } catch (err) {
    logger?.warn?.(
      `[phase=tickets]   Story #${storyId} snapshot read failed (continuing with transition): ${err?.message ?? err}`,
    );
  }
  const alreadyDone =
    storySnapshot &&
    Array.isArray(storySnapshot.labels) &&
    storySnapshot.labels.includes(STATE_LABELS.DONE) &&
    storySnapshot.state === 'closed';
  if (alreadyDone) {
    log(
      'TICKETS',
      `  #${storyId} already agent::done — no-op (idempotent re-run)`,
    );
    closedTickets.push(storyId);
  } else {
    await toDone(provider, [storyId]);
    closedTickets.push(storyId);
    log('TICKETS', `  #${storyId} → agent::done ✅`);
  }

  log('TICKETS', 'Running cascade completion...');
  let cascadedTo = [];
  let cascadeFailed = [];
  try {
    const cascade = (await cascadeCompletion(provider, storyId)) ?? {
      cascadedTo: [],
      failed: [],
    };
    cascadedTo = cascade.cascadedTo ?? [];
    cascadeFailed = cascade.failed ?? [];
    if (cascadedTo.length > 0) {
      log(
        'TICKETS',
        `  Cascaded to: ${cascadedTo.map((id) => `#${id}`).join(', ')}`,
      );
    }
    for (const { parentId, error } of cascadeFailed) {
      logger.error(
        `  Cascade partial-failure on parent #${parentId}: ${error}`,
      );
    }
  } catch (err) {
    logger.error(`  Cascade fully failed (non-fatal): ${err.message}`);
  }

  return { closedTickets, cascadedTo, cascadeFailed };
}
