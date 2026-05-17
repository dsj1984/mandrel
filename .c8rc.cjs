/**
 * c8 configuration for `npm run test:coverage`.
 *
 * Source of truth for the coverage **scope** (include/exclude) and the
 * c8 reporters. The numeric coverage gate is no longer expressed here —
 * it lives per-file in [`baselines/coverage.json`](./baselines/coverage.json),
 * checked by `.agents/scripts/check-baselines.js` (coverage kind) and
 * updated via `npm run coverage:update`. See
 * [`docs/quality-gates.md`](./docs/quality-gates.md) for the full ratchet
 * workflow.
 *
 * The `exclude` list below removes thin CLI shells whose meaningful
 * logic lives in `lib/` (which the per-file baseline still scores).
 * Each excluded file also carries `/* node:coverage ignore file *​/`
 * at the top of its source as a second line of defence; new exclusions
 * MUST add that pragma at the same time as touching this list, or
 * `c8 report` and the baseline checker disagree on what's in scope.
 *
 *   - agents-bootstrap-github.js — one-shot bootstrap CLI run once per
 *     consuming repo to seed labels, project fields, and views from
 *     `lib/label-taxonomy.js`. The taxonomy itself is unit-tested; the
 *     CLI shell only argv-parses and calls a single provider method
 *     loop. Real coverage requires hitting a live GitHub repo, which
 *     belongs in integration tests, not the unit-test gate.
 *   - context-hydrator.js — thin CLI wrapper around
 *     `lib/orchestration/context-hydration-engine.js` and
 *     `hydrate-context.js`. The engine, hierarchy parser, and token
 *     budgeter are unit-tested under `tests/`; the CLI shell only
 *     parses argv and delegates. End-to-end hydration depends on a
 *     real provider tree and a Story prompt context that only an
 *     integration test can reasonably build.
 *   - retrofit-task-bodies.js — top-level CLI shell with zero exports.
 *     The retrofit logic is unit-tested under `lib/retrofit/`; the
 *     shell glue (argv → provider → batch loop) is integration-shaped
 *     and not on a unit-test path.
 *   - epic-plan.js / epic-plan-decompose.js / epic-plan-spec.js /
 *     epic-plan-healthcheck.js — `/epic-plan` slash-command CLIs.
 *     Each exports a `runXPhase` that calls into a real GitHub
 *     provider, reads PRD/Tech Spec bodies, drives `lib/orchestration/
 *     plan-runner` against live tickets, and writes back through
 *     `lib/orchestration/ticketing.js`. The exports have no unit-
 *     test seam without standing up a fake provider plus fixtures
 *     for every prompt the planner emits — that's an integration
 *     fixture suite, not unit coverage. The pure helpers each phase
 *     needs (`buildAuthoringContext`, ticket validators, etc.) live
 *     in `lib/orchestration/plan-runner/*` and are unit-tested
 *     there.
 *
 * --- Story #1702 (Epic #1653) bounded-sweep additions ---
 *
 * The block below carves out top-30 floor-gap offenders from Story #1702
 * (see git history under `epic/1653` for the full inventory table). Each
 * entry meets one of the operator-approved criteria from Story #1702's
 * body: thin CLI shell, pure I/O glue, deprecation/one-shot script, or
 * unit-mock-only test surface. Per-file rationale lives in the
 * `node:coverage ignore file` pragma at the top of each source file;
 * aggregate categories:
 *
 *   Top-level CLI gates (lint/baselines gate and `/git-merge-pr` step
 *   gates):
 *     audit-orchestrator.js, lint-baseline.js, git-pr-quality-gate.js,
 *     validate-docs-freshness.js, detect-merges.js
 *
 *   Top-level orchestration CLIs (already pragma'd; promoted to the c8
 *   exclude list to keep `c8 report` and the per-file baseline in sync):
 *     story-close.js, story-init.js, story-deliver-prepare.js,
 *     story-task-progress.js, task-commit.js, run-audit-suite.js,
 *     post-structured-comment.js, hydrate-context.js, assert-branch.js,
 *     epic-deliver-runner.js, epic-deliver-prepare.js,
 *     epic-deliver-note-intervention.js, epic-deliver-automerge.js,
 *     epic-deliver-finalize.js, epic-deliver-cleanup.js, epic-close.js,
 *     epic-reconcile.js, epic-execute-record-wave.js, dispatcher.js,
 *     diagnose-friction.js, select-audits.js, run-tests.js, test-wrapper.js,
 *     notify.js, loc-delta.js
 *
 *   Git-manipulation CLIs (rebase + branch sweepers, integration-shaped):
 *     git-rebase-and-resolve.js, git-cleanup.js
 *
 *   Long-lived dev tools (one-shot watchers):
 *     quality-watch.js
 *
 *   lib/* carve-outs (data-as-code schemas and orchestration glue over
 *   live git/filesystem state where unit-mocking asserts only the mock
 *   structure):
 *     lib/config-schema.js, lib/config-settings-schema.js,
 *     lib/git-merge-orchestrator.js, lib/orchestration/epic-cleanup.js,
 *     lib/orchestration/epic-spec-reconciler-ops.js,
 *     lib/orchestration/story-close-recovery.js,
 *     lib/orchestration/epic-deliver-close-tail.js,
 *     lib/story-init/branch-initializer.js,
 *     lib/worktree/node-modules-strategy.js
 */

