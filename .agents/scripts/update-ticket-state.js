/**
 * .agents/scripts/update-ticket-state.js — CLI entrypoint for ticket
 * label transitions. Core logic lives in `lib/orchestration/ticketing.js`;
 * this file is the operator-facing command surface (not a compatibility
 * layer).
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { transitionTicketState } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const USAGE = {
  invocation:
    'node .agents/scripts/update-ticket-state.js --ticket <id> [--state <state> | --remove-label <label>]',
  summary:
    'The one sanctioned surface for an agent::* label transition on a ticket.',
  flags: [
    ['--ticket <id>', 'GitHub issue number to transition (required).'],
    [
      '--state <state>',
      'Target agent state (e.g. agent::ready, agent::executing, agent::done).',
    ],
    [
      '--remove-label <label>',
      'Drop a single label without flipping the agent state.',
    ],
  ],
  notes: ['Exactly one of --state or --remove-label is required.'],
};

/** @param {string[]} argv */
function parseTicketStateArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      state: { type: 'string' },
      'remove-label': { type: 'string' },
    },
    strict: false,
  });
  const ticketId = Number.parseInt(values.ticket, 10);
  const state = values.state;
  const removeLabel = values['remove-label'];
  if (Number.isNaN(ticketId) || (!state && !removeLabel)) {
    throw new Error(
      'Usage: node update-ticket-state.js ' +
        '--ticket <id> ' +
        '[--state <state> | --remove-label <label>]',
    );
  }
  return { ticketId, state, removeLabel };
}

/**
 * @param {{ argv?: string[], provider?: object, transition?: typeof transitionTicketState }} [opts]
 */
export async function runUpdateTicketState({
  argv = process.argv.slice(2),
  provider,
  transition = transitionTicketState,
} = {}) {
  const { ticketId, state, removeLabel } = parseTicketStateArgs(argv);
  const ticketing = provider ?? createProvider(resolveConfig());

  // Label-only mutation path — no state transition. Callers that just
  // need to drop a single label without flipping the agent::* state.
  if (removeLabel && !state) {
    Logger.info(
      `[State-Sync] Removing label \`${removeLabel}\` from ticket #${ticketId}...`,
    );
    await ticketing.updateTicket(ticketId, {
      labels: { remove: [removeLabel] },
    });
    Logger.info('[State-Sync] ✅ Success');
    return { ticketId, state: null, removedLabel: removeLabel };
  }

  Logger.info(`[State-Sync] Transitioning ticket #${ticketId} to ${state}...`);
  // No explicit cascade: `transitionTicketState` already runs it.
  await transition(ticketing, ticketId, state);

  // Optional secondary label removal alongside the state transition
  // (e.g. clear `status::blocked` when transitioning back to ready).
  if (removeLabel) {
    await ticketing.updateTicket(ticketId, {
      labels: { remove: [removeLabel] },
    });
  }

  Logger.info('[State-Sync] ✅ Success');
  return { ticketId, state, removedLabel: removeLabel ?? null };
}

runAsCli(import.meta.url, () => runUpdateTicketState(), {
  source: 'update-ticket-state',
  usage: USAGE,
});
