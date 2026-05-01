/**
 * state-transitioner.js — Stage 6 of the story-init pipeline.
 *
 * Batch-transitions every child Task of the Story to `agent::executing`.
 * Returns a structured `{ ok, failed }` verdict so the caller can decide
 * whether partial failures abort init or are tolerated based on the
 * `orchestration.storyInit.continueOnPartialTransition` setting.
 */

import { STATE_LABELS } from '../orchestration/ticketing.js';
import { batchTransitionTickets } from '../story-lifecycle.js';

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {Array<object>} deps.input.tasks
 * @param {Function|null} [deps.input.notify] - Per-task notify hook. Pass a
 *   skipComment-aware wrapper so per-task webhooks fire individually but the
 *   comment fanout is consolidated into one Story-level summary by the caller
 *   (see `postBatchedTransitionSummary`).
 * @returns {Promise<{
 *   ok: boolean,
 *   failed: Array<{id:number,attempts:number,error:string}>,
 *   transitioned: number[],
 *   skipped: number[],
 * }>}
 */
export async function transitionTaskStates({ provider, logger, input }) {
  const { tasks, notify = null } = input;
  const progress = logger?.progress ?? (() => {});

  progress(
    'TICKETS',
    `Transitioning ${tasks.length} Task(s) to agent::executing...`,
  );
  const transitionResult = await batchTransitionTickets(
    provider,
    tasks,
    STATE_LABELS.EXECUTING,
    { progress, notify },
  );

  return {
    ok: transitionResult.failed.length === 0,
    failed: transitionResult.failed,
    transitioned: transitionResult.transitioned,
    skipped: transitionResult.skipped,
  };
}
