/**
 * label-transitions.js — readability wrappers over `transitionTicketState`.
 *
 * These are deliberately thin: each helper names the *target* state and
 * forwards to the underlying SDK call. They exist so that init / close /
 * deliver-tail call sites read as prose ("toExecuting(provider, taskId)")
 * instead of forcing readers to parse the `STATE_LABELS.X` constant at
 * every call site.
 *
 * Not an abstraction — the underlying `transitionTicketState` remains the
 * authoritative single-ticket transition path. Opts are forwarded verbatim.
 */

import { STATE_LABELS, transitionTicketState } from './ticketing.js';

/** Transition a ticket to `agent::executing`. */
export function toExecuting(provider, ticketId, opts) {
  return transitionTicketState(
    provider,
    ticketId,
    STATE_LABELS.EXECUTING,
    opts,
  );
}

/**
 * Transition an array of tickets to `agent::done`, in order. Each call
 * triggers its own cascade (via `transitionTicketState`). Failures for
 * individual tickets propagate — callers that need per-ticket tolerance
 * should use `batchTransitionTickets` instead.
 *
 * @param {object} provider
 * @param {number[]} ticketIds
 * @param {object} [opts]
 */
export async function toDone(provider, ticketIds, opts) {
  if (!Array.isArray(ticketIds)) {
    throw new TypeError('toDone: ticketIds must be an array');
  }
  for (const id of ticketIds) {
    await transitionTicketState(provider, id, STATE_LABELS.DONE, opts);
  }
}
