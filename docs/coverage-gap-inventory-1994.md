# Coverage Gap Inventory — Epic #1994 (Story #2031, Task #2046)

Generated from `baselines/coverage.json` against the framework
default floors (lines:90 / branches:85 / functions:90).

## Summary

- Total modules in baseline: **296**
- Sub-floor modules (any failing axis): **156**
- Disposition `lift-tests` (≤2pp gap on every failing axis): **13**
- Disposition `path-override` (larger gap or structural glue): **143**

Project rollup against framework default:

| Axis | Observed | Floor | Status |
| --- | ---: | ---: | --- |
| lines | 96.81 | 90 | PASS |
| branches | 86.39 | 85 | PASS |
| functions | 92.44 | 90 | PASS |

## Disposition rubric

- **lift-tests** — Worst failing-axis gap ≤ 2pp. A focused unit
  test or two will clear the floor; no per-path override needed.
  Task #2050 adds tests for these modules.
- **path-override** — Worst failing-axis gap > 2pp, or the file is
  structural glue (CLI shells, state machines, thin re-exports)
  where the framework floor is the wrong shape today. Task #2050
  adds a `floors.paths` entry per module with the observed score
  rounded down, citing follow-up issue **#2073**.
- **refactor** *(treated as `path-override` here)* — Modules that
  should ultimately be decomposed before tests are added. For Epic
  #1994 we override now and defer the refactor under the umbrella
  issue #2073 — no individual stub issues are filed.

## Cross-Epic dependency note

The current coverage gate (`check-baselines.js applyFloors`) only
enforces the project-wide `rollup["*"]` aggregate, not per-row
(per-file) percentages. Task #2051 audits this wiring against Epic
#1943 outcome and decides whether to thread `pathOverrides` into
the per-row coverage path on `check-baselines.js` or to leave it
as-is. The path-override entries from Task #2050 are recorded
regardless so the override surface is correct ahead of any wiring
change.

## orchestration (55)

