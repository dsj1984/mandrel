# Data Dictionary

This document defines the core data structures and schemas used across the
Mandrel orchestration engine.

---

## SignalEvent (`signals.ndjson` line)

One newline-terminated JSON object emitted by `signals-writer.appendSignal`
to `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` (and a sibling
`traces.ndjson` for `kind: trace`). Closed taxonomy of seven record kinds —
`friction`, `hotspot`, `rework`, `churn`, `idle`, `retry`, `trace` — defined
by Epic #1030. Schema lives at
[`signal-event.schema.json`](../.agents/schemas/signal-event.schema.json);
the table below mirrors that schema — update both together. See
[`docs/architecture.md`](architecture.md#performance-signal-telemetry) for
the producer / detector / analyzer flow and the ADR in
[`docs/decisions.md`](decisions.md) for the events-local /
summaries-on-tickets rationale.

| Field      | Type                | Required | Description                                                                                                                |
| ---------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ts`       | `ISO8601 date-time` | Yes      | Event timestamp in UTC.                                                                                                    |
| `kind`     | `enum`              | Yes      | One of `friction`, `hotspot`, `rework`, `churn`, `idle`, `retry`, `trace`. Drives detector dispatch and analyzer rollup.   |
| `source`   | `object`            | Yes      | `{ tool: string, script?: string }`. `tool` is the originating surface (`Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, or a script name for derived signals). |
| `epicId`   | `integer ≥ 1`       | Yes      | Epic the event belongs to. Pins the on-disk path to `temp/epic-<epicId>/`.                                                 |
| `storyId`  | `integer ≥ 1`       | Yes      | Story the event was sampled inside. Pins the on-disk path to `story-<storyId>/`.                                           |
| `taskId`   | `integer ≥ 1` \| `null` | No   | Legacy field name; GitHub issue number when the event is scoped below Epic level. `null` for Story-wide events.              |
| `phase`    | `string` \| `null`  | No       | Execution phase the event was sampled inside (`bootstrap`, `implement`, `test`, `close`, …). `null` for raw traces outside a phase boundary. |
| `details`  | `object`            | No       | Kind-specific payload (free-form for forward compatibility). Common keys: `category`, `command`, `elapsedMs`, `targetHash`. |

---

## StoryPerfSummary (`structured:story-perf-summary` comment)

