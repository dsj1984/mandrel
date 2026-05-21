#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * resync-status-column.js — re-assert the GitHub Projects v2 Status
 * column for a ticket after auto-merge has fired (Story #2845).
 *
 * The `/single-story-deliver` and `/story-deliver` workflow docs call
 * this CLI after Step 5 confirms `state: "MERGED"` so the orchestrator
 * wins the race against the GitHub built-in `Pull request merged`
 * workflow, which would otherwise overwrite Status to whatever value
 * the bot's rule prescribes (typically `In Progress`) ~minutes after
 * the merge lands.
 *
 * Idempotent: re-running on a ticket whose Status already matches the
 * derived target returns the same `synced` envelope and issues the
 * same single GraphQL mutation. No retries — callers re-run the CLI if
 * the bot's overwrite arrives later than expected.
 *
 * Usage:
 *   node .agents/scripts/resync-status-column.js --ticket <id>
 *   node .agents/scripts/resync-status-column.js --story <id>   # alias
 *
 * Exit codes:
 *   0 — sync succeeded OR was skipped for a documented reason
 *       (`no-project`, `no-meta`, `not-on-project`).
 *   1 — provider error, GraphQL error, or invalid input.
 *
 * The CLI prints a single-line JSON envelope to stdout:
 *   `{ ticketId, status, column?, reason? }`
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { reassertStatusColumn } from './lib/orchestration/reassert-status-column.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/resync-status-column.js \\
  --ticket <id> | --story <id> [--provider github]

Re-asserts the Projects v2 Status column for the ticket based on its
current agent::* label set. Intended to run after auto-merge fires, to
overwrite any post-merge bot-driven Status flip.

Flags:
  --ticket   GitHub issue number (required, or pass --story).
  --story    Alias for --ticket.
  --provider Provider name (default: value in .agentrc.json orchestration).
  --help     Show this message.
`;

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      story: { type: 'string' },
      provider: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

/**
 * Pure input-validation extracted so it can be tested without spawning
 * a subprocess. Returns `{ ticketId, errors }` — `errors` is empty on
 * success.
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
  return { ticketId, errors };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const { ticketId, errors } = validateRequiredArgs(values);
  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`[resync-status-column] ${e}\n`);
    }
    process.stderr.write(HELP);
    process.exit(2);
  }

  const { orchestration } = resolveConfig();
  const effectiveOrchestration = values.provider
    ? { ...orchestration, provider: values.provider }
    : orchestration;
  const provider = createProvider(effectiveOrchestration);

  const result = await reassertStatusColumn({
    provider,
    ticketId,
    logger: Logger,
  });
  process.stdout.write(`${JSON.stringify({ ticketId, ...result })}\n`);
}

runAsCli(import.meta.url, main, { source: 'resync-status-column' });
