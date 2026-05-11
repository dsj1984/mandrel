#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-note-intervention.js — record a manual-intervention event
 * against the active `/epic-deliver` run-state checkpoint.
 *
 * The host LLM driving `/epic-deliver` invokes this CLI whenever it does
 * something out-of-band that disqualifies the Epic from auto-merge:
 *
 *   - `AskUserQuestion` to the operator mid-run
 *   - `git restore` / `git reset` against the working tree
 *   - manual `--no-ff` recovery merge
 *   - per-Story close that needed `--skipValidation`
 *
 * The auto-merge predicate (see `lib/orchestration/automerge-predicate.js`)
 * reads `state.manualInterventions[]` and refuses to fire when the array is
 * non-empty.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-note-intervention.js \
 *     --epic <epicId> --reason "<text>" [--source <text>]
 *
 * Output: a single JSON envelope `{ epicId, intervention, total }`.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-note-intervention.js \\
  --epic <epicId> --reason "<text>" [--source <text>]

Appends a manual-intervention record to the epic-run-state checkpoint on
Epic #<epicId>. Disqualifies the Epic from auto-merge.
`;

/**
 * Pure: parse argv into the normalized option bag. Exported for tests.
 *
 * @param {string[]} argv
 * @returns {{ epicId: number|null, reason: string|null, source: string|null, help: boolean }}
 */
export function parseNoteArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      reason: { type: 'string' },
      source: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
  const source = typeof values.source === 'string' ? values.source.trim() : '';
  return {
    epicId: Number.isNaN(epicId) || epicId <= 0 ? null : epicId,
    reason: reason.length > 0 ? reason : null,
    source: source.length > 0 ? source : null,
    help: values.help === true,
  };
}

/**
 * Runner-shaped entry point. DI-friendly so tests can stub the provider and
 * checkpointer factories without touching disk or the GitHub API.
 *
 * @param {{
 *   epicId: number,
 *   reason: string,
 *   source?: string,
 *   injectedConfig?: object,
 *   injectedProvider?: object,
 *   checkpointerFactory?: (deps: { provider: object, epicId: number }) => Checkpointer,
 * }} args
 * @returns {Promise<{ epicId: number, intervention: object, total: number }>}
 */
export async function runNoteIntervention({
  epicId,
  reason,
  source,
  injectedConfig,
  injectedProvider,
  checkpointerFactory,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runNoteIntervention: epicId must be a positive integer',
    );
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError('runNoteIntervention: reason is required');
  }
  const config = injectedConfig ?? resolveConfig();
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const factory = checkpointerFactory ?? ((deps) => new Checkpointer(deps));
  const checkpointer = factory({ provider, epicId });
  const state = await checkpointer.appendIntervention({
    reason,
    source: source ?? 'host-llm',
  });
  const list = Array.isArray(state.manualInterventions)
    ? state.manualInterventions
    : [];
  const intervention = list[list.length - 1] ?? null;
  return { epicId, intervention, total: list.length };
}

async function main() {
  const args = parseNoteArgs(process.argv.slice(2));
  if (args.help) {
    Logger.info(HELP);
    return;
  }
  if (args.epicId === null) {
    Logger.error(
      '[epic-deliver-note-intervention] ERROR: --epic <epicId> is required.',
    );
    Logger.error(HELP);
    process.exit(2);
  }
  if (args.reason === null) {
    Logger.error(
      '[epic-deliver-note-intervention] ERROR: --reason "<text>" is required.',
    );
    Logger.error(HELP);
    process.exit(2);
  }
  const out = await runNoteIntervention({
    epicId: args.epicId,
    reason: args.reason,
    source: args.source ?? undefined,
  });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-note-intervention' });
