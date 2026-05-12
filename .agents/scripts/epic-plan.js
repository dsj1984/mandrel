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
import {
  confirmInteractive as defaultConfirmInteractive,
  runReconcile,
} from './epic-reconcile.js';
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
 * Edit-in-place flow for Phase 2.5 (Story #1499 / Task #1530).
 *
 * Reached when `detectExistingSpec` reports the spec is already on disk
 * for `epicId`. Wraps `epic-reconcile.js`'s `runReconcile` to:
 *
 *   1. Compute the structural plan (dry-run) and render it to stdout.
 *   2. Short-circuit with a no-changes message when the plan is empty —
 *      no operator prompt, no apply.
 *   3. Otherwise, gate the apply phase behind explicit operator
 *      confirmation (`y`/`yes`). When the operator declines, exit
 *      cleanly with `applied: false` and `reason: 'declined'`.
 *   4. On confirmation, invoke `runReconcile` a second time with
 *      `apply: true, yes: true` so the operator-confirmed apply runs
 *      end-to-end without prompting the embedded reconciler's own gate.
 *
 * The function is dependency-injection-heavy so tests can drive every
 * branch (dry-run-only, empty-diff, confirmed-apply, declined-apply)
 * without spawning a child process or hitting a real TTY.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   specFilePath: string,
 *   apply?: boolean,
 *   reconcileFn?: typeof runReconcile,
 *   confirm?: typeof defaultConfirmInteractive,
 *   isTty?: () => boolean,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   loaderOpts?: object,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   mode: 'edit',
 *   specPath: string,
 *   applied: boolean,
 *   plan: object|null,
 *   exitCode: number,
 *   reason?: string,
 *   applyResult?: object,
 * }>}
 */
export async function runEditFlow({
  epicId,
  provider,
  specFilePath,
  apply = false,
  reconcileFn = runReconcile,
  confirm = defaultConfirmInteractive,
  isTty = () => Boolean(process.stdin.isTTY),
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  loaderOpts,
}) {
  Logger.info(
    `[epic-plan] Existing spec detected for Epic #${epicId} at ${specFilePath}. Routing through edit-in-place flow.`,
  );

  // Step 1: dry-run to compute + render the plan. We always do this,
  // regardless of `apply`, so the operator sees the diff before being
  // prompted to confirm anything.
  const dryRunResult = await reconcileFn(
    {
      epicId,
      dryRun: true,
      apply: false,
      explicitDelete: false,
      yes: false,
    },
    {
      provider,
      stdout,
      stderr,
      loaderOpts,
    },
  );

  if (dryRunResult.exitCode !== 0) {
    return {
      epicId,
      mode: 'edit',
      specPath: specFilePath,
      applied: false,
      plan: dryRunResult.plan ?? null,
      exitCode: dryRunResult.exitCode,
      reason: 'dry-run-failed',
    };
  }

  // Step 2: empty-plan short-circuit. The reconciler reports this via
  // its `plan` envelope; we re-check rather than re-deriving the
  // predicate so the two surfaces stay aligned.
  const { isEmptyPlan } = await import(
    './lib/orchestration/epic-spec-reconciler-ops.js'
  );
  if (dryRunResult.plan && isEmptyPlan(dryRunResult.plan)) {
    stdout(
      `[epic-plan] No structural changes detected for Epic #${epicId}. Spec is in sync with live state.`,
    );
    return {
      epicId,
      mode: 'edit',
      specPath: specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 0,
      reason: 'empty-diff',
    };
  }

  // Step 3: apply path. The default is dry-run-only — the operator must
  // pass `--apply` (CLI) or `apply: true` (programmatic) to opt in.
  if (!apply) {
    return {
      epicId,
      mode: 'edit',
      specPath: specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 0,
      reason: 'dry-run-only',
    };
  }

  if (!isTty()) {
    stderr(
      '[epic-plan] --apply requires an interactive TTY for the operator confirmation gate.',
    );
    return {
      epicId,
      mode: 'edit',
      specPath: specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 1,
      reason: 'no-tty',
    };
  }

  stdout(
    `[epic-plan] Reviewed plan for Epic #${epicId}. Apply these structural changes?`,
  );
  const confirmed = await confirm();
  if (!confirmed) {
    stdout('[epic-plan] Edit-in-place declined by operator.');
    return {
      epicId,
      mode: 'edit',
      specPath: specFilePath,
      applied: false,
      plan: dryRunResult.plan,
      exitCode: 0,
      reason: 'declined',
    };
  }

  // Step 4: confirmed apply. `yes: true` so we do not double-prompt
  // through the embedded reconciler's gate — the operator already
  // consented one layer up.
  const applyResult = await reconcileFn(
    {
      epicId,
      dryRun: false,
      apply: true,
      explicitDelete: false,
      yes: true,
    },
    {
      provider,
      stdout,
      stderr,
      loaderOpts,
    },
  );

  return {
    epicId,
    mode: 'edit',
    specPath: specFilePath,
    applied: applyResult.exitCode === 0,
    plan: applyResult.plan ?? dryRunResult.plan,
    exitCode: applyResult.exitCode,
    applyResult: applyResult.applyResult,
    reason: applyResult.exitCode === 0 ? 'applied' : 'apply-failed',
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
  apply = false,
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
      apply: { type: 'boolean', default: false },
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
    apply: values.apply,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Re-export the phase names/enums so downstream tooling can import them from
// a single entry point. `advancePhase` and `PLAN_PHASES` (phase-name enum)
// are the two most common consumers.
export { advancePhase, PLAN_PHASE_NAMES, PLAN_PHASES, PlanCheckpointer };

runAsCli(import.meta.url, main, { source: 'epic-plan' });
