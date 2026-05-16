#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-spec.js — Phase 1 (spec) entry point for the split planning flow.
 *
 * Two idempotent modes and a single-purpose label lifecycle:
 *
 *   1. --emit-context   Prints the planner authoring context (Epic body,
 *                       scraped project docs, recommended system prompts) as
 *                       JSON. The authoring middle is the
 *                       `epic-plan-spec-author` Skill (see
 *                       `.agents/skills/core/epic-plan-spec-author/SKILL.md`),
 *                       which consumes this envelope and writes the PRD and
 *                       Tech Spec markdown files.
 *
 *   2. (default)        Given author-provided PRD and Tech Spec files,
 *                       persists the two artifact issues, flips the Epic to
 *                       `agent::review-spec`, and upserts the `epic-plan-state`
 *                       structured comment.
 *
 * --force regenerates existing PRD/Tech Spec.
 *
 * Exit codes:
 *   0 — phase complete, Epic is now `agent::review-spec`.
 *   1 — fatal error (see stderr).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  forkAndCommitEpicSnapshot,
  forkMainToEpic,
} from './lib/baseline-snapshot.js';

// Re-exported so the historic import path
// (`epic-plan-spec.js#forkAndCommitEpicSnapshot`) and existing tests keep
// working after Story #1585 relocated the wrapper into the lower-level
// `lib/baseline-snapshot.js` module. `forkMainToEpic` is also re-exported
// for the same reason.
export { forkAndCommitEpicSnapshot, forkMainToEpic };

import { verifyBddRunnerPendingTag } from './lib/bdd-runner-detect.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getLimits,
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import * as gitUtils from './lib/git-utils.js';
import { Logger, STDERR_LOGGER } from './lib/Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from './lib/label-constants.js';
import { PlanRunnerContext } from './lib/orchestration/context.js';
import { buildDocsContext } from './lib/orchestration/doc-reader.js';
import {
  PLAN_PHASES,
  PlanCheckpointer,
} from './lib/orchestration/plan-runner/plan-checkpointer.js';
import { sweepStaleStoryWorktrees } from './lib/orchestration/plan-runner/worktree-sweep.js';
import { applyBudget } from './lib/orchestration/planning-context-budget.js';
import { PlanningStateManager } from './lib/orchestration/planning-state-manager.js';
import { cleanupPhaseTempFiles } from './lib/plan-phase-cleanup.js';
import { createProvider } from './lib/provider-factory.js';
import { forceDrainPendingCleanup } from './lib/worktree/lifecycle/force-drain.js';
import { readManifest } from './lib/worktree/lifecycle/pending-cleanup.js';

// ─── PRD / Tech Spec system prompts ──────────────────────────────────────────
//
// These are the canonical authoring prompts that ride along on the
// `--emit-context` envelope as a backstop. The `epic-plan-spec-author` Skill
// (`.agents/skills/core/epic-plan-spec-author/SKILL.md`) embeds the
// authoritative copies of these strings — keep the two surfaces in sync when
// either is edited.

export const PRD_SYSTEM_PROMPT = `You are an expert Technical Product Manager.
Your job is to convert a high-level Epic description into a structured Product Requirements Document (PRD).

The PRD should outline:
1. Context & Goals
2. User Stories
3. Acceptance Criteria
4. Out of Scope

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Overview.
- Format requirements clearly with bullet points and bold text where appropriate.`;

export const TECH_SPEC_SYSTEM_PROMPT = `You are an expert Engineering Architect.
Your job is to convert a PRD into a Technical Specification for implementation.

The Tech Spec should outline:
1. Architecture & Design
2. Data Models (if any)
3. API Changes (if any)
4. Core Components
5. Security & Privacy Considerations

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Technical Overview.
- Format architectural decisions clearly with bullet points.`;

