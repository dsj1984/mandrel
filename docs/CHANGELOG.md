# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Removed — Epic #2586: retire `/audit-fan-out` workflow

The broken parallel fan-out orchestrator `/audit-fan-out` is retired. Its
workflow source (`.agents/workflows/audit-fan-out.md`) and the generated
slash-command mirror (`.claude/commands/audit-fan-out.md`) are deleted, and a
reappearance smoke test (`tests/audit-suite/audit-fan-out-retirement.test.js`)
guards against accidental restoration. Closes Epic #2586 (Stories #2595, #2602
follow-up).

- Operators that previously invoked `/audit-fan-out` should run the
  individual `/audit-<dimension>` workflows directly, or use `/audit-to-stories`
  for end-to-end audit-to-backlog routing. A future adaptive audit
  orchestrator (per `docs/future-considerations.md` § 8) may replace the
  retired fan-out surface.

### Changed — Story #2202: `update-maintainability-baseline.js` defaults to diff-scope

The manual maintainability-baseline refresh CLI
(`.agents/scripts/update-maintainability-baseline.js`) is now a thin wrapper
around `refreshBaseline({ kind: 'maintainability' })` from
`lib/baselines/refresh-service.js`, and its **default behaviour changed**.
Closes #2202 (Epic #2173).

- **`feat(baselines): flag-omission defaults to diff-scope; --full-scope is the opt-out`** —
  invoking the CLI with no flags previously rewrote the entire baseline
  envelope from a full target-tree walk. It now narrows the refresh to
  files changed since `origin/main` (via the service's
  `baseRef..headRef` diff derivation) and preserves out-of-scope rows
  byte-for-byte from the prior on-disk baseline. Operators who relied on
  the legacy "rewrite everything" semantics must pass the new
  `--full-scope` flag. `--diff-scope <ref>` continues to accept an
  explicit base ref. The two scope flags are mutually exclusive and the
  CLI fails fast when both are supplied. This is a deliberate breaking
  CLI behaviour change — local automations that pipe through the manual
  CLI should add `--full-scope` if they expect the prior full-rewrite
  semantics.