module.exports = {
  reporter: ['json', 'text'],
  include: ['.agents/scripts/**'],
  exclude: [
    // Pre-Story-#1702 baseline carve-outs.
    '.agents/scripts/agents-bootstrap-github.js',
    '.agents/scripts/context-hydrator.js',
    '.agents/scripts/epic-plan-decompose.js',
    '.agents/scripts/epic-plan-healthcheck.js',
    '.agents/scripts/epic-plan-spec.js',
    '.agents/scripts/epic-plan.js',
    '.agents/scripts/retrofit-task-bodies.js',

    // Story #1702 — top-level CLI gates and orchestrators.
    '.agents/scripts/assert-branch.js',
    '.agents/scripts/audit-orchestrator.js',
    '.agents/scripts/detect-merges.js',
    '.agents/scripts/diagnose-friction.js',
    '.agents/scripts/dispatcher.js',
    '.agents/scripts/epic-close.js',
    '.agents/scripts/epic-deliver-automerge.js',
    '.agents/scripts/epic-deliver-cleanup.js',
    '.agents/scripts/epic-deliver-finalize.js',
    '.agents/scripts/epic-deliver-note-intervention.js',
    '.agents/scripts/epic-deliver-prepare.js',
    '.agents/scripts/epic-deliver-runner.js',
    '.agents/scripts/epic-execute-record-wave.js',
    '.agents/scripts/epic-reconcile.js',
    '.agents/scripts/git-cleanup.js',
    '.agents/scripts/git-pr-quality-gate.js',
    '.agents/scripts/git-rebase-and-resolve.js',
    '.agents/scripts/hydrate-context.js',
    '.agents/scripts/lint-baseline.js',
    '.agents/scripts/loc-delta.js',
    '.agents/scripts/notify.js',
    '.agents/scripts/post-structured-comment.js',
    '.agents/scripts/quality-watch.js',
    '.agents/scripts/run-audit-suite.js',
    '.agents/scripts/run-tests.js',
    '.agents/scripts/select-audits.js',
    // single-story-close.js — Story #1827 brings this file back in scope.
    // The orchestration body is exercised through `runSingleStoryClose`
    // with an injected provider, fake gh runner, and in-memory worktree;
    // `ensurePullRequest` is exercised through `execFileSync` module mocks.
    '.agents/scripts/single-story-init.js',
    '.agents/scripts/story-close.js',
    '.agents/scripts/story-deliver-prepare.js',
    '.agents/scripts/story-init.js',
    '.agents/scripts/story-task-progress.js',
    '.agents/scripts/task-commit.js',
    '.agents/scripts/test-wrapper.js',
    '.agents/scripts/validate-docs-freshness.js',

    // Story #1702 — lib/* carve-outs (data-as-code + orchestration glue).
    '.agents/scripts/lib/config-schema.js',
    '.agents/scripts/lib/config-settings-schema.js',
    '.agents/scripts/lib/git-merge-orchestrator.js',
    '.agents/scripts/lib/orchestration/epic-cleanup.js',
    '.agents/scripts/lib/orchestration/epic-deliver-close-tail.js',
    '.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js',
    '.agents/scripts/lib/orchestration/story-close-recovery.js',
    '.agents/scripts/lib/story-init/branch-initializer.js',
    '.agents/scripts/lib/worktree/node-modules-strategy.js',
  ],
};
