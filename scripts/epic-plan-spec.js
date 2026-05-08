#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-spec.js — Phase 1 (spec) entry point for the split planning flow.
 *
 * Wraps `epic-planner.js` behind two idempotent modes and a single-purpose
 * label lifecycle:
 *
 *   1. --emit-context   Prints the planner authoring context (Epic body,
 *                       scraped project docs, recommended system prompts) as
 *                       JSON. Host LLM consumes this to author the PRD and
 *                       Tech Spec markdown.
 *
 *   2. (default)        Given author-provided PRD and Tech Spec files,
 *                       persists the two artifact issues, flips the Epic to
 *                       `agent::review-spec`, and upserts the `epic-plan-state`
 *                       structured comment.
 *
 * --force regenerates existing PRD/Tech Spec (same semantics as
 * `epic-planner.js --force`).
 *
 * Exit codes:
 *   0 — phase complete, Epic is now `agent::review-spec`.
 *   1 — fatal error (see stderr).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildAuthoringContext, planEpic } from './epic-planner.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import * as gitUtils from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from './lib/label-constants.js';
import { PlanRunnerContext } from './lib/orchestration/context.js';
import {
  PLAN_PHASES,
  PlanCheckpointer,
} from './lib/orchestration/plan-runner/plan-checkpointer.js';
import { sweepStaleStoryWorktrees } from './lib/orchestration/plan-runner/worktree-sweep.js';
import { cleanupPhaseTempFiles } from './lib/plan-phase-cleanup.js';
import { createProvider } from './lib/provider-factory.js';
import { forceDrainPendingCleanup } from './lib/worktree/lifecycle/force-drain.js';
import { readManifest } from './lib/worktree/lifecycle/pending-cleanup.js';

/**
 * Runs `sweepStaleStoryWorktrees` when a ticketing `provider` is available
 * (normal CLI boot): drains `.pending-cleanup.json` with Windows escalation,
 * then reaps registered worktrees for done/closed stories. When `provider` is
 * omitted (unit tests), runs `forceDrainPendingCleanup` on the manifest only.
 *
 * Uses `orchestration.worktreeIsolation.root` when present; defaults to
 * `.worktrees`.
 *
 * Non-blocking: stuck entries stay in the manifest; plan execution continues.
 *
 * Exposed for integration tests.
 *
 * @param {{ repoRoot?: string, orchestration?: object, provider?: object, git?: object, logger?: object, fsRm?: function }} [opts]
 * @returns {Promise<object>} Sweep/drain summary with legacy `drained` / `persistent` / `remaining` aliases for callers.
 */
export async function drainPendingCleanupAtBoot(opts = {}) {
  const repoRoot = opts.repoRoot ?? PROJECT_ROOT;
  const orchestration = opts.orchestration;
  const worktreeRoot = path.join(
    repoRoot,
    orchestration?.worktreeIsolation?.root ?? '.worktrees',
  );
  const git = opts.git ?? gitUtils;
  const logger = opts.logger ?? console;
  const fsRm = opts.fsRm;
  const provider = opts.provider;

  // legacyExtras adds `drained`/`persistent`/`remaining` aliases consumed by
  // drain-pending-cleanup.js, epic-plan-decompose.js, plan-runner/worktree-sweep.js,
  // and tests/epic-plan-spec-drain.test.js (Epic #990 Story #1006 triage).
  const legacyExtras = (base) => {
    const remaining =
      (base.persistentPending?.length ?? base.persistent?.length ?? 0) +
      (base.stillPending?.length ?? 0);
    const drained = base.drainedPending ?? base.drained ?? [];
    const persistent = base.persistentPending ?? base.persistent ?? [];
    return {
      ...base,
      remaining,
      drained,
      persistent,
    };
  };

  if (provider?.getTicket) {
    const sweep = await sweepStaleStoryWorktrees({
      provider,
      repoRoot,
      git,
      logger,
      worktreeRoot,
      fsRm,
    });
    const remaining =
      (sweep.persistentPending?.length ?? 0) +
      (sweep.stillPending?.length ?? 0);
    logger.info?.(
      `[epic-plan-spec] worktree sweep: reaped=${sweep.reaped.length} drainedPending=${sweep.drainedPending?.length ?? 0} remaining=${remaining}`,
    );
    return legacyExtras(sweep);
  }

  const before = readManifest(worktreeRoot).length;
  if (before === 0) {
    return legacyExtras({
      reaped: [],
      skipped: [],
      drainedPending: [],
      persistentPending: [],
      stillPending: [],
    });
  }
  const result = await forceDrainPendingCleanup({
    repoRoot,
    worktreeRoot,
    git,
    fsRm,
    logger,
  });
  const remaining =
    (result.persistent?.length ?? 0) + (result.stillPending?.length ?? 0);
  logger.info?.(
    `[epic-plan-spec] pending-cleanup drain: reaped=${result.drained?.length ?? 0} remaining=${remaining}`,
  );
  return legacyExtras({
    reaped: [],
    skipped: [],
    drainedPending: result.drained,
    persistentPending: result.persistent,
    stillPending: result.stillPending,
    escalated: result.escalated,
    killedPids: result.killedPids,
    noHolders: result.noHolders,
    drainedDetails: result.drainedDetails,
    persistentDetails: result.persistentDetails,
    stillPendingDetails: result.stillPendingDetails,
  });
}

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
 * Execute the spec phase end to end.
 *
 * @param {number} epicId
 * @param {import('./lib/ITicketingProvider.js').ITicketingProvider} provider
 * @param {{ prdContent: string, techSpecContent: string }} artifacts
 * @param {object} settings
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ epicId: number, prdId: number|null, techSpecId: number|null, checkpoint: object }>}
 */