- **`refactor(baselines): make update-maintainability-baseline.js a refreshBaseline wrapper`** —
  the CLI no longer drives `writer.write` / `writeFile` /
  `buildWriterScopeArgs` directly; scoring is injected as a scorer
  function and the service owns scope resolution, envelope assembly,
  out-of-scope merging, epsilon application, and atomic persistence.
  The `refresh-service` invariant test (Task #2208) is updated to drop
  the maintainability CLI from the migration allowlist so any future
  regression that bypasses the service fails the static guard.

### Changed — Story #2171: rename `/story-execute` → `/story-deliver` (hard cutover)

Mirror the epic-side naming (`/epic-deliver`) on the story-side workflows.
Closes #2171.

- **`refactor: rename story workflows to deliver`** — the user-facing slash
  commands `/story-execute` and `/single-story-execute` are renamed to
  `/story-deliver` and `/single-story-deliver`. The backing workflow files
  move from `.agents/workflows/story-execute.md` and
  `.agents/workflows/single-story-execute.md` to
  `story-deliver.md` and `single-story-deliver.md`. The internal helper
  script `.agents/scripts/story-execute-prepare.js` is renamed to
  `story-deliver-prepare.js` (exported `runStoryDeliverPrepare`) and the
  test directory `tests/story-execute/` is renamed to `tests/story-deliver/`.
  All in-repo cross-references, log strings, and baselines are updated to
  the new names; `.claude/commands/` is regenerated via `npm run sync:commands`.
- **No backward-compat aliases.** This is a hard cutover — consumers update
  on the next `dist` sync. The pre-v6 archive (`docs/archive/CHANGELOG-pre-v6.md`)
  and the v6.1.0 snapshot doc (`docs/quality-floor-inventory-v6-1-0.md`) are
  preserved verbatim as historical record.

### Added — Story #2128: `/epic-plan` Phase 6 Epic Clarity Gate

- **`feat(epic-plan): add Phase 6 Epic Clarity Gate`** — every
  existing-Epic `/epic-plan` invocation now scores the Epic body against
  the five canonical sections from
  `.agents/templates/epic-from-idea.md` (Problem, Direction, Assumptions,
  MVP Scope, Not Doing). Rubric threshold is **4 of 5 sections present
  → `clear`**; below that, the gate seeds the `core/idea-refinement`
  skill from the current Epic body, surfaces a HITL diff, and on
  approval persists the sharpened body via `gh issue edit` before
  Phase 7 PRD / Tech Spec / Acceptance Spec authoring begins. Scoring
  lives in `.agents/scripts/lib/epic-plan-clarity.js` (pure rubric);
  the CLI is `.agents/scripts/epic-plan-clarity.js` (two modes:
  `--emit-context` read-only, and `--updated-body` idempotent persist
  with a `clarity-gate-update` audit comment).
- **`refactor(epic-plan): renumber phases to linear 1..11`** — the
  ideation block (`0a/0b/0c/0d`), the always-on Phase `0`, and the
  PRD/Decompose/Roadmap/Healthcheck/Notify phases (`1..5`) are
  renumbered into a single linear sequence so the new clarity gate fits
  as Phase 6 without fractional suffixes. No CLI flag carries a phase
  number — only docs, log lines, and inline comments change. Operator
  muscle memory is the only break; the workflow contract is unchanged.

### Fixed — Story #2125: framework-default floors actually apply

Closes the absolute-floor gap that Story #2119 surfaced when it drained the
`floors.paths` overrides Epic #1994 had baked into `.agentrc.json`. The
framework defaults (coverage `lines: 90 / branches: 85 / functions: 90`,
maintainability `≥ 70`, CRAP `≤ 20`) were declared in
`lib/config/quality.js` but never propagated into the `gates.<kind>.floors`
block that `check-baselines.js` reads — Epic #1994 hid the gap by writing
explicit `'*'` floors into `.agentrc.json`, and Story #2119 exposed it by
draining those entries.

- **Resolver fix.** `resolveQuality` now merges framework-default floors
  into `gates.<kind>.floors` for each declared kind (coverage, crap,
  maintainability). Consumer `.agentrc.json` can carry `floors: {}` (or
  omit the key entirely on a declared gate) and still get the framework
  default at runtime. Kinds the consumer never declared are left absent;
  the dispatcher's "omitted gate is a disabled gate" contract is preserved.
- **Consumer override semantics unchanged.** A consumer-supplied
  `floors: { "*": { lines: 80 } }` still wins; defaults supply any
  workspace key the consumer didn't override.

### Removed — Story #2125: dead per-row floor machinery

Story #2119 verified that the per-row `floors.paths` enforcement path was
decorative across all three gates — the unified `check-baselines.js`
dispatcher (Epic #1943) only enforces project-wide rollup floors, and the
per-kind CLIs that did honor per-row overrides were retired when the gate
consolidated. With #2119 having drained every override, the machinery is
unreachable. This release removes it:

- Deleted `.agents/scripts/lib/quality-floors.js` (689 LOC).
- Removed `enforceCrapFloor`, `enforceMaintainabilityFloor`, and the
  associated `logActivePathOverrides` helpers from
  `.agents/scripts/lib/baselines/kinds/{crap,maintainability}.js`.
- Removed the `paths` slot and its `PATH_OVERRIDE_ENTRY` schema fragment
  from the gates floor schema in both `lib/config-gates-schema.js` and
  `.agents/schemas/agentrc.schema.json`. A consumer config still carrying
  a `floors.paths` bag will now fail config validation with a clear
  schema error.
- Removed three dead test files:
  `tests/absolute-floor-gate-rejects-subfloor.test.js`,
  `tests/baselines/kinds/path-override-pass-log.test.js`,
  `tests/lib/quality-floors.test.js` (~920 LOC).

Net: ~1,610 LOC of source + tests removed; no behavioural change to the
unified gate (per-row enforcement was never active under #1943).

### Changed — Epic #1994 finalize: quality-floor restoration

Restored framework-default quality floors across all three governance gates,
with per-path overrides tracked against follow-up issues. This closes the
guardrail-drift remediation tracked under Epic #1994.

- **Coverage gate restored** to the framework default
  (`lines: 90 / branches: 85 / functions: 90`).
- **CRAP gate restored** to the framework default (`crap: 20`).
- **Maintainability gate restored** to the framework default
  (`maintainability: 70`).
- **targetDirs decision (Task #2054):** kept `crap.targetDirs` and
  `maintainability.targetDirs` overrides in `.agentrc.json` pointing at
  `.agents/scripts` (and `tests/` for maintainability). The Mandrel
  repository's executable code lives there, not under `src/`. Rationale is
  now captured in `.agents/schemas/agentrc.schema.json` as a description on
  each `targetDirs` property. Adopted **document-and-keep** rather than the
  alternate **layout-discovery** path (auto-fall back to `.agents/scripts`
  when `src/` is absent), because layout-discovery would be a framework
  change wider in scope than this Epic.
- **Working artefact removed:** deleted
  `docs/coverage-gap-inventory-1994.md`, the working spreadsheet used by
  Story #2031 to plan per-path coverage overrides. The inventory's content
  is now reflected by the `coverage.floors.paths` block in `.agentrc.json`
  itself.

#### Active per-path overrides at finalize

Every entry below is a documented, dated deviation from the restored
framework default, paired with the follow-up issue that owns its eventual
restoration.

##### coverage.floors.paths (156 entries)

- 153 overrides cite **follow-up #2073** (broad coverage-restoration work).
- 2 overrides cite **follow-up #2072** (CRAP-restoration work — co-scoped
  via the cross-gate follow_up agreement):
  `.agents/scripts/check-dead-exports.js`,
  `.agents/scripts/lib/baselines/kinds/crap.js`.
- 1 override cites **follow-up #2071** (maintainability-restoration work —
  co-scoped via the cross-gate follow_up agreement):
  `.agents/scripts/lib/config-gates-schema.js`.

##### crap.floors.paths (4 entries, all → follow-up #2072)

- `.agents/scripts/lib/baselines/preview-gates.js` (`crap: 130`)
- `.agents/scripts/lib/baselines/kinds/crap.js` (`crap: 55`)
- `.agents/scripts/check-dead-exports.js` (`crap: 30`)
- `.agents/scripts/lib/gates/gate-cli.js` (`crap: 27`)

##### maintainability.floors.paths (5 entries)

- → follow-up **#2070** (legacy hotspots scheduled for refactor):
  - `.agents/scripts/lib/orchestration/epic-cleanup.js` (`mi: 0`)
  - `.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js`
    (`mi: 0`)
  - `.agents/scripts/quality-watch.js` (`mi: 0`)
- → follow-up **#2071** (schema-module maintainability uplift):
  - `.agents/scripts/lib/config-settings-schema.js` (`mi: 46`)
  - `.agents/scripts/lib/config-gates-schema.js` (`mi: 51`)
## [1.26.0](https://github.com/dsj1984/mandrel/compare/v1.25.0...v1.26.0) (2026-05-20)


### Added

* **architecture:** cleanup shims, adapters, and enums (closes [#2646](https://github.com/dsj1984/mandrel/issues/2646)) ([#2712](https://github.com/dsj1984/mandrel/issues/2712)) ([8993bad](https://github.com/dsj1984/mandrel/commit/8993bad5085c02e39fce0fbd0dd6c440eba2e7c5))
* **audit-architecture:** add Automated Architecture Guardrails dimension ([#2734](https://github.com/dsj1984/mandrel/issues/2734)) ([184574d](https://github.com/dsj1984/mandrel/commit/184574d65bdaba1ebed54a68cda5d0cdee50d823)), closes [#2713](https://github.com/dsj1984/mandrel/issues/2713)
* **orchestration:** propagate ticket state upward on every transition ([#2677](https://github.com/dsj1984/mandrel/issues/2677)) ([29a036d](https://github.com/dsj1984/mandrel/commit/29a036deea739a0ec7abd39ba8e76dc2ebeb8d5b)), closes [#2676](https://github.com/dsj1984/mandrel/issues/2676)


### Fixed

* **lifecycle:** close-tail completeness — audit-results marker, epic.merge.* schemas, Phase 7 doc-truth ([#2710](https://github.com/dsj1984/mandrel/issues/2710)) ([41c4c84](https://github.com/dsj1984/mandrel/commit/41c4c84ec272f501f3d6e30df6ecb71a0d8357e1)), closes [#2681](https://github.com/dsj1984/mandrel/issues/2681)
* **single-story-deliver:** route label flips through transitionTicketState so Projects v2 Status syncs ([#2739](https://github.com/dsj1984/mandrel/issues/2739)) ([5f4e6e2](https://github.com/dsj1984/mandrel/commit/5f4e6e291f89f7f4353b6a72d57f173982b25c75)), closes [#2717](https://github.com/dsj1984/mandrel/issues/2717)

## [1.25.0](https://github.com/dsj1984/mandrel/compare/v1.24.0...v1.25.0) (2026-05-19)


### Added

* **epic-plan:** cross-reference ACs against existing BDD scenarios ([#2642](https://github.com/dsj1984/mandrel/issues/2642)) ([de68d65](https://github.com/dsj1984/mandrel/commit/de68d65e7c392f07fb5eeb9b207b061c5bea8f6d)), closes [#2637](https://github.com/dsj1984/mandrel/issues/2637)
* **epic-plan:** cross-validate Tech Spec against codebase in Phase 7 ([#2638](https://github.com/dsj1984/mandrel/issues/2638)) ([aec99d1](https://github.com/dsj1984/mandrel/commit/aec99d1ccb216104a216bf6386c39a2eb64ba3bd)), closes [#2635](https://github.com/dsj1984/mandrel/issues/2635)
* **epic-plan:** require explicit filesAssumption on Task paths ([#2639](https://github.com/dsj1984/mandrel/issues/2639)) ([fda76f2](https://github.com/dsj1984/mandrel/commit/fda76f2166f7096f31f92d3c45de2751b2fb92ec)), closes [#2636](https://github.com/dsj1984/mandrel/issues/2636)


### Fixed

* **column-sync:** look up project item by issue, not by paginated board scan ([#2633](https://github.com/dsj1984/mandrel/issues/2633)) ([bc6b6e4](https://github.com/dsj1984/mandrel/commit/bc6b6e4b2e1cf736cc65b6c67b022a3fa04146fa)), closes [#2632](https://github.com/dsj1984/mandrel/issues/2632)


### Changed

* **model-selection:** resolve daylight between schema, code, and docs ([#2630](https://github.com/dsj1984/mandrel/issues/2630)) ([d1f1eaf](https://github.com/dsj1984/mandrel/commit/d1f1eaff693528d1f8223f5ff555ea18c6494615)), closes [#2590](https://github.com/dsj1984/mandrel/issues/2590)

## [1.24.0](https://github.com/dsj1984/mandrel/compare/v1.23.0...v1.24.0) (2026-05-19)


### Added

* **close:** sync story/epic branch from base before PR open ([#2581](https://github.com/dsj1984/mandrel/issues/2581)) ([1026c86](https://github.com/dsj1984/mandrel/commit/1026c86759de7f1319c2d173773cb35fedbe4da6)), closes [#2580](https://github.com/dsj1984/mandrel/issues/2580)
* **workflows:** add /audit-to-stories — convert audit MD findings into actionable GitHub Stories ([#2583](https://github.com/dsj1984/mandrel/issues/2583)) ([#2585](https://github.com/dsj1984/mandrel/issues/2585)) ([e4ab422](https://github.com/dsj1984/mandrel/commit/e4ab4227c84b825f259b8682c95a285baafe08b3))

## [1.23.0](https://github.com/dsj1984/mandrel/compare/v1.22.0...v1.23.0) (2026-05-19)


### Added

* **column-sync:** wire Projects v2 Status sync into transitionTicketState (resolves [#2548](https://github.com/dsj1984/mandrel/issues/2548)) ([#2575](https://github.com/dsj1984/mandrel/issues/2575)) ([5457ca7](https://github.com/dsj1984/mandrel/commit/5457ca7c39a31d8c6d9a80091597364c893785cb))


### Fixed

* **baselines/writer:** project legacy prior rows through projectRow at writer entry ([#2578](https://github.com/dsj1984/mandrel/issues/2578)) ([a106457](https://github.com/dsj1984/mandrel/commit/a1064577334a0cc4a901500f7888dd18b9fb6e29)), closes [#2574](https://github.com/dsj1984/mandrel/issues/2574)
* **baselines:** ship refresh-service.js inside .agents/ bundle ([#2579](https://github.com/dsj1984/mandrel/issues/2579)) ([e27c109](https://github.com/dsj1984/mandrel/commit/e27c109597485301f9f7d6597c8e5e81b725c8a2)), closes [#2572](https://github.com/dsj1984/mandrel/issues/2572)
* **full-agentrc:** correct floor axis keys to match v2 envelopes ([#2577](https://github.com/dsj1984/mandrel/issues/2577)) ([bdb90d7](https://github.com/dsj1984/mandrel/commit/bdb90d781c3d4658fe6f720a208db328b5aa5a17)), closes [#2573](https://github.com/dsj1984/mandrel/issues/2573)

## [1.22.0](https://github.com/dsj1984/mandrel/compare/v1.21.0...v1.22.0) (2026-05-18)


### Fixed

* **git-cleanup:** correct merged-PR signal and guard DEP0190 stderr ([#2498](https://github.com/dsj1984/mandrel/issues/2498)) ([8fe3ea0](https://github.com/dsj1984/mandrel/commit/8fe3ea063ea2aa1c495731e1d3dabe94e5c51363))


### Changed

* **audit-suite:** centralize audit artifacts under {tempRoot}/audits ([#2452](https://github.com/dsj1984/mandrel/issues/2452)) ([1eff6c4](https://github.com/dsj1984/mandrel/commit/1eff6c48e1da0f8828016d30db8c4e8aaa3663cd)), closes [#2451](https://github.com/dsj1984/mandrel/issues/2451)

## [1.21.0](https://github.com/dsj1984/mandrel/compare/v1.20.0...v1.21.0) (2026-05-18)


### Fixed

* **git-cleanup:** split current-HEAD skip + add remote-only sweep ([#2446](https://github.com/dsj1984/mandrel/issues/2446)) ([8b63fee](https://github.com/dsj1984/mandrel/commit/8b63feed54b738e97492c00ae284b0db3148f9d1)), closes [#2445](https://github.com/dsj1984/mandrel/issues/2445)

## [1.20.0](https://github.com/dsj1984/mandrel/compare/v1.19.0...v1.20.0) (2026-05-18)


### Added

* **orchestration:** add BranchCleaner lifecycle listener for end-of-Epic branch reap ([#2402](https://github.com/dsj1984/mandrel/issues/2402)) ([b912e54](https://github.com/dsj1984/mandrel/commit/b912e54f5da1c2c8305af4ef0e6eead8f6050d7f)), closes [#2398](https://github.com/dsj1984/mandrel/issues/2398)

## [1.19.0](https://github.com/dsj1984/mandrel/compare/v1.18.0...v1.19.0) (2026-05-18)


### Added

* **epic-deliver:** surface cross-Story conflict findings in manifest and prepare-gate (resolves [#2297](https://github.com/dsj1984/mandrel/issues/2297)) ([#2305](https://github.com/dsj1984/mandrel/issues/2305)) ([e2a3288](https://github.com/dsj1984/mandrel/commit/e2a3288ef4a6d671d91a0a58627d29205fc92f18))
* **epic-plan:** add cross-Story path-conflict & implicit-dependency graph (resolves [#2296](https://github.com/dsj1984/mandrel/issues/2296)) ([#2302](https://github.com/dsj1984/mandrel/issues/2302)) ([20fe62c](https://github.com/dsj1984/mandrel/commit/20fe62c81f319f40ac17069e6cf5fd44df72ac04))
* **epic-plan:** decomposer prompt heuristic for shared config-file edits across Stories ([#2300](https://github.com/dsj1984/mandrel/issues/2300)) ([30dadc0](https://github.com/dsj1984/mandrel/commit/30dadc070124e45e5b56cf4295763fee1c28ed65)), closes [#2298](https://github.com/dsj1984/mandrel/issues/2298)
* **workflows:** add /single-story-plan for standalone Story drafting (resolves [#2293](https://github.com/dsj1984/mandrel/issues/2293)) ([#2295](https://github.com/dsj1984/mandrel/issues/2295)) ([7b9b3b7](https://github.com/dsj1984/mandrel/commit/7b9b3b7cd76d9d92dff9aa451c05fbc6b039199e))


### Fixed

* **retro:** align retro-runner with ITicketingProvider; add no-op guard; count manual interventions ([#2290](https://github.com/dsj1984/mandrel/issues/2290)) ([3815739](https://github.com/dsj1984/mandrel/commit/3815739f0cc707c8ea24606198edf55936de9357)), closes [#2289](https://github.com/dsj1984/mandrel/issues/2289)

## [1.18.0](https://github.com/dsj1984/mandrel/compare/v1.17.0...v1.18.0) (2026-05-17)


### Fixed

* **bootstrap:** sync-agentrc and quality-bootstrap contradict each other on default-key writes ([#2281](https://github.com/dsj1984/mandrel/issues/2281)) ([#2285](https://github.com/dsj1984/mandrel/issues/2285)) ([c6626f3](https://github.com/dsj1984/mandrel/commit/c6626f3723f1a772e90f3eb030402d0a4af6388f))
* **emit-context:** route Logger output to stderr to keep stdout pure JSON ([#2287](https://github.com/dsj1984/mandrel/issues/2287)) ([5622bd6](https://github.com/dsj1984/mandrel/commit/5622bd6cf63645778a8e108626e5176883ba6b44)), closes [#2278](https://github.com/dsj1984/mandrel/issues/2278)
* **epic-plan-decompose:** preserve Epic body through reconciler persist ([#2286](https://github.com/dsj1984/mandrel/issues/2286)) ([07e50e5](https://github.com/dsj1984/mandrel/commit/07e50e59e355040115c38586fdf5fdfba8e541c6)), closes [#2283](https://github.com/dsj1984/mandrel/issues/2283)


### Changed

* **epic-deliver:** drop close-as-approval gate for context::acceptance-spec ([#2280](https://github.com/dsj1984/mandrel/issues/2280)) ([328f4a5](https://github.com/dsj1984/mandrel/commit/328f4a539a4748a7b2b3aeb914899320d1ebb452))
* **epic-plan:** unify Epic canonical headings (Context/Goal/Non-Goals/Scope/AC) ([#2183](https://github.com/dsj1984/mandrel/issues/2183)) ([2abc8f3](https://github.com/dsj1984/mandrel/commit/2abc8f3ea5f245c2370595955b89b71946b00e2e))

## [1.17.0](https://github.com/dsj1984/mandrel/compare/v1.16.0...v1.17.0) (2026-05-17)


### Added

* **story-close:** bounded timeout for biome-format + baseline-refresh spawns ([#2165](https://github.com/dsj1984/mandrel/issues/2165)) ([#2180](https://github.com/dsj1984/mandrel/issues/2180)) ([01a61b3](https://github.com/dsj1984/mandrel/commit/01a61b32488ea6dc9031a5427a2029f56b67a043))


### Fixed

* **story-close:** enforce single baseline-refresh commit per close cycle (resolves [#2176](https://github.com/dsj1984/mandrel/issues/2176)) ([#2177](https://github.com/dsj1984/mandrel/issues/2177)) ([a900e4f](https://github.com/dsj1984/mandrel/commit/a900e4f0c8c5c598dbd831feca218636cecb49d5))

## [1.16.0](https://github.com/dsj1984/mandrel/compare/v1.15.0...v1.16.0) (2026-05-17)


### Changed

* rename /story-execute to /story-deliver (hard cutover) ([#2174](https://github.com/dsj1984/mandrel/issues/2174)) ([a40e385](https://github.com/dsj1984/mandrel/commit/a40e3854ee6bb3e3bf15f096a4186bd0df6c6822)), closes [#2171](https://github.com/dsj1984/mandrel/issues/2171)

## [1.15.0](https://github.com/dsj1984/mandrel/compare/v1.14.0...v1.15.0) (2026-05-17)


### Added

* **epic-deliver:** enforce code-review halted flag before retro phase (resolves [#2167](https://github.com/dsj1984/mandrel/issues/2167)) ([#2168](https://github.com/dsj1984/mandrel/issues/2168)) ([d41634c](https://github.com/dsj1984/mandrel/commit/d41634c606c540abfc0a06d49b8a3120c69c3197))

## [1.14.0](https://github.com/dsj1984/mandrel/compare/v1.13.0...v1.14.0) (2026-05-17)


### Added

* **epic-plan:** add Epic Clarity Gate (new Phase 6) and renumber phases to linear 1..11 ([#2128](https://github.com/dsj1984/mandrel/issues/2128)) ([#2163](https://github.com/dsj1984/mandrel/issues/2163)) ([f65a14f](https://github.com/dsj1984/mandrel/commit/f65a14f4fa954242011ccd7bbebd5ade2c981d12))

## [1.13.0](https://github.com/dsj1984/mandrel/compare/v1.12.0...v1.13.0) (2026-05-16)


### Fixed

* **quality:** inject framework-default floors in resolver; delete dead per-row machinery ([#2125](https://github.com/dsj1984/mandrel/issues/2125)) ([#2126](https://github.com/dsj1984/mandrel/issues/2126)) ([4c3d687](https://github.com/dsj1984/mandrel/commit/4c3d6875a7dd61eeb49888330f9711d29a91d1ea))

## [1.12.0](https://github.com/dsj1984/mandrel/compare/v1.11.0...v1.12.0) (2026-05-16)


### Added

* **bootstrap:** auto-accept inferred git defaults instead of prompting ([#2122](https://github.com/dsj1984/mandrel/issues/2122)) ([09b1413](https://github.com/dsj1984/mandrel/commit/09b1413d203a4c0f886da7a76bf0322895b598dc)), closes [#2121](https://github.com/dsj1984/mandrel/issues/2121)

## [1.11.0](https://github.com/dsj1984/mandrel/compare/v1.10.0...v1.11.0) (2026-05-16)


### Fixed

* **baselines:** maintainability/crap update writes worktree-relative paths instead of repo-relative ([#2079](https://github.com/dsj1984/mandrel/issues/2079)) ([#2080](https://github.com/dsj1984/mandrel/issues/2080)) ([b5f0f24](https://github.com/dsj1984/mandrel/commit/b5f0f245b0b306e984c617efa74b57eceaf2a817))

## [1.10.0](https://github.com/dsj1984/mandrel/compare/v1.9.0...v1.10.0) (2026-05-16)


### Added

* **bootstrap:** unified consumer setup script + README cleanup (hard cutover) ([#2075](https://github.com/dsj1984/mandrel/issues/2075)) ([8543677](https://github.com/dsj1984/mandrel/commit/854367748c68c5191fef99d849664f49329db63f)), closes [#2074](https://github.com/dsj1984/mandrel/issues/2074)

## [1.9.0](https://github.com/dsj1984/mandrel/compare/v1.8.0...v1.9.0) (2026-05-16)


### Fixed

* **epic-plan-decompose:** restore sub-issue link safety net + branch cleanup ([#2067](https://github.com/dsj1984/mandrel/issues/2067)) ([450b159](https://github.com/dsj1984/mandrel/commit/450b159b414cb87603668f3cac1747f6a460c1a7)), closes [#2063](https://github.com/dsj1984/mandrel/issues/2063)

## [1.8.0](https://github.com/dsj1984/mandrel/compare/v1.7.0...v1.8.0) (2026-05-16)


### Fixed

* **epic-plan:** route --emit-context drain logs to stderr ([#2055](https://github.com/dsj1984/mandrel/issues/2055)) ([#2066](https://github.com/dsj1984/mandrel/issues/2066)) ([295bd4b](https://github.com/dsj1984/mandrel/commit/295bd4b0fceb9e9b34c63c8678f7bc15ca02d8e2))
* **epic-spec-reconciler:** preserve type::* and risk::* labels on Epic persist ([#2064](https://github.com/dsj1984/mandrel/issues/2064)) ([c6aa08f](https://github.com/dsj1984/mandrel/commit/c6aa08f5824b749122317e237a59ebf164d9a01a)), closes [#2056](https://github.com/dsj1984/mandrel/issues/2056)

## [1.7.0](https://github.com/dsj1984/mandrel/compare/v1.6.0...v1.7.0) (2026-05-16)


### Fixed

* **bootstrap:** close consumer-side runtime-deps install gap ([#2057](https://github.com/dsj1984/mandrel/issues/2057)) ([#2061](https://github.com/dsj1984/mandrel/issues/2061)) ([4cfc564](https://github.com/dsj1984/mandrel/commit/4cfc564619626ca80e988a20440ea9ba2bdfa2b7))
* **tests:** stabilize shipped-baselines-idempotency round-trip ([#2017](https://github.com/dsj1984/mandrel/issues/2017)) ([#2026](https://github.com/dsj1984/mandrel/issues/2026)) ([4cc4075](https://github.com/dsj1984/mandrel/commit/4cc4075a906bbca4a1f866334372585586297df5))

## [1.6.0](https://github.com/dsj1984/mandrel/compare/v1.5.0...v1.6.0) (2026-05-16)


### Fixed

* **baselines:** classify new files as additions, not regressions (resolves [#2012](https://github.com/dsj1984/mandrel/issues/2012)) ([#2058](https://github.com/dsj1984/mandrel/issues/2058)) ([3bcb15a](https://github.com/dsj1984/mandrel/commit/3bcb15a8ff8fc36176b168330a173536b983eb06))

## [1.5.0](https://github.com/dsj1984/mandrel/compare/v1.4.0...v1.5.0) (2026-05-16)


### Fixed

* **bootstrap:** handle fresh-empty-repo bootstrap failure modes ([#2022](https://github.com/dsj1984/mandrel/issues/2022)) ([28ae5d4](https://github.com/dsj1984/mandrel/commit/28ae5d481ca9fb256e6b22bc9e515b2dcc74f5e5)), closes [#2018](https://github.com/dsj1984/mandrel/issues/2018)

## [1.4.0](https://github.com/dsj1984/mandrel/compare/v1.3.0...v1.4.0) (2026-05-16)


### Fixed

* switch the push-to-main path to set BASELINE_SCOPE=full instead. ([9b8b1a2](https://github.com/dsj1984/mandrel/commit/9b8b1a26e7465920bfd49c469f427b421ccea2e2))

## [1.3.0](https://github.com/dsj1984/mandrel/compare/v1.2.0...v1.3.0) (2026-05-16)


### Added

* **sweep:** protect active worktrees + add cross-session lock (resolves [#2011](https://github.com/dsj1984/mandrel/issues/2011)) ([#2013](https://github.com/dsj1984/mandrel/issues/2013)) ([67e6bd9](https://github.com/dsj1984/mandrel/commit/67e6bd9c84507368eb4d5c6659cdb9d9d2859f40))

## [1.2.0](https://github.com/dsj1984/mandrel/compare/v1.1.0...v1.2.0) (2026-05-16)


### Added

* **pr-watch:** auto-recover from BEHIND mergeStateStatus during PR watch loops ([#2009](https://github.com/dsj1984/mandrel/issues/2009)) ([fc013e8](https://github.com/dsj1984/mandrel/commit/fc013e81a1318fc9b0564b6bf0f3e4bc97ba4e4b))

## [1.1.0](https://github.com/dsj1984/mandrel/compare/v1.0.0...v1.1.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* **release:** footers or !-marked commits never auto-propose a major version. Major bumps now require explicit operator intervention via a Release-As: X.0.0 trailer or a manual edit on the release PR branch.

### Added

* **idea-refinement:** fold grill-me interrogation pattern into Phase 2 (resolves [#1926](https://github.com/dsj1984/mandrel/issues/1926)) ([#1932](https://github.com/dsj1984/mandrel/issues/1932)) ([987eb93](https://github.com/dsj1984/mandrel/commit/987eb93c78bb8a6529228932bcaca21af654ead2))


### Fixed

* **release:** use PAT so release-please PRs trigger CI ([#1933](https://github.com/dsj1984/mandrel/issues/1933)) ([4ee603f](https://github.com/dsj1984/mandrel/commit/4ee603f4317e92f3c75397bae28a3e8a3adb75c2))


### Chores

* **release:** cap release-please at minor bumps ([#1929](https://github.com/dsj1984/mandrel/issues/1929)) ([d4ea2c8](https://github.com/dsj1984/mandrel/commit/d4ea2c8955a94958e0c96005183ab1252f5a8c09))

## [1.0.0] — 2026-05-15

**Mandrel 1.0 — rebrand + clean slate.** The framework relaunches under the
**Mandrel** name with a fresh major-version line. The pre-rebrand version
history (v1.x – v5.41.x under the old name, plus the transitional `6.0.0`
cut-over tag) is preserved verbatim in
[`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md) and is **not
comparable** to entries under this line — file structure, package name,
and configuration shapes all changed at the rebrand boundary. New
adopters target the **`mandrel`** package / **`mandrel.git`** submodule
from this point forward.

### Added (dispatch hints & parallel tooling)

All optional unless used; untouched consumers behave as before.

- Workflow frontmatter: `recommendedModel` and `dispatchModel` (`haiku` |
  `sonnet` | `opus`) — dispatcher hints only, no required schema fields.
- Helper [**parallel-tooling**](../.agents/workflows/helpers/parallel-tooling.md) documenting fan-out tooling in one assistant turn.
- Skill **`audit-fan-out`** (opt-in `/audit-fan-out`).
- **`epic-perf-report`**: optional `dispatchModel` on `mostFrictionStories[]`
  items; omitted when absent. See PRD #1276 / Tech Spec #1277 /
  Stories #1326–#1329.

### Breaking changes (decomposition & manifest)

Hard cut — no aliases. Update `.agentrc.json` in lockstep; legacy shapes fail
schema validation.

- **Concurrency**: single **`orchestration.concurrency`** block (`decomposer`,
  `deliverRunner`, `waveGate`, `commitAssertion`, `progressReporter`).
  Removes **`runners.decomposer`**, **`runners.concurrency`**, and
  **`deliverRunner.concurrencyCap`**; use **`resolveConcurrency(orchestration)`**.

- **`sizingProfile`** on dispatch-manifest Tasks that exceed **`agentSettings.planning.taskSizing.softFileCount`** file threshold (profiles: **`mechanical-sweep`**, **`atomic-rewrite`**, **`scaffolding`**).

- **`agentSettings.planning.taskSizing`** — tunable **`maxAcceptance`** /
  **`maxChanges`** / **`softFileCount`** / **`softAcceptanceCount`** with
  structured oversized/missing-profile findings consumed by decomposition retry.

- **Dispatch markdown**: one nested Wave → Story → Task flow (TOC anchors,
  checkboxes, per‑wave decomposition notes, single footer `<details>`). Behavior
  is locked by **`tests/lib/presentation/manifest-formatter-end-to-end.test.js`**.

### Changed (Story #1922 — agentrc template rename + role split)

- **Renamed `.agents/min-agentrc.json` → `.agents/starter-agentrc.json`**. The
  bootstrap delta-seed consumers copy to `.agentrc.json` is now named for what
  it is: a *starter*, not the absolute minimum. Content unchanged from the
  pre-rename `min-agentrc.json`.
- **Renamed `.agents/default-agentrc.json` → `.agents/full-agentrc.json`** and
  expanded it to enumerate every schema key. The reference template now
  includes the three Epic #1720 gates (`mutation`, `lighthouse`,
  `bundleSize`) plus the two `worktreeIsolation` keys (`primeFromPath`,
  `allowSymlinkOnWindows`) the schema accepts. Values mirror the in-code
  framework defaults so the file documents reality, not aspiration. Story
  #1911 will lift the placeholder mutation / lighthouse / bundle-size
  floors to their high-bar values.
- **Trimmed the dogfood `.agentrc.json`** to minimum + delta. Dropped every
  key whose value matched a framework default (`planning.maxTickets`,
  `delivery.execution.timeoutMs`, `delivery.maxTokenBudget`,
  `delivery.deliverRunner.concurrencyCap`, all of `delivery.signals.*`,
  `delivery.quality.gateScoping`, the entire `lint` gate, and several
  inherited fields from `coverage` / `crap` / `maintainability`). The
  remaining keys are genuine project overrides — primarily the workspace
  floors, the symlink worktree strategy, and the `riskHeuristics` /
  `docsFreshness.paths` lists whose runtime fallback is empty.
- **Bootstrap workflow** ([agents-bootstrap-project.md §2.5](../.agents/workflows/agents-bootstrap-project.md))
  rewritten to seed from `starter-agentrc.json` with a refreshed
  "Why starter, not full?" callout explaining the delta-vs-copy rationale.

No schema changes. The static schema mirror, AJV runtime schemas, and the
runtime defaults in code (`LIMITS_DEFAULTS`, `*_GATE_DEFAULTS`,
`DEFAULT_DELIVER_RUNNER`, etc.) are untouched.

### Removed

- Epic #1235 hands-off CI automation: bot approver, auto-fix, triage-PR,
  baseline-refresh-guardrail workflows and implementations; **`agents-bootstrap-github`**
  no longer bundles workflow templates. Operator flow: Phase 7 in
  [`.agents/workflows/epic-deliver.md`](../.agents/workflows/epic-deliver.md). Ruleset **`14286998`**
  and secrets **`BOT_APPROVER_*`** must be reconciled manually; **`agent-protocols-reviewer`** app may go away.
- **Windows** runner removed from **`ci.yml`** / required checks due to flaky
  c8 drift (#1267); Windows remains covered locally via pre-push.

### Changed

- **Tasks** close at **commit-time**; Story stays **`agent::executing`** until merge
  (**`story-task-progress.js`**, **`cascade: false`** on close path).
- **Story resume** skips Tasks already **`agent::done`** with reachable **`commitSha`**.
- **`epic-complete` webhook** fires after **`gh pr create`** (**`epic-deliver-finalize.js`**).
- **Maintainability** gate default tolerance **0.001 → 0.5**, overridable via
  **`agentSettings.quality.maintainability.tolerance`** / **`CRAP_TOLERANCE`**.

---

Pre-rebrand history (the old-name v1.x–v5.41.x line and the 6.0.0 cut-over
tag) is preserved in [`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md).
