#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * hydrate-context.js — CLI wrapper for context hydration.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 *
 * Delegates to `hydrateContext` from `lib/orchestration/context-hydration-engine.js`
 * and emits the `{ prompt }` JSON envelope on stdout.
 *
 * Usage:
 *   node .agents/scripts/hydrate-context.js --ticket <id> [--epic <id>]
 *
 * If `--epic` is omitted, the epic id is parsed from the ticket body
 * (`Epic: #N`). Persona / skills are derived from the ticket's labels.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { getEpicBranch, getStoryBranch } from './lib/git-utils.js';
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

Output: a single JSON object {"prompt": "..."} on stdout.
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
  const prompt = await hydrateContext(
    task,
    provider,
    epicBranch,
    taskBranch,
    resolvedEpicId,
  );
  return { prompt };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      epic: { type: 'string' },
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
 *   - { kind: 'run', ticketId, epicId | undefined }
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
  return { kind: 'run', ticketId, epicId };
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

  const { orchestration } = resolveConfig();
  const provider = createProvider(orchestration);
  const envelope = await runHydrateContext({
    ticketId: intent.ticketId,
    epicId: intent.epicId,
    provider,
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

runAsCli(import.meta.url, main, { source: 'hydrate-context' });
