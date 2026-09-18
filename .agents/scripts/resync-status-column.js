#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * resync-status-column.js — re-assert a ticket's Projects v2 Status after
 * merge, beating GitHub's built-in "Pull request merged" workflow that
 * overwrites it minutes later. A one-shot write loses that race, so the live
 * Status is polled and re-fired on drift. Idempotent.
 *
 * Usage:
 *   node .agents/scripts/resync-status-column.js --ticket <id>
 *   node .agents/scripts/resync-status-column.js --story <id>   # alias
 *
 * Exit codes:
 *   0 — sync succeeded, drifted-but-exhausted, OR was skipped for a
 *       documented reason (`no-project`, `no-meta`, `not-on-project`).
 *   1 — provider error, GraphQL error, or invalid input.
 *   2 — usage error (missing required args).
 *
 * The CLI prints a single-line JSON envelope to stdout:
 *   `{ ticketId, status, column?, reason?, attempts? }`
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { reassertStatusColumn } from './lib/orchestration/reassert-status-column.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/resync-status-column.js \\
  --ticket <id> | --story <id> \\
  [--provider github] [--poll-attempts <n>] [--poll-delay-ms <ms>]

Re-asserts the Projects v2 Status column for the ticket based on its
current agent::* label set. Intended to run after auto-merge fires, to
overwrite any post-merge bot-driven Status flip.

Story #2876 — the helper polls the live Status after the initial
mutation and re-fires on drift (defense against asynchronous bot
overwrites that land after our initial write). Default budget is
~15 s (4 attempts × 5 s delay).

Flags:
  --ticket           GitHub issue number (required, or pass --story).
  --story            Alias for --ticket.
  --provider         Provider name (default: value in .agentrc.json).
  --poll-attempts    Total mutation attempts including the initial sync
                     (default 4). Pass 1 to disable the poll loop.
  --poll-delay-ms    Delay between drift checks in ms (default 5000).
  --help             Show this message.
`;

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      story: { type: 'string' },
      provider: { type: 'string' },
      'poll-attempts': { type: 'string' },
      'poll-delay-ms': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

/**
 * `errors` is empty on success.
 *
 * @param {Record<string, unknown>} values
 */
export function validateRequiredArgs(values) {
  const raw = values.ticket ?? values.story ?? '';
  const ticketId = Number.parseInt(raw, 10);
  const errors = [];
  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    errors.push('--ticket <id> (or --story <id>) is required.');
  }

  let pollAttempts;
  if (values['poll-attempts'] !== undefined) {
    pollAttempts = Number.parseInt(values['poll-attempts'], 10);
    if (!Number.isInteger(pollAttempts) || pollAttempts <= 0) {
      errors.push('--poll-attempts must be a positive integer.');
    }
  }

  let pollDelayMs;
  if (values['poll-delay-ms'] !== undefined) {
    pollDelayMs = Number.parseInt(values['poll-delay-ms'], 10);
    if (!Number.isInteger(pollDelayMs) || pollDelayMs < 0) {
      errors.push('--poll-delay-ms must be a non-negative integer.');
    }
  }

  return { ticketId, pollAttempts, pollDelayMs, errors };
}

export function resolveEffectiveConfig(config, providerName) {
  return providerName ? { ...config, provider: providerName } : config;
}

export function buildReassertOptions({
  provider,
  ticketId,
  logger,
  pollAttempts,
  pollDelayMs,
  config,
}) {
  const opts = {
    provider,
    ticketId,
    logger,
  };
  if (pollAttempts !== undefined) opts.pollAttempts = pollAttempts;
  if (pollDelayMs !== undefined) opts.pollDelayMs = pollDelayMs;
  // So the board-metadata cache lands under the configured tempRoot.
  if (config !== undefined) opts.config = config;
  return opts;
}

export function writeUsageErrors(errors, stderr = process.stderr) {
  for (const e of errors) {
    stderr.write(`[resync-status-column] ${e}\n`);
  }
  stderr.write(HELP);
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const { ticketId, pollAttempts, pollDelayMs, errors } =
    validateRequiredArgs(values);
  if (errors.length) {
    writeUsageErrors(errors);
    process.exit(2);
  }

  const config = resolveConfig();
  const effectiveConfig = resolveEffectiveConfig(config, values.provider);
  const provider = createProvider(effectiveConfig);
  const result = await reassertStatusColumn(
    buildReassertOptions({
      provider,
      ticketId,
      logger: Logger,
      pollAttempts,
      pollDelayMs,
      config: effectiveConfig,
    }),
  );
  process.stdout.write(`${JSON.stringify({ ticketId, ...result })}\n`);
}

runAsCli(import.meta.url, main, {
  source: 'resync-status-column',
  usage: HELP,
});
