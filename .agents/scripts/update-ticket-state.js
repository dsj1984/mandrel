/**
 * .agents/scripts/update-ticket-state.js — CLI entrypoint for ticket
 * label transitions. Core logic lives in `lib/orchestration/ticketing.js`;
 * this file is the operator-facing command surface (not a compatibility
 * layer). The decision body is `runUpdateTicketState`, driven by tests with
 * an injected provider and transition.
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

/**
 * Parse and validate the argv. Throws the usage line when the ticket id is
 * not numeric or neither `--state` nor `--remove-label` is given.
 *
 * @param {string[]} argv
 * @returns {{ ticketId: number, state: string|undefined, removeLabel: string|undefined }}
 */
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
 * Apply one label mutation: the remove-label-only path, or the state
 * transition with an optional secondary label removal.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] Defaults to `process.argv.slice(2)`.
 * @param {object} [opts.provider] Defaults to the configured provider.
 * @param {typeof transitionTicketState} [opts.transition]
 * @returns {Promise<{ ticketId: number, state: string|null, removedLabel: string|null }>}
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
