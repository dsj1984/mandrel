#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-automerge.js — Phase 7.5 of `/epic-deliver`, thin emit
 * shim (Story #2256 / Task #2262 / Epic #2172).
 *
 * Pre-Wave-7 this CLI armed GitHub's native auto-merge directly by
 * calling `gh pr merge --auto --squash --delete-branch` after the
 * legacy `evaluateAutoMergePredicate` returned clean. The Wave 7
 * refactor moved that responsibility into the lifecycle bus listener
 * chain:
 *
 *   1. `Watcher` (subscribes to `pr.created`) resolves required-check
 *      names from `gh pr checks` at runtime, polls, emits
 *      `epic.watch.end`.
 *   2. `AutomergePredicate` (subscribes to `epic.watch.end`) evaluates
 *      the same signals as the legacy predicate plus the check-outcome
 *      gate, emits `epic.merge.ready` or `epic.merge.blocked`.
 *   3. `AutomergeArmer` (subscribes ONLY to `epic.merge.ready`, which
 *      is the SOLE production code path authorized to call
 *      `gh pr merge`) probes for an existing arm via
 *      `gh pr view --json autoMergeRequest`, calls
 *      `gh pr merge --auto --squash --delete-branch` if not already
 *      armed, emits `epic.merge.armed`.
 *
 * This CLI is now a telemetry shim: it emits `epic.automerge.start`
 * onto a per-invocation bus and exits. The actual arming runs inside
 * the `/epic-deliver` runner where the listener chain is wired. Direct
 * invocations no longer arm auto-merge — operators should run
 * `/epic-deliver` (or the runner's bus-driven equivalent) instead.
 *
 * The merge-lockout lint rule
 * (`.agents/scripts/check-lifecycle-lint.js`) historically exempted
 * this file because it carried the literal `gh pr merge` call. After
 * this conversion the file contains no such literal; the exemption is
 * retained one release for migration safety and can be deleted in the
 * follow-on cleanup.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-automerge.js --epic <id> --pr <prNumber>
 *
 * Exit codes:
 *   0 — `epic.automerge.start` emitted (or `--help`).
 *   2 — usage error (missing --epic / --pr).
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { Bus } from './lib/orchestration/lifecycle/bus.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-automerge.js \\
  --epic <id> --pr <prNumber>

Emits an \`epic.automerge.start\` lifecycle event for the given Epic / PR
and exits. The actual auto-merge arming is owned by the \`AutomergeArmer\`
lifecycle listener inside the \`/epic-deliver\` runner — this CLI does
NOT call \`gh\` directly.
`;

/**
 * Pure: parse argv. Exported for tests.
 */
export function parseAutomergeArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      pr: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  const prNumber = Number.parseInt(values.pr ?? '', 10);
  return {
    epicId: Number.isNaN(epicId) || epicId <= 0 ? null : epicId,
    prNumber: Number.isNaN(prNumber) || prNumber <= 0 ? null : prNumber,
    help: values.help === true,
  };
}

/**
 * Pure: classify parsed CLI args into a runnable intent. Carved out
 * so the side-effecting wrapper stays at CC ≤ 2.
 *
 * Shapes:
 *   - { kind: 'help' }
 *   - { kind: 'usage-error', messages: string[] }
 *   - { kind: 'run', epicId, prNumber }
 */
export function classifyAutomergeInvocation(args) {
  if (args?.help) return { kind: 'help' };
  if (args?.epicId === null || args?.prNumber === null) {
    return {
      kind: 'usage-error',
      messages: [
        '[epic-deliver-automerge] ERROR: --epic <id> and --pr <prNumber> are required.',
        HELP,
      ],
    };
  }
  return {
    kind: 'run',
    epicId: args.epicId,
    prNumber: args.prNumber,
  };
}

/**
 * Build the `pr.created`-shaped URL the lifecycle emit carries.
 *
 * The shim does not know the host repo; the canonical encoding is
 * `pr/<n>` and the listener-chain consumer of this event (typically
 * the runner's wired `AutomergeArmer`) reads `prUrl` directly from the
 * payload. For the thin shim we accept the bare PR number as the
 * shim's identifier.
 *
 * Exported for tests.
 */
export function buildPrUrl(prNumber) {
  // Synthetic URL fragment — sufficient for the schema's `format: uri`
  // + `minLength: 1` validation; the listener chain inside the runner
  // overrides this from real GitHub data when wired in-process.
  return `https://github.com/local/pr/${prNumber}`;
}

/**
 * Runner-shaped entry. Emits `epic.automerge.start` onto the supplied
 * bus (or a freshly-constructed one when invoked standalone). Returns
 * the seqId of the emit for observability.
 *
 * @param {{
 *   epicId: number,
 *   prNumber: number,
 *   bus?: object,
 *   loggerImpl?: { info?: Function, warn?: Function, error?: Function },
 * }} args
 * @returns {Promise<{ epicId: number, prNumber: number, prUrl: string, seqId: number }>}
 */
export async function runEpicDeliverAutomerge({
  epicId,
  prNumber,
  bus,
  loggerImpl,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverAutomerge: epicId must be a positive integer',
    );
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new TypeError(
      'runEpicDeliverAutomerge: prNumber must be a positive integer',
    );
  }
  const logger = loggerImpl ?? Logger;
  const localBus = bus ?? new Bus();
  const prUrl = buildPrUrl(prNumber);

  logger.info?.(
    `[epic-deliver-automerge] Emitting epic.automerge.start for Epic #${epicId} (PR #${prNumber}).`,
  );
  const { seqId } = await localBus.emit('epic.automerge.start', { prUrl });
  return { epicId, prNumber, prUrl, seqId };
}

async function main() {
  const intent = classifyAutomergeInvocation(
    parseAutomergeArgs(process.argv.slice(2)),
  );
  if (intent.kind === 'help') {
    Logger.info(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    for (const m of intent.messages) Logger.error(m);
    process.exit(2);
  }
  const out = await runEpicDeliverAutomerge({
    epicId: intent.epicId,
    prNumber: intent.prNumber,
  });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-automerge' });
