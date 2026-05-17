#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-cleanup.js — Phase 8 of `/epic-deliver`, thin emit shim
 * (Story #2259 / Task #2265 / Epic #2172).
 *
 * Pre-Wave-8 this CLI reaped local worktrees + branches directly by
 * reading the `epic-run-state` checkpoint and shelling out to
 * `git worktree remove` / `git branch -D`. The Wave 8 refactor moved
 * that responsibility into the lifecycle bus listener chain:
 *
 *   1. `AutomergeArmer` (subscribes to `epic.merge.ready`) arms
 *      GitHub's native auto-merge, emits `epic.merge.armed`.
 *   2. `Cleaner` (subscribes to `epic.merge.armed`) archives
 *      `temp/epic-<id>/` under `temp/archive/`, emits
 *      `epic.cleanup.start`, `epic.cleanup.end`, and the terminal
 *      `epic.complete`.
 *
 * This CLI is now a telemetry shim: it emits `epic.cleanup.start`
 * onto a per-invocation bus and exits. The actual archive + branch
 * reaping runs inside the `/epic-deliver` runner where the listener
 * chain is wired. Direct invocations no longer reap branches —
 * operators should run `/epic-deliver` (or use
 * `/delete-epic-branches` for the "scrap and reset" flow) instead.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-cleanup.js --epic <id>
 *
 * Exit codes:
 *   0 — `epic.cleanup.start` emitted (or `--help`).
 *   2 — usage error (missing --epic).
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { Bus } from './lib/orchestration/lifecycle/bus.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-cleanup.js --epic <id>

Emits an \`epic.cleanup.start\` lifecycle event for the given Epic and
exits. The actual temp/epic-<id>/ archive + branch reap is owned by the
\`Cleaner\` lifecycle listener inside the \`/epic-deliver\` runner —
this CLI does NOT mutate the filesystem.
`;

/**
 * Pure: parse argv. Exported for tests.
 */
export function parseCleanupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  return {
    epicId: Number.isNaN(epicId) || epicId <= 0 ? null : epicId,
    help: values.help === true,
  };
}

/**
 * Pure: classify parsed CLI args into a runnable intent. Carved out
 * so the side-effecting wrapper stays at CC ≤ 2.
 */
export function classifyCleanupInvocation(args) {
  if (args?.help) return { kind: 'help' };
  if (args?.epicId === null) {
    return {
      kind: 'usage-error',
      messages: [
        '[epic-deliver-cleanup] ERROR: --epic <id> is required.',
        HELP,
      ],
    };
  }
  return {
    kind: 'run',
    epicId: args.epicId,
  };
}

/**
 * Runner-shaped entry. Emits `epic.cleanup.start` onto the supplied
 * bus (or a freshly-constructed one when invoked standalone). Returns
 * the seqId of the emit for observability.
 *
 * @param {{
 *   epicId: number,
 *   bus?: object,
 *   loggerImpl?: { info?: Function, warn?: Function, error?: Function },
 * }} args
 * @returns {Promise<{ epicId: number, seqId: number }>}
 */
export async function runEpicDeliverCleanup({ epicId, bus, loggerImpl } = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverCleanup: epicId must be a positive integer',
    );
  }
  const logger = loggerImpl ?? Logger;
  const localBus = bus ?? new Bus();
  logger.info?.(
    `[epic-deliver-cleanup] Emitting epic.cleanup.start for Epic #${epicId}.`,
  );
  const { seqId } = await localBus.emit('epic.cleanup.start', { epicId });
  return { epicId, seqId };
}

async function main() {
  const intent = classifyCleanupInvocation(
    parseCleanupArgs(process.argv.slice(2)),
  );
  if (intent.kind === 'help') {
    Logger.info(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    for (const m of intent.messages) Logger.error(m);
    process.exit(2);
  }
  const out = await runEpicDeliverCleanup({ epicId: intent.epicId });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-cleanup' });
