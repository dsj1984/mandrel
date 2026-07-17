#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * post-structured-comment.js — CLI wrapper for structured comment upsert.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 *
 * Delegates to `upsertStructuredComment` from `lib/orchestration/ticketing.js`
 * and emits the `{ success, ticketId, type }` JSON envelope on stdout.
 *
 * Usage:
 *   node .agents/scripts/post-structured-comment.js \
 *     --ticket <id> --marker <type> --body-file <path> [--provider github]
 *
 * Exit codes:
 *   0 — upsert succeeded
 *   non-zero — validation or provider failure (error on stderr)
 */

import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  assertValidStructuredCommentType,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/post-structured-comment.js \\
  --ticket <id> --marker <type> --body-file <path> [--provider github]

Flags:
  --ticket       GitHub issue number to comment on (required).
  --marker       Structured-comment type (e.g. progress, friction,
                 retro, epic-run-state, wave-0-start) (required).
  --body-file    Path to a file containing the markdown body (required).
  --provider     Provider name (default: inferred from .agentrc.json github block).
  --help         Show this message.
`;

/**
 * Core: idempotently upsert the structured comment and return the envelope.
 * Exported so tests can pin input/output parity against direct SDK use
 * without spawning a subprocess.
 */
export async function runPostStructuredComment({
  ticketId,
  type,
  body,
  provider,
}) {
  assertValidStructuredCommentType(type);
  await upsertStructuredComment(provider, ticketId, type, body);
  return { success: true, ticketId, type };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      marker: { type: 'string' },
      'body-file': { type: 'string' },
      provider: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

/**
 * Pure: validate the required CLI inputs for `post-structured-comment`. The
 * orchestrator is otherwise too dense to score under the CRAP cap, and these
 * rules deserve their own targeted tests.
 *
 * @param {Record<string, unknown>} values parsed CLI values
 * @returns {{ ticketId: number, errors: string[] }} `errors` is empty on success.
 */
export function validateRequiredArgs(values) {
  const ticketId = Number.parseInt(values.ticket ?? '', 10);
  const errors = [];
  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    errors.push('--ticket <id> is required.');
  }
  if (!values.marker) errors.push('--marker <type> is required.');
  if (!values['body-file']) errors.push('--body-file <path> is required.');
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
      process.stderr.write(`[post-structured-comment] ${e}\n`);
    }
    process.stderr.write(HELP);
    process.exit(2);
  }

  const body = await fs.readFile(values['body-file'], 'utf8');

  const config = resolveConfig();
  const effectiveConfig = values.provider
    ? { ...config, provider: values.provider }
    : config;
  const provider = createProvider(effectiveConfig);

  const envelope = await runPostStructuredComment({
    ticketId,
    type: values.marker,
    body,
    provider,
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

runAsCli(import.meta.url, main, { source: 'post-structured-comment' });
