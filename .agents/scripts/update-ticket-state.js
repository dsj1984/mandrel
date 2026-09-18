/**
 * .agents/scripts/update-ticket-state.js — CLI entrypoint for ticket
 * label transitions. Core logic lives in `lib/orchestration/ticketing.js`;
 * this file is the operator-facing command surface (not a compatibility
 * layer).
 */

import { parseArgs } from 'node:util';
import { respondToHelp } from './lib/cli-usage.js';
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

// ── CLI Main Block ────────────────────────────────────────────────────────
// cli-opt-out: re-export shim with a DEBUG_MAIN escape hatch for tests; runAsCli's strict path-equality guard would block the env-flag entry path.
if (
  (process.argv[1]?.endsWith('update-ticket-state.js') ||
    process.env.DEBUG_MAIN) &&
  !respondToHelp(process.argv.slice(2), USAGE)
) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
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

  (async () => {
    const config = resolveConfig();
    const provider = createProvider(config);

    // Label-only mutation path — no state transition. Callers that just
    // need to drop a single label without flipping the agent::* state.
    if (removeLabel && !state) {
      Logger.info(
        `[State-Sync] Removing label \`${removeLabel}\` from ticket #${ticketId}...`,
      );
      await provider.updateTicket(ticketId, {
        labels: { remove: [removeLabel] },
      });
      Logger.info('[State-Sync] ✅ Success');
      return;
    }

    Logger.info(
      `[State-Sync] Transitioning ticket #${ticketId} to ${state}...`,
    );
    // No explicit cascade: `transitionTicketState` already runs it.
    await transitionTicketState(provider, ticketId, state);

    // Optional secondary label removal alongside the state transition
    // (e.g. clear `status::blocked` when transitioning back to ready).
    if (removeLabel) {
      await provider.updateTicket(ticketId, {
        labels: { remove: [removeLabel] },
      });
    }

    Logger.info('[State-Sync] ✅ Success');
  })().catch((err) => {
    // Re-throw as an unhandled rejection so Node exits with a non-zero
    // status. Per orchestration-error-handling rule, orchestrator CLIs MUST
    // surface failures via throw rather than Logger.fatal so a stubbed
    // process.exit (in tests) does not silently mask the error.
    throw new Error(err.message);
  });
}
