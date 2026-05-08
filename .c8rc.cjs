/**
 * c8 coverage configuration for `npm run test:coverage`.
 *
 * Single source of truth for the coverage scope, threshold gates, and
 * the exclude list. Documented from docs/quality-gates.md so operators
 * tracing a failed gate land here.
 *
 * Threshold gates: 87 % lines / 80 % branches / 84 % functions across
 * everything in `.agents/scripts/**` minus the explicit `exclude` list
 * below. Anything that lowers the gate is a mainline policy change,
 * not a tactical exclusion — reach for an exclude only when the file
 * genuinely cannot be unit-tested.
 *
 * The thresholds are walked toward 90/90/90 incrementally as tests
 * land — each ratchet picks up the new floor that the suite produced
 * without changing scope. Bumping requires `npm run test:coverage`
 * staying green at the new numbers.
 *
 * The three entries below are excluded because they are thin CLI shells
 * over already-covered library code, and the meaningful logic lives in
 * the libs (which the threshold gate exercises). Each carries
 * `/* node:coverage ignore file *​/` at the top of the source as a
 * second line of defence.
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
 *   - ticket-decomposer.js — drives `/epic-plan` decomposition. As of
 *     v5.6 the host LLM authors the tickets directly; this CLI's two
 *     modes (`--emit-context` and the default validate-then-create)
 *     are integration-shaped (real PRD/Tech-Spec bodies, real Epic id,
 *     real provider). Validation logic is exercised by the planner
 *     tests under `tests/`; the CLI shell itself is not on a
 *     unit-test path.
 *   - epic-runner.js — top-level CLI shell with zero exports. All
 *     orchestration logic lives in `lib/orchestration/epic-runner/*`
 *     (factory, phases, progress-reporter, wave-scheduler, etc.) and
 *     is unit-tested there. The shell itself just argv-parses and
 *     hands off to `factory.create(...)`.
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
 * Files previously on this list that now sit inside the gate:
 *   - dispatcher.js, notify.js, providers/github.js — each has a
 *     dedicated test file (`tests/dispatcher.test.js`,
 *     `tests/notify.test.js`, `tests/providers-github*.test.js`),
 *     so they're now part of the threshold gate.
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
    '.agents/scripts/epic-runner.js',
    '.agents/scripts/retrofit-task-bodies.js',
    '.agents/scripts/ticket-decomposer.js',
  ],
  lines: 87,
  branches: 80,
  functions: 84,
};
