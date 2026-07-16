/**
 * c8 configuration for `npm run test:coverage`.
 *
 * Source of truth for the coverage **scope** (include/exclude) and the
 * c8 reporters. The numeric coverage gate is no longer expressed here —
 * it lives per-file in [`baselines/coverage.json`](./baselines/coverage.json),
 * checked by `.agents/scripts/check-baselines.js` (coverage kind) and
 * updated via `npm run coverage:update`. See
 * [`.agents/docs/quality-gates.md`](./.agents/docs/quality-gates.md) for the full ratchet
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
 *
 * --- Story #1702 (Epic #1653) bounded-sweep additions ---
 *
 * The block below carves out floor-gap offenders from Story #1702 (see
 * git history under `epic/1653` for the full inventory table; the v2
 * Story-only cutover deleted many of the original entries). Each entry
 * meets one of the operator-approved criteria from Story #1702's body:
 * thin CLI shell, pure I/O glue, deprecation/one-shot script, or
 * unit-mock-only test surface. Per-file rationale lives in the
 * `node:coverage ignore file` pragma at the top of each source file;
 * aggregate categories:
 *
 *   Top-level CLI gates (lint/baselines gate):
 *     lint-baseline.js, validate-docs-freshness.js
 *
 *   Top-level orchestration CLIs (already pragma'd; promoted to the c8
 *   exclude list to keep `c8 report` and the per-file baseline in sync):
 *     single-story-init.js, post-structured-comment.js,
 *     diagnose-friction.js, run-tests.js, test-wrapper.js, notify.js
 *
 *   Git-manipulation CLIs (branch sweepers, integration-shaped):
 *     git-cleanup.js
 *
 *   Long-lived dev tools (one-shot watchers):
 *     quality-watch.js
 *
 *   lib/* carve-outs (data-as-code schemas and orchestration glue over
 *   live git/filesystem state where unit-mocking asserts only the mock
 *   structure):
 *     lib/config-schema.js, lib/config-settings-schema.js,
 *     lib/worktree/node-modules-strategy.js
 */

module.exports = {
  reporter: ['json', 'text'],
  include: ['.agents/scripts/**', 'bin/**', 'lib/**'],
  exclude: [
    // Story #4125 — colocated test files under lib/ are test sources, not
    // production sources. Excluding them keeps `c8 report` and the
    // per-file coverage baseline from scoring test code as instrumented
    // source.
    'lib/**/__tests__/**',
    // Story #4195 — orchestration-engine modules under .agents/scripts may
    // colocate tests in __tests__ directories too. They are caught by the
    // `.agents/scripts/**` include above, so exclude them here (and from the
    // maintainability / crap / duplication ignoreGlobs in .agentrc.json) so
    // test code is never scored as instrumented production source.
    '.agents/scripts/**/__tests__/**',

    // Pre-Story-#1702 baseline carve-outs.
    '.agents/scripts/agents-bootstrap-github.js',
    // Story #1702 — top-level CLI gates and orchestrators.
    '.agents/scripts/diagnose-friction.js',
    '.agents/scripts/git-cleanup.js',
    '.agents/scripts/lint-baseline.js',
    '.agents/scripts/notify.js',
    '.agents/scripts/post-structured-comment.js',
    '.agents/scripts/quality-watch.js',
    '.agents/scripts/run-tests.js',
    // single-story-close.js — Story #1827 brings this file back in scope.
    // The orchestration body is exercised through `runSingleStoryClose`
    // with an injected provider, fake gh runner, and in-memory worktree;
    // `ensurePullRequest` is exercised through `execFileSync` module mocks.
    '.agents/scripts/single-story-init.js',
    '.agents/scripts/test-wrapper.js',
    '.agents/scripts/validate-docs-freshness.js',

    // Story #1702 — lib/* carve-outs (data-as-code + orchestration glue).
    '.agents/scripts/lib/config-schema.js',
    '.agents/scripts/lib/config-settings-schema.js',
    '.agents/scripts/lib/worktree/node-modules-strategy.js',
  ],
};
