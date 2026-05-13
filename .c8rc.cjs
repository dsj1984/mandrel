/**
 * c8 configuration for `npm run test:coverage`.
 *
 * Source of truth for the coverage **scope** (include/exclude) and the
 * c8 reporters. The numeric coverage gate is no longer expressed here —
 * it lives per-file in [`baselines/coverage.json`](./baselines/coverage.json),
 * checked by `.agents/scripts/check-coverage-baseline.js` and updated
 * via `npm run coverage:update`. See [`docs/quality-gates.md`](./docs/quality-gates.md)
 * for the full ratchet workflow.
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
 */

module.exports = {
  reporter: ['json', 'text'],
  include: ['.agents/scripts/**'],
  exclude: [
    '.agents/scripts/agents-bootstrap-github.js',
    '.agents/scripts/context-hydrator.js',
    '.agents/scripts/epic-plan-decompose.js',
    '.agents/scripts/epic-plan-healthcheck.js',
    '.agents/scripts/epic-plan-spec.js',
    '.agents/scripts/epic-plan.js',
    '.agents/scripts/retrofit-task-bodies.js',
  ],
};