export const ACCEPTANCE_SPEC_SYSTEM_PROMPT = `You are an expert Acceptance Engineer.
Your job is to convert a PRD and a Tech Spec into a structured Acceptance Specification that drives features-first BDD authoring.

The Acceptance Spec should outline:
1. Acceptance Criteria — one row per user-visible outcome, expressed as a Markdown table with columns: AC ID | Outcome | Feature File | Scenario | Disposition
2. Stable AC IDs — assign AC-1, AC-2, ... in document order; reuse the same ID across re-plans when an Outcome is materially unchanged so scenario tags (@ac-N) stay aligned
3. Disposition — tag each row with one of: new | updated | unchanged

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Acceptance Criteria.
- Every AC row MUST have a stable AC ID of the form AC-<n> (AC-1, AC-2, ...) — do not reorder IDs across re-plans; new ACs get fresh sequential IDs.
- Every AC row MUST carry a Disposition value from the enum: new | updated | unchanged.
- Each Outcome MUST be a single user-visible behaviour — no DB assertions, no HTTP status codes, no internal implementation details.
- Cite proposed feature file paths under tests/features/** so Phase 2 can scaffold matching scenarios.`;

/**
 * Build the authoring context the host LLM (or the
 * `epic-plan-spec-author` Skill) needs to write the PRD and Tech Spec.
 *
 * Returns a plain JSON-serialisable object; never hits the network beyond the
 * provider call needed to load the Epic.
 *
 * `docsContext` is bounded by the planning-context budget (Epic #817 Story 9):
 * over-budget payloads downgrade to a summary representation with headings +
 * bounded excerpts. Pass `{ fullContext: true }` (CLI: `--full-context`) to
 * restore the unbounded full-body envelope. The Epic body itself is always
 * subject to the same budget so a sprawling Epic narrative cannot bypass the
 * cap by riding on top of `docsContext`.
 */
export async function buildAuthoringContext(
  epicId,
  provider,
  settings = {},
  opts = {},
) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`Epic #${epicId} not found.`);
  }

  const planningLimits = getLimits({ agentSettings: settings }).planningContext;
  const { fullContext = false } = opts;

  const docsContext = await buildDocsContext(settings, planningLimits, {
    fullContext,
  });

  const epicBody = applyBudget(
    [{ path: `epic-${epic.id}.md`, content: epic.body ?? '' }],
    planningLimits,
    { fullContext },
  );

  // Story #2094 Task #2103 — verify the project's BDD runner pending-tag
  // support so the acceptance-spec body can record either the verified tag
  // (features-first ordering) or "fallback: dependencies-first ordering"
  // when no supported runner is present.
  const bddRunner = await verifyBddRunnerPendingTag({ cwd: PROJECT_ROOT });

  return {
    epic: {
      id: epic.id,
      title: epic.title,
      body: epicBody.mode === 'full' ? epic.body : null,
      bodySummary: epicBody.mode === 'summary' ? epicBody.items[0] : null,
      linkedIssues: epic.linkedIssues ?? { prd: null, techSpec: null },
    },
    docsContext,
    systemPrompts: {
      prd: PRD_SYSTEM_PROMPT,
      techSpec: TECH_SPEC_SYSTEM_PROMPT,
      acceptanceSpec: ACCEPTANCE_SPEC_SYSTEM_PROMPT,
    },
    bddRunner,
  };
}

/**
 * Persist the host-authored PRD and Tech Spec under the Epic.
 *
 * Heals any prior planning artifacts (PRD / Tech Spec issues, "Planning
 * Artifacts" body section, lifecycle labels) before writing the new issues.
 * Idempotent against partial state: when the Epic already has a PRD but no
 * Tech Spec, the existing PRD is reused. Pass `force: true` to force a full
 * regeneration (close prior PRD/Tech Spec and re-create both).
 */
