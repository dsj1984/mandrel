#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-note-intervention.js — record a manual-intervention event
 * against the active `/deliver` run-state checkpoint.
 *
 * The host LLM driving `/deliver` invokes this CLI whenever it does
 * something out-of-band that disqualifies the Epic from auto-merge:
 *
 *   - `AskUserQuestion` to the operator mid-run
 *   - `git restore` / `git reset` against the working tree
 *   - manual `--no-ff` recovery merge
 *   - per-Story close that needed `--skipValidation`
 *
 * The auto-merge predicate (see
 * `lib/orchestration/lifecycle/listeners/automerge-predicate.js`) reads
 * `state.manualInterventions[]` and refuses to fire when the array is
 * non-empty.
 *
 * Story #2413 / Task #2426 — the CLI no longer writes the structured
 * comment directly. It builds an `intervention.recorded` payload, emits
 * it through a one-shot lifecycle bus, and lets the
 * `InterventionRecorder` listener (registered against the same bus)
 * persist the record via the epic-run-state-store. This collapses the
 * legacy script-level checkpoint consumer to a single bus emit, matching
 * the canonical pattern for state mutations described in the lifecycle
 * listeners README.
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
import { read as readEpicRunState } from './lib/orchestration/epic-run-state-store.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';
import {
  INTERVENTION_RECORDED_EVENT,
  InterventionRecorder,
} from './lib/orchestration/lifecycle/listeners/intervention-recorder.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-note-intervention.js \\
  --epic <epicId> --reason "<text>" [--source <text>]

Emits an \`intervention.recorded\` lifecycle event for Epic #<epicId>. The
InterventionRecorder listener appends the payload to the epic-run-state
structured comment, disqualifying the Epic from auto-merge.
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
 * Runner-shaped entry point. DI-friendly so tests can stub the provider
 * and bus without touching disk or the GitHub API.
 *
 * The bus emit drives the InterventionRecorder listener, which grows
 * the `manualInterventions` array on the epic-run-state structured
 * comment via the function-based store. After the emit settles, we
 * read the comment back so the CLI's stdout envelope can report
 * `{ intervention, total }` exactly as before the script-level
 * checkpoint cut-over.
 *
 * @param {{
 *   epicId: number,
 *   reason: string,
 *   source?: string,
 *   injectedConfig?: object,
 *   injectedProvider?: object,
 *   busFactory?: () => { emit: Function, on: Function },
 *   listenerFactory?: (deps: { provider: object, epicId: number, bus: object }) => { register: Function },
 *   readEpicRunState?: (deps: { provider: object, epicId: number }) => Promise<object|null>,
 *   now?: () => string,
 * }} args
 * @returns {Promise<{ epicId: number, intervention: object, total: number }>}
 */
export async function runNoteIntervention({
  epicId,
  reason,
  source,
  injectedConfig,
  injectedProvider,
  busFactory,
  listenerFactory,
  readEpicRunState: readEpicRunStateFn,
  now,
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
  const provider = injectedProvider ?? createProvider(config);
  const bus = busFactory ? busFactory() : createBus();
  const buildListener =
    listenerFactory ?? ((deps) => new InterventionRecorder(deps));
  const listener = buildListener({ provider, epicId, bus });
  if (typeof listener.register === 'function') {
    listener.register(bus);
  }

  const ts = typeof now === 'function' ? now() : new Date().toISOString();
  const resolvedSource =
    typeof source === 'string' && source.length > 0 ? source : 'host-llm';
  const payload = {
    epicId,
    reason,
    source: resolvedSource,
    ts,
  };
  await bus.emit(INTERVENTION_RECORDED_EVENT, payload);

  // Read the state back so the stdout envelope reports the canonical
  // `{ intervention, total }` shape. The listener has already persisted
  // the record by the time `emit` resolves (sequential awaited mediator);
  // a missing comment collapses to `total: 0` defensively.
  const readFn = readEpicRunStateFn ?? readEpicRunState;
  const state = (await readFn({ provider, epicId })) ?? {};
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
