#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-finalize.js — flip the Epic to `agent::review`, sync its project
 * column, and post the bookend hand-off (or trigger autoClose).
 *
 *   1. Read the `epic-run-state` checkpoint via `Checkpointer.read()` so the
 *      authoritative `autoClose` snapshot from dispatch time is recovered —
 *      mid-run label changes are intentionally ignored.
 *   2. Transition the Epic ticket to `agent::review` via `transitionTicketState`.
 *   3. Run column-sync (`ColumnSync.sync`) to push the Status field to the
 *      Review column. No-op when no project is configured.
 *   4. Construct `BookendChainer` with `{ epicId, autoClose, runSkill: null,
 *      postComment, logger }`. The CLI never has a `runSkill` adapter, so:
 *        - `autoClose=true`  → posts the missing-runSkill hand-off comment
 *          (and lists `/epic-close` as a manual remaining step).
 *        - `autoClose=false` → posts the standard hand-off comment.
 *
 * Stdout: `{ epicId, flipped, columnSynced, autoClose, bookendsExecuted,
 * remainingSteps }`.
 *
 * Usage:
 *   node .agents/scripts/epic-finalize.js --epic <epicId>
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS } from './lib/label-constants.js';
import { BookendChainer } from './lib/orchestration/epic-runner/bookend-chainer.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { ColumnSync } from './lib/orchestration/epic-runner/column-sync.js';
import { transitionTicketState } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-finalize.js --epic <epicId>

Reads the epic-run-state checkpoint to recover the autoClose snapshot, flips
the Epic to agent::review, runs column-sync, and invokes BookendChainer to
either post the operator hand-off or (when authorized) chain /epic-close.
`;

const REMAINING_OPERATOR_STEPS_HANDOFF = [
  '/epic-code-review',
  'epic-retro helper',
  '/epic-close',
];

const REMAINING_OPERATOR_STEPS_AUTOCLOSE_NO_ADAPTER = [
  '/epic-code-review',
  'epic-retro helper',
  '/epic-close',
];

/**
 * End-to-end finalize. DI-friendly: tests pass `injectedProvider`,
 * `injectedConfig`, and a `loggerImpl` to skip real GitHub mutations.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   loggerImpl?: { info?: Function, warn?: Function },
 *   columnSyncImpl?: { sync: (id: number, labels: string[]) => Promise<{ status: string }> },
 *   bookendChainerImpl?: { run: () => Promise<{ executed: boolean, completed?: boolean }> },
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   flipped: true,
 *   columnSynced: boolean,
 *   autoClose: boolean,
 *   bookendsExecuted: boolean,
 *   remainingSteps: string[],
 * }>}
 */
export async function runEpicFinalize({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
  loggerImpl,
  columnSyncImpl,
  bookendChainerImpl,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runEpicFinalize: --epic must be a positive integer');
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const logger = loggerImpl ?? console;

  // 1. Recover the dispatch-time autoClose snapshot.
  const checkpointer = new Checkpointer({ provider, epicId });
  const checkpoint = await checkpointer.read();
  const autoClose = Boolean(checkpoint?.autoClose);

  // 2. Flip Epic → agent::review.
  await transitionTicketState(provider, epicId, AGENT_LABELS.REVIEW);

  // 3. Column-sync best-effort.
  let columnSynced = false;
  const columnSync = columnSyncImpl ?? new ColumnSync({ provider, logger });
  try {
    const result = await columnSync.sync(epicId, [AGENT_LABELS.REVIEW]);
    columnSynced = result?.status === 'synced';
  } catch (err) {
    logger.warn?.(
      `[epic-finalize] column-sync failed for #${epicId}: ${err?.message ?? err}`,
    );
  }

  // 4. Hand off via BookendChainer. The CLI never carries a `runSkill`
  //    adapter — autoClose=true degrades to a hand-off comment that names
  //    `/epic-close` as the manual remaining step (BookendChainer logs
  //    a `missing-runSkill` reason in that case).
  const chainer =
    bookendChainerImpl ??
    new BookendChainer({
      epicId,
      autoClose,
      runSkill: null,
      postComment: (id, payload) => provider.postComment(id, payload),
      logger,
    });
  const bookendResult = await chainer.run();

  const remainingSteps = autoClose
    ? REMAINING_OPERATOR_STEPS_AUTOCLOSE_NO_ADAPTER
    : REMAINING_OPERATOR_STEPS_HANDOFF;

  return {
    epicId,
    flipped: true,
    columnSynced,
    autoClose,
    bookendsExecuted: Boolean(bookendResult?.executed),
    remainingSteps,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  if (values.help) {
    Logger.info(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    Logger.error('[epic-finalize] ERROR: --epic <epicId> is required.');
    Logger.error(HELP);
    process.exit(2);
  }
  const out = await runEpicFinalize({ epicId });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-finalize' });
