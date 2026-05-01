#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-decompose.js — Phase 2 (decompose) entry point for the split
 * planning flow.
 *
 * Wraps `ticket-decomposer.js` behind the idempotent plan-phase lifecycle:
 *
 *   1. --emit-context   Prints the decomposer authoring context (PRD body,
 *                       Tech Spec body, risk heuristics, system prompt, ticket
 *                       cap) as JSON. Host LLM consumes this to author the
 *                       ticket hierarchy JSON.
 *
 *   2. (default)        Given an author-provided tickets JSON file, persists
 *                       the Feature/Story/Task hierarchy, flips the Epic to
 *                       `agent::ready`, and updates the `epic-plan-state`
 *                       structured comment.
 *
 * --force re-decomposes (closes existing child Features/Stories/Tasks, same
 * semantics as `ticket-decomposer.js --force`).
 *
 * Exit codes:
 *   0 — phase complete, Epic is now `agent::ready`.
 *   1 — fatal error (see stderr).
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { drainPendingCleanupAtBoot } from './epic-plan-spec.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from './lib/label-constants.js';
import { PlanRunnerContext } from './lib/orchestration/context.js';
import {
  PLAN_PHASES,
  PlanCheckpointer,
} from './lib/orchestration/plan-runner/plan-checkpointer.js';
import { cleanupPhaseTempFiles } from './lib/plan-phase-cleanup.js';
import { createProvider } from './lib/provider-factory.js';
import {
  buildDecompositionContext,
  decomposeEpic,
} from './ticket-decomposer.js';

async function setEpicLabel(provider, epicId, targetLabel) {
  const planningLabels = [AGENT_LABELS.REVIEW_SPEC, AGENT_LABELS.READY];
  await provider.updateTicket(epicId, {
    labels: {
      add: [targetLabel],
      remove: planningLabels.filter((l) => l !== targetLabel),
    },
  });
}

/**
 * Execute the decompose phase end to end.
 *
 * @param {number} epicId
 * @param {import('./lib/ITicketingProvider.js').ITicketingProvider} provider
 * @param {{ tickets: Array<object> }} payload
 * @param {object} config
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ epicId: number, ticketCount: number, checkpoint: object }>}
 */
export async function runDecomposePhase(
  epicId,
  provider,
  { tickets },
  config = {},
  { force = false } = {},
) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-decompose] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-decompose] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }
  if (!epic.linkedIssues?.prd || !epic.linkedIssues?.techSpec) {
    throw new Error(
      `[epic-plan-decompose] Epic #${epicId} is missing a linked PRD or Tech Spec. Run /epic-plan-spec first.`,
    );
  }

  const ctx = new PlanRunnerContext({
    epicId,
    provider,
    config: config ?? {},
    phase: PLAN_PHASES.DECOMPOSING,
  });
  const checkpointer = new PlanCheckpointer({ ctx });
  await checkpointer.initialize({
    spec: {
      prdId: epic.linkedIssues.prd,
      techSpecId: epic.linkedIssues.techSpec,
      completedAt: null,
    },
  });
  await checkpointer.setPhase(PLAN_PHASES.DECOMPOSING);

  await decomposeEpic(epicId, provider, { tickets }, config, { force });

  const checkpoint = await checkpointer.updateDecompose({
    ticketCount: tickets.length,
    completedAt: new Date().toISOString(),
  });

  console.log(
    `[epic-plan-decompose] Flipping Epic #${epicId} to ${AGENT_LABELS.READY}...`,
  );
  await setEpicLabel(provider, epicId, AGENT_LABELS.READY);
  await checkpointer.setPhase(PLAN_PHASES.READY);

  const cleanup = await cleanupPhaseTempFiles({ phase: 'decompose', epicId });

  console.log(
    `[epic-plan-decompose] ✅ Decompose phase complete for Epic #${epicId}. ${tickets.length} ticket(s) persisted.`,
  );
  if (cleanup.deleted.length > 0) {
    console.log(
      `[epic-plan-decompose] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }

  return { epicId, ticketCount: tickets.length, checkpoint, cleanup };
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      tickets: { type: 'string' },
      force: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: epic-plan-decompose.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tickets <file>) [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    Logger.fatal(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config.orchestration);
  } catch (err) {
    Logger.fatal(
      `Orchestration config schema validation failed:\n${err.message}`,
    );
  }
  const provider = createProvider(config.orchestration);

  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      orchestration: config.orchestration,
      provider,
    });
  } catch (err) {
    console.warn(
      `[epic-plan-decompose] worktree sweep skipped: ${err.message}`,
    );
  }

  if (values['emit-context']) {
    const ctx = await buildDecompositionContext(epicId, provider, config, {
      fullContext: values['full-context'],
    });
    const json = values.pretty
      ? JSON.stringify(ctx, null, 2)
      : JSON.stringify(ctx);
    process.stdout.write(`${json}\n`);
    return;
  }

  if (!values.tickets) {
    Logger.fatal(
      'Missing --tickets <file>. (Use --emit-context first to gather authoring context.)',
    );
  }

  const raw = await readFile(values.tickets, 'utf8');
  let tickets;
  try {
    tickets = JSON.parse(raw);
  } catch (err) {
    Logger.fatal(
      `Failed to parse tickets file "${values.tickets}" as JSON: ${err.message}`,
    );
  }

  const result = await runDecomposePhase(
    epicId,
    provider,
    { tickets },
    config,
    { force: values.force },
  );

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-decompose' });
