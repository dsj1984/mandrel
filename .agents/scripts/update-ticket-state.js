/**
 * .agents/scripts/update-ticket-state.js — CLI entrypoint for ticket
 * label transitions. Core logic lives in `lib/orchestration/ticketing.js`;
 * this file is the operator-facing command surface (not a compatibility
 * layer).
 */

import { parseArgs } from 'node:util';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { transitionTicketState } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

// ── CLI Main Block ────────────────────────────────────────────────────────
// cli-opt-out: re-export shim with a DEBUG_MAIN escape hatch for tests; runAsCli's strict path-equality guard would block the env-flag entry path.
if (
  process.argv[1]?.endsWith('update-ticket-state.js') ||
  process.env.DEBUG_MAIN
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
    // Story #4545 — no second cascade here. `transitionTicketState` already
    // fires the upward cascade on every transition (bulk.js registers
    // `cascadeParentState` as transition.js's cascade runner, and the DONE
    // branch delegates to `cascadeCompletion`), so the explicit call this
    // used to make re-walked the same parents and re-spent the same API
    // calls a second time on every done transition — under a Story-only
    // model where no orchestration parent exists to find.
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
