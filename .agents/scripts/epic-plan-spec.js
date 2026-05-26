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
 *
 * The phase implementations live under
 * `lib/orchestration/epic-plan-spec/phases/`. This file is now a thin CLI
 * entry that wires argv → phases.
 */

import { readFile } from 'node:fs/promises';
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
import { drainPendingCleanupAtBoot } from './lib/orchestration/epic-plan-spec/phases/drain.js';
import {
  planEpic,
  resolveAcceptancePersistence,
} from './lib/orchestration/epic-plan-spec/phases/plan-epic.js';
import {
  ACCEPTANCE_SPEC_SYSTEM_PROMPT,
  PRD_SYSTEM_PROMPT,
  TECH_SPEC_SYSTEM_PROMPT,
} from './lib/orchestration/epic-plan-spec/phases/prompts.js';
import { runSpecPhase } from './lib/orchestration/epic-plan-spec/phases/run-spec-phase.js';
import { runSpecFreshnessCheck } from './lib/orchestration/epic-plan-spec/phases/spec-freshness.js';
import { resolveReviewRouting } from './lib/orchestration/plan-review-routing.js';
import { createProvider } from './lib/provider-factory.js';

// Re-exports for stable public API: tests and external callers import these
// from `epic-plan-spec.js`. The implementations live in `phases/`.
export {
  ACCEPTANCE_SPEC_SYSTEM_PROMPT,
  buildAuthoringContext,
  drainPendingCleanupAtBoot,
  PRD_SYSTEM_PROMPT,
  planEpic,
  resolveAcceptancePersistence,
  resolveMemoryDir,
  resolveReviewRouting,
  runSpecFreshnessCheck,
  runSpecPhase,
  TECH_SPEC_SYSTEM_PROMPT,
};

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      prd: { type: 'string' },
      techspec: { type: 'string' },
      'acceptance-spec': { type: 'string' },
      force: { type: 'boolean', default: false },
      'force-review': { type: 'boolean', default: false },
      'emit-context': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    throw new Error(
      'Usage: epic-plan-spec.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --prd <file> --techspec <file> [--acceptance-spec <file>]) [--force]',
    );
  }

  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${values.epic}" — must be a number.`);
  }

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
  // buildAuthoringContext → buildDocsContext → scrapeProjectDocs), so a
  // captured file is unconditionally parseable by `JSON.parse`.
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

  if (!values.prd || !values.techspec) {
    throw new Error(
      'Missing --prd and/or --techspec file paths. (Use --emit-context first to gather authoring context.)',
    );
  }

  const readPromises = [
    readFile(values.prd, 'utf8'),
    readFile(values.techspec, 'utf8'),
  ];
  if (values['acceptance-spec']) {
    readPromises.push(readFile(values['acceptance-spec'], 'utf8'));
  }
  const [prdContent, techSpecContent, acceptanceSpecContent = null] =
    await Promise.all(readPromises);

  const result = await runSpecPhase(
    epicId,
    provider,
    { prdContent, techSpecContent, acceptanceSpecContent },
    settings,
    { force: values.force, forceReview: values['force-review'] },
  );

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'epic-plan-spec' });
