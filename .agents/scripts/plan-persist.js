#!/usr/bin/env node

/**
 * plan-persist.js — single GitHub-write surface for the collapsed /plan
 * flow (Epic #4474, PR3 — design §1 Step 3).
 *
 * Supersedes the retired 12-phase pipeline's separate persist halves
 * (Epic #4474 PR7 — the delegate CLIs are import shims now, deleted next
 * release). Given the author-written planning artifacts
 * (Tech Spec, optional Acceptance Table, risk verdict, tickets JSON), this
 * CLI performs every GitHub mutation of the plan flow in one ordered,
 * fail-closed pass:
 *
 *   section gate → risk-verdict + mode-coherence → ticket validator /
 *   file-assumption gate / DAG / budget → (ideation: open the Epic) →
 *   Epic lease → managed sections + risk comment + freshness advisory →
 *   story creation (structural reconciler) → inline healthcheck →
 *   single terminal `agent::ready` flip (no intermediate
 *   `agent::review-spec`) → checkpoint v2 + `plan-summary` comment with
 *   the dry-run wave table → temp cleanup at terminal success only.
 *
 * Modes:
 *   --epic <id>          Persist against an existing Epic. Artifact paths
 *                        default to the per-Epic temp tree
 *                        (`temp/epic-<id>/techspec.md`, `risk-verdict.json`,
 *                        `tickets.json`, and `acceptance-spec.md` when
 *                        present).
 *   --one-pager <path>   Ideation mode: render + open the Epic from a
 *                        sharpened one-pager first (folds the former
 *                        Phase 3/4 steps in). Artifact paths must be
 *                        explicit (there is no Epic id to derive them from).
 *
 * Modes (Epic #4474 PR4, design §2 mode matrix): the risk verdict's
 * optional `deliveryShape` field selects between the full fan-out persist
 * (default; requires tickets) and the spec-only single-delivery variant
 * (`deliveryShape: "single"`; NO tickets — the ticket validator + DAG are
 * skipped, fenced by construction, and the `delivery::single` routing
 * marker is applied instead of a Story tree; inert until #4475 lands the
 * deliver-side reader). `--amend` selects the change-request delta path:
 * tickets carry `op: add|modify|keep|close` and the persist maps the ops
 * onto the existing tree.
 *
 * Flags:
 *   --force              Deliberate re-persist: overwrite managed sections,
 *                        close + recreate the story tree (reconciler
 *                        --explicit-delete). Reuses on-disk artifacts —
 *                        cleanup is deferred to terminal success, so a
 *                        failed run leaves them in place.
 *   --resume             Continue a partial persist after a crash
 *                        (rate-limit, network): sections short-circuit
 *                        idempotently, the reconciler creates only the
 *                        missing slugs from its per-slug state ledger.
 *   --amend              Change-request delta persist: every ticket carries
 *                        `op: add|modify|keep|close`; close-and-recreate is
 *                        scoped to modify/close slugs only, keeps are
 *                        untouched, and the DAG is validated over the
 *                        merged set.
 *   --explicit-delete    Confirm the close ops of an --amend plan (mirrors
 *                        epic-reconcile.js). Without it, an amend carrying
 *                        close ops prints the dry-run diff and exits 2.
 *   --steal              Force-transfer a live foreign Epic-lease claim.
 *   --force-review       Operator-forced review routing (recorded in the
 *                        checkpoint's reviewRouting envelope).
 *   --allow-over-budget / --allow-large-fan-out
 *                        Same overrides as the retired split persist.
 *
 * Exit codes: 0 — persist complete, Epic is `agent::ready`; 1 — fatal
 * error (see stderr); 2 — amend close ops require --explicit-delete (the
 * dry-run diff is printed; nothing was mutated); 3 — reachability orphans
 * (Epic #4474 PR6 named soft failure: the deterministic route-glob vs
 * `planning.navigation.navRegistry` scan found route-adding draft stories
 * with no navigation owner — the orphan-surface list is printed, nothing
 * was mutated; apply one targeted amend and re-run the persist once). The
 * Epic lease is released on every exit path.
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { epicArtifactPath } from './lib/config/temp-paths.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { drainPendingCleanupAtBoot } from './lib/orchestration/epic-plan-spec/phases/drain.js';
import { loadRiskVerdict } from './lib/orchestration/epic-plan-spec/phases/risk-verdict.js';
import {
  readPlanMetrics,
  recordPlanInvocation,
  renderPlanMetricsSummaryLine,
  summarizePlanMetrics,
} from './lib/orchestration/plan-metrics.js';
import {
  resolveDeliveryMode,
  runPlanPersist,
  writeCheckpointV2,
} from './lib/orchestration/plan-persist/run-plan-persist.js';
import {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from './lib/orchestration/plan-persist/summary.js';
import { createProvider } from './lib/provider-factory.js';

// Re-exports for the stable public API (tests import through the CLI
// module, mirroring the plan-context.js CLI-shell shape).
export {
  buildPlanSummaryCommentBody,
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
  resolveDeliveryMode,
  runPlanPersist,
  writeCheckpointV2,
};

export const EPIC_FROM_IDEA_TEMPLATE_PATH = path.resolve(
  PROJECT_ROOT,
  '.agents',
  'templates',
  'epic-from-idea.md',
);

const CLI_OPTIONS = {
  epic: { type: 'string' },
  'one-pager': { type: 'string' },
  'tech-spec': { type: 'string' },
  'acceptance-table': { type: 'string' },
  'risk-verdict': { type: 'string' },
  tickets: { type: 'string' },
  force: { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false },
  steal: { type: 'boolean', default: false },
  'force-review': { type: 'boolean', default: false },
  'allow-over-budget': { type: 'boolean', default: false },
  'allow-large-fan-out': { type: 'boolean', default: false },
  amend: { type: 'boolean', default: false },
  'explicit-delete': { type: 'boolean', default: false },
};

const USAGE =
  'Usage: plan-persist.js (--epic <EpicId> | --one-pager <file>) ' +
  '[--tech-spec <file>] [--acceptance-table <file>] [--risk-verdict <file>] ' +
  '[--tickets <file>] [--force | --resume | --amend [--explicit-delete]] ' +
  '[--steal] [--force-review] [--allow-over-budget] [--allow-large-fan-out]';

/**
 * Parse `--epic`; returns null when absent (ideation mode).
 */
