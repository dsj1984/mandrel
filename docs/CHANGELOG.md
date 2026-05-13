# Changelog

All notable changes to this project will be documented in this file.

## [6.0.0] — 2026-05-13

**Mandrel rebrand plus v6 breaking cut** (Epic #1184). History for v1.x–v5.41.x
lives only in [`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md). One-time migration CLIs shipped for Epic #1184 (`docs/migration-v6.md`, `migrate-to-v6*` / `rebrand-to-mandrel*`, tests) are removed from this tree; adopters bump to **`mandrel`** / **`mandrel.git`** on submodule and npm deps.

### Added (Epic #1185 — dispatch hints & parallel tooling)

All optional unless used; untouched consumers behave as before.

- Workflow frontmatter: `recommendedModel` and `dispatchModel` (`haiku` |
  `sonnet` | `opus`) — dispatcher hints only, no required schema fields.
- Helper [**parallel-tooling**](../.agents/workflows/helpers/parallel-tooling.md) documenting fan-out tooling in one assistant turn.
- Skill **`audit-fan-out`** (opt-in `/audit-fan-out`).
- **`epic-perf-report`**: optional `dispatchModel` on `mostFrictionStories[]`
  items; omitted when absent. See PRD #1276 / Tech Spec #1277 /
  Stories #1326–#1329.

### Breaking changes (Epic #1178 — decomposition & manifest)

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
