/**
 * c8 coverage configuration for `npm run test:coverage`.
 *
 * Single source of truth for the coverage scope, threshold gates, and
 * the exclude list. Documented from docs/quality-gates.md so operators
 * tracing a failed gate land here.
 *
 * Threshold gates: 85 % lines / 70 % branches / 75 % functions across
 * everything in `.agents/scripts/**`. Anything that lowers the gate is
 * a mainline policy change, not a tactical exclusion — reach for an
 * exclude only when the file genuinely cannot be unit-tested.
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
    '.agents/scripts/ticket-decomposer.js',
  ],
  lines: 85,
  branches: 70,
  functions: 75,
};
