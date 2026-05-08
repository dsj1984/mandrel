#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-planner.js
 *
 * Epic Planner Orchestration Script (v5.6+)
 *
 * As of v5.6 the host LLM authors the PRD and Tech Spec directly — this script
 * no longer calls any external LLM API. It has two modes:
 *
 *   1. --emit-context  Prints a JSON envelope (epic body, project docs,
 *                      recommended system prompts) to stdout. The host LLM
 *                      consumes this to author the PRD and Tech Spec markdown.
 *
 *   2. (default)       Given author-provided PRD/Tech Spec files, heals any
 *                      existing planning artifacts and creates the linked
 *                      GitHub issues under the Epic.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { getLimits, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { buildDocsContext } from './lib/orchestration/doc-reader.js';
import { applyBudget } from './lib/orchestration/planning-context-budget.js';
import { PlanningStateManager } from './lib/orchestration/planning-state-manager.js';
import { createProvider } from './lib/provider-factory.js';

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

/**
 * Build the authoring context the host LLM needs to write the PRD/Tech Spec.
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
    },
  };
}

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

export function parseEpicPlannerArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      force: { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
      prd: { type: 'string' },
      techspec: { type: 'string' },
    },
    strict: false,
  });
  return values;
}

/**
 * Orchestration body of `main` extracted as a sibling exported function so
 * the validate / dispatch / mode-routing ladder is unit-testable without
 * spawning a process. `main` becomes a thin shell: parse → call this →
 * render → exit. CLI surface unchanged (same flags, same exit codes, same
 * stdout JSON schema for `--emit-context`).
 *
 * @param {ReturnType<typeof parseEpicPlannerArgs>} values
 * @param {{
 *   resolveConfig?: typeof resolveConfig,
 *   createProvider?: (orchestration: object) => object,
 *   buildAuthoringContext?: typeof buildAuthoringContext,
 *   planEpic?: typeof planEpic,
 *   readFile?: typeof readFile,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, result: object }>}
 *   `result.kind` is one of: `'validation-error'`, `'emit-context'`, `'plan'`.
 */
export async function runEpicPlannerCli(values, deps = {}) {
  if (!values.epic) {
    return {
      exitCode: 1,
      result: {
        kind: 'validation-error',
        message:
          'Usage: epic-planner.js --epic <ID> (--emit-context [--pretty] [--full-context] | --prd <file> --techspec <file>) [--force]',
      },
    };
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    return {
      exitCode: 1,
      result: {
        kind: 'validation-error',
        message: `Invalid epic ID: "${values.epic}" — must be a number.`,
      },
    };
  }

  const cfg = deps.resolveConfig ? deps.resolveConfig() : resolveConfig();
  const provider = deps.createProvider
    ? deps.createProvider(cfg.orchestration)
    : createProvider(cfg.orchestration);
  const buildCtx = deps.buildAuthoringContext ?? buildAuthoringContext;
  const plan = deps.planEpic ?? planEpic;
  const read = deps.readFile ?? readFile;

  if (values['emit-context']) {
    const context = await buildCtx(epicId, provider, cfg.settings, {
      fullContext: Boolean(values['full-context']),
    });
    return {
      exitCode: 0,
      result: {
        kind: 'emit-context',
        context,
        pretty: Boolean(values.pretty),
      },
    };
  }

  if (!values.prd || !values.techspec) {
    return {
      exitCode: 1,
      result: {
        kind: 'validation-error',
        message:
          'Missing --prd and/or --techspec file paths. (Use --emit-context first to gather authoring context.)',
      },
    };
  }

  const [prdContent, techSpecContent] = await Promise.all([
    read(values.prd, 'utf8'),
    read(values.techspec, 'utf8'),
  ]);

  await plan(epicId, provider, { prdContent, techSpecContent }, cfg.settings, {
    force: Boolean(values.force),
  });
  return { exitCode: 0, result: { kind: 'plan', epicId } };
}

/* node:coverage ignore next */
async function main() {
  const values = parseEpicPlannerArgs();
  const { exitCode, result } = await runEpicPlannerCli(values);

  if (result.kind === 'validation-error') {
    Logger.fatal(result.message);
    return; // unreachable — Logger.fatal exits.
  }
  if (result.kind === 'emit-context') {
    const json = result.pretty
      ? JSON.stringify(result.context, null, 2)
      : JSON.stringify(result.context);
    process.stdout.write(`${json}\n`);
    return;
  }
  // kind === 'plan': planEpic emitted its own progress lines; nothing more
  // to write. Non-zero exit codes still propagate.
  if (exitCode !== 0) process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'EpicPlanner' });
