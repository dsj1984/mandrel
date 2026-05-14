# Quality Floor Inventory — Post-Epic-#1653 Tree

Generated: 2026-05-14  
Source commit: `dda1bedf310a6a84440f26e391c24bbd64f9e5b7` (`epic/1653` HEAD at Story #1700 start)  
Scope: `.agents/scripts/` (all `*.js` recursive)

## Floors Used

| Signal | Floor | Source |
| --- | --- | --- |
| Coverage — lines | 90% | Aspirational target per Story #1700 brief |
| Coverage — branches | 85% | Aspirational target per Story #1700 brief |
| Coverage — functions | 90% | Aspirational target per Story #1700 brief |
| Maintainability Index (module) | ≥ 70 | Aspirational target per Story #1700 brief |
| CRAP (per method) | ≤ 20 | Aspirational target per Story #1700 brief |

> The floors above are the **inventory thresholds for this audit only**.
> They are intentionally stricter than the merge-gate floors in
> `.agentrc.json` (`qualityFloors`: coverage 40/40/0, MI 0, CRAP 30) so the
> downstream remediation Stories can target a sensible quality ceiling rather
> than just the regression-prevention minimum.

## Executive Summary

- **Files with coverage gaps** (any of lines<90, branches<85, functions<90): **155**
- **Files with MI < 70**: **6**
- **Methods with CRAP > 20**: **0**
- **Total `.agents/scripts/` JS files scanned (MI)**: **300**
- **Total coverage-baseline files**: **279**
- **Total CRAP rows scanned**: **1587**

## Cluster: `lib/ (root)`

Counts: coverage gaps **22** · MI<70 **2** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/git-merge-orchestrator.js` | 55.93% (Δ +34.07% to floor) | 66.67% (Δ +18.33% to floor) | 50.00% (Δ +40% to floor) |
| `.agents/scripts/lib/quality-floors.js` | 86.17% (Δ +3.83% to floor) | 79.09% (Δ +5.91% to floor) | 100.00% |
| `.agents/scripts/lib/crap-utils.js` | 87.62% (Δ +2.38% to floor) | 81.08% (Δ +3.92% to floor) | 100.00% |
| `.agents/scripts/lib/close-validation.js` | 89.54% (Δ +0.46% to floor) | 82.91% (Δ +2.09% to floor) | 77.27% (Δ +12.73% to floor) |
| `.agents/scripts/lib/CacheLayer.js` | 90.70% | 100.00% | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/lib/preflight-runner.js` | 91.33% | 58.82% (Δ +26.18% to floor) | 50.00% (Δ +40% to floor) |
| `.agents/scripts/lib/push-epic-retry.js` | 91.46% | 71.79% (Δ +13.21% to floor) | 83.33% (Δ +6.67% to floor) |
| `.agents/scripts/lib/maintainability-utils.js` | 92.33% | 81.25% (Δ +3.75% to floor) | 100.00% |
| `.agents/scripts/lib/maintainability-engine.js` | 92.68% | 72.50% (Δ +12.5% to floor) | 100.00% |
| `.agents/scripts/lib/worktree-manager.js` | 92.89% | 85.71% | 70.00% (Δ +20% to floor) |
| `.agents/scripts/lib/git-utils.js` | 95.26% | 75.41% (Δ +9.59% to floor) | 89.47% (Δ +0.53% to floor) |
| `.agents/scripts/lib/ITicketingProvider.js` | 95.99% | 100.00% | 69.57% (Δ +20.43% to floor) |
| `.agents/scripts/lib/coverage-capture.js` | 96.05% | 83.33% (Δ +1.67% to floor) | 100.00% |
| `.agents/scripts/lib/baseline-snapshot.js` | 96.97% | 75.64% (Δ +9.36% to floor) | 85.71% (Δ +4.29% to floor) |
| `.agents/scripts/lib/epic-merge-lock.js` | 97.22% | 78.00% (Δ +7% to floor) | 100.00% |
| `.agents/scripts/lib/gh-exec.js` | 97.57% | 92.86% | 80.00% (Δ +10% to floor) |
| `.agents/scripts/lib/plan-phase-cleanup.js` | 98.45% | 76.47% (Δ +8.53% to floor) | 100.00% |
| `.agents/scripts/lib/duplicate-search.js` | 99.47% | 83.33% (Δ +1.67% to floor) | 100.00% |
| `.agents/scripts/lib/baseline-loader.js` | 100.00% | 70.00% (Δ +15% to floor) | 100.00% |
| `.agents/scripts/lib/cli-utils.js` | 100.00% | 84.21% (Δ +0.79% to floor) | 100.00% |
| `.agents/scripts/lib/crap-engine.js` | 100.00% | 84.00% (Δ +1% to floor) | 100.00% |
| `.agents/scripts/lib/runtime-context.js` | 100.00% | 100.00% | 25.00% (Δ +65% to floor) |

### MI < 70 outliers

| File | Module MI |
| --- | --- |
| `.agents/scripts/lib/config-settings-schema.js` | 44.59 (Δ +25.41 to floor) |
| `.agents/scripts/lib/config-schema.js` | 59.46 (Δ +10.54 to floor) |

## Cluster: `lib/bootstrap`

Counts: coverage gaps **2** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/bootstrap/ci-workflow-template.js` | 100.00% | 66.67% (Δ +18.33% to floor) | 100.00% |
| `.agents/scripts/lib/bootstrap/hitl-confirm.js` | 100.00% | 63.16% (Δ +21.84% to floor) | 100.00% |

## Cluster: `lib/checks`

Counts: coverage gaps **7** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/checks/state.js` | 92.51% | 89.58% | 81.82% (Δ +8.18% to floor) |
| `.agents/scripts/lib/checks/index.js` | 96.25% | 75.47% (Δ +9.53% to floor) | 100.00% |
| `.agents/scripts/lib/checks/subagent-agent-tool-required.js` | 96.70% | 83.33% (Δ +1.67% to floor) | 100.00% |
| `.agents/scripts/lib/checks/baseline-drift-main-checkout.js` | 99.04% | 77.27% (Δ +7.73% to floor) | 100.00% |
| `.agents/scripts/lib/checks/core-bare-clean.js` | 100.00% | 80.00% (Δ +5% to floor) | 100.00% |
| `.agents/scripts/lib/checks/epic-merge-lock-stale.js` | 100.00% | 71.43% (Δ +13.57% to floor) | 100.00% |
| `.agents/scripts/lib/checks/worktree-residue-biome.js` | 100.00% | 80.00% (Δ +5% to floor) | 100.00% |

## Cluster: `lib/config`

Counts: coverage gaps **1** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/config/temp-paths.js` | 94.79% | 100.00% | 88.89% (Δ +1.11% to floor) |

## Cluster: `lib/gates`

Counts: coverage gaps **2** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/gates/friction.js` | 90.70% | 80.00% (Δ +5% to floor) | 100.00% |
| `.agents/scripts/lib/gates/baseline-store.js` | 96.23% | 78.26% (Δ +6.74% to floor) | 100.00% |

## Cluster: `lib/observability`

Counts: coverage gaps **3** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/observability/tool-trace-hook.js` | 89.14% (Δ +0.86% to floor) | 66.67% (Δ +18.33% to floor) | 88.89% (Δ +1.11% to floor) |
| `.agents/scripts/lib/observability/signals-writer.js` | 91.90% | 75.00% (Δ +10% to floor) | 83.33% (Δ +6.67% to floor) |
| `.agents/scripts/lib/observability/perf-aggregator.js` | 98.13% | 81.10% (Δ +3.9% to floor) | 100.00% |

## Cluster: `lib/orchestration`

Counts: coverage gaps **53** · MI<70 **3** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/orchestration/dispatch-engine.js` | 82.74% (Δ +7.26% to floor) | 76.92% (Δ +8.08% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/wave-dispatcher.js` | 83.95% (Δ +6.05% to floor) | 92.31% | 100.00% |
| `.agents/scripts/lib/orchestration/epic-deliver-close-tail.js` | 84.21% (Δ +5.79% to floor) | 64.58% (Δ +20.42% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close-recovery.js` | 84.60% (Δ +5.4% to floor) | 93.33% | 64.71% (Δ +25.29% to floor) |
| `.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js` | 85.88% (Δ +4.12% to floor) | 71.56% (Δ +13.44% to floor) | 78.57% (Δ +11.43% to floor) |
| `.agents/scripts/lib/orchestration/epic-runner/blocker-handler.js` | 88.07% (Δ +1.93% to floor) | 80.00% (Δ +5% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/phases/iterate-waves.js` | 88.32% (Δ +1.68% to floor) | 56.25% (Δ +28.75% to floor) | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/lib/orchestration/epic-runner/factory.js` | 89.01% (Δ +0.99% to floor) | 57.14% (Δ +27.86% to floor) | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/lib/orchestration/reconciler.js` | 89.06% (Δ +0.94% to floor) | 85.71% | 87.50% (Δ +2.5% to floor) |
| `.agents/scripts/lib/orchestration/ticket-validator-sizing.js` | 91.09% | 80.95% (Δ +4.05% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/story-run-progress-writer.js` | 91.56% | 76.19% (Δ +8.81% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/deliver-phases.js` | 91.67% | 71.43% (Δ +13.57% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/context-hydration-engine.js` | 91.69% | 62.96% (Δ +22.04% to floor) | 90.91% |
| `.agents/scripts/lib/orchestration/planning-state-manager.js` | 92.48% | 81.08% (Δ +3.92% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js` | 92.57% | 70.65% (Δ +14.35% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js` | 92.86% | 75.00% (Δ +10% to floor) | 90.91% |
| `.agents/scripts/lib/orchestration/epic-runner/wave-observer.js` | 92.90% | 80.39% (Δ +4.61% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/dependency-analyzer.js` | 94.85% | 80.00% (Δ +5% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/column-sync.js` | 95.53% | 82.22% (Δ +2.78% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/spec-renderer.js` | 95.67% | 82.93% (Δ +2.07% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/error-journal.js` | 95.68% | 84.62% (Δ +0.38% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/dispatch-pipeline.js` | 96.57% | 83.87% (Δ +1.13% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/retro-runner.js` | 96.58% | 70.00% (Δ +15% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/code-review.js` | 96.69% | 73.33% (Δ +11.67% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/cascade-grouping.js` | 96.73% | 95.35% | 75.00% (Δ +15% to floor) |
| `.agents/scripts/lib/orchestration/post-merge-pipeline.js` | 97.04% | 73.96% (Δ +11.04% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-spec-reverse-bootstrap.js` | 97.08% | 69.79% (Δ +15.21% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js` | 97.15% | 65.63% (Δ +19.37% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-format.js` | 97.39% | 80.49% (Δ +4.51% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/concurrent-task-resolver.js` | 97.74% | 80.49% (Δ +4.51% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/version-bump-intent.js` | 97.76% | 82.05% (Δ +2.95% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js` | 97.83% | 72.41% (Δ +12.59% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-cleanup.js` | 98.44% | 82.65% (Δ +2.35% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/close-inputs.js` | 98.59% | 83.33% (Δ +1.67% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/checkpointer.js` | 98.70% | 79.17% (Δ +5.83% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/planning-context-budget.js` | 99.06% | 84.75% (Δ +0.25% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-apply.js` | 99.31% | 83.20% (Δ +1.8% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/plan-runner/worktree-sweep.js` | 99.53% | 76.47% (Δ +8.53% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/progress-signals/crap-drift.js` | 99.58% | 76.92% (Δ +8.08% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner.js` | 100.00% | 50.00% (Δ +35% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js` | 100.00% | 75.00% (Δ +10% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/epic-runner/story-launcher.js` | 100.00% | 82.98% (Δ +2.02% to floor) | 80.00% (Δ +10% to floor) |
| `.agents/scripts/lib/orchestration/manifest-builder.js` | 100.00% | 71.43% (Δ +13.57% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/parked-follow-ons.js` | 100.00% | 80.95% (Δ +4.05% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/phase-runner.js` | 100.00% | 81.25% (Δ +3.75% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/plan-runner/plan-checkpointer.js` | 100.00% | 83.87% (Δ +1.13% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/baseline-attribution.js` | 100.00% | 83.33% (Δ +1.67% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/baseline-friction-body.js` | 100.00% | 84.62% (Δ +0.38% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/cleanup-reconciler.js` | 100.00% | 75.00% (Δ +10% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/format-autofix.js` | 100.00% | 76.47% (Δ +8.53% to floor) | 100.00% |
| `.agents/scripts/lib/orchestration/story-close/merge-runner.js` | 100.00% | 100.00% | 70.83% (Δ +19.17% to floor) |
| `.agents/scripts/lib/orchestration/story-close/pre-merge-validation.js` | 100.00% | 95.83% | 75.00% (Δ +15% to floor) |
| `.agents/scripts/lib/orchestration/task-fetcher.js` | 100.00% | 75.00% (Δ +10% to floor) | 100.00% |

### MI < 70 outliers

| File | Module MI |
| --- | --- |
| `.agents/scripts/lib/orchestration/epic-cleanup.js` | 0.00 (Δ +70 to floor) |
| `.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js` | 0.00 (Δ +70 to floor) |
| `.agents/scripts/lib/orchestration/epic-deliver-close-tail.js` | 67.92 (Δ +2.08 to floor) |

## Cluster: `lib/presentation`

Counts: coverage gaps **2** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/presentation/manifest-persistence.js` | 97.39% | 77.55% (Δ +7.45% to floor) | 100.00% |
| `.agents/scripts/lib/presentation/manifest-renderer.js` | 100.00% | 84.78% (Δ +0.22% to floor) | 100.00% |

## Cluster: `lib/signals`

Counts: coverage gaps **1** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/signals/span-tree.js` | 99.31% | 81.18% (Δ +3.82% to floor) | 100.00% |

## Cluster: `lib/story-init`

Counts: coverage gaps **3** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/story-init/branch-initializer.js` | 61.04% (Δ +28.96% to floor) | 78.38% (Δ +6.62% to floor) | 61.54% (Δ +28.46% to floor) |
| `.agents/scripts/lib/story-init/context-resolver.js` | 86.67% (Δ +3.33% to floor) | 72.73% (Δ +12.27% to floor) | 100.00% |
| `.agents/scripts/lib/story-init/dependency-guard.js` | 93.18% | 74.39% (Δ +10.61% to floor) | 100.00% |

## Cluster: `lib/templates`

Counts: coverage gaps **1** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/templates/task-body-renderer.js` | 100.00% | 80.00% (Δ +5% to floor) | 100.00% |

## Cluster: `lib/wave-runner`

Counts: coverage gaps **1** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/wave-runner/tick.js` | 95.74% | 83.49% (Δ +1.51% to floor) | 100.00% |

## Cluster: `lib/worktree`

Counts: coverage gaps **7** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/lib/worktree/node-modules-strategy.js` | 82.31% (Δ +7.69% to floor) | 87.27% | 87.50% (Δ +2.5% to floor) |
| `.agents/scripts/lib/worktree/lifecycle/creation.js` | 84.87% (Δ +5.13% to floor) | 83.33% (Δ +1.67% to floor) | 100.00% |
| `.agents/scripts/lib/worktree/bootstrapper.js` | 87.50% (Δ +2.5% to floor) | 82.67% (Δ +2.33% to floor) | 92.31% |
| `.agents/scripts/lib/worktree/lifecycle/force-drain.js` | 87.68% (Δ +2.32% to floor) | 85.25% | 60.00% (Δ +30% to floor) |
| `.agents/scripts/lib/worktree/lifecycle/reap.js` | 89.80% (Δ +0.2% to floor) | 74.25% (Δ +10.75% to floor) | 100.00% |
| `.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js` | 98.48% | 78.46% (Δ +6.54% to floor) | 100.00% |
| `.agents/scripts/lib/worktree/lifecycle/gc.js` | 100.00% | 81.25% (Δ +3.75% to floor) | 100.00% |

## Cluster: `providers`

Counts: coverage gaps **2** · MI<70 **0** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/providers/github/projects-v2-graphql.js` | 82.27% (Δ +7.73% to floor) | 82.18% (Δ +2.82% to floor) | 73.33% (Δ +16.67% to floor) |
| `.agents/scripts/providers/github.js` | 86.13% (Δ +3.87% to floor) | 72.37% (Δ +12.63% to floor) | 86.67% (Δ +3.33% to floor) |

## Cluster: `top-level scripts`

Counts: coverage gaps **48** · MI<70 **1** · CRAP>20 methods **0**

### Coverage gaps (any of lines<90, branches<85, functions<90)

| File | Lines % | Branches % | Functions % |
| --- | --- | --- | --- |
| `.agents/scripts/epic-deliver-runner.js` | 42.76% (Δ +47.24% to floor) | 42.86% (Δ +42.14% to floor) | 50.00% (Δ +40% to floor) |
| `.agents/scripts/audit-orchestrator.js` | 56.02% (Δ +33.98% to floor) | 93.94% | 71.43% (Δ +18.57% to floor) |
| `.agents/scripts/post-structured-comment.js` | 64.57% (Δ +25.43% to floor) | 100.00% | 50.00% (Δ +40% to floor) |
| `.agents/scripts/run-audit-suite.js` | 67.01% (Δ +22.99% to floor) | 100.00% | 0.00% (Δ +90% to floor) |
| `.agents/scripts/check-maintainability.js` | 67.67% (Δ +22.33% to floor) | 79.55% (Δ +5.45% to floor) | 60.00% (Δ +30% to floor) |
| `.agents/scripts/lint-baseline.js` | 70.54% (Δ +19.46% to floor) | 85.00% | 68.75% (Δ +21.25% to floor) |
| `.agents/scripts/assert-branch.js` | 71.08% (Δ +18.92% to floor) | 90.00% | 50.00% (Δ +40% to floor) |
| `.agents/scripts/story-close.js` | 71.86% (Δ +18.14% to floor) | 63.89% (Δ +21.11% to floor) | 57.14% (Δ +32.86% to floor) |
| `.agents/scripts/detect-merges.js` | 73.39% (Δ +16.61% to floor) | 88.89% | 80.00% (Δ +10% to floor) |
| `.agents/scripts/git-pr-quality-gate.js` | 73.53% (Δ +16.47% to floor) | 88.00% | 71.43% (Δ +18.57% to floor) |
| `.agents/scripts/noise-study.js` | 75.48% (Δ +14.52% to floor) | 88.68% | 61.54% (Δ +28.46% to floor) |
| `.agents/scripts/validate-docs-freshness.js` | 76.59% (Δ +13.41% to floor) | 94.29% | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/check-crap.js` | 80.62% (Δ +9.38% to floor) | 82.07% (Δ +2.93% to floor) | 70.37% (Δ +19.63% to floor) |
| `.agents/scripts/hydrate-context.js` | 81.01% (Δ +8.99% to floor) | 77.78% (Δ +7.22% to floor) | 60.00% (Δ +30% to floor) |
| `.agents/scripts/epic-deliver-note-intervention.js` | 81.12% (Δ +8.88% to floor) | 77.78% (Δ +7.22% to floor) | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/epic-deliver-prepare.js` | 81.76% (Δ +8.24% to floor) | 62.50% (Δ +22.5% to floor) | 50.00% (Δ +40% to floor) |
| `.agents/scripts/select-audits.js` | 82.14% (Δ +7.86% to floor) | 84.21% (Δ +0.79% to floor) | 33.33% (Δ +56.67% to floor) |
| `.agents/scripts/git-rebase-and-resolve.js` | 82.40% (Δ +7.6% to floor) | 78.38% (Δ +6.62% to floor) | 75.00% (Δ +15% to floor) |
| `.agents/scripts/git-cleanup-branches.js` | 83.07% (Δ +6.93% to floor) | 90.65% | 88.24% (Δ +1.76% to floor) |
| `.agents/scripts/story-execute-prepare.js` | 84.74% (Δ +5.26% to floor) | 60.42% (Δ +24.58% to floor) | 62.50% (Δ +27.5% to floor) |
| `.agents/scripts/epic-reconcile.js` | 86.34% (Δ +3.66% to floor) | 65.33% (Δ +19.67% to floor) | 58.33% (Δ +31.67% to floor) |
| `.agents/scripts/story-task-progress.js` | 86.35% (Δ +3.65% to floor) | 70.49% (Δ +14.51% to floor) | 60.00% (Δ +30% to floor) |
| `.agents/scripts/delete-epic-branches.js` | 86.43% (Δ +3.57% to floor) | 90.00% | 83.33% (Δ +6.67% to floor) |
| `.agents/scripts/story-init.js` | 86.80% (Δ +3.2% to floor) | 74.65% (Δ +10.35% to floor) | 72.73% (Δ +17.27% to floor) |
| `.agents/scripts/loc-delta.js` | 86.83% (Δ +3.17% to floor) | 66.67% (Δ +18.33% to floor) | 77.78% (Δ +12.22% to floor) |
| `.agents/scripts/epic-deliver-automerge.js` | 87.01% (Δ +2.99% to floor) | 82.86% (Δ +2.14% to floor) | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/test-wrapper.js` | 87.04% (Δ +2.96% to floor) | 100.00% | 20.00% (Δ +70% to floor) |
| `.agents/scripts/epic-execute-record-wave.js` | 87.21% (Δ +2.79% to floor) | 79.78% (Δ +5.22% to floor) | 84.62% (Δ +5.38% to floor) |
| `.agents/scripts/diagnose.js` | 87.31% (Δ +2.69% to floor) | 83.33% (Δ +1.67% to floor) | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/wave-gate.js` | 87.55% (Δ +2.45% to floor) | 80.36% (Δ +4.64% to floor) | 75.00% (Δ +15% to floor) |
| `.agents/scripts/render-manifest.js` | 87.94% (Δ +2.06% to floor) | 62.50% (Δ +22.5% to floor) | 75.00% (Δ +15% to floor) |
| `.agents/scripts/epic-deliver-finalize.js` | 88.37% (Δ +1.63% to floor) | 67.09% (Δ +17.91% to floor) | 81.82% (Δ +8.18% to floor) |
| `.agents/scripts/notify.js` | 89.44% (Δ +0.56% to floor) | 81.67% (Δ +3.33% to floor) | 83.33% (Δ +6.67% to floor) |
| `.agents/scripts/epic-plan-edit-flow.js` | 90.50% | 68.42% (Δ +16.58% to floor) | 50.00% (Δ +40% to floor) |
| `.agents/scripts/epic-close.js` | 90.76% | 80.00% (Δ +5% to floor) | 20.00% (Δ +70% to floor) |
| `.agents/scripts/diagnose-friction.js` | 91.58% | 77.55% (Δ +7.45% to floor) | 100.00% |
| `.agents/scripts/dispatcher.js` | 91.63% | 75.00% (Δ +10% to floor) | 90.91% |
| `.agents/scripts/epic-deliver-cleanup.js` | 92.24% | 89.47% | 83.33% (Δ +6.67% to floor) |
| `.agents/scripts/analyze-execution.js` | 92.82% | 64.71% (Δ +20.29% to floor) | 100.00% |
| `.agents/scripts/signals-view.js` | 92.90% | 73.12% (Δ +11.88% to floor) | 86.67% (Δ +3.33% to floor) |
| `.agents/scripts/hierarchy-gate.js` | 93.19% | 87.50% | 80.00% (Δ +10% to floor) |
| `.agents/scripts/sync-claude-commands.js` | 93.41% | 44.44% (Δ +40.56% to floor) | 100.00% |
| `.agents/scripts/quality-watch.js` | 94.12% | 70.37% (Δ +14.63% to floor) | 81.82% (Δ +8.18% to floor) |
| `.agents/scripts/task-commit.js` | 94.12% | 73.77% (Δ +11.23% to floor) | 85.71% (Δ +4.29% to floor) |
| `.agents/scripts/run-tests.js` | 96.30% | 60.00% (Δ +25% to floor) | 66.67% (Δ +23.33% to floor) |
| `.agents/scripts/epic-code-review.js` | 96.58% | 88.57% | 85.71% (Δ +4.29% to floor) |
| `.agents/scripts/quality-preview.js` | 96.81% | 71.43% (Δ +13.57% to floor) | 100.00% |
| `.agents/scripts/evidence-gate.js` | 97.87% | 85.71% | 80.00% (Δ +10% to floor) |

### MI < 70 outliers

| File | Module MI |
| --- | --- |
| `.agents/scripts/quality-watch.js` | 0.00 (Δ +70 to floor) |

## Methodology

- **MI scores** were computed live by invoking
  `.agents/scripts/lib/maintainability-engine.js#calculateReportForFile`
  over every `*.js` file under `.agents/scripts/` at the recorded source
  commit. The on-disk `baselines/maintainability.json` was bypassed because
  its keys are stale (`.worktrees/story-1665/...` prefixed) and cannot be
  matched against current paths.
- **Coverage rows** were read from `baselines/coverage.json`, which records
  `{lines, branches, functions}` per file from the last full coverage run.
- **CRAP rows** were read from `baselines/crap.json#rows`, which records
  `{file, method, startLine, crap}` per method.
- **Clustering** is by the first directory under `.agents/scripts/`. Files
  directly under `.agents/scripts/` are bucketed as `top-level scripts`;
  `lib/` is exploded one level deeper (`lib/orchestration`, `lib/audit-suite`,
  `lib/bootstrap`, `lib/checks`, `lib/config`, etc.) so each remediation
  Story has a believably-sized cluster to chew on.
- Each row carries its **current value** and the **delta to the floor**.
  Coverage deltas are percentage points; MI is a unit-less score; CRAP is
  cyclomatic-coverage product (lower is better).

## Out of Scope

- Files outside `.agents/scripts/` (e.g. `tests/`, `docs/`). The
  remediation Epic #1653 targets the dispatcher and its libraries; tests
  remain in scope only as collateral when a remediation Story refactors a
  caller.
- The merge-gate floors in `.agentrc.json#agentSettings.quality.qualityFloors`
  (coverage 40/40/0, MI 0, CRAP 30). Those guard against regression; this
  inventory targets the **aspirational** ceiling described in the Story
  brief.
