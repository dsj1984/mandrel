/**
 * .agents/scripts/update-ticket-state.js — CLI entrypoint for ticket
 * label transitions. Core logic lives in `lib/orchestration/ticketing.js`;
 * this file is the operator-facing command surface (not a compatibility
 * layer).
 */

import { parseArgs } from 'node:util';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  enqueueLabel,
  outboxPathFor,
} from './lib/orchestration/bookkeeping-outbox.js';
import {
  cascadeCompletion,
  STATE_LABELS,
  transitionTicketState,
} from './lib/orchestration/ticketing.js';
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
      buffer: { type: 'boolean' },
      epic: { type: 'string' },
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

    // Headless buffering (Epic #4476 M5): buffer an intermediate state flip to
    // the per-Epic outbox instead of a live GitHub round-trip; finalize's
    // bookkeeping-reconcile.js drains it once. `agent::blocked` (the HITL gate,
    // §1.J) and `agent::done` (its cascade must run live) ALWAYS surface
    // immediately and are never buffered. Requires --epic to locate the outbox.
    if (
      values.buffer &&
      state !== STATE_LABELS.BLOCKED &&
      state !== STATE_LABELS.DONE
    ) {
      const epicId = Number.parseInt(values.epic ?? '', 10);
      if (!Number.isInteger(epicId) || epicId <= 0) {
        throw new Error('--buffer requires --epic <id>');
      }
      enqueueLabel({
        outboxPath: outboxPathFor(epicId, config),
        ticketId,
        state,
      });
      Logger.info(
        `[State-Sync] Buffered #${ticketId} → ${state} (headless; drained at finalize)`,
      );
      return;
    }

    Logger.info(
      `[State-Sync] Transitioning ticket #${ticketId} to ${state}...`,
    );
    await transitionTicketState(provider, ticketId, state);

    if (state === STATE_LABELS.DONE) {
      Logger.info(`[State-Sync] Cascading completion from #${ticketId}...`);
      const cascade = await cascadeCompletion(provider, ticketId);
      // Hoisted out of the `for...of` initializer because typhonjs-escomplex
      // mis-parses optional chaining there (it would zero out this file's
      // maintainability score).
      const cascadeFailures = cascade?.failed ?? [];
      for (const { parentId, error } of cascadeFailures) {
        Logger.warn(
          `[State-Sync] ⚠️  Cascade partial-failure on parent #${parentId}: ${error}`,
        );
      }
    }

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
