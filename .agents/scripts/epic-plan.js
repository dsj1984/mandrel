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

import { existsSync as defaultExistsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runDecomposePhase } from './epic-plan-decompose.js';
import { runSpecPhase } from './epic-plan-spec.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  PLAN_PHASES,
  PlanCheckpointer,
} from './lib/orchestration/plan-runner/plan-checkpointer.js';
import {
  advancePhase,
  nextPhaseForEpic,
  PLAN_PHASE_NAMES,
} from './lib/orchestration/plan-runner/plan-router.js';
import { createProvider } from './lib/provider-factory.js';
import { specPath } from './lib/spec/loader.js';

/**
 * Story #1499 / Task #1527 — Phase 2.5 edit-in-place entry-point detection.
 *
 * Resolve the on-disk spec file for `epicId` and report whether it
 * already exists. When present, the host LLM (this wrapper) routes the
 * plan invocation through the edit-in-place flow (`runEditFlow`) instead
 * of the author-then-reconcile (`runSpec` → `runDecompose`) chain.
 *
 * The check is intentionally a stat — neither YAML parse nor schema
 * validation runs here, so a malformed spec does not poison the
 * detection path. The downstream edit flow (Task #1530) calls `loadSpec`
 * to validate before doing any further work.
 *
 * Exported so tests can pin the routing predicate without re-deriving
 * the path convention from prose.
 *
 * @param {number|string} epicId
 * @param {{ existsSync?: typeof defaultExistsSync, specPathFn?: typeof specPath, epicsDir?: string }} [opts]
 * @returns {{ exists: boolean, path: string }}
 */
export function detectExistingSpec(epicId, opts = {}) {
  const existsFn = opts.existsSync ?? defaultExistsSync;
  const specPathFn = opts.specPathFn ?? specPath;
  const filePath = specPathFn(
    epicId,
    opts.epicsDir ? { epicsDir: opts.epicsDir } : {},
  );
  return { exists: existsFn(filePath), path: filePath };
}

/**
 * Edit-in-place flow stub for Phase 2.5 (Story #1499).
 *
 * This is the routing target taken when `detectExistingSpec` reports the
 * spec already exists. Task #1527 only wires the route; Task #1530 fills
 * in the dry-run + HITL confirmation behaviour (delegating to the
 * existing `epic-reconcile.js` CLI). Until then, the flow returns a
 * surface-shape stable envelope so the wrapping skill (and tests) can
 * pin the route taken without depending on the apply behaviour.
 *
 * Exported so the test suite can override the apply path or inject a
 * stub reconciler runner once Task #1530 lands.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   specFilePath: string,
 *   force?: boolean,
 *   runReconcile?: function,
 *   confirm?: () => Promise<boolean>,
 *   isTty?: () => boolean,
 *   stdout?: (line: string) => void,
 * }} args
 * @returns {Promise<{ epicId: number, mode: 'edit', specPath: string, applied: boolean, plan?: object, reason?: string }>}
 */
export async function runEditFlow({
  epicId,
  specFilePath,
  // Apply gate + collaborators are reserved for Task #1530.
}) {
  Logger.info(
    `[epic-plan] Existing spec detected for Epic #${epicId} at ${specFilePath}. Routing through edit-in-place flow (Task #1530 stub).`,
  );
  return {
    epicId,
    mode: 'edit',
    specPath: specFilePath,
    applied: false,
    reason: 'edit-flow-stub-task-1530',
  };
}

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
  runSpec = runSpecPhase,
  runDecompose = runDecomposePhase,
  runEdit = runEditFlow,
  detectSpec = detectExistingSpec,
}) {
  // Phase 2.5 edit-in-place detection (Story #1499 / Task #1527).
  // `--force` is the operator escape hatch: it re-runs the author path
  // even when a spec is present, matching the behaviour the spec phase
  // already documents for PRD/Tech Spec regeneration.
  const specProbe = detectSpec(epicId);
  if (specProbe.exists && !force) {
    const editResult = await runEdit({
      epicId,
      provider,
      specFilePath: specProbe.path,
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
    { force },
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
  const checkpointer = new PlanCheckpointer({ provider, epicId });
  const checkpoint = await checkpointer.read();
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
      'describe-resume-point': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: epic-plan.js --epic <EpicId> --prd <file> --techspec <file> --tickets <file> [--force]',
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
    Logger.fatal(
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
      Logger.fatal(
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
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Re-export the phase names/enums so downstream tooling can import them from
// a single entry point. `advancePhase` and `PLAN_PHASES` (phase-name enum)
// are the two most common consumers.
export { advancePhase, PLAN_PHASE_NAMES, PLAN_PHASES, PlanCheckpointer };

runAsCli(import.meta.url, main, { source: 'epic-plan' });
