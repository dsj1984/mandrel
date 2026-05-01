/**
 * Finalize phase — close out the run after the wave loop.
 *
 * For a `completed` run: flip Epic to `agent::review`, sync the project
 * column, and invoke the BookendChainer (which may auto-run `/epic-close`
 * when `epic::auto-close` was set). For a `halted` run: sync the column to
 * `agent::blocked` and exit without running bookends.
 *
 * Always finalizes the error journal on the way out.
 */

import { AGENT_LABELS } from '../../../label-constants.js';
import { STATE_LABELS, transitionTicketState } from '../../ticketing.js';

export async function runFinalizePhase(ctx, collaborators, state) {
  const { epicId, provider, logger } = ctx;
  const { notify: notifyFn, syncColumn, journal } = collaborators;
  const { completionState, waveHistory, bookends } = state;
  const journalSuffix = () => (journal?.path ? ` (see ${journal.path})` : '');

  try {
    if (completionState === 'completed') {
      await transitionTicketState(provider, epicId, STATE_LABELS.REVIEW, {
        notify: notifyFn,
      }).catch(async (err) => {
        logger.warn?.(
          `[EpicRunner] review flip failed: ${err.message}${journalSuffix()}`,
        );
        await journal?.record({
          module: 'EpicRunner',
          op: `transitionTicketState(#${epicId}, REVIEW)`,
          error: err,
          recovery: 'swallowed',
        });
      });
      await syncColumn?.(epicId, [STATE_LABELS.REVIEW]);
      const bookendResult = await bookends.run();
      if (bookendResult?.completed) {
        await syncColumn?.(epicId, [STATE_LABELS.DONE]);
      }
      return { epicId, state: completionState, waveHistory, bookendResult };
    }
    await syncColumn?.(epicId, [AGENT_LABELS.BLOCKED]);
    return {
      epicId,
      state: completionState,
      waveHistory,
      bookendResult: null,
    };
  } finally {
    await journal?.finalize?.();
  }
}