| Path | Lines % | Branches % | Functions % | Disposition |
| --- | ---: | ---: | ---: | --- |
| `.agents/scripts/lib/orchestration/cascade-grouping.js` | 97.09 | 95.45 | 83.33 | path-override |
| `.agents/scripts/lib/orchestration/code-review.js` | 96.69 | 73.33 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/concurrent-task-resolver.js` | 97.74 | 80.49 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/context-hydration-engine.js` | 91.69 | 62.96 | 90.91 | path-override |
| `.agents/scripts/lib/orchestration/detectors-phase.js` | 97.24 | 81.82 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/dispatch-engine.js` | 82.74 | 85.71 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/dispatch-pipeline.js` | 96.57 | 83.87 | 100.00 | lift-tests |
| `.agents/scripts/lib/orchestration/doc-reader.js` | 92.05 | 83.33 | 100.00 | lift-tests |
| `.agents/scripts/lib/orchestration/epic-runner.js` | 100.00 | 50.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/blocker-handler.js` | 88.07 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/checkpointer.js` | 98.82 | 80.77 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/column-sync.js` | 95.53 | 82.22 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/deliver-phases.js` | 91.67 | 71.43 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/factory.js` | 89.01 | 50.00 | 66.67 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/hotspot-detection.js` | 95.41 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js` | 100.00 | 75.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/phases/iterate-waves.js` | 92.66 | 66.67 | 75.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js` | 89.31 | 77.48 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/progress-reporter/composition.js` | 99.14 | 78.79 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/progress-reporter/transport.js` | 98.66 | 74.63 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/progress-signals/crap-drift.js` | 99.33 | 77.27 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/progress-signals/maintainability-drift.js` | 98.91 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/story-launcher.js` | 100.00 | 82.98 | 80.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/story-run-progress-writer.js` | 91.56 | 76.19 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-runner/wave-observer.js` | 92.90 | 80.39 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-apply.js` | 99.22 | 84.40 | 100.00 | lift-tests |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js` | 99.03 | 78.65 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-format.js` | 97.39 | 80.95 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/epic-spec-reverse-bootstrap.js` | 97.08 | 69.79 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/error-journal.js` | 95.68 | 84.62 | 100.00 | lift-tests |
| `.agents/scripts/lib/orchestration/manifest-builder.js` | 100.00 | 71.43 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/parked-follow-ons.js` | 100.00 | 80.95 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/phase-runner.js` | 100.00 | 81.25 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/plan-runner/plan-checkpointer.js` | 98.92 | 79.31 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/plan-runner/worktree-sweep.js` | 99.53 | 76.47 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/planning-state-manager.js` | 92.48 | 81.08 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/post-merge-pipeline.js` | 97.12 | 73.94 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/reconciler.js` | 89.06 | 85.71 | 87.50 | path-override |
| `.agents/scripts/lib/orchestration/retro-runner.js` | 96.58 | 70.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/spec-renderer.js` | 95.67 | 82.93 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js` | 97.15 | 65.63 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js` | 86.53 | 73.98 | 81.25 | path-override |
| `.agents/scripts/lib/orchestration/story-close/baseline-attribution.js` | 100.00 | 83.33 | 100.00 | lift-tests |
| `.agents/scripts/lib/orchestration/story-close/baseline-friction-body.js` | 100.00 | 84.62 | 100.00 | lift-tests |
| `.agents/scripts/lib/orchestration/story-close/cleanup-reconciler.js` | 100.00 | 76.32 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/story-close/close-inputs.js` | 95.77 | 72.73 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/story-close/format-autofix.js` | 100.00 | 76.47 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/story-close/merge-runner.js` | 100.00 | 100.00 | 70.83 | path-override |
| `.agents/scripts/lib/orchestration/story-close/pre-merge-validation.js` | 100.00 | 95.83 | 75.00 | path-override |
| `.agents/scripts/lib/orchestration/task-fetcher.js` | 100.00 | 75.00 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/ticket-validator-sizing.js` | 91.09 | 80.95 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/ticketing.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/orchestration/ticketing/bulk.js` | 97.71 | 82.86 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/wave-dispatcher.js` | 87.35 | 87.50 | 100.00 | path-override |
| `.agents/scripts/lib/orchestration/wave-record-io.js` | 76.74 | 50.00 | 80.00 | path-override |

## baselines (10)

| Path | Lines % | Branches % | Functions % | Disposition |
| --- | ---: | ---: | ---: | --- |
| `.agents/scripts/lib/baselines/components.js` | 100.00 | 81.08 | 100.00 | path-override |
| `.agents/scripts/lib/baselines/kinds/bundle-size.js` | 83.93 | 50.00 | 100.00 | path-override |
| `.agents/scripts/lib/baselines/kinds/coverage.js` | 84.93 | 56.25 | 85.71 | path-override |
| `.agents/scripts/lib/baselines/kinds/crap.js` | 89.66 | 70.00 | 85.71 | path-override |
| `.agents/scripts/lib/baselines/kinds/lighthouse.js` | 81.58 | 41.18 | 85.71 | path-override |
| `.agents/scripts/lib/baselines/kinds/lint.js` | 100.00 | 55.00 | 100.00 | path-override |
| `.agents/scripts/lib/baselines/kinds/maintainability.js` | 89.71 | 80.00 | 85.71 | path-override |
| `.agents/scripts/lib/baselines/kinds/mutation.js` | 85.94 | 42.86 | 83.33 | path-override |
| `.agents/scripts/lib/baselines/reader.js` | 92.79 | 65.67 | 100.00 | path-override |
| `.agents/scripts/lib/baselines/writer.js` | 92.73 | 76.47 | 100.00 | path-override |

## lib (71)

| Path | Lines % | Branches % | Functions % | Disposition |
| --- | ---: | ---: | ---: | --- |
| `.agents/scripts/lib/audit-suite/findings.js` | 97.56 | 78.13 | 100.00 | path-override |
| `.agents/scripts/lib/audit-suite/index.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/baseline-loader.js` | 100.00 | 70.00 | 100.00 | path-override |
| `.agents/scripts/lib/baseline-snapshot.js` | 96.97 | 75.64 | 85.71 | path-override |
| `.agents/scripts/lib/bootstrap/ci-workflow-template.js` | 100.00 | 66.67 | 100.00 | path-override |
| `.agents/scripts/lib/bootstrap/hitl-confirm.js` | 100.00 | 63.16 | 100.00 | path-override |
| `.agents/scripts/lib/CacheLayer.js` | 90.70 | 100.00 | 66.67 | path-override |
| `.agents/scripts/lib/checks/baseline-drift-main-checkout.js` | 99.03 | 77.27 | 100.00 | path-override |
| `.agents/scripts/lib/checks/core-bare-clean.js` | 100.00 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/checks/epic-merge-lock-stale.js` | 100.00 | 71.43 | 100.00 | path-override |
| `.agents/scripts/lib/checks/index.js` | 96.25 | 73.08 | 100.00 | path-override |
| `.agents/scripts/lib/checks/state.js` | 92.81 | 90.48 | 83.33 | path-override |
| `.agents/scripts/lib/checks/subagent-agent-tool-required.js` | 96.70 | 79.49 | 100.00 | path-override |
| `.agents/scripts/lib/checks/worktree-residue-biome.js` | 100.00 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/close-validation.js` | 89.49 | 84.07 | 83.33 | path-override |
| `.agents/scripts/lib/close-validation/projections/maintainability.js` | 100.00 | 84.44 | 100.00 | lift-tests |
| `.agents/scripts/lib/config-gates-schema.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/config-schema-shared.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/config/baselines.js` | 82.81 | 91.67 | 66.67 | path-override |
| `.agents/scripts/lib/config/sync-agentrc.js` | 98.94 | 82.76 | 100.00 | path-override |
| `.agents/scripts/lib/config/temp-paths.js` | 94.95 | 100.00 | 88.89 | lift-tests |
| `.agents/scripts/lib/config/worktree-isolation.js` | 100.00 | 76.47 | 100.00 | path-override |
| `.agents/scripts/lib/coverage-capture.js` | 96.05 | 83.33 | 100.00 | lift-tests |
| `.agents/scripts/lib/crap-engine.js` | 100.00 | 84.00 | 100.00 | lift-tests |
| `.agents/scripts/lib/crap-utils.js` | 86.04 | 80.17 | 100.00 | path-override |
| `.agents/scripts/lib/duplicate-search.js` | 99.47 | 83.33 | 100.00 | lift-tests |
| `.agents/scripts/lib/epic-merge-lock.js` | 97.22 | 78.00 | 100.00 | path-override |
| `.agents/scripts/lib/error-redactor.js` | 100.00 | 81.58 | 100.00 | path-override |
| `.agents/scripts/lib/gates/baseline-store.js` | 96.23 | 78.26 | 100.00 | path-override |
| `.agents/scripts/lib/gates/friction.js` | 90.70 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/gh-exec.js` | 97.74 | 93.02 | 81.08 | path-override |
| `.agents/scripts/lib/git-utils.js` | 95.26 | 81.54 | 89.47 | path-override |
| `.agents/scripts/lib/git/cached-fetch.js` | 94.81 | 96.00 | 63.64 | path-override |
| `.agents/scripts/lib/install-cmd-parser.js` | 84.31 | 80.00 | 50.00 | path-override |
| `.agents/scripts/lib/ITicketingProvider.js` | 95.99 | 100.00 | 69.57 | path-override |
| `.agents/scripts/lib/label-constants.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/maintainability-engine.js` | 92.68 | 72.50 | 100.00 | path-override |
| `.agents/scripts/lib/maintainability-utils.js` | 92.95 | 82.61 | 100.00 | path-override |
| `.agents/scripts/lib/mutation/stryker-runner.js` | 97.71 | 81.25 | 100.00 | path-override |
| `.agents/scripts/lib/observability/perf-aggregator.js` | 98.28 | 82.44 | 100.00 | path-override |
| `.agents/scripts/lib/observability/signals-writer.js` | 91.90 | 75.00 | 83.33 | path-override |
| `.agents/scripts/lib/observability/tool-trace-hook.js` | 92.19 | 77.14 | 90.91 | path-override |
| `.agents/scripts/lib/plan-phase-cleanup.js` | 98.45 | 76.47 | 100.00 | path-override |
| `.agents/scripts/lib/preflight-runner.js` | 91.33 | 58.82 | 50.00 | path-override |
| `.agents/scripts/lib/presentation/manifest-formatter.js` | 89.66 | 83.33 | 100.00 | lift-tests |
| `.agents/scripts/lib/presentation/manifest-persistence.js` | 97.39 | 79.59 | 100.00 | path-override |
| `.agents/scripts/lib/presentation/manifest-renderer.js` | 100.00 | 84.78 | 100.00 | lift-tests |
| `.agents/scripts/lib/presentation/manifest-story-views.js` | 100.00 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/push-epic-retry.js` | 91.46 | 71.79 | 83.33 | path-override |
| `.agents/scripts/lib/quality-floors.js` | 87.61 | 80.17 | 100.00 | path-override |
| `.agents/scripts/lib/runtime-context.js` | 100.00 | 100.00 | 25.00 | path-override |
| `.agents/scripts/lib/signals/detectors/index.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/signals/detectors/retry.js` | 96.97 | 73.08 | 100.00 | path-override |
| `.agents/scripts/lib/signals/detectors/rework.js` | 94.84 | 75.00 | 100.00 | path-override |
| `.agents/scripts/lib/signals/index.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/signals/span-tree.js` | 99.31 | 81.18 | 100.00 | path-override |
| `.agents/scripts/lib/signals/write.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/single-story/story-merged-notify.js` | 100.00 | 78.95 | 100.00 | path-override |
| `.agents/scripts/lib/spec/index.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/story-init/context-resolver.js` | 86.67 | 72.73 | 100.00 | path-override |
| `.agents/scripts/lib/story-init/dependency-guard.js` | 93.18 | 74.39 | 100.00 | path-override |
| `.agents/scripts/lib/story-init/donor-precheck.js` | 89.86 | 78.79 | 85.71 | path-override |
| `.agents/scripts/lib/templates/task-body-renderer.js` | 100.00 | 80.00 | 100.00 | path-override |
| `.agents/scripts/lib/worktree-manager.js` | 92.55 | 83.33 | 70.00 | path-override |
| `.agents/scripts/lib/worktree/bootstrapper.js` | 87.50 | 82.67 | 92.31 | path-override |
| `.agents/scripts/lib/worktree/lifecycle-manager.js` | 100.00 | 100.00 | 0.00 | path-override |
| `.agents/scripts/lib/worktree/lifecycle/creation.js` | 84.87 | 83.33 | 100.00 | path-override |
| `.agents/scripts/lib/worktree/lifecycle/force-drain.js` | 87.68 | 83.61 | 60.00 | path-override |
| `.agents/scripts/lib/worktree/lifecycle/gc.js` | 100.00 | 81.25 | 100.00 | path-override |
| `.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js` | 98.48 | 78.46 | 100.00 | path-override |
| `.agents/scripts/lib/worktree/lifecycle/reap.js` | 90.97 | 75.17 | 100.00 | path-override |

## scripts (20)

| Path | Lines % | Branches % | Functions % | Disposition |
| --- | ---: | ---: | ---: | --- |
| `.agents/scripts/analyze-execution.js` | 91.32 | 62.24 | 100.00 | path-override |
| `.agents/scripts/check-baselines.js` | 83.62 | 65.52 | 72.73 | path-override |
| `.agents/scripts/check-dead-exports.js` | 89.64 | 83.93 | 81.82 | path-override |
| `.agents/scripts/check-mutation.js` | 93.58 | 81.43 | 85.71 | path-override |
| `.agents/scripts/delete-epic-branches.js` | 86.74 | 90.00 | 83.33 | path-override |
| `.agents/scripts/diagnose.js` | 92.83 | 86.05 | 71.43 | path-override |
| `.agents/scripts/epic-code-review.js` | 96.58 | 88.57 | 85.71 | path-override |
| `.agents/scripts/epic-plan-edit-flow.js` | 90.50 | 68.42 | 50.00 | path-override |
| `.agents/scripts/evidence-gate.js` | 97.87 | 85.71 | 80.00 | path-override |
| `.agents/scripts/hierarchy-gate.js` | 93.19 | 87.50 | 80.00 | path-override |
| `.agents/scripts/pr-watch-with-update.js` | 82.21 | 91.57 | 55.56 | path-override |
| `.agents/scripts/providers/github.js` | 84.84 | 67.09 | 82.00 | path-override |
| `.agents/scripts/providers/github/projects-v2-graphql.js` | 82.27 | 82.18 | 73.33 | path-override |
| `.agents/scripts/quality-preview.js` | 96.81 | 71.43 | 100.00 | path-override |
| `.agents/scripts/render-manifest.js` | 87.94 | 62.50 | 75.00 | path-override |
| `.agents/scripts/signals-view.js` | 92.90 | 73.12 | 86.67 | path-override |
| `.agents/scripts/single-story-close.js` | 94.44 | 61.04 | 50.00 | path-override |
| `.agents/scripts/sync-claude-commands.js` | 93.41 | 44.44 | 100.00 | path-override |
| `.agents/scripts/update-maintainability-baseline.js` | 96.30 | 75.00 | 100.00 | path-override |
| `.agents/scripts/wave-gate.js` | 87.55 | 80.36 | 75.00 | path-override |
