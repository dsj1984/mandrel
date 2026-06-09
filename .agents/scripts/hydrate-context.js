#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * hydrate-context.js — CLI wrapper for context hydration.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 *
 * Delegates to `hydrateContext` from `lib/orchestration/context-hydration-engine.js`
 * and emits the `{ prompt }` JSON envelope on stdout. Pass `--emit prompt`
 * to write the raw hydrated prompt (no JSON wrapper) instead — this is the
 * sole supported hydration entry point.
 *
 * Usage:
 *   node .agents/scripts/hydrate-context.js --ticket <id> [--epic <id>]
 *   node .agents/scripts/hydrate-context.js --ticket <id> --emit prompt
 *
 * If `--epic` is omitted, the epic id is parsed from the ticket body
 * (`Epic: #N`). Persona / skills are derived from the ticket's labels.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { getEpicBranch, getStoryBranch } from './lib/git-utils.js';
import { envelopeToPrompt } from './lib/orchestration/context-envelope.js';
import {
  hydrateContext,
  parseHierarchy,
} from './lib/orchestration/context-hydration-engine.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/hydrate-context.js --ticket <id> [--epic <id>]

Flags:
  --ticket   GitHub issue number to hydrate (required).
  --epic     Epic id (optional; parsed from the ticket body when omitted).
  --help     Show this message.

Output: a single JSON object {"prompt": "..."} on stdout by default.
  --emit envelope  Write {"envelope": {...}} instead (debug / inspection).
  --emit prompt    Write the raw hydrated prompt (no JSON wrapper) to stdout.
`;

/**
 * Build the normalized task object the hydration engine expects from a
 * full ticket fetched via the provider. Persona and skills come from the
 * `persona::*` and `skill::*` labels.
 */
export function ticketToTask(ticket) {
  const labels = ticket.labels ?? [];
  const persona = labels
    .find((l) => l.startsWith('persona::'))
    ?.replace('persona::', '');
  const skills = labels
    .filter((l) => l.startsWith('skill::'))
    .map((l) => l.replace('skill::', ''));

  return {
    id: ticket.id ?? ticket.number,
    title: ticket.title,
    body: ticket.body ?? '',
    labels,
    persona,
    skills,
  };
}

/**
 * Core: build the hydrated prompt and return the MCP-compatible envelope.
 * Exported so tests can pin parity against direct SDK invocation without a
 * subprocess.
 */
export async function runHydrateContext({ ticketId, epicId, provider }) {
  const ticket = await provider.getTicket(ticketId);
  const hierarchy = parseHierarchy(ticket.body ?? '');

  const resolvedEpicId = epicId ?? hierarchy.epic ?? null;

  const storyId =
    hierarchy.story ??
    hierarchy.parent ??
    ticket.id ??
    ticket.number ??
    ticketId;

  if (!resolvedEpicId) {
    throw new Error(
      `[hydrate-context] Could not resolve epic id for ticket #${ticketId}; ` +
        `pass --epic explicitly or ensure the body contains "Epic: #N".`,
    );
  }

  const epicBranch = getEpicBranch(resolvedEpicId);
  const taskBranch = getStoryBranch(resolvedEpicId, storyId);

  const task = ticketToTask({ ...ticket, id: ticketId });
  const envelope = await hydrateContext(
    task,
    provider,
    epicBranch,
    taskBranch,
    resolvedEpicId,
  );
  const prompt = envelopeToPrompt(envelope);
  return { prompt, envelope };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      epic: { type: 'string' },
      emit: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

/**
 * Pure: classify parsed CLI values into a runnable intent. Pulling this
 * decision out of `main` keeps the side-effecting wrapper at CC ≤ 2 and
 * lets the unit tests exercise every branch directly.
 *
 * Shapes:
 *   - { kind: 'help' }
 *   - { kind: 'usage-error', message }
 *   - { kind: 'run', ticketId, epicId | undefined, emit?: 'envelope' | 'prompt' }
 */
export function classifyCliInvocation(values) {
  if (values?.help) return { kind: 'help' };
  const ticketId = Number.parseInt(values?.ticket ?? '', 10);
  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return {
      kind: 'usage-error',
      message: `[hydrate-context] --ticket <id> is required.\n${HELP}`,
    };
  }
  const epicId = values?.epic ? Number.parseInt(values.epic, 10) : undefined;
  const intent = { kind: 'run', ticketId, epicId };
  if (values?.emit === 'envelope' || values?.emit === 'prompt') {
    intent.emit = values.emit;
  }
  return intent;
}

export async function main(argv = process.argv.slice(2)) {
  const intent = classifyCliInvocation(parseArgv(argv));
  if (intent.kind === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    process.stderr.write(intent.message);
    process.exit(2);
  }

  const config = resolveConfig();
  const provider = createProvider(config);
  const result = await runHydrateContext({
    ticketId: intent.ticketId,
    epicId: intent.epicId,
    provider,
  });
  if (intent.emit === 'prompt') {
    process.stdout.write(result.prompt);
    return;
  }
  const stdoutPayload =
    intent.emit === 'envelope'
      ? { envelope: result.envelope }
      : { prompt: result.prompt };
  process.stdout.write(`${JSON.stringify(stdoutPayload)}\n`);
}

runAsCli(import.meta.url, main, { source: 'hydrate-context' });
