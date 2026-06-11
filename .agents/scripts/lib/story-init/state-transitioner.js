/**
 * state-transitioner.js — Stage 6 of the story-init pipeline.
 *
 * Flips the Story ticket to `agent::executing` at init time. Under the
 * 2-tier hierarchy the Story has inline acceptance and no child Task
 * lifecycle — `/deliver` runs a single Story-implementation phase.
 */

import {
  STATE_LABELS,
  transitionTicketState,
} from '../orchestration/ticketing.js';
import { batchTransitionTickets } from '../story-lifecycle.js';

/**
 * Flip the Story to `agent::executing` and cascade upward (Epic / Feature).
 *
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {number} deps.input.storyId
 * @param {object} deps.input.story - Prefetched Story ticket (`ticketSnapshot`).
 * @param {Function|null} [deps.input.notify]
 * @returns {Promise<{ ok: true }>}
 */
export async function transitionStoryToExecuting({ provider, logger, input }) {
  const { storyId, story, notify = null } = input;
  const progress = logger?.progress ?? (() => {});

  progress('TICKETS', `Transitioning Story #${storyId} to agent::executing...`);
  await transitionTicketState(provider, storyId, STATE_LABELS.EXECUTING, {
    ticketSnapshot: story,
    cascade: true,
    notify,
  });

  return { ok: true };
}

/**
 * Batch-transitions every child Task to a target label. Retained for
 * `batchTransitionTickets` unit coverage and post-merge batch closes;
 * story-init no longer calls this at startup.
 *
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {Array<object>} deps.input.tasks
 * @param {Function|null} [deps.input.notify]
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
