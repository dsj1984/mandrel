# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

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