function parseEpicId(rawEpic) {
  if (rawEpic === undefined) return null;
  const epicId = Number.parseInt(rawEpic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(
      `Invalid epic ID: "${rawEpic}" — must be a number.\n${USAGE}`,
    );
  }
  return epicId;
}

/**
 * Resolve the artifact file paths. Existing-Epic mode defaults each path to
 * the per-Epic temp tree — the same locations the authoring skill writes to
 * — so a `--force`/`--resume` re-persist reuses the on-disk artifacts with
 * no re-typing (they survive until terminal success now that cleanup is
 * deferred). Ideation mode has no Epic id to derive from, so the paths must
 * be explicit.
 */
function resolveArtifactPaths({ epicId, values, config }) {
  const fallback = (basename) =>
    epicId === null ? undefined : epicArtifactPath(epicId, basename, config);
  const techSpecPath = values['tech-spec'] ?? fallback('techspec.md');
  const riskVerdictPath =
    values['risk-verdict'] ?? fallback('risk-verdict.json');
  const ticketsPath = values.tickets ?? fallback('tickets.json');
  const acceptancePath =
    values['acceptance-table'] ?? fallback('acceptance-spec.md');
  if (!techSpecPath || !riskVerdictPath) {
    throw new Error(
      `Missing artifact path(s): ideation mode requires explicit --tech-spec and --risk-verdict.\n${USAGE}`,
    );
  }
  return {
    techSpecPath,
    riskVerdictPath,
    ticketsPath,
    acceptancePath,
    acceptanceExplicit: values['acceptance-table'] !== undefined,
    ticketsExplicit: values.tickets !== undefined,
  };
}

