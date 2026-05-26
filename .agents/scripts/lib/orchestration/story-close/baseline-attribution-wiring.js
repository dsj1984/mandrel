/**
 * baseline-attribution-wiring.js — glue between the close-validation gate
 * chain and the diff-based attribution classifier (Story #1124).
 *
 * `runPreMergeGates` throws on the first failed gate but does not surface
 * regression rows. For baseline gates (`check-maintainability`, `check-crap`)
 * the post-#1120 contract is to:
 *
 *   1. Compute the regressions list ourselves (the pre-merge MI projection
 *      already knows how — Story #874).
 *   2. Compute the Story's diff vs `epic/<id>` so the classifier can split
 *      attributable from non-attributable rows.
 *   3. If every regression is attributable, refresh the kind's baseline via
 *      `refreshBaseline()` (Story #2197), stage the changed baseline file,
 *      and commit on the Story branch with a `chore(baselines): refresh
 *      <kind> for story-<id>` subject. The caller then re-runs the gate
 *      chain — drift is now committed, gate passes.
 *   4. If any regression is non-attributable, render the friction body
 *      (`renderBaselineFrictionBody`) and upsert it via
 *      `upsertStructuredComment`. Return a status that signals story-close
 *      to short-circuit with `{ status: 'blocked', phase: 'closing' }`.
 *
 * Story #2205 — refresh path now flows through `refreshBaseline()` from
 * `.agents/scripts/lib/baselines/refresh-service.js`. The `--amend` / `--allow-empty`
 * shortcuts and the legacy `npm run <kind>:update` shell-outs are gone.
 * Post-refresh hygiene is: stage the baseline file, run `git diff --cached
 * --exit-code`, and either skip (empty diff → log "no baseline drift to
 * fold in") or emit one canonical `chore(baselines): refresh <kind> for
 * story-<id>` commit. The retry loop is gated by an idempotency token
 * (`cycleState.refreshedKinds`) so a fail-then-pass sequence still emits
 * at most one baseline-refresh commit per close cycle (AC-9, #2176-fixture).
 *
 * Story #3002 — the module body was decomposed into
 * `./baseline-attribution/phases/` (one file per functional phase)
 * following the established pattern at `./phases/`, `../post-merge/phases/`,
 * and `../retro/phases/`. This file is now a thin re-export sequencer; the
 * phase implementations live under:
 *
 *   - phases/scope-discovery.js       — Story-diff scope + projection guard.
 *   - phases/regression-projection.js — per-gate regression projectors.
 *   - phases/refresh-commit.js        — in-process refresh + commit.
 *   - phases/gate-failure.js          — orchestrators (handleBaselineGateFailure,
 *                                       runPreMergeGatesWithAttribution).
 */

export {
  DEFAULT_GATE_REGISTRY,
  handleBaselineGateFailure,
  runPreMergeGatesWithAttribution,
} from './baseline-attribution/phases/gate-failure.js';
export {
  buildKindScorer,
  runRefreshCommit,
  stageAndCheckBaselineDrift,
} from './baseline-attribution/phases/refresh-commit.js';
export {
  diffCrapBaselines,
  PROJECTORS,
  projectCrapRegressions,
  projectRegressionsForGate,
} from './baseline-attribution/phases/regression-projection.js';
export {
  computeStoryDiffPaths,
  validateProjectionContext,
} from './baseline-attribution/phases/scope-discovery.js';

/**
 * Story #2165 — exit code surfaced when one of the baseline-refresh spawns
 * is killed by the bounded-timeout watchdog. Matches
 * `COVERAGE_TIMEOUT_EXIT_CODE` and the GNU `timeout(1)` convention so the
 * close orchestrator can branch on "refresh hung" (124) vs. "refresh
 * exited non-zero for some other reason" without inspecting signal names.
 *
 * Story #2205 — the gate-attribution refresh now uses the in-process
 * `refreshBaseline()` service and never spawns a child process, so this
 * timeout no longer fires from this module. Kept as an exported constant
 * for callers (and tests) that still reference the historical contract.
 */
export const REFRESH_TIMEOUT_EXIT_CODE = 124;
