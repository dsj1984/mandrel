#!/usr/bin/env node

/**
 * bookkeeping-reconcile.js — Epic #4476 (M5).
 *
 * Drain the per-run bookkeeping outbox (buffered structured-comment upserts
 * and `agent::*` label flips accumulated during an unattended run) to GitHub,
 * once, at finalize. GitHub becomes the source of truth at rest; the outbox is
 * cleared only when the whole batch lands (crash-recovery: a partial drain
 * leaves the remainder for the next reconcile).
 *
 * The `/deliver` Phase 7 finalize step calls this once after the merge tail
 * opens the PR. It is idempotent: an empty / already-drained outbox is a
 * no-op, and both sink operations converge on a re-run.
 *
 * Usage:
 *   node .agents/scripts/bookkeeping-reconcile.js --epic <id> [--provider github]
 *
 * Stdout: a single JSON envelope
 *   { ok, epicId, drained, comments, labels, errors, cleared }
 *
 * Exit codes:
 *   0 — every buffered op drained (or nothing was buffered)
 *   1 — one or more ops failed (outbox retained for the next reconcile)
 *   2 — usage error
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  outboxPathFor,
  reconcileOutbox,
} from './lib/orchestration/bookkeeping-outbox.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/bookkeeping-reconcile.js \\
  --epic <id> [--provider github]

Drains temp/run-<id>/bookkeeping-outbox.ndjson (buffered comment upserts +
label flips from an unattended run) to GitHub once, at finalize. Idempotent.

Flags:
  --epic       Epic id whose outbox to drain (required).
  --provider   Provider name (default: inferred from .agentrc.json github block).
  --help       Show this message.
`;

/**
 * Core: resolve the outbox path and drain it. Exported so tests can drive it
 * with a fake provider and an injected outbox path.
 *
 * @param {{ epicId: number, provider: object, config?: object,
 *           outboxPath?: string, logger?: object }} args
 * @returns {Promise<object>}
 */
export async function runBookkeepingReconcile({
  epicId,
  provider,
  config,
  outboxPath,
  logger = Logger,
}) {
  const resolvedOutbox = outboxPath ?? outboxPathFor(epicId, config);
  const result = await reconcileOutbox({
    outboxPath: resolvedOutbox,
    provider,
    logger,
  });
  return { ok: result.errors.length === 0, epicId, ...result };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      provider: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (!Number.isInteger(epicId) || epicId <= 0) {
    process.stderr.write('[bookkeeping-reconcile] --epic <id> is required.\n');
    process.stderr.write(HELP);
    process.exit(2);
  }

  const config = resolveConfig();
  const effectiveConfig = values.provider
    ? { ...config, provider: values.provider }
    : config;
  const provider = createProvider(effectiveConfig);

  const envelope = await runBookkeepingReconcile({
    epicId,
    provider,
    config,
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if (!envelope.ok) process.exitCode = 1;
}

runAsCli(import.meta.url, main, { source: 'bookkeeping-reconcile' });
