/**
 * blocker-wait.js — single runtime pause point for the iterate-waves
 * phase.
 *
 * Story #2241 / Task #2246 split the original `epic-runner/blocker-handler.js`
 * into two pieces:
 *
 *   1. The lifecycle BlockerHandler listener at
 *      `lib/orchestration/lifecycle/listeners/blocker-handler.js` — owns
 *      classification + cascade emission (`story.blocked` →
 *      `epic.blocked`).
 *   2. This module — owns the wait-for-operator-resume polling loop,
 *      which is intentionally NOT a listener responsibility (a listener
 *      runs synchronously inside a bus emit; the resume loop is
 *      decoupled from any single emit and runs across many minutes).
 *
 * The label-flip / structured-comment / notify side effects that the
 * legacy `BlockerHandler.halt()` performed are now produced by the
 * existing LabelTransitioner / StructuredCommentPoster /
 * NotifyDispatcher listeners when `epic.blocked` lands on the bus, so
 * this helper does not touch the provider or the notify surface.
 */

import { AGENT_LABELS } from '../../label-constants.js';
import { pollUntil } from '../../util/poll-loop.js';

const BLOCKED_LABEL = AGENT_LABELS.BLOCKED;
const EXECUTING_LABEL = AGENT_LABELS.EXECUTING;

/**
 * Poll the Epic ticket's labels until the operator flips it back to
 * `agent::executing`. Returns `{ resumed: true }` when the flip is
 * observed, `{ resumed: false, reasonToStop: 'aborted' }` if the
 * supplied AbortSignal aborts before the flip is seen.
 *
 * The poll uses the existing `pollUntil` utility so its backoff /
 * abort semantics match every other poll loop in the runner. A
 * `labelFetcher` throw is treated as "labels unknown" — `pollUntil`
 * keeps polling until either the predicate matches or the signal
 * aborts; a transient GitHub 5xx must not break the runner.
 *
 * @param {{
 *   epicId: number,
 *   labelFetcher: (id: number) => Promise<string[]>,
 *   pollIntervalMs?: number,
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 *   errorJournal?: { record?: Function, path?: string },
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ resumed: boolean, reasonToStop?: string }>}
 */
export async function waitForEpicUnblock(opts) {
  const {
    epicId,
    labelFetcher,
    pollIntervalMs = 30_000,
    logger = console,
    errorJournal = null,
    signal,
  } = opts;
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError('waitForEpicUnblock requires a numeric epicId');
  }
  if (typeof labelFetcher !== 'function') {
    throw new TypeError('waitForEpicUnblock requires a labelFetcher function');
  }
  const journalSuffix = () =>
    errorJournal?.path ? ` (see ${errorJournal.path})` : '';

  const safeLabels = async (id) => {
    try {
      return await labelFetcher(id);
    } catch (err) {
      logger.warn?.(
        `[blocker-wait] poll error on #${id}: ${err?.message ?? err}${journalSuffix()}`,
      );
      await errorJournal?.record?.({
        module: 'BlockerWait',
        op: 'labelFetcher',
        error: err,
        recovery: 'returned-empty',
      });
      return [];
    }
  };

  const resumed = await pollUntil({
    fn: () => safeLabels(epicId),
    predicate: (labels) =>
      labels.includes(EXECUTING_LABEL) && !labels.includes(BLOCKED_LABEL),
    intervalMs: pollIntervalMs,
    signal,
    logger,
  });
  if (resumed) {
    logger.info?.(`[blocker-wait] Epic #${epicId} resumed by operator.`);
    return { resumed: true };
  }
  return { resumed: false, reasonToStop: 'aborted' };
}