Payload of the single performance summary comment posted on every Story
ticket at close (Epic #1030). Replaces the per-Story friction comment fanout
and the standalone phase-timings comment. Schema lives at
[`story-perf-summary.schema.json`](../.agents/schemas/story-perf-summary.schema.json).

| Field                     | Type                | Required | Description                                                                                              |
| ------------------------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `kind`                    | `const string`      | Yes      | Always `"story-perf-summary"` so the analyzer can index the comment by kind.                              |
| `storyId`                 | `integer ≥ 1`       | Yes      | Story this summary belongs to.                                                                            |
| `epicId`                  | `integer ≥ 1`       | Yes      | Epic the Story rolls up to.                                                                               |
| `closedAt`                | `ISO8601 date-time` | Yes      | When the close transitioned the Story to `agent::done`.                                                   |
| `frictionByCategory`      | `object`            | Yes      | Counts of friction signals bucketed by category for this Story. Keys are category strings; values ≥ 0.    |
| `phaseTimingsMs`          | `object`            | Yes      | Elapsed ms per phase, sourced from `phase-timer.js`. Keys are phase names; values ≥ 0.                    |
| `topSlowPhasesVsBaseline` | `array`             | Yes      | Items: `{ phase, elapsedMs, baselineP95Ms, ratio }`. `ratio = elapsedMs / baselineP95Ms`.                 |
| `reworkScore`             | `object`            | Yes      | `{ filesEditedBeyondThreshold, topPath?, topPathEdits? }`. Threshold from `signals.rework.editsPerFile`.  |
| `retryDensity`            | `object`            | Yes      | `{ retries, uniqueCommands }`. `retries / uniqueCommands` is the density per Story.                       |

---

## EpicPerfReport (`structured:epic-perf-report` comment)

Payload of the single Epic-level performance comment posted alongside the
retro at Epic close (Epic #1030). Aggregates every Story's NDJSON stream
into one rolled-up report. Schema lives at
[`epic-perf-report.schema.json`](../.agents/schemas/epic-perf-report.schema.json).

| Field                 | Type                | Required | Description                                                                                                                                                |
| --------------------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                | `const string`      | Yes      | Always `"epic-perf-report"`.                                                                                                                                |
| `epicId`              | `integer ≥ 1`       | Yes      | Epic this report belongs to.                                                                                                                                |
| `generatedAt`         | `ISO8601 date-time` | Yes      | When `epic-deliver runner` produced the report.                                                                                                                   |
| `signalCounts`        | `object`            | Yes      | Rolled-up counts by `kind` for the entire Epic. Keys: `friction`, `hotspot`, `rework`, `churn`, `idle`, `retry` (each integer ≥ 0).                         |
| `waveParallelism`     | `array`             | Yes      | Items: `{ wave, wallClockMs, sumStoryMs, utilization, stories }`. `utilization = wallClockMs / sumStoryMs` (lower is better; ideal is `1/N` for `N` slots). |
| `topHotspots`         | `array`             | Yes      | Items: `{ phase, occurrences, avgRatio }`. Phases that fired the hotspot detector most often, with the average `elapsedMs / baselineP95Ms` ratio.           |
| `mostFrictionStories` | `array`             | Yes      | Items: `{ storyId, frictionCount }`. Stories that produced the highest count of `kind: friction` events.                                                    |

---

## FrictionEvent (`friction` NDJSON signal)

Appended to `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` by
`signals-writer.appendSignal` when detector or gate-failure paths
trip. (Pre Epic #1030 Story #1042 the same payload was posted as a
GitHub structured comment by the now-deleted in-process emitter.)
Schema lives at
[`friction-event.schema.json`](../.agents/schemas/friction-event.schema.json);
the table below mirrors that schema — update both together.

| Field      | Type                | Required | Description                                                            |
| ---------- | ------------------- | -------- | ---------------------------------------------------------------------- |
| `eventId`  | `uuid string`       | Yes      | Unique event identifier.                                               |
| `timestamp`| `ISO8601 date-time` | Yes      | When the event occurred.                                               |
| `sprintId` | `string`            | Yes      | Epic identifier the event belongs to. Field is `sprintId` for back-compat with the schema; rename to `epicId` is a planned breaking change tracked in the next major. |
| `taskId`   | `integer`           | Yes      | GitHub issue number of the Story (legacy field name `taskId`).          |
| `category` | `enum`              | Yes      | One of `Prompt Ambiguity`, `Missing Skill`, `Incorrect Persona`, `Tool Limitation`, `Execution Error`. |
| `details`  | `string`            | Yes      | Specific error message or observation.                                  |
| `source`   | `object`            | No       | `{ tool?: string, command?: string }` — failed tool / command.          |
| `context`  | `object`            | No       | `{ protocolFile?: string }` — relevant protocol file path.              |

---

## `WorktreeRecord` (in-memory)

Ephemeral record held by `WorktreeManager` during a dispatch run.

| Field        | Type     | Description                                        |
| ------------ | -------- | -------------------------------------------------- |
| `storyId`    | `number` | GitHub issue number for the story.                 |
| `branch`     | `string` | `story-<id>` branch name.                          |
| `path`       | `string` | Absolute path to `.worktrees/story-<id>/`.         |
| `createdAt`  | `string` | ISO timestamp.                                     |
| `nmStrategy` | `string` | `nodeModulesStrategy` used for this worktree.      |

---

## `GcCandidate` (in-memory)

Shape returned during `WorktreeManager.gc` evaluation.

| Field    | Type      | Description                                                                     |
| -------- | --------- | ------------------------------------------------------------------------------- |
| `path`   | `string`  | Absolute worktree path from `git worktree list --porcelain`.                    |
| `branch` | `string`  | Checked-out branch.                                                             |
| `clean`  | `boolean` | `true` if `git status --porcelain` is empty.                                    |
| `merged` | `boolean` | `true` if `git merge-base --is-ancestor branch epicBranch` exits 0.             |
| `safe`   | `boolean` | `clean && merged`. Gates `git worktree remove`.                                 |

---

## Gherkin Tag Taxonomy

Canonical tag set enforced by `.agents/rules/gherkin-standards.md`. Tags
outside this set MUST be proposed in a PR that updates the rule before use.

| Tag               | Scope                  | Usage                                                                                                |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `@smoke`          | Suite membership       | Minimal critical-path scenarios that MUST pass on every PR.                                          |
| `@risk-high`      | Suite membership       | Scenarios covering flows flagged `risk::high` on the originating ticket; runs on every RC.           |
| `@platform-web`   | Platform exclusive     | Scenario only makes sense on the web client.                                                         |
| `@platform-mobile`| Platform exclusive     | Scenario only makes sense on the mobile client.                                                      |
| `@domain-<slug>`  | Domain scope (required)| Exactly one per scenario. Slug is project-defined (e.g. `@domain-billing`, `@domain-auth`).          |
| `@flaky`          | Operational quarantine | Scenario excluded from the gating suite; runs in a non-blocking job until stabilized. Debt marker.   |

---

## Orchestration Submodule Boundaries

The orchestration SDK splits its three largest modules into cohesive submodules
behind façade files. Only the façade paths are part of the stable public
surface; submodule paths are internal implementation detail and may be renamed
without a major version bump.

| Façade (public)                          | Submodule directory                 | Internal submodules                                                                                             |
| ---------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lib/worktree-manager.js`                | `lib/worktree/`                     | `lifecycle-manager`, `node-modules-strategy`, `bootstrapper`, `inspector`                                       |
| `lib/orchestration/dispatch-engine.js`   | `lib/orchestration/` (co-located)   | `dispatch-pipeline`, `risk-gate-handler`                                                                        |
| `lib/presentation/manifest-renderer.js`  | `lib/presentation/` (co-located)    | `manifest-formatter` (pure), `manifest-persistence` (fs I/O)                                                    |

Downstream consumers must import from the façade column. Tests, MCP tools, and
CLI entry points inside this repository also import from the façade column —
the split is internal. See `docs/architecture.md` and `docs/patterns.md` for
the responsibility map.

---

## Epic Deliver Runner Vocabulary

Vocabulary specific to the runner over and above the existing label/comment
taxonomy.

| Term                       | Kind                | Definition                                                                                                                          |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `epic-run-state`           | Structured comment  | HTML-marker-scoped JSON checkpoint on the Epic; single SSOT for wave progress and resume across all six `/deliver` phases.    |
| `wave-<N>-start`           | Structured comment  | Per-wave start marker with wave manifest and start timestamp.                                                                       |
| `wave-<N>-end`             | Structured comment  | Per-wave end marker with story outcomes and duration.                                                                               |
| `concurrencyCap`           | Config (integer)    | `delivery.deliverRunner.concurrencyCap`; max parallel `/deliver <storyId>` sub-agents per wave.                  |
| Blocker-escalation         | Flow state          | Runtime pause driven by `agent::blocked`; the sole HITL touchpoint during a run.                                                    |
| Status (Projects v2)       | Project field       | Single-select custom field driven by `ColumnSync` from `agent::` labels.                                                            |

`risk::high` is metadata only — it ranks work in the dispatch table and helps
reviewers prioritize, but does not pause execution.

### Structured-comment types

`post-structured-comment.js` (the CLI behind every framework comment) writes
typed comments. Each `type` is keyed on a stable HTML marker so reads are
idempotent; `upsertStructuredComment(provider, ticketId, type, body)` replaces
any prior comment of the same type.

| Type                | Writer                                              | Purpose                                                                  |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| `epic-run-state`    | `Checkpointer`                                      | JSON checkpoint of wave progress and resume state.                       |
| `epic-run-progress` | `ProgressReporter`                                  | Periodic operator-facing wave roll-up.                                   |
| `wave-<N>-start`    | `/deliver` wave loop (`lib/orchestration/wave-marker.js`) | Per-wave start manifest + timestamp.                                |
| `wave-<N>-end`      | `/deliver` wave loop (`lib/orchestration/wave-marker.js`) | Per-wave outcomes + duration.                                       |
| `epic-plan-state`   | `/plan` checkpoint                             | Phase 1/2 progress so re-plans resume cleanly.                           |
| `dispatch-manifest` | `/plan` / dispatcher                           | Frozen Story manifest for the wave-gate.                                 |
| `parked-follow-ons` | dispatcher                                          | Out-of-manifest Stories surfaced at the deliver-tail gate (recuts + parked). |
| `story-init`        | `story-init.js`                                     | Initial Story metadata snapshot.                                         |
| `story-run-progress`| `/deliver`                                    | Per-Story label transitions during `/deliver`.                   |
| `epic-run-progress` | `/deliver` (`epic-execute-record-wave.js`)     | Cross-wave Story-level rollup, grouped by wave. Single comment, upserted in place after each wave. |
| `code-review`       | `lib/orchestration/code-review.js` (Phase 5)        | Findings report posted on the Epic.                                      |
| `retro`             | `lib/orchestration/retro-runner.js` (Phase 6)       | Final retrospective body with the `retro-complete` marker.               |
| `audit-results`     | `helpers/epic-audit` (Phase 4)                      | Per-lens audit findings posted on the Epic. Read by `lib/feedback-loop/audit-results-graduator.js`, which auto-graduates non-blocking findings (severity high/medium/low/suggestion — anything not a 🔴 Critical Blocker) into routed follow-up issues carrying `meta::audit-finding`, `meta::framework-gap`/`meta::consumer-improvement`, `audit-results::<severity>`, and `domain::<lens>` labels, with an `<!-- audit-results-followup: epic-<id>-finding-<idx> -->` idempotency marker. Toggle: `delivery.feedbackLoop.auditResultsAutoFile` (default `true`). |
| `retro-partial`     | `epic-retro` helper                                 | Mid-run checkpoint so a crashed retro can resume without re-collecting.  |
| `phase-timings`     | `phase-timer` (on `story-close`)                    | Per-phase elapsed-time spans for the closed Story.                       |
| `friction`          | `signals-writer.appendSignal` (NDJSON, on disk)     | Per-Story friction observation appended to `signals.ndjson` (no GitHub round-trip post Story #1042). |
| `notification`      | `notify.js`                                         | Operator-facing severity-tiered notification.                            |

The `mcp__mandrel__post_structured_comment` tool is **gone**; the
direct CLI is the only path. Earlier dispatcher snapshots referencing the MCP
tool are obsolete.

Readers consuming any of the comment types above should parse the JSON fence
through the shared `parseFencedJsonComment(comment)` helper in
`lib/orchestration/structured-comment-parser.js`. Three open-coded regex
parsers were consolidated onto this helper in Epic #946 (v5.31.1); new
readers should not re-implement the fence-extraction logic inline.

---

## Dispatch Manifest

`temp/dispatch-manifest-<epicId>.json` is the frozen Story manifest the
wave-gate reads. The structured comment of type `dispatch-manifest` posted on
the Epic is the SSOT; the on-disk file is a renderer cache regenerable via
`render-manifest.js --epic <id>`.

| Field                    | Type    | Description                                                                                       |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `type`                   | `enum`  | `"epic-dispatch"` or `"story-execution"` discriminator.                                            |
| `epicId`                 | `int`   | GitHub Issue number of the Epic.                                                                  |
| `storyManifest[]`        | `array` | Frozen list of Stories per wave. Each row carries `{ storyId, storyTitle, wave, … }`. `model_tier` was removed from this row in Epic #990 (audit remediation) — the orchestrator no longer selects models; the executing agent / external router does. |
| `agentTelemetry`         | `object`| Open object for runner telemetry (cap-source, runner version, etc.).                              |
| `summary`                | `object`| Summary counts (total, by-wave, by-status).                                                       |

> **Story-centric manifest.** The dispatch manifest is Story-centric:
> `waves[].stories[]` lists the Stories per wave and `storyManifest[]`
> rows carry inline `acceptance[]` / `verify[]` from each Story body.
> Schema-version identifiers on the manifest let a future consumer
> detect "I cannot read this artifact" (per the
> [hard-cutover policy](decisions.md)).

---

## Resilience & Throughput Primitives

| Term                                                | Kind     | Definition                                                                                                                                                                       |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyWaveResults({ provider, results, concurrencyCap })` | Function | Post-wave claim guard in `lib/orchestration/wave-record-io.js` (the surviving successor to the deleted `CommitAssertion` class, removed with the in-process epic-runner stratum in PR #3936). Re-fetches each Story ticket fresh and downgrades any `status: 'done'` claim whose ticket has not reached `agent::done` (or `closed`) to `failed`, returning the verified rows plus a `discrepancies` list. Network failures during verification become `verify-error` discrepancies. Per-row checks run through `concurrentMap` under a bounded cap (default 4, override via `delivery.deliverRunner.verifyConcurrencyCap`). |
| `detectPriorPhase()`                                | Function | Recovery-state detector exported by `lib/orchestration/story-close-recovery.js`; classifies the close-time situation as `clean` / `unmerged-story-branch` / `merge-in-progress` / `dirty-worktree` so `--resume` and `--restart` can branch. |
| `--resume` / `--restart`                            | CLI flag | `story-close.js` flags. `--resume` picks up at the merge-resolution step from a failed prior close without re-running init/implement/validate; `--restart` aborts any partial state and re-inits. |
| `hierarchy-gate.js`                                 | Script   | Standalone hierarchy-completeness CLI (`node .agents/scripts/hierarchy-gate.js --epic <EPIC_ID>`). Walks the Epic's live Story sub-issue graph (2-tier: Epic → Story, Story #4041 — `getSubTickets(<storyId>)` returns `[]`, so the walk terminates at the Story) and requires every Story closed; auxiliary `context::prd` / `context::tech-spec` tickets are ignored (the operator closes them after the Epic PR merges). Exits 0 when every descendant is closed, 1 when any is open, 2 on configuration/provider error. |
| `signals-writer.appendSignal`                       | Helper   | Append-only NDJSON writer at `lib/observability/signals-writer.js`. Writes one JSON record per line to `temp/epic-<eid>/stories/story-<sid>/signals.ndjson`. Consumers: `diagnose-friction.js`, `story-close.js` reap-failure (via `post-merge-pipeline.js`), `analyze-execution.js`, and the retro signal gatherer (`lib/orchestration/retro/phases/gather-signals.js`). Per-kind quality-gate logic formerly in `check-crap.js` / `check-maintainability.js` now lives in `lib/baselines/kinds/{lint,coverage,crap,maintainability,mutation}.js` behind `check-baselines.js`. Replaced the deleted in-process emitter class in Epic #1030 Story #1042. |
| `--reap-discard-after-merge` / `--no-reap-discard-after-merge` | CLI flag | `/deliver` Phase 7 flag. Default force-reaps worktrees whose Story branch is already merged into `epic/<id>` (per `git merge-base --is-ancestor`), discarding uncommitted post-merge drift; the `--no-` form preserves prior skip-on-uncommitted behavior. Force-reap emits a `friction` comment listing discarded paths. |
| Version-bump-intent snapshot                        | Checkpoint | `/deliver` Phase 0.5 parses the Epic body for `Release target:` / `--segment` directives and posts a `notification` structured comment on the Epic (marker `<!-- notification: version-bump-intent -->`) when they disagree with `release.autoVersionBump`.            |
| Launcher-level config validation                    | Contract | `validateOrchestrationConfig(config)` (from `lib/config/validate-orchestration.js`) runs at launcher startup in `epic-plan-spec.js`, `epic-plan-clarity.js`, `epic-plan-healthcheck.js`, `bootstrap.js`, `agents-bootstrap-github.js`, and the `epic-plan-decompose` CLI phase — a schema-invalid `.agentrc.json` exits non-zero before any long-running flow begins. |

---

## GitHub Provider Contract

| Term                              | Kind                | Definition                                                                                                                                                |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHubProvider` façade           | Module set          | `providers/github.js` is a thin composition over `providers/github/{ticket-mapper,graphql-builder,cache-manager,error-classifier}.js`. Every symbol previously imported is re-exported from the façade. |
| `getTicket(id, { fresh: true })`  | API opt             | Bypasses the per-instance ticket cache and forces a live REST read.                                                                                       |
| `getTicket(id, { maxAgeMs })`     | API opt             | Treats entries older than `maxAgeMs` as cache misses and refetches; newer entries are served from cache.                                                  |
| `primeTicketCache(tickets)`       | Behavior contract   | Every `provider.getTickets(epicId)` call site is followed by `primeTicketCache(result)` so downstream `getTicket` lookups for the same Epic cost zero HTTP. |
| Bulk label-poll path              | Behavior            | `providers/github/issues.js` chooses between a bulk `GET /issues?labels=agent::*&state=open` read and the per-ticket fallback based on tracked-story count and response well-formedness. Malformed payloads fall back to per-ticket; out-of-scope issues are filtered against the tracked-story set. |
| `gh auth token` memoization       | Behavior            | The first successful `execSync('gh auth token')` resolution is cached into `process.env.GITHUB_TOKEN` so subsequent provider constructions short-circuit. |

---

## Logger

`lib/Logger.js` is the single orchestrator logger.

| Level     | Behavior                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `silent`  | Only `fatal` emits.                                                                                   |
| `info`    | Default. `info` / `warn` / `error` / `fatal` emit; `debug` is suppressed.                             |
| `verbose` | All levels emit, including `debug` trace output. `debug` is accepted as a backward-compat alias.       |

---

## Wave Marker Regex

The wave structured-comment marker regex is
`/^wave-([0-9]{1,3})-(start|end)$/` — up to 999 waves. `wave-1000-start` is
rejected; downstream wave-index consumers (`manifest-builder`) tolerate
rejected indices gracefully.

---

## CRAP Analysis Artefacts

Per-method complexity × coverage risk gate, sibling to the maintainability
ratchet.

| Term                                                | Kind               | Definition                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baselines/crap.json`                               | Repo-root artefact | `{ kernelVersion, escomplexVersion, rows: [{ file, method, startLine, crap }] }`. Rows deterministically sorted by `(file, startLine)`; alphabetized keys; trailing newline. `kernelVersion` bumps when the inline CRAP formula changes; `escomplexVersion` bumps with the `typhonjs-escomplex` dependency. A baseline whose stamps don't match the running scorer fails closed. |
| `delivery.quality.gates.crap`                       | Config block       | `{ enabled, targetDirs, newMethodCeiling, coveragePath, tolerance, requireCoverage, friction.markerKey, refreshTag }`. Defaults: `enabled: true`, `targetDirs: ["src"]`, `newMethodCeiling: 30`, `coveragePath: "coverage/coverage-final.json"`, `tolerance: 0.05`, `requireCoverage: true`, `refreshTag: "baseline-refresh:"`. List-valued keys accept `{ append }` / `{ prepend }`. |
| Hybrid enforcement                                  | Decision contract  | `compareCrap()` resolves each scanned row through four match paths: exact `(file, method, startLine)`, line-drift fallback (same `(file, method)`, shifted `startLine`), new (no match → ceiling check), removed (baseline row absent → reported, never a failure).                                                                                                          |
| `fixGuidance`                                       | Report field       | Per-violation block in the `--json` envelope: `{ crapCeiling, minComplexityAt100Cov, minCoverageAtCurrentComplexity }`. Derived deterministically from the formula; `null` when unachievable at current complexity. Round-trip property: applying either single-axis fix re-scores under target.                                                                              |
| `--changed-since <ref>`                             | CLI flag           | On `quality-preview.js` (defaults to `HEAD` when omitted). Limits scoring + comparison to files changed relative to `<ref>`. For the unified gate (`check-baselines.js`), diff scoping is config-driven via `delivery.quality.gateScoping` rather than a CLI flag.                                                                                                            |
| `--json` / `--format json`                          | CLI flag           | `quality-preview.js` takes boolean `--json` (emits the merged machine-readable envelope on stdout); `check-baselines.js` takes `--format json\|text` and emits the JSON report on stdout. The standalone per-gate `--json <path>` file writers went away with `check-crap.js` / `check-maintainability.js` — per-kind gate logic now lives in `lib/baselines/kinds/`.        |
| `CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` / `CRAP_REFRESH_TAG` | Env vars | Override `crap.newMethodCeiling`, `crap.tolerance`, and `crap.refreshTag` respectively at runtime. Malformed values warn and fall back to config — a typo must never silently relax the gate. Originally consumed by the (since-removed) baseline-refresh CI guardrail; still available for local re-runs that need to force base-branch values.                                |
| `refreshTag` (commit-message convention)            | Operator convention | A baseline edit should land in a commit whose subject starts with the configured `refreshTag` (default `baseline-refresh:`) and whose body is non-empty. The CI guardrail that mechanically enforced this was removed in 5.42; the operator is now the gate during `/deliver` Phase 7.                                                                                  |

---

## Concurrency Caps

| Term                            | Kind             | Definition                                                                                                                                          |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrentMap(items, fn, opts)` | Utility         | `lib/util/concurrent-map.js`; bounded-concurrency fanout helper. Preserves result order; rejects aggregate on the first thrown error unless the callback swallows it. |
| `analyze-execution.js`          | CLI              | Reads per-Story `signals.ndjson` and emits the `story-perf-summary` (Story-mode) / `epic-perf-report` (Epic-mode) structured comments. The retro composer reads these for phase p50/p95 and concurrency hints. Wired into `post-merge-pipeline` (Story mode) and Epic close Phase 6.0 (Epic mode) in Epic #1114. |
| `lib/baseline-loader.js`        | Helper           | `readBaselineAtRef(ref, path)` resolves a baseline JSON file at an arbitrary git ref (`git show <ref>:<path>`). Used by every close-validation gate so the gate compares Story-touched files in the worktree against shared baselines on the Epic ref, eliminating cross-Story drift on the main checkout as a close-blocker. Added in Epic #1114. |

---

## Web-Parallel Execution

| Term                              | Kind          | Definition                                                                                                                                                                                                          |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AP_WORKTREE_ENABLED`             | Env var       | Operator override for the worktree resolver. Strict string match: `"true"` forces worktrees on; `"false"` forces worktrees off. Wins over the `CLAUDE_CODE_REMOTE` auto-detect and the committed config.            |
| `CLAUDE_CODE_REMOTE`              | Env var       | Web-session marker set automatically inside claude.ai/code. When `=== "true"` and `AP_WORKTREE_ENABLED` is unset, the resolver disables worktrees. Also drives `runtime.isRemote`.                                  |
| `CLAUDE_CODE_REMOTE_SESSION_ID`   | Env var       | Anthropic-provided web session id. Preferred input to `runtime.sessionId`; sanitised to `[a-z0-9]` and truncated to 12 chars.                                                                                       |
| `runtime.sessionId`               | Runtime field | Process-local identity surfaced in the startup `[ENV] sessionId=…` log line for operator correlation. Prefers `CLAUDE_CODE_REMOTE_SESSION_ID`; falls back to a hostname+pid+random short-id. Stable across the run. |
| `resolveWorktreeEnabled(opts, env)` | Helper      | `lib/config-resolver.js`. Returns the resolved boolean (env override → web auto-detect → committed config).                                                                                                          |
| `resolveSessionId(env)`           | Helper        | `lib/config-resolver.js`. Returns the sanitised, 12-char session-id used in the startup log line.                                                                                                                    |
| `resolveRuntime(opts, env)`       | Helper        | `lib/config-resolver.js`. Returns `{ worktreeEnabled, sessionId, isRemote }` plus the source attribution string used in the startup log line.                                                                        |
| `DEFAULT_STORY_MERGE_RETRY`     | Framework constant | `{ maxAttempts: 3, backoffMs: [250, 500, 1000] }`, exported from `.agents/scripts/lib/config/runners.js`. Drives the bounded retry on the epic-branch push at story close. Post-reshape this is a framework-internal constant — no `.agentrc.json` override. See `docs/CHANGELOG.md` for the rename history. |
| `pushEpicWithRetry(...)`          | Helper        | `lib/push-epic-retry.js`. Wraps the `git push origin epic/<id>` step with fetch-replay-push retry on non-fast-forward rejection. Aborts cleanly on real content conflicts; never destroys local work.                |
| `validateBlockers({ provider, logger, input })` | Helper | `lib/story-init/blocker-validator.js` (Stage 3 of the story-init pipeline). Parses `blocked by #N` references from the Story body and verifies each is resolved (`agent::done` label or GitHub state `closed`). Returns `{ openBlockers }`; fetch failures are treated as blocking (`fetchError: true`) so an agent never proceeds past a dependency whose state is unknown. |

---

## Direct CLIs

The framework ships no MCP server. Every orchestration capability is a direct
Node CLI under `.agents/scripts/`, with `lib/orchestration/ticketing.js` as the
authoritative SDK.

| Term                                       | Kind     | Definition                                                                                                                                                         |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `post-structured-comment.js`               | CLI      | `--ticket <id> --marker <key> --body-file <path>`. Wraps `upsertStructuredComment(provider, ticketId, marker, body)` from `lib/orchestration/ticketing.js`; idempotent by marker. |
| `select-audits.js` / `run-audit-suite.js`  | CLI      | Selection reads `audit-rules.json` (manifest schema: `audit-rules.schema.json`); suite execution loads the selected workflow prompts.                              |
| `hydrate-context.js`                       | CLI      | `hydrate-context.js --ticket <id> [--epic <id>]` emits the `{"prompt": …}` JSON envelope. `--emit envelope` emits the raw envelope; `--emit prompt` writes the raw hydrated prompt (no JSON wrapper). The only supported hydration entry point. |
| `update-ticket-state.js`                   | CLI      | Covers ticket state transitions and cascade-completion. Cascade runs inline at the SDK layer when a Story reaches `agent::done`.                                    |
| `dispatcher.js`                            | CLI      | Builds the dependency DAG, computes execution waves, dispatches stories. Invoked by `/plan` Phase 3.                                                           |
| `process.env`-only secrets resolution      | Contract | `notifier.js` `resolveWebhookUrl()` and the GitHub provider's `GITHUB_TOKEN` lookup read **only** from `process.env`. `.mcp.json` is not consulted as a secrets backstop.       |

---

## Validation Evidence Records

Each successful local quality gate persists a small evidence record so
identical re-runs against an unchanged tree skip the second invocation.
Evidence is per-clone, gitignored, and never committed.

| Field               | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `gateName`          | Lowercase gate identifier (`lint`, `test`, `format`, `maintainability`, `crap`).      |
| `commitSha`         | Output of `git rev-parse HEAD` at the time the gate ran.                             |
| `commandConfigHash` | SHA-256 of the resolved command config (script path + args + env subset).            |
| `timestamp`         | ISO-8601 UTC timestamp of the successful run.                                        |
| `exitCode`          | The wrapped command's exit code (always `0` for skip-eligible records).               |

Evidence is keyed on `{ scopeId, gateName }` and lives under the per-Epic
tree at `temp/epic-<epicId>/validation-evidence.json` (Epic-scoped) or
`temp/epic-<epicId>/stories/story-<storyId>/validation-evidence.json`
(Story-scoped). Callers must thread both the scope id and the owning Epic
id through the wrapper. The wrapper at `evidence-gate.js` is the only
writer; close-validation, `epic-code-review`, and `/deliver` Phase 4
are the readers. `--no-evidence` on any wrapper invocation forces a re-run
and overwrites the record on success.

---

## Health-Monitor Refresh Cadence

Post-reshape the Epic Health (`epic-run-progress`) structured comment is
composed and upserted at wave-boundary by
`lib/orchestration/epic-runner/progress-reporter/composition.js`
(`upsertEpicRunProgress`, invoked via `epic-execute-record-wave.js`).
The historic `every-close` / `every-n-closes` cadence selector is no
longer operator-tunable, and the former lifecycle-bus
`structured-comment-poster` listener is deleted — the live listener
roster under `lib/orchestration/lifecycle/listeners/` is:
acceptance-reconciler, automerge-armer, automerge-predicate,
branch-cleaner, checkpoint-pointer-writer, cleaner, finalizer,
intervention-recorder, merge-watcher, notify-dispatcher, watcher.

---

## QA Session & Ledger Artifacts

`/qa-assist` (human-led) and `/qa-explore` (agent-led) share a persistent,
resumable rolling-session substrate under `<tempRoot>/qa/` (default
`temp/qa/`), owned by `lib/qa/qa-session.js`. Each session writes exactly
one append-only ndjson ledger; resume runs with the same session-id append
to — never overwrite — the existing file. Evidence MUST be scrubbed of
secrets/PII per `rules/security-baseline.md` (via `lib/qa/redact-evidence.js`)
before it reaches disk.

| Term                                     | Kind          | Definition                                                                                                                                                |
| ---------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temp/qa/<sessionId>.ndjson`             | Temp artefact | The session ledger: one `QaLedgerItem` JSON object per line, validated by `.agents/schemas/qa-ledger.schema.json`. Append-only; malformed lines are skipped on read so a crashed run still resumes. |
| `resolveQaSession({ sessionId, config, env })` | Helper  | `lib/qa/qa-session.js`. Resolves `{ sessionId, ledgerPath, reused, untriaged }`. Session-id precedence: explicit `--session-id` → `QA_SESSION_ID` env var → derived `qa-<YYYY-MM-DD>-<hex8>`. Ids are slugified (path-traversal safe). `reused: true` signals an existing ledger that must be appended to. |
| `QaLedgerItem`                           | Record shape  | Required: `id` (`L1`, `L2`, … in capture order), `class` (`product-bug` \| `environment-setup` \| `tooling-dx` \| `test-gap` \| `enhancement`), `severity` (`critical` \| `high` \| `medium` \| `low` \| `info`), `evidence` (one-line, scrubbed), `coverage` (surface/scenario label, `unknown` fallback), `missingTest` (string or `null`). Optional: `disposition`, `relates` (ids of folded-in items). |
| `disposition`                            | Field         | Two-phase lifecycle marker. Capture phase: absent, `null`, or a `pending`/`untriaged` sentinel — these items form the rolling backlog (`untriaged`) a resume run carries forward. Triage phase: `file` (promote to follow-up ticket), `defer` (park), or `dismiss` (non-actionable). `TRIAGED_DISPOSITIONS` in `qa-session.js` is the SSOT. |

---

## Retro Heuristic

| Term                       | Kind     | Definition                                                                                                                                                |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isCleanManifest(signals)` | Predicate | `lib/orchestration/retro-heuristics.js`. Returns `true` iff `friction === 0 && parked === 0 && recuts === 0 && hotfixes === 0 && hitl === 0`. Drives the compact-retro branch of the `epic-retro` helper. |
| `--full-retro`             | CLI flag | `/deliver` override forcing the six-section retro body regardless of `isCleanManifest`. Mirrors `--skip-retro` / `--skip-code-review`.                 |
