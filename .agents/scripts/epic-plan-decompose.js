#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-plan-decompose.js — Story #2466 thin CLI shell.
 *
 * > **Delegate for one release (Epic #4474, PR3).** The collapsed
 * > `plan-persist.js` CLI is now the canonical single GitHub-write surface
 * > for the plan flow. This CLI's persist half remains fully functional so
 * > in-flight workflows and external callers keep working; the
 * > workflow-prose cutover is PR5 and this entry point is retired in PR7.
 *
 * Phase 8 (decompose) entry point for the split planning flow. The
 * deterministic decomposer engine and reconciler-based persist flow
 * have been split into phase modules under
 * `lib/orchestration/epic-plan-decompose/phases/`:
 *
 *   1. planning-artifacts — `resolveConflictPolicy`.
 *   2. dag                — `resolveDependencies`,
 *                            `orderTicketsForCreation`.
 *   3. context            — `buildDecomposerSystemPrompt`,
 *                            `buildDecompositionContext`.
 *   4. creation           — sub-issue link reconciliation, Epic label
 *                            transitions, and the advisory ticket-cap
 *                            warning (`reconcileSubIssueLinks`,
 *                            `setEpicLabel`, `warnTicketCapNearLimit`).
 *   5. persist            — `runDecomposePhase` (reconciler-based flow).
 *   6. cli                — argument parsing + `main()` pipeline.
 *
 * Modes:
 *   --emit-context     Prints the decomposer authoring context (Epic body,
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

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
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
import { runDecomposePhase } from './lib/orchestration/epic-plan-decompose/phases/persist.js';

// Named exports preserved for the existing test surface. The pre-refactor
// module published these and the consumers (`tests/ticket-decomposer.test.js`,
// `tests/scripts/epic-plan-decompose.body-preservation.test.js`,
// `tests/scripts/epic-plan-decompose.sub-issue-safety-net.test.js`,
// `tests/scripts/epic-plan.spec-flow.test.js`) still depend on them.
export {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
  orderTicketsForCreation,
  resolveDependencies,
  runDecomposePhase,
};

runAsCli(import.meta.url, main, { source: 'epic-plan-decompose' });