export async function runSpecPhase(
  epicId,
  provider,
  { prdContent, techSpecContent },
  settings = {},
  { force = false } = {},
) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`[epic-plan-spec] Epic #${epicId} not found.`);
  }
  if (!epic.labels?.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `[epic-plan-spec] Ticket #${epicId} is not a ${TYPE_LABELS.EPIC}.`,
    );
  }

  const ctx = new PlanRunnerContext({
    epicId,
    provider,
    config: settings ?? {},
    phase: PLAN_PHASES.PLANNING,
  });
  const checkpointer = new PlanCheckpointer({ ctx });
  await checkpointer.initialize();
  await checkpointer.setPhase(PLAN_PHASES.PLANNING);

  await planEpic(epicId, provider, { prdContent, techSpecContent }, settings, {
    force,
  });

  const afterPlan = await provider.getEpic(epicId);
  const prdId = afterPlan.linkedIssues?.prd ?? null;
  const techSpecId = afterPlan.linkedIssues?.techSpec ?? null;

  const checkpoint = await checkpointer.updateSpec({
    prdId,
    techSpecId,
    completedAt: new Date().toISOString(),
  });

  Logger.info(
    `[epic-plan-spec] Flipping Epic #${epicId} to ${AGENT_LABELS.REVIEW_SPEC}...`,
  );
  await setEpicLabel(provider, epicId, AGENT_LABELS.REVIEW_SPEC);
  await checkpointer.setPhase(PLAN_PHASES.REVIEW_SPEC);

  const cleanup = await cleanupPhaseTempFiles({ phase: 'spec', epicId });

  Logger.info(
    `[epic-plan-spec] ✅ Spec phase complete for Epic #${epicId}. PRD #${prdId}, Tech Spec #${techSpecId}.`,
  );
  if (cleanup.deleted.length > 0) {
    Logger.info(
      `[epic-plan-spec] 🧹 Cleaned up ${cleanup.deleted.length} temp file(s).`,
    );
  }

  return { epicId, prdId, techSpecId, checkpoint, cleanup };
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      prd: { type: 'string' },
      techspec: { type: 'string' },
      force: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: epic-plan-spec.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --prd <file> --techspec <file>) [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    Logger.fatal(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  let orchestration;
  let settings;
  try {
    ({ orchestration, settings } = resolveConfig());
    validateOrchestrationConfig(orchestration);
  } catch (err) {
    Logger.fatal(
      `Orchestration config schema validation failed:\n${err.message}`,
    );
  }
  const provider = createProvider(orchestration);

  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      orchestration,
      provider,
    });
  } catch (err) {
    Logger.warn(
      `[epic-plan-spec] pending-cleanup drain skipped: ${err.message}`,
    );
  }

  if (values['emit-context']) {
    const ctx = await buildAuthoringContext(epicId, provider, settings, {
      fullContext: values['full-context'],
    });
    const json = values.pretty
      ? JSON.stringify(ctx, null, 2)
      : JSON.stringify(ctx);
    process.stdout.write(`${json}\n`);
    return;
  }

  if (!values.prd || !values.techspec) {
    Logger.fatal(
      'Missing --prd and/or --techspec file paths. (Use --emit-context first to gather authoring context.)',
    );
  }

  const [prdContent, techSpecContent] = await Promise.all([
    readFile(values.prd, 'utf8'),
    readFile(values.techspec, 'utf8'),
  ]);

  const result = await runSpecPhase(
    epicId,
    provider,
    { prdContent, techSpecContent },
    settings,
    { force: values.force },
  );

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-spec' });
