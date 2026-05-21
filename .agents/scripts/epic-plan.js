#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan.js — Local `/epic-plan` wrapper.
 *
 * Thin orchestrator that chains the split plan-phase CLIs for IDE-driven
 * planning:
 *
 *   1. Run the spec phase via `epic-plan-spec.js`.
 *   2. Surface PRD / Tech Spec URLs plus the next-step prompt.
 *   3. Wait for operator confirmation (handled by the host LLM in chat —
 *      this script exits cleanly after Step 1 when `--pause-after-spec` is
 *      set, letting the wrapping skill resume after human approval).
 *   4. Run the decompose phase via `epic-plan-decompose.js`.
 *
 * The script is intentionally small — the heavy lifting lives in each
 * sub-CLI. This wrapper primarily owns the in-chat confirmation gate.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runDecomposePhase } from './epic-plan-decompose.js';
import { detectExistingSpec, runEditFlow } from './epic-plan-edit-flow.js';
import { runSpecPhase } from './epic-plan-spec.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import {
  PLAN_PHASES,
  read as readPlanState,
} from './lib/orchestration/epic-plan-state-store.js';
import {
  advancePhase,
  nextPhaseForEpic,
  PLAN_PHASE_NAMES,
} from './lib/orchestration/plan-runner/plan-router.js';
import { createProvider } from './lib/provider-factory.js';

// Story #1499 / Task #1527: detect + edit-in-place flow live in their own
// module (epic-plan-edit-flow.js) so this wrapper stays a thin router.
// Re-exported for test ergonomics — `tests/scripts/epic-plan.edit-flow.test.js`
// imports them through this surface.
export { detectExistingSpec, runEditFlow };

/**
 * Orchestrate the full local plan. Intentionally side-effect-free on its
 * arguments — all I/O happens through `provider` and the two phase runners.
 *
 * Story #1499 / Task #1527: before invoking the spec phase, check whether
 * `.agents/epics/<id>.yaml` already exists. When it does, route through
 * the edit-in-place flow (`runEditFlow`) instead of the author-then-
 * reconcile path. `--force` bypasses the route check so operators can
 * regenerate from scratch on top of an existing spec.
 *
 * @param {{
 *   epicId: number,
 *   provider: import('./lib/ITicketingProvider.js').ITicketingProvider,
 *   settings: object,
 *   config: object,
 *   artifacts: { prdContent: string, techSpecContent: string, tickets: Array<object> },
 *   force?: boolean,
 *   runSpec?: typeof runSpecPhase,
 *   runDecompose?: typeof runDecomposePhase,
 *   runEdit?: typeof runEditFlow,
 *   detectSpec?: typeof detectExistingSpec,
 * }} opts
 */
/* exported for tests — Story-level reuse runner reserved for future test coverage */
export async function runSprintPlan({
  epicId,
  provider,
  settings,
  config,
  artifacts,
  force = false,
  forceReview = false,
  apply = false,
  runSpec = runSpecPhase,
  runDecompose = runDecomposePhase,
  runEdit = runEditFlow,
  detectSpec = detectExistingSpec,
}) {
  // Phase 8.5 edit-in-place detection (Story #1499 / Task #1527).
  // `--force` is the operator escape hatch: it re-runs the author path
  // even when a spec is present, matching the behaviour the spec phase
  // already documents for PRD/Tech Spec regeneration.
  const specProbe = detectSpec(epicId);
  if (specProbe.exists && !force) {
    const editResult = await runEdit({
      epicId,
      provider,
      specFilePath: specProbe.path,
      apply,
    });
    return {
      epicId,
      mode: 'edit',
      spec: null,
      decompose: null,
      edit: editResult,
    };
  }

  const specResult = await runSpec(
    epicId,
    provider,
    {
      prdContent: artifacts.prdContent,
      techSpecContent: artifacts.techSpecContent,
    },
    settings,
    { force, forceReview },
  );

  const decomposeResult = await runDecompose(
    epicId,
    provider,
    { tickets: artifacts.tickets },
    config,
    { force },
  );

  return {
    epicId,
    mode: 'author',
    spec: specResult,
    decompose: decomposeResult,
  };
}

/**
 * Read the `epic-plan-state` checkpoint and return the recommended next
 * phase the wrapper should invoke. Surface-only helper — used by the host
 * LLM to decide whether to resume after a paused spec phase.
 *
 * @param {{ provider: object, epicId: number }} ctx
 * @returns {Promise<{ nextPhase: string|null, checkpoint: object|null, epicLabels: string[] }>}
 */
async function describePlanResumePoint({ provider, epicId }) {
  const checkpoint = await readPlanState({ provider, epicId });
  const epic = await provider.getEpic(epicId);
  const labels = epic?.labels ?? [];
  const next = nextPhaseForEpic(labels);
  return {
    nextPhase: next?.phase ?? null,
    checkpoint,
    epicLabels: labels,
  };
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      prd: { type: 'string' },
      techspec: { type: 'string' },
      tickets: { type: 'string' },
      force: { type: 'boolean', default: false },
      'force-review': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'describe-resume-point': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    throw new Error(
      'Usage: epic-plan.js --epic <EpicId> --prd <file> --techspec <file> --tickets <file> [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config.orchestration);
  } catch (err) {
    throw new Error(
      `Orchestration config schema validation failed:\n${err.message}`,
    );
  }
  const { orchestration, agentSettings } = config;
  const provider = createProvider(orchestration);

  if (values['describe-resume-point']) {
    const info = await describePlanResumePoint({ provider, epicId });
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }

  // Story #1499 / Task #1527: when a spec already exists and the
  // operator did not pass --force, we route through the edit-in-place
  // flow. PRD/Tech Spec/tickets inputs are unused on that path because
  // the spec on disk is the authoritative source — re-emitting fresh
  // tickets would double-write. Probe up front so the CLI does not
  // require inputs operators do not have on hand for a re-plan.
  const specProbe = detectExistingSpec(epicId);
  const willEdit = specProbe.exists && !values.force;

  if (!willEdit && (!values.prd || !values.techspec || !values.tickets)) {
    throw new Error(
      'Missing required inputs. Need --prd, --techspec, and --tickets files.',
    );
  }

  let prdContent = '';
  let techSpecContent = '';
  let tickets = [];
  if (!willEdit) {
    const [prdRaw, techSpecRaw, ticketsRaw] = await Promise.all([
      readFile(values.prd, 'utf8'),
      readFile(values.techspec, 'utf8'),
      readFile(values.tickets, 'utf8'),
    ]);
    prdContent = prdRaw;
    techSpecContent = techSpecRaw;
    try {
      tickets = JSON.parse(ticketsRaw);
    } catch (err) {
      throw new Error(
        `Failed to parse tickets file "${values.tickets}" as JSON: ${err.message}`,
      );
    }
  }

  const result = await runSprintPlan({
    epicId,
    provider,
    settings: agentSettings,
    config,
    artifacts: { prdContent, techSpecContent, tickets },
    force: values.force,
    forceReview: values['force-review'],
    apply: values.apply,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Re-export the phase names/enums so downstream tooling can import them from
// a single entry point. `advancePhase` and `PLAN_PHASES` (phase-name enum)
// are the two most common consumers.
export { advancePhase, PLAN_PHASE_NAMES, PLAN_PHASES };

runAsCli(import.meta.url, main, { source: 'epic-plan' });
