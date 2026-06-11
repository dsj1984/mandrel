#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * retro-run.js — execute the `/deliver` Phase 6 retro from a CLI.
 *
 * Phase 6 of `/deliver` posts the Epic retro by invoking the
 * in-process retro module (`lib/orchestration/retro-runner.js`'s
 * `runRetro`). That module is a library entry point — it has no CLI
 * wrapper and hard-requires both a GitHub `provider` and a lifecycle
 * `bus` (Epic #2646 Story C made `bus` a non-optional input). Without a
 * wrapper the host LLM driving Phase 6 had to hand-improvise a bus, and
 * a bare bus with no `LedgerWriter` registered means `retro.start` /
 * `retro.end` never reach the Epic-scoped `lifecycle.ndjson` ledger.
 *
 * This CLI mirrors `epic-deliver-note-intervention.js`: it resolves the
 * config and provider, constructs a lifecycle bus with a `LedgerWriter`
 * bound to the Epic's temp tree, calls `runRetro`, and prints the result
 * envelope. `--full-retro` forces the six-section retro regardless of
 * manifest cleanliness (maps to `runRetro`'s `forceFull`).
 *
 * Usage:
 *   node .agents/scripts/retro-run.js --epic <epicId> [--full-retro]
 *
 * Output: a single JSON envelope
 *   `{ epicId, posted, compact, ledgerPath, commentId? }`.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { tempRootFrom } from './lib/config/temp-paths.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';
import { createLedgerWriter } from './lib/orchestration/lifecycle/ledger-writer.js';
import { runRetro } from './lib/orchestration/retro-runner.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/retro-run.js --epic <epicId> [--full-retro]

Composes and posts the Epic retro structured comment for Epic #<epicId>,
wiring a lifecycle bus + LedgerWriter so the run's \`retro.start\` /
\`retro.end\` boundaries land in temp/epic-<epicId>/lifecycle.ndjson.

  --epic <epicId>   Epic to run the retro for (required, positive integer).
  --full-retro      Force the full six-section retro regardless of
                    manifest cleanliness (maps to runRetro forceFull).
`;

/**
 * Pure: parse argv into the normalized option bag. Exported for tests.
 *
 * @param {string[]} argv
 * @returns {{ epicId: number|null, fullRetro: boolean, help: boolean }}
 */
export function parseRetroRunArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      'full-retro': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  return {
    epicId: Number.isNaN(epicId) || epicId <= 0 ? null : epicId,
    fullRetro: values['full-retro'] === true,
    help: values.help === true,
  };
}

/**
 * Runner-shaped entry point. DI-friendly so tests can stub the provider,
 * the bus, the ledger writer, and `runRetro` without touching disk or the
 * GitHub API.
 *
 * Wires the lifecycle bus and registers a `LedgerWriter` bound to the
 * Epic's temp tree before invoking `runRetro`, so the run's
 * `retro.start` / `retro.end` boundaries persist to
 * `temp/epic-<epicId>/lifecycle.ndjson` rather than evaporating into a
 * bare bus.
 *
 * @param {{
 *   epicId: number,
 *   fullRetro?: boolean,
 *   injectedConfig?: object,
 *   injectedProvider?: object,
 *   busFactory?: () => object,
 *   ledgerFactory?: (deps: { epicId: number, tempRoot: string }) => { register: Function, ledgerPath?: string },
 *   runRetroFn?: typeof runRetro,
 *   logger?: { info?: Function, warn?: Function },
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   posted: boolean,
 *   compact: boolean,
 *   ledgerPath: string|null,
 *   commentId?: number,
 * }>}
 */
export async function runRetroCli({
  epicId,
  fullRetro = false,
  injectedConfig,
  injectedProvider,
  busFactory,
  ledgerFactory,
  runRetroFn = runRetro,
  logger,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runRetroCli: epicId must be a positive integer');
  }

  const config = injectedConfig ?? resolveConfig();
  const provider = injectedProvider ?? createProvider(config);
  const bus = busFactory ? busFactory() : createBus();

  const tempRoot = tempRootFrom(config);
  const ledger = ledgerFactory
    ? ledgerFactory({ epicId, tempRoot })
    : createLedgerWriter({ epicId, tempRoot });
  ledger.register(bus);

  const result = await runRetroFn({
    epicId,
    provider,
    bus,
    forceFull: fullRetro,
    logger,
  });

  const envelope = {
    epicId,
    posted: result?.posted === true,
    compact: result?.compact === true,
    ledgerPath: ledger.ledgerPath ?? null,
  };
  if (Number.isInteger(result?.commentId)) {
    envelope.commentId = result.commentId;
  }
  return envelope;
}

async function main() {
  const args = parseRetroRunArgs(process.argv.slice(2));
  if (args.help) {
    Logger.info(HELP);
    return;
  }
  if (args.epicId === null) {
    Logger.error('[retro-run] ERROR: --epic <epicId> is required.');
    Logger.error(HELP);
    process.exit(2);
  }
  const out = await runRetroCli({
    epicId: args.epicId,
    fullRetro: args.fullRetro,
    logger: Logger,
  });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'retro-run' });
