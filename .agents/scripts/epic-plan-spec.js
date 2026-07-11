#!/usr/bin/env node

/**
 * epic-plan-spec.js — Phase 7 (spec) entry point for the split planning flow.
 *
 * Two idempotent modes and a single-purpose label lifecycle:
 *
 *   1. --emit-context   Prints the planner authoring context (Epic body,
 *                       scraped project docs, recommended system prompts) as
 *                       JSON. The authoring middle is the
 *                       `epic-plan-spec-author` Skill (see
 *                       `.agents/skills/core/epic-plan-spec-author/SKILL.md`),
 *                       which consumes this envelope and writes the Tech Spec
 *                       markdown file.
 *
 *   2. (default)        Given author-provided Tech Spec and risk-verdict
 *                       files, validates the risk verdict against
 *                       `risk-verdict.schema.json`, derives the planningRisk
 *                       envelope, folds the authored content into managed
 *                       sections of the Epic body (Story #4324 — no separate
 *                       context tickets), records the verdict as a
 *                       `risk-verdict` structured comment, flips the Epic to
 *                       `agent::review-spec`, and upserts the
 *                       `epic-plan-state` structured comment.
 *
 * --force regenerates the existing Tech Spec.
 * --steal forcibly transfers a foreign Epic-lease claim (the plan-lease guard
 *   fails closed, so any foreign assignee blocks the run unless stolen).
 *
 * Exit codes:
 *   0 — phase complete, Epic is now `agent::review-spec`.
 *   1 — fatal error (see stderr).
 *
 * The phase implementations live under
 * `lib/orchestration/epic-plan-spec/phases/`. This file is now a thin CLI
 * entry that wires argv → phases.
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { readFile } from 'node:fs/promises';
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

import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr, STDERR_LOGGER } from './lib/Logger.js';
import {
  buildAuthoringContext,
  resolveMemoryDir,
} from './lib/orchestration/epic-plan-spec/phases/authoring-context.js';
import { parseEpicPlanSpecArgs } from './lib/orchestration/epic-plan-spec/phases/cli-args.js';
import { drainPendingCleanupAtBoot } from './lib/orchestration/epic-plan-spec/phases/drain.js';
import {
  planEpic,
  resolveAcceptancePersistence,
} from './lib/orchestration/epic-plan-spec/phases/plan-epic.js';
import {
  loadRiskVerdict,
  validateRiskVerdict,
} from './lib/orchestration/epic-plan-spec/phases/risk-verdict.js';
import { runSpecPhase } from './lib/orchestration/epic-plan-spec/phases/run-spec-phase.js';
import { runSpecFreshnessCheck } from './lib/orchestration/epic-plan-spec/phases/spec-freshness.js';
import { resolveReviewRouting } from './lib/orchestration/plan-review-routing.js';
import { createProvider } from './lib/provider-factory.js';

// Re-exports for stable public API: tests and external callers import these
// from `epic-plan-spec.js`. The implementations live in `phases/`.
export {
  buildAuthoringContext,
  drainPendingCleanupAtBoot,
  loadRiskVerdict,
  planEpic,
  resolveAcceptancePersistence,
  resolveMemoryDir,
  resolveReviewRouting,
  runSpecFreshnessCheck,
  runSpecPhase,
  validateRiskVerdict,
};

async function main() {
  const { values, epicId } = parseEpicPlanSpecArgs();

  let config;
  let settings;
  try {
    config = resolveConfig();
    // `settings` retains the legacy bag shape used by buildAuthoringContext
    // and friends: `{ baseBranch, paths, planning, ... }`. Build it from the
    // canonical blocks rather than the legacy shim.
    settings = {
      baseBranch: config.project?.baseBranch,
      paths: config.project?.paths,
      planning: config.planning,
      docsContextFiles: config.project?.docsContextFiles,
    };
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const provider = createProvider(config);

  const emitContext = values['emit-context'];
  // Story #2278 — in --emit-context mode stdout is reserved for the JSON
  // envelope. Flip every Logger sink that could land on stdout to stderr
  // *before* any pipeline code runs (drainPendingCleanupAtBoot,
  // buildAuthoringContext → ensureDocsDigest — Story #4433 cut the digest
  // build over from the old buildDocsContext/scrapeProjectDocs full-content
  // read path), so a captured file is unconditionally parseable by
  // `JSON.parse`.
  if (emitContext) routeAllOutputToStderr();

  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      config,
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
      github: config.github ?? null,
    });
    const json = values.pretty
      ? JSON.stringify(ctx, null, 2)
      : JSON.stringify(ctx);
    process.stdout.write(`${json}\n`);
    return;
  }

  if (!values['tech-spec'] || !values['risk-verdict']) {
    throw new Error(
      'Missing --tech-spec and/or --risk-verdict file paths. (Use --emit-context first to gather authoring context; the epic-plan-spec-author Skill writes all artifacts including risk-verdict.json.)',
    );
  }

  // Read + schema-validate the planner-authored risk verdict before any
  // GitHub mutation: a malformed verdict fails closed here (Epic #3865).
  const riskVerdict = loadRiskVerdict(values['risk-verdict']);

  const readPromises = [readFile(values['tech-spec'], 'utf8')];
  if (values['acceptance-table']) {
    readPromises.push(readFile(values['acceptance-table'], 'utf8'));
  }
  const [techSpecContent, acceptanceSpecContent = null] =
    await Promise.all(readPromises);

  const result = await runSpecPhase(
    epicId,
    provider,
    { techSpecContent, acceptanceSpecContent },
    settings,
    {
      force: values.force,
      forceReview: values['force-review'],
      steal: values.steal === true,
      config,
      riskVerdict,
    },
  );

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-spec' });
