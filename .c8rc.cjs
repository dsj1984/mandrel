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
 * ## One declaration, not two (Story #4922)
 *
 * This header used to restate the whole `exclude` inventory in prose, so
 * the scope was declared twice in one file and the two copies drifted.
 * The arrays below are now the **only** declaration; each entry carries
 * its rationale inline, where it cannot drift away from the path it
 * justifies. Do not reintroduce a prose inventory here.
 *
 * `include` mirrors `delivery.quality.gates.coverage.targetDirs` in
 * `.agentrc.json` — the gate scores what c8 measures, so the two must name
 * the same roots. `tests/c8rc-scope.test.js` asserts that correspondence.
 *
 * Every excluded file MUST also carry `/* node:coverage ignore file *​/` at
 * the top of its own source as a second line of defence; new exclusions add
 * that pragma at the same time as touching this list, or `c8 report` and the
 * baseline checker disagree on what is in scope.
 */

module.exports = {
  reporter: ['json', 'text'],
  // Story #4922 — score EVERY in-scope source file, not only the ones some
  // test happened to load. Without `all`, a module no test imports is absent
  // from `coverage-final.json` entirely, so it gets no baseline row, no floor,
  // and no way to regress: it reads as "not measured" where the honest
  // reading is 0 %. Four files sat in exactly that hole. This is what makes
  // "every in-scope source file has a row" a checkable invariant.
  all: true,
  // Coverage target roots — keep in lockstep with
  // `delivery.quality.gates.coverage.targetDirs` in `.agentrc.json`.
  include: ['.agents/scripts/**', 'bin/**', 'lib/**', 'scripts/**'],
  exclude: [
    // --- Colocated test sources (test code, not production source) ------
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

    // --- Thin CLI shells: argv-parse + delegate to a unit-tested lib/ ----
    // One-shot bootstrap CLI run once per consuming repo to seed labels,
    // project fields, and views from `lib/label-taxonomy.js`. The taxonomy
    // itself is unit-tested; the shell only argv-parses and calls a single
    // provider method loop. Real coverage requires a live GitHub repo,
    // which belongs in integration tests, not the unit-test gate.
    '.agents/scripts/agents-bootstrap-github.js',

    // --- Story #1702 bounded sweep: top-level CLI gates and orchestrators
    // Each entry below is a thin CLI shell, pure I/O glue, or a one-shot
    // dev tool whose meaningful logic lives in a unit-tested `lib/` module.
    // Friction-telemetry CLI: NDJSON append over a spawned child.
    '.agents/scripts/diagnose-friction.js',
    // Git-manipulation CLI (branch sweeper) — integration-shaped.
    '.agents/scripts/git-cleanup.js',
    // Temp-tree cleanup CLI; its engine is `lib/clean-temp.js`, unit-tested.
    '.agents/scripts/clean-temp.js',
    // Desktop/terminal notification glue — pure side effect.
    '.agents/scripts/notify.js',
    // Structured-comment CLI shell over the ticketing provider.
    'scripts/post-structured-comment.js',
    // Long-lived dev watcher (one-shot, interactive).
    '.agents/scripts/quality-watch.js',
    // Test-tier driver: spawns `node --test`; the tier logic it delegates
    // to lives in `lib/test-tiers.js` and is unit-tested there.
    '.agents/scripts/run-tests.js',
    // Story #1827 note: `single-story-close.js` is deliberately NOT
    // excluded — its orchestration body is exercised through
    // `runSingleStoryClose` with an injected provider, a fake gh runner,
    // and an in-memory worktree. Only the init shell stays out.
    '.agents/scripts/single-story-init.js',
    // Test harness wrapper — spawns the runner, no logic of its own.
    '.agents/scripts/test-wrapper.js',

    // --- Story #1702 lib/* carve-outs: data-as-code and process glue ----
    // Data-as-code JSON Schema literals — no branches to cover.
    '.agents/scripts/lib/config-schema.js',
    '.agents/scripts/lib/config-settings-schema.js',
    // Story #5109 — AJV's standalone emit for AGENTRC_SCHEMA. Every branch in
    // it was written by AJV's code generator from the schema literal above,
    // so a coverage figure over it measures the generator, not this
    // repository. `check-generated-validator.js --check` is what actually
    // guards the artifact, and the parity test in
    // tests/lib/gate-scan-fast-path.test.js pins its verdicts against a live
    // compile. The file carries the matching `node:coverage ignore file`
    // pragma at its top, emitted as part of the artifact.
    '.agents/scripts/lib/generated/**',
    // Orchestration glue over live filesystem/npm state; unit-mocking it
    // asserts only the mock's structure.
    '.agents/scripts/lib/worktree/node-modules-strategy.js',
  ],
};
