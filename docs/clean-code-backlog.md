# Clean Code Backlog — Long-Tail Files Parked at Epic #1831 Close

This document parks the >500-LOC long-tail files that remained unrefactored
at the close of Epic #1831 ("Clean-code remediation — module bloat,
orchestrator throw rule, CRAP hotspots"). Each row records the current
loc, the maximum CRAP score of any tracked method, and the file-level
Maintainability Index (MI), all captured against the **Epic #1831 frozen
baseline** (`baselines/crap.json` and `baselines/maintainability.json`
on `epic/1831` after Wave-0 stories landed but before Story #1856 close).

The baseline reference point is the post-Wave-0 state of `epic/1831`;
the MI values were recorded with worktree-prefixed keys (e.g.,
`.worktrees/story-1851/.agents/scripts/<file>.js`) because the baseline
snapshot was generated from inside the Wave-0 implementation worktree.
Path columns below strip the worktree prefix and report the canonical
in-repo path.

## Backlog Rows

Stories 2–5 of Epic #1831 (Stories #1844, #1846, #1847, #1845, #1848,
#1849, #1850, #1851, #1852) extracted hotspots from a focused set of
files; the nine rows below are the remaining >500-LOC modules that were
deliberately deferred. Each is sized for a dedicated follow-up refactor.

| # | File | LOC | Max CRAP | MI | Proposed Split |
|---|---|---:|---:|---:|---|
| 1 | `.agents/scripts/check-crap.js` | 962 | n/a (no method above the CRAP tracking floor on `epic/1831`) | 86.12 | Split into a thin CLI shell (`check-crap.js`) plus `lib/crap/{cli-args.js, baseline-loader.js, report-printer.js, evaluator.js}` — current file mixes argv parsing, env override resolution, baseline I/O, regression evaluation, and console summary printing in one module. |
| 2 | `.agents/scripts/epic-plan-decompose.js` | 952 | n/a (no method above the CRAP tracking floor on `epic/1831`) | 88.86 | Split into `lib/epic-plan/{prompt-builder.js, context-builder.js, dependency-resolver.js, ticket-orderer.js}` plus a slim `epic-plan-decompose.js` orchestrator — prompt assembly, context hydration, dependency resolution, and topo-sort each deserve their own testable module. |
| 3 | `.agents/scripts/lib/orchestration/post-merge-pipeline.js` | 833 | 7.00 (`branchCleanupPhase`) | 86.82 | Split each post-merge phase into its own file under `lib/orchestration/post-merge/{worktree-reap.js, branch-cleanup.js, ticket-closure.js, notification.js, dashboard-refresh.js}` and keep `post-merge-pipeline.js` as a thin sequencer — phases already have clear seams. |
| 4 | `.agents/scripts/git-cleanup.js` | 775 | n/a (no method above the CRAP tracking floor on `epic/1831`) | 93.21 | Split into `lib/git-cleanup/{arg-parser.js, branch-enumeration.js, pr-probe.js, plan.js, execute.js}` plus a slim CLI driver — args, branch discovery, PR-state probing, plan generation, and side-effecting execution are independent concerns. |
| 5 | `.agents/scripts/lib/orchestration/epic-spec-reconciler-apply.js` | 767 | 14.00 (`apply`) | 92.34 | Split into `lib/orchestration/epic-spec-reconciler/{gates.js, slug-seeding.js, dry-run.js, footer-renderer.js, topo-create.js, applier.js}` — the `apply` orchestrator carries the highest CRAP in the file and would simplify substantially with the side-effecting steps extracted. |
| 6 | `.agents/scripts/analyze-execution.js` | 737 | 10.00 (`parseCli`) | 92.66 | Split into `lib/analyze-execution/{renderers/{story-body.js, epic-body.js, quality-gate-friction.js, baseline-refresh-rate.js}, readers/{phase-timings.js, gh-spawn-count.js, story-signals.js}}` and reduce `parseCli` complexity by table-driving the flag map. |
| 7 | `.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js` | 708 | 11.77 (`runRefreshCommit`) | 84.45 | Split into `lib/orchestration/story-close/baseline/{crap-projection.js, maintainability-projection.js, refresh-commit.js, gate-handlers.js}` — the four exported entry points already map to four clean modules, and `runRefreshCommit` would benefit from extracting its git/staging sub-steps. |
| 8 | `.agents/scripts/epic-code-review.js` | 673 | 7.16 (`maybeRecordLintEvidence`) | 87.18 | Split into `lib/epic-code-review/{lint-runner.js, file-classifier.js, evidence-recorder.js, severity-builder.js, report-renderer.js}` plus a slim CLI — lint execution, file classification, evidence I/O, and report rendering are independent. |
| 9 | `.agents/scripts/lib/gh-exec.js` | 531 | 8.03 (`api`) | 105.34 | Split the error-class taxonomy into `lib/gh-exec/errors.js`, the spawn-error classifier into `lib/gh-exec/classify.js`, and keep `gh-exec.js` as the public-facing `exec`/`createGh`/`gh` surface — MI is already > 100 but the file is two distinct concerns glued together. |

## Notes on "n/a" CRAP Values

Three files (`check-crap.js`, `epic-plan-decompose.js`,
`git-cleanup.js`) have no entries in `baselines/crap.json` on
`epic/1831`. This is not a measurement gap — the CRAP baseline already
includes methods scoring as low as 1.0, so the absence of rows means
every method in those files scored below the baseline's tracking floor.
These files are parked here on **size** alone (LOC > 500 + multiple
distinct responsibilities), not on hotspot-style complexity.

## Tracking & Follow-Up

Each parked file SHOULD be addressed by a dedicated Story in a future
clean-code Epic. The proposed splits above are deliberately one-line
sketches — the per-file Story decomposition will refine module
boundaries based on the actual usage graph at the time of the refactor.
Epic #1831's audit closure (Story #1856 → Task #1882) verifies that the
overall codebase maintainability rating moves from Medium to High once
these long-tail items are tracked rather than left undocumented.
