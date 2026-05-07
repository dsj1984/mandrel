# Data Dictionary

This document defines the core data structures and schemas used across the
Agent Protocols orchestration engine.

---

## FrictionEvent (`friction` NDJSON signal)

Appended to `temp/epic-<eid>/story-<sid>/signals.ndjson` by
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
| `taskId`   | `integer`           | Yes      | GitHub issue number of the Task / Story.                                |
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
| `lib/orchestration/dispatch-engine.js`   | `lib/orchestration/` (co-located)   | `dispatch-pipeline`, `wave-dispatcher`, `risk-gate-handler`, `health-check-service`, `epic-lifecycle-detector` |
| `lib/presentation/manifest-renderer.js`  | `lib/presentation/` (co-located)    | `manifest-formatter` (pure), `manifest-persistence` (fs I/O)                                                    |

Downstream consumers must import from the façade column. Tests, MCP tools, and
CLI entry points inside this repository also import from the façade column —
the split is internal. See `docs/architecture.md` and `docs/patterns.md` for
the responsibility map.

---

## Epic Runner Vocabulary

Vocabulary specific to the runner over and above the existing label/comment
taxonomy.

| Term                       | Kind                | Definition                                                                                                     |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `epic::auto-close`         | Label (snapshot)    | Opt-in modifier captured at dispatch. Authorises the bookend chain (`review → retro → close → merge-to-main`). |
| `epic-run-state`           | Structured comment  | HTML-marker-scoped JSON checkpoint on the Epic; single SSOT for wave progress and resume.                      |
| `wave-<N>-start`           | Structured comment  | Per-wave start marker with wave manifest and start timestamp.                                                  |
| `wave-<N>-end`             | Structured comment  | Per-wave end marker with story outcomes and duration.                                                          |
| `concurrencyCap`           | Config (integer)    | `orchestration.runners.epicRunner.concurrencyCap`; max parallel `/story-execute <storyId>` sub-agents per wave.        |
| Blocker-escalation         | Flow state          | Runtime pause driven by `agent::blocked`; the sole HITL touchpoint during a run.                               |
| Status (Projects v2)       | Project field       | Single-select custom field driven by `ColumnSync` from `agent::` labels.                                       |

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
| `wave-<N>-start`    | `WaveObserver.waveStart`                            | Per-wave start manifest + timestamp.                                     |
| `wave-<N>-end`      | `WaveObserver.waveEnd`                              | Per-wave outcomes + duration.                                            |
| `epic-plan-state`   | `/epic-plan` checkpoint                             | Phase 1/2 progress so re-plans resume cleanly.                           |
| `dispatch-manifest` | `/epic-plan` / dispatcher                           | Frozen Story manifest for the wave-gate.                                 |
| `parked-follow-ons` | dispatcher                                          | Out-of-manifest Stories surfaced at epic-close gate (recuts + parked).   |
| `story-init`        | `story-init.js`                                     | Initial Story metadata snapshot.                                         |
| `story-run-progress`| `/story-execute`                                    | Per-Task transitions inside one Story.                                   |
| `wave-run-progress` | `/wave-execute`                                     | Story-level roll-up for one wave.                                        |
| `code-review`       | `epic-code-review` helper                           | Findings report posted on the Epic.                                      |
| `retro`             | `epic-retro` helper                                 | Final retrospective body with the `retro-complete` marker.               |
| `retro-partial`     | `epic-retro` helper                                 | Mid-run checkpoint so a crashed retro can resume without re-collecting.  |
| `phase-timings`     | `phase-timer` (on `story-close`)                    | Per-phase elapsed-time spans for the closed Story.                       |
| `friction`          | `signals-writer.appendSignal` (NDJSON, on disk)     | Per-Story friction observation appended to `signals.ndjson` (no GitHub round-trip post Story #1042). |
| `notification`      | `notify.js`                                         | Operator-facing severity-tiered notification.                            |

The `mcp__agent-protocols__post_structured_comment` tool is **gone**; the
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

---

## Resilience & Throughput Primitives

| Term                                                | Kind     | Definition                                                                                                                                                                       |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CommitAssertion`                                   | Class    | Post-wave guard wired into `wave-observer`; reclassifies a `done` wave with zero new commits on `origin/story-<id>` as `halted`. Lives at `lib/orchestration/epic-runner/commit-assertion.js`. Falls back to a `resolves #<storyId>` grep on `origin/epic/<id>` when `origin/story-<id>` is already deleted by `story-close`. |
| `detectPriorPhase()`                                | Function | Recovery-state detector exported by `lib/orchestration/story-close-recovery.js`; classifies the close-time situation as `clean` / `unmerged-story-branch` / `merge-in-progress` / `dirty-worktree` so `--resume` and `--restart` can branch. |
| `--resume` / `--restart`                            | CLI flag | `story-close.js` flags. `--resume` picks up at the merge-resolution step from a failed prior close without re-running init/implement/validate; `--restart` aborts any partial state and re-inits. |
| `hierarchy-gate.js`                                 | Script   | `/epic-close` Phase 1.2 gate; walks the Epic's full sub-issue graph (Features → Stories → Tasks plus auxiliary tickets) and exits non-zero if any descendant is open or any Task is closed without `agent::done`. Pairs with `wave-gate.js` (manifest view) for the Phase 1 Feature Completeness Check. |
| `setPlan({ waves })`                                | Method   | `ProgressReporter` API. Called once at runner start so each fire renders every wave + story (queued / in-flight / done / blocked) with a `Wave` column rather than only the active wave.                |
| `progress-signals/stalled-worktree.js`              | Detector | Mechanical `ProgressReporter` detector; flags Stories where `agent::done` ships with a live `.worktrees/story-<id>/` directory still on disk.                                                          |
| `progress-signals/maintainability-drift.js`         | Detector | Mechanical detector; emits a Notable bullet when the maintainability score for any tracked file drifts negatively from the wave-start baseline.                                                        |
| `progress-signals/crap-drift.js`                    | Detector | Mechanical detector; per-method CRAP drift versus a wave-start baseline. Surfaces a `🧨 CRAP drift: <file>::<method> <score> (ceiling <N>)` bullet when a method crosses the configured ceiling or rises by ≥ threshold. |
| `signals-writer.appendSignal`                       | Helper   | Append-only NDJSON writer at `lib/observability/signals-writer.js`. Writes one JSON record per line to `temp/epic-<eid>/story-<sid>/signals.ndjson`. Consumers: `diagnose-friction.js`, `story-close.js` reap-failure (via `post-merge-pipeline.js`), `epic-runner/progress-reporter.js` poller-failure, `check-maintainability.js`, and `check-crap.js`. Replaced the deleted in-process emitter class in Epic #1030 Story #1042. |
| `--reap-discard-after-merge` / `--no-reap-discard-after-merge` | CLI flag | `/epic-close` Phase 7 flag. Default force-reaps worktrees whose Story branch is already merged into `epic/<id>` (per `git merge-base --is-ancestor`), discarding uncommitted post-merge drift; the `--no-` form preserves prior skip-on-uncommitted behavior. Force-reap emits a `friction` comment listing discarded paths. |
| Version-bump-intent snapshot                        | Checkpoint | `/epic-execute` Phase 0.5 parses the Epic body for `Release target:` / `--segment` directives and posts a `notification` structured comment on the Epic (marker `<!-- notification: version-bump-intent -->`) when they disagree with `release.autoVersionBump`.            |
| Launcher-level config validation                    | Contract | `validateOrchestrationConfig(config)` runs in `main()` of `epic-runner.js`, `plan-runner.js`, `epic-plan-spec.js`, and `epic-plan-decompose.js` — a schema-invalid `.agentrc.json` exits non-zero before any long-running flow begins. |

---

## Runtime Context

A unified runtime-context object is owned by
`.agents/scripts/lib/runtime-context.js`. It threads `provider`, `logger`,
`config`, `operatorHandle`, `cwd`, and lifecycle primitives (cancel signal,
clock) through orchestration call sites, replacing hand-rolled opts-bags.

| Term                | Kind             | Definition                                                                                                                  |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ctx`               | Object           | Unified runtime context. Frozen on creation; submodules accept it as the first argument.                                    |
| `ctx.concurrency`   | Frozen object    | `{ waveGate, commitAssertion, progressReporter }`. `CommitAssertion` and `ProgressReporter` read their cap through this.     |
| `ctx.errorJournal`  | `ErrorJournal`   | Writes structured JSONL to `temp/epic-<id>-errors.log` (one JSON object per line: `{ ts, phase, error, context }`).         |

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
rejected; downstream wave-index consumers (`manifest-builder`,
`wave-dispatcher`) tolerate rejected indices gracefully.

---

## CRAP Analysis Artefacts

Per-method complexity × coverage risk gate, sibling to the maintainability
ratchet.

| Term                                                | Kind               | Definition                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baselines/crap.json`                               | Repo-root artefact | `{ kernelVersion, escomplexVersion, rows: [{ file, method, startLine, crap }] }`. Rows deterministically sorted by `(file, startLine)`; alphabetized keys; trailing newline. `kernelVersion` bumps when the inline CRAP formula changes; `escomplexVersion` bumps with the `typhonjs-escomplex` dependency. A baseline whose stamps don't match the running scorer fails closed. |
| `agentSettings.quality.crap`                        | Config block       | `{ enabled, targetDirs, newMethodCeiling, coveragePath, tolerance, requireCoverage, friction.markerKey, refreshTag }`. Defaults: `enabled: true`, `targetDirs: ["src"]`, `newMethodCeiling: 30`, `coveragePath: "coverage/coverage-final.json"`, `tolerance: 0.05`, `requireCoverage: true`, `refreshTag: "baseline-refresh:"`. List-valued keys accept `{ append }` / `{ prepend }`. |
| Hybrid enforcement                                  | Decision contract  | `compareCrap()` resolves each scanned row through four match paths: exact `(file, method, startLine)`, line-drift fallback (same `(file, method)`, shifted `startLine`), new (no match → ceiling check), removed (baseline row absent → reported, never a failure).                                                                                                          |
| `fixGuidance`                                       | Report field       | Per-violation block in the `--json` envelope: `{ crapCeiling, minComplexityAt100Cov, minCoverageAtCurrentComplexity }`. Derived deterministically from the formula; `null` when unachievable at current complexity. Round-trip property: applying either single-axis fix re-scores under target.                                                                              |
| `--changed-since <ref>`                             | CLI flag           | On `check-crap.js` and `check-maintainability.js`. Limits scoring + comparison to files in `git diff --name-only <ref>...HEAD`. Bad ref → non-zero exit (no silent degradation to "no regressions").                                                                                                                                                                          |
| `--json <path>`                                     | CLI flag           | On both gates. Writes `{ kernelVersion, summary, violations }`; CRAP envelope adds `fixGuidance` per violation.                                                                                                                                                                                                                                                              |
| `CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` / `CRAP_REFRESH_TAG` | Env vars | Override `crap.newMethodCeiling`, `crap.tolerance`, and `crap.refreshTag` respectively at runtime. Malformed values warn and fall back to config — a typo in CI must never silently relax the gate. Used by the `baseline-refresh-guardrail` job to force base-branch values on the PR-branch run.                                                                            |
| `baseline-refresh-guardrail.js`                     | CLI script         | Reads `<baseRef>:.agentrc.json` via `git show`, applies env-overrides, lists changed files + commits since base, evaluates the refresh-tag rule, and (on a baseline-only PR) idempotently applies the `review::baseline-refresh` label.                                                                                                                                       |
| `review::baseline-refresh`                          | PR label           | Auto-applied to PRs whose diff touches **only** `baselines/crap.json` and/or `baselines/maintainability.json`. Idempotent across CI re-runs.                                                                                                                                                                                                                                  |
| `refreshTag` (commit-message rule)                  | Validation contract | A PR that modifies any baseline file must include at least one commit whose subject starts with the configured `refreshTag` (default `baseline-refresh:`) AND whose body is non-empty. Both conditions are required.                                                                                                                                                          |

---

## Concurrency Caps

| Term                            | Kind             | Definition                                                                                                                                          |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestration.concurrency`     | Config block     | `{ waveGate: integer ≥ 0, commitAssertion: integer ≥ 1, progressReporter: integer ≥ 1 }`. All keys optional. Defaults: `0` / `4` / `8`. `additionalProperties: false`. |
| `resolveConcurrency(source)`    | Helper           | `lib/orchestration/concurrency.js`. Returns a frozen `{ waveGate, commitAssertion, progressReporter }`. Falls back to defaults on missing/malformed values. |
| `concurrentMap(items, fn, opts)` | Utility         | `lib/util/concurrent-map.js`; bounded-concurrency fanout helper. Preserves result order; rejects aggregate on the first thrown error unless the callback swallows it. |
| `aggregate-phase-timings.js`    | CLI              | Reads `phase-timings` structured comments across Story tickets, computes per-phase p50/p95, emits a markdown summary plus recommended concurrency caps. Zero-sample runs exit 1 with the framework defaults recommended. |

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
| `orchestration.runners.closeRetry`| Config block  | `{ maxAttempts: integer ≥ 1, backoffMs: integer[] }`. Both keys optional. Defaults: `maxAttempts: 3`, `backoffMs: [250, 500, 1000]`. Drives the bounded retry on the epic-branch push at story close.                |
| `pushEpicWithRetry(...)`          | Helper        | `lib/push-epic-retry.js`. Wraps the `git push origin epic/<id>` step with fetch-replay-push retry on non-fast-forward rejection. Aborts cleanly on real content conflicts; never destroys local work.                |
| `runDispatchManifestGuard(opts)`  | Helper        | `lib/story-init/dependency-guard.js`. Pre-flight blocker check at `story-init.js` startup. Refuses launch if any of the story's blockers are unmerged.                                                              |

---

## Direct CLIs

The framework ships no MCP server. Every orchestration capability is a direct
Node CLI under `.agents/scripts/`, with `lib/orchestration/ticketing.js` as the
authoritative SDK.

| Term                                       | Kind     | Definition                                                                                                                                                         |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `post-structured-comment.js`               | CLI      | `--ticket <id> --marker <key> --body-file <path>`. Wraps `upsertStructuredComment(provider, ticketId, marker, body)` from `lib/orchestration/ticketing.js`; idempotent by marker. |
| `select-audits.js` / `run-audit-suite.js`  | CLI      | Selection reads `audit-rules.json` (manifest schema: `audit-rules.schema.json`); suite execution loads the selected workflow prompts.                              |
| `hydrate-context.js` / `context-hydrator.js` | CLI    | `hydrate-context.js --ticket <id> --epic <id>` emits the JSON envelope. `context-hydrator.js --task <id> --epic <id>` is the raw-prompt wrapper used by operator workflows. |
| `update-ticket-state.js`                   | CLI      | Covers ticket state transitions and cascade-completion. Cascade runs inline at the SDK layer when a Story's last open Task closes.                                  |
| `dispatcher.js`                            | CLI      | Builds the dependency DAG, computes execution waves, dispatches stories. Invoked by `/epic-plan` Phase 3.                                                           |
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

Evidence is keyed on `{ scopeId, gateName }` and lives at
`temp/validation-evidence-<scopeId>.json`. The wrapper at `evidence-gate.js`
is the only writer; close-validation, `epic-code-review`, and `/epic-close`
Phase 4 are the readers. `--no-evidence` on any wrapper invocation forces a
re-run and overwrites the record on success.

---

## Health-Monitor Refresh Cadence

`agentSettings.healthMonitor.refreshCadence` selects how often the Epic Health
structured comment is refreshed during Epic execution:

| Value             | Behaviour                                                                  |
| ----------------- | -------------------------------------------------------------------------- |
| `every-close`     | Refresh on every story-close.                                              |
| `wave-boundary`   | Refresh only at wave transitions and at epic-close. **Default.**           |
| `every-n-closes`  | Refresh every Nth close, where N comes from `healthMonitor.everyNCloses`.  |

`wave-boundary` is the recommended setting for large Epics; the per-close
refresh is preserved as `every-close` for projects that prefer continuous
health visibility.

---

## Retro Heuristic

| Term                       | Kind     | Definition                                                                                                                                                |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isCleanManifest(signals)` | Predicate | `lib/orchestration/retro-heuristics.js`. Returns `true` iff `friction === 0 && parked === 0 && recuts === 0 && hotfixes === 0 && hitl === 0`. Drives the compact-retro branch of the `epic-retro` helper. |
| `--full-retro`             | CLI flag | `/epic-close` override forcing the six-section retro body regardless of `isCleanManifest`. Mirrors `--skip-retro` / `--skip-code-review`.                 |