export async function planEpic(
  epicId,
  provider,
  { prdContent, techSpecContent },
  _settings = {},
  { force = false } = {},
) {
  if (typeof prdContent !== 'string' || prdContent.trim() === '') {
    throw new Error(
      '[Epic Planner] prdContent is required and must be non-empty.',
    );
  }
  if (typeof techSpecContent !== 'string' || techSpecContent.trim() === '') {
    throw new Error(
      '[Epic Planner] techSpecContent is required and must be non-empty.',
    );
  }

  Logger.info(`[Epic Planner] Fetching Epic #${epicId}...`);
  const epic = await provider.getEpic(epicId);

  if (!epic) {
    throw new Error(`Epic #${epicId} not found.`);
  }

  const stateManager = new PlanningStateManager(provider);
  await stateManager.healAndCleanupArtifacts(epic, force);

  // M-8: Resumable planning — if PRD exists but Tech Spec doesn't, resume from PRD.
  if (!force && epic.linkedIssues?.prd && epic.linkedIssues?.techSpec) {
    Logger.warn(
      `[Epic Planner] Epic #${epicId} already has both PRD and Tech Spec. Aborting to prevent duplicates. Use --force to re-plan.`,
    );
    return;
  }
  const existingPrdId = force ? null : (epic.linkedIssues?.prd ?? null);

  let prdId;
  if (existingPrdId) {
    Logger.info(
      `[Epic Planner] Reusing existing PRD #${existingPrdId}. Skipping PRD creation.`,
    );
    prdId = existingPrdId;
  } else {
    Logger.info(`[Epic Planner] Creating PRD issue for "${epic.title}"...`);
    const prdTicket = await provider.createTicket(epicId, {
      title: `[PRD] ${epic.title}`,
      body: prdContent,
      labels: ['context::prd'],
      dependencies: [],
    });
    Logger.info(
      `[Epic Planner] Created PRD Issue #${prdTicket.id} (${prdTicket.url})`,
    );
    prdId = prdTicket.id;
  }

  Logger.info(
    `[Epic Planner] Creating Tech Spec issue linking to PRD #${prdId}...`,
  );
  const techSpecTicket = await provider.createTicket(epicId, {
    title: `[Tech Spec] ${epic.title}`,
    body: techSpecContent,
    labels: ['context::tech-spec'],
    dependencies: [prdId],
  });
  Logger.info(
    `[Epic Planner] Created Tech Spec Issue #${techSpecTicket.id} (${techSpecTicket.url})`,
  );

  Logger.info(
    `[Epic Planner] Updating Epic #${epicId} with linked documents...`,
  );

  // Format exactly so getEpic regex /PRD:\s*#\d+/i still catches it efficiently.
  const appendBody = `\n\n## Planning Artifacts\n- [ ] PRD: #${prdId}\n- [ ] Tech Spec: #${techSpecTicket.id}\n`;
  const newBody = epic.body + appendBody;

  await provider.updateTicket(epicId, {
    body: newBody,
  });

  Logger.info(`[Epic Planner] Epic #${epicId} updated successfully.`);
  Logger.info(`[Epic Planner] Planning pipeline complete!`);
}

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
 * @param {{ force?: boolean, snapshotFork?: typeof forkAndCommitEpicSnapshot }} [opts]
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

  // Story #1585 (Epic #1471): the baseline-snapshot fork was previously
  // performed here at plan-time. It now runs at first-story-init time
  // inside `lib/story-init/branch-initializer.js#bootstrapWorktree` so
  // `/epic-plan` remains git-state-free. `forkAndCommitEpicSnapshot` and
  // `forkMainToEpic` remain exported for that caller.

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
    throw new Error(
      'Usage: epic-plan-spec.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --prd <file> --techspec <file>) [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  let orchestration;
  let settings;
  try {
    ({ orchestration, agentSettings: settings } = resolveConfig());
    validateOrchestrationConfig(orchestration);
  } catch (err) {
    throw new Error(
      `Orchestration config schema validation failed:\n${err.message}`,
    );
  }
  const provider = createProvider(orchestration);

  const emitContext = values['emit-context'];

  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      orchestration,
      provider,
      // In --emit-context mode stdout is reserved for the JSON envelope;
      // route every drain/sweep log line through stderr so the captured
      // file is unconditionally parseable.
      logger: emitContext ? STDERR_LOGGER : undefined,
    });
  } catch (err) {
    Logger.warn(
      `[epic-plan-spec] pending-cleanup drain skipped: ${err.message}`,
    );
  }

  if (emitContext) {
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
    throw new Error(
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
