#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * resync-status-column.js — re-assert the GitHub Projects v2 Status
 * column for a ticket after auto-merge has fired (Story #2845).
 *
 * The `/single-story-deliver` and `/deliver` workflow docs call
 * this CLI after Step 5 confirms `state: "MERGED"` so the orchestrator
 * wins the race against the GitHub built-in `Pull request merged`
 * workflow, which would otherwise overwrite Status to whatever value
 * the bot's rule prescribes (typically `In Progress`) ~minutes after
 * the merge lands.
 *
 * Story #2876 — the helper polls the live Status after the initial
 * mutation and re-fires on drift. The one-shot mutation routinely
 * lost the race (reproduced on Story #2871 / PR #2872); the bounded
 * poll loop hardens the defense-in-depth so consumers who haven't
 * disabled the conflicting bot workflows still get a deterministic
 * outcome.
 *
 * Idempotent: re-running on a ticket whose Status already matches the
 * derived target returns the same `synced` envelope and issues the
 * same single GraphQL mutation.
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
 * Pure input-validation extracted so it can be tested without spawning
 * a subprocess. Returns `{ ticketId, pollAttempts, pollDelayMs, errors }`
 * — `errors` is empty on success.
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
}) {
  const opts = {
    provider,
    ticketId,
    logger,
  };
  if (pollAttempts !== undefined) opts.pollAttempts = pollAttempts;
  if (pollDelayMs !== undefined) opts.pollDelayMs = pollDelayMs;
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
    }),
  );
  process.stdout.write(`${JSON.stringify({ ticketId, ...result })}\n`);
}

runAsCli(import.meta.url, main, { source: 'resync-status-column' });
