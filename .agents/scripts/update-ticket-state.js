/**
 * .agents/scripts/update-ticket-state.js — CLI Re-export Shim
 *
 * Thin backward-compatibility shim. The core logic has been moved to
 * `lib/orchestration/ticketing.js` as part of the SDK refactor.
 *
 * This file preserves backward compatibility for CLI usage and existing
 * testing patterns.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 */

import { parseArgs } from 'node:util';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
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
      task: { type: 'string' },
      ticket: { type: 'string' },
      state: { type: 'string' },
      'remove-label': { type: 'string' },
    },
    strict: false,
  });

  // `--ticket` is the v5.9.0 alias for `--task` (labels can apply to any
  // ticket type, not just Tasks). Both continue to work.
  const idSource = values.ticket ?? values.task;
  const ticketId = Number.parseInt(idSource, 10);
  const state = values.state;
  const removeLabel = values['remove-label'];

  if (Number.isNaN(ticketId) || (!state && !removeLabel)) {
    throw new Error(
      'Usage: node update-ticket-state.js ' +
        '(--ticket|--task) <id> ' +
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