async function readOptional(filePath, { required }) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (!required && err?.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: CLI_OPTIONS });

  if (values.force && values.resume) {
    throw new Error('--force and --resume are mutually exclusive.');
  }
  if (values.amend && (values.force || values.resume)) {
    throw new Error(
      '--amend is mutually exclusive with --force/--resume — the amend ' +
        'delta is already an incremental re-persist.',
    );
  }

  const epicId = parseEpicId(values.epic);
  const onePagerPath = values['one-pager'];
  if (epicId === null && !onePagerPath) {
    throw new Error(USAGE);
  }
  if (epicId !== null && onePagerPath) {
    throw new Error(
      '--epic and --one-pager are mutually exclusive (ideation mode opens ' +
        `the Epic itself).\n${USAGE}`,
    );
  }

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const settings = {
    baseBranch: config.project?.baseBranch,
    paths: config.project?.paths,
    planning: config.planning,
    docsContextFiles: config.project?.docsContextFiles,
  };
  const provider = createProvider(config);

  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      config,
      provider,
    });
  } catch (err) {
    Logger.warn(`[plan-persist] pending-cleanup drain skipped: ${err.message}`);
  }

  const {
    techSpecPath,
    riskVerdictPath,
    ticketsPath,
    acceptancePath,
    acceptanceExplicit,
    ticketsExplicit,
  } = resolveArtifactPaths({ epicId, values, config });

  // Deterministic local reads + validation before any GitHub call. A
  // malformed risk verdict fails closed here (Epic #3865); the section
  // gate itself runs first inside runPlanPersist.
  const techSpecContent = await readOptional(techSpecPath, { required: true });
  const riskVerdict = loadRiskVerdict(riskVerdictPath);
  // Tickets are mode-dependent (#4474 PR4): required when explicitly
  // passed or in --amend mode; otherwise best-effort — a single-delivery
  // plan authors no tickets file at all, and the mode-coherence gate
  // (`resolveDeliveryMode`) hard-errors on every contradictory combination
  // (including a stale tickets.json next to a `deliveryShape: "single"`
  // verdict).
  const ticketsRequired = ticketsExplicit || values.amend;
  const ticketsRaw = ticketsPath
    ? await readOptional(ticketsPath, { required: ticketsRequired })
    : null;
  let tickets = null;
  if (ticketsRaw !== null) {
    try {
      tickets = JSON.parse(ticketsRaw);
    } catch (err) {
      throw new Error(
        `Failed to parse tickets file "${ticketsPath}" as JSON: ${err.message}`,
      );
    }
  }
  // Acceptance table: explicit path is required to exist; the per-Epic
  // default is best-effort (absent file → no acceptance section, matching
  // the waived/none dispositions).
  const acceptanceSpecContent = acceptancePath
    ? await readOptional(acceptancePath, { required: acceptanceExplicit })
    : null;
  const onePagerContent = onePagerPath
    ? await readOptional(onePagerPath, { required: true })
    : null;
  const templateContent = onePagerContent
    ? await readOptional(EPIC_FROM_IDEA_TEMPLATE_PATH, { required: true })
    : null;

  // Plan-metrics ledger (#4474 PR1): stamp entry/exit + mode. Ideation runs
  // have no Epic id at entry, so they stamp on the standalone stream.
  const mode = values.amend
    ? 'amend'
    : values.resume
      ? 'resume'
      : values.force
        ? 'force'
        : 'persist';
  let result;
  try {
    result = await recordPlanInvocation(
      { cli: 'plan-persist', mode, epicId, config },
      () =>
        runPlanPersist({
          epicId,
          provider,
          artifacts: {
            techSpecContent,
            acceptanceSpecContent,
            riskVerdict,
            tickets,
            onePagerContent,
            templateContent,
          },
          config,
          settings,
          opts: {
            force: values.force,
            resume: values.resume,
            amend: values.amend,
            explicitDelete: values['explicit-delete'],
            steal: values.steal,
            forceReview: values['force-review'],
            allowOverBudget: values['allow-over-budget'],
            allowLargeFanOut: values['allow-large-fan-out'],
          },
        }),
    );
  } catch (err) {
    // Amend close-op confirmation gate (exit 2, mirroring the
    // epic-reconcile.js contract): print the dry-run diff so the operator
    // reviews exactly what would close, mutate nothing, and exit 2 so
    // non-interactive callers can branch on the code.
    if (err?.code === 'PLAN_AMEND_EXPLICIT_DELETE_REQUIRED') {
      process.stdout.write(`${err.diff}\n\n${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    // Reachability soft failure (#4474 PR6): the orphan-surface list is the
    // message; nothing was mutated (the check runs before any provider
    // call). Exit 3 so non-interactive callers can branch on the code.
    if (err?.code === 'PLAN_REACHABILITY_ORPHANS') {
      process.stdout.write(`${err.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }

  // Surface the whole plan run's invocation ledger in the persist summary
  // (#4474 PR1). Additive and best-effort.
  try {
    const summary = summarizePlanMetrics(
      await readPlanMetrics(result.epicId, config),
    );
    if (summary) {
      result.planMetrics = summary;
      Logger.info(`[plan-persist] ${renderPlanMetricsSummaryLine(summary)}`);
    }
  } catch (err) {
    Logger.warn(`[plan-persist] plan-metrics summary skipped: ${err.message}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'plan-persist' });
