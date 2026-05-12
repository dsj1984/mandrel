#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-decompose.js — Phase 2 (decompose) entry point for the split
 * planning flow.
 *
 * Wraps the deterministic ticket-decomposer engine behind the idempotent
 * plan-phase lifecycle:
 *
 *   1. --emit-context   Prints the decomposer authoring context (PRD body,
 *                       Tech Spec body, risk heuristics, system prompt, ticket
 *                       cap) as JSON. The authoring middle is the
 *                       `epic-plan-decompose-author` Skill
 *                       (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`)
 *                       — it consumes this envelope and writes the ticket
 *                       array JSON. The Skill carries the authoritative
 *                       system prompt; the `systemPrompt` field on the
 *                       envelope is retained as a backstop for tools that
 *                       still consume the legacy contract.
 *
 *   2. (default)        Given an author-provided tickets JSON file, persists
 *                       the Feature/Story/Task hierarchy, flips the Epic to
 *                       `agent::ready`, and updates the `epic-plan-state`
 *                       structured comment.
 *
 * --force re-decomposes (closes existing child Features/Stories/Tasks).
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
 * @param {{ force?: boolean, resume?: boolean }} [opts]
 * @returns {Promise<{ epicId: number, ticketCount: number, checkpoint: object }>}
 */
export async function runDecomposePhase(
  epicId,
  provider,
  { tickets },
  config = {},
  { force = false, resume = false } = {},
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

  await decomposeEpic(epicId, provider, { tickets }, config, { force, resume });

  const checkpoint = await checkpointer.updateDecompose({
    ticketCount: tickets.length,
    completedAt: new Date().toISOString(),
  });

  Logger.info(
    `[epic-plan-decompose] Flipping Epic #${epicId} to ${AGENT_LABELS.READY}...`,
  );
  await setEpicLabel(provider, epicId, AGENT_LABELS.READY);
  await checkpointer.setPhase(PLAN_PHASES.READY);

  const cleanup = await cleanupPhaseTempFiles({ phase: 'decompose', epicId });

  Logger.info(
    `[epic-plan-decompose] ✅ Decompose phase complete for Epic #${epicId}. ${tickets.length} ticket(s) persisted.`,
  );
  if (cleanup.deleted.length > 0) {
    Logger.info(
      `[epic-plan-decompose] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }

  return { epicId, ticketCount: tickets.length, checkpoint, cleanup };
}

/**
 * Best-effort recovery diagnostics emitted when `runDecomposePhase` throws
 * mid-pass (typically GitHub secondary RL after dozens of issue creations).
 * Never throws — diagnostics must not eclipse the original failure.
 */
async function reportPartialFailure({ epicId, provider, err }) {
  Logger.error('');
  Logger.error('[epic-plan-decompose] ❌ Decompose phase aborted.');
  Logger.error(`[epic-plan-decompose] Reason: ${err?.message ?? err}`);
  try {
    if (typeof provider.getEpic === 'function') {
      const epic = await provider.getEpic(epicId);
      const lifecycleLabel =
        (epic?.labels || []).find((l) => l.startsWith('agent::')) ?? 'unknown';
      Logger.error(
        `[epic-plan-decompose] Epic #${epicId} current label: ${lifecycleLabel}`,
      );
    }
    if (typeof provider.getTickets === 'function') {
      const existing = await provider.getTickets(epicId);
      const childTypes = [
        TYPE_LABELS.FEATURE,
        TYPE_LABELS.STORY,
        TYPE_LABELS.TASK,
      ];
      const created = (existing || []).filter(
        (t) =>
          (t.labels || []).some((l) => childTypes.includes(l)) &&
          t.state !== 'closed',
      ).length;
      Logger.error(
        `[epic-plan-decompose] Children currently open under Epic: ${created}`,
      );
    }
  } catch (probeErr) {
    Logger.error(
      `[epic-plan-decompose] (diagnostics probe failed: ${probeErr.message})`,
    );
  }
  Logger.error('');
  Logger.error('[epic-plan-decompose] To resume from the partial backlog:');
  Logger.error(
    `[epic-plan-decompose]   node .agents/scripts/epic-plan-decompose.js --epic ${epicId} --tickets <tickets-file> --resume`,
  );
  Logger.error('');
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      tickets: { type: 'string' },
      force: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: epic-plan-decompose.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tickets <file>) [--force | --resume]',
    );
  }
  if (values.force && values.resume) {
    Logger.fatal('--force and --resume are mutually exclusive.');
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
    Logger.warn(`[epic-plan-decompose] worktree sweep skipped: ${err.message}`);
  }

  if (values['emit-context']) {
    const ctx = await buildDecompositionContext(epicId, provider, config, {
      fullContext: values['full-context'],
    });
    // Surface the resolved cap on stderr so a misconfigured `.agentrc.json`
    // (e.g. flat-key `maxTickets` instead of grouped `limits.maxTickets`)
    // is visible to the operator rather than silently falling through to
    // the framework default. The decomposer prompt embeds the same value
    // — see ticket-decomposer.js:buildDecompositionContext.
    Logger.error(
      `[epic-plan-decompose] Resolved limits.maxTickets = ${ctx.maxTickets} (prompt cap).`,
    );
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

  let result;
  try {
    result = await runDecomposePhase(epicId, provider, { tickets }, config, {
      force: values.force,
      resume: values.resume,
    });
  } catch (err) {
    await reportPartialFailure({ epicId, provider, err });
    throw err;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-decompose' });
