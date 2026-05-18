#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-decompose.js — Story #2466 thin CLI shell.
 *
 * Phase 8 (decompose) entry point for the split planning flow. The
 * deterministic decomposer engine and reconciler-based persist flow
 * have been split into phase modules under
 * `lib/orchestration/epic-plan-decompose/phases/`:
 *
 *   1. planning-artifacts — `ensurePlanningArtifacts`,
 *                            `resolveConflictPolicy`.
 *   2. dag                — `resolveParentId`, `resolveDependencies`,
 *                            `orderTicketsForCreation`.
 *   3. context            — `buildDecomposerSystemPrompt`,
 *                            `buildDecompositionContext`.
 *   4. creation           — staged-pass ticket creation engine plus
 *                            `decomposeEpic` (legacy direct-create flow,
 *                            kept for the existing test surface).
 *   5. persist            — `runDecomposePhase` (reconciler-based flow).
 *   6. cli                — argument parsing + `main()` orchestration.
 *
 * Modes:
 *   --emit-context     Prints the decomposer authoring context (PRD body,
 *                      Tech Spec body, risk heuristics, system prompt,
 *                      ticket cap) as JSON. The authoring middle is the
 *                      `epic-plan-decompose-author` Skill
 *                      (`.agents/skills/core/epic-plan-decompose-author/SKILL.md`).
 *
 *   (default)          Given an author-provided tickets JSON file,
 *                      persists the Feature/Story/Task hierarchy via the
 *                      structural reconciler, flips the Epic to
 *                      `agent::ready`, and updates the `epic-plan-state`
 *                      structured comment.
 *
 * --force re-decomposes (closes existing child Features/Stories/Tasks).
 *
 * Exit codes:
 *   0 — phase complete, Epic is now `agent::ready`.
 *   1 — fatal error (see stderr).
 *
 * Public CLI surface and named exports are byte-identical to the pre-
 * refactor implementation.
 */

import { runAsCli } from './lib/cli-utils.js';
import { main } from './lib/orchestration/epic-plan-decompose/phases/cli.js';
import {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
} from './lib/orchestration/epic-plan-decompose/phases/context.js';
import {
  orderTicketsForCreation,
  resolveDependencies,
} from './lib/orchestration/epic-plan-decompose/phases/dag.js';
import { decomposeEpic } from './lib/orchestration/epic-plan-decompose/phases/decompose-legacy.js';
import { runDecomposePhase } from './lib/orchestration/epic-plan-decompose/phases/persist.js';
import { ensurePlanningArtifacts } from './lib/orchestration/epic-plan-decompose/phases/planning-artifacts.js';

// Named exports preserved for the existing test surface. The pre-refactor
// module published these and the consumers (`tests/ticket-decomposer.test.js`,
// `tests/scripts/epic-plan-decompose.body-preservation.test.js`,
// `tests/scripts/epic-plan-decompose.sub-issue-safety-net.test.js`,
// `tests/scripts/epic-plan.spec-flow.test.js`) still depend on them.
export {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
  decomposeEpic,
  ensurePlanningArtifacts,
  orderTicketsForCreation,
  resolveDependencies,
  runDecomposePhase,
};

runAsCli(import.meta.url, main, { source: 'epic-plan-decompose' });
