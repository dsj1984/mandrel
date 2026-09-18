# Data Dictionary

This document defines the core data structures and schemas used across the
Mandrel orchestration engine.

---

## SignalEvent (`signals.ndjson` line)

One newline-terminated JSON object emitted by `signals-writer.appendSignal`
to `temp/run-<eid>/stories/story-<sid>/signals.ndjson` (standalone Stories:
`temp/standalone/stories/story-<sid>/signals.ndjson`; and a sibling
`traces.ndjson` for `kind: trace`). Schema lives at
[`signal-event.schema.json`](../.agents/schemas/signal-event.schema.json);
the table below mirrors that schema — update both together. See
[`docs/architecture.md`](architecture.md#performance-signal-telemetry) for
the producer / detector / analyzer flow and the ADR in
[`docs/decisions.md`](decisions.md) for the events-local /
summaries-on-tickets rationale.

**Only `ts` and `kind` are required** (the envelope is
`additionalProperties: true`); the Required column mirrors the schema, not
usage. The `kind` enum holds **thirteen** values, mirrored by `EVENT_KINDS`
(`lib/signals/schema.js`): `friction`, `trace`, `wave-start`, `wave-end`,
`wave-complete`, `state-transition`, `hotspot`, `rework`, `churn`, `idle`,
`retry`, `acceptance-eval`, `notification.emitted` — `hotspot`/`churn`/`idle`
being reserved names with no shipped detector.

| Field      | Type                | Required | Description                                                                                                                |
| ---------- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ts`       | `ISO8601 date-time` | **Yes**  | Event timestamp in UTC. The single canonical timestamp key — the legacy `timestamp` alias is gone.                          |
| `kind`     | `enum` (13 values)  | **Yes**  | One of the thirteen kinds listed above. Drives detector dispatch and analyzer rollup.                                       |
| `source`   | `string` enum       | No       | **`framework` \| `consumer` only** — the classifier tag from `tagSignalSource` (`signals-writer.js`). **Not** a provenance object; the pre-#4406 `source: { tool }` shape was deleted outright. |
| `emitter`  | `object`            | No       | Provenance — `{ tool?, command? }`, where the old `source.tool` went. `tool` is the originating surface (`Bash`, `Edit`, a script name); `command` is the line blamed. |
| `epicId`   | `integer ≥ 1` \| `null` | No   | Run / parent id the event belongs to (field name retained for schema compat). Pins the on-disk path to `temp/run-<epicId>/` (standalone Stories: `temp/standalone/`). |
| `storyId`  | `integer ≥ 1` \| `null` | No   | Story the event was sampled inside. Pins the on-disk path to `story-<storyId>/`.                                            |
| `taskId`   | `integer ≥ 1` \| `null` | No   | Legacy field name; GitHub issue number when the event is scoped below Epic level. `null` for Story-wide events.              |
| `phase`    | `string` \| `null`  | No       | Execution phase the event was sampled inside (`bootstrap`, `implement`, `test`, `close`, …). `null` for raw traces outside a phase boundary. |
| `details`  | `object`            | No       | Kind-specific payload — always an object, never a bare string. Free-form; common keys `errorPreview`, `command`, `commandHash`, `targetHash`, `exitCode`, `elapsedMs`. |

---

## Retired vocabulary (archived)

Five sections whose entire body recorded that a surface was gone — they defined
no live vocabulary — are archived verbatim:
[StoryPerfSummary / EpicPerfReport](archive/data-dictionary-2026-08.md#storyperfsummary--epicperfreport),
[Dispatch Manifest](archive/data-dictionary-2026-08.md#dispatch-manifest),
[Health-Monitor Refresh Cadence](archive/data-dictionary-2026-08.md#health-monitor-refresh-cadence),
[Retro Heuristic](archive/data-dictionary-2026-08.md#retro-heuristic),
[FrictionEvent](archive/data-dictionary-2026-08.md#frictionevent-retired-shape).

A live `friction` record is a `SignalEvent` with `kind: "friction"` — see the
table above. The retired `FrictionEvent` shape it replaced is field-for-field
in the archive; Story #4938 deleted the schema file itself, and
`check-schema-references.js` keeps `.agents/schemas/` from accumulating another
contract nothing compiles.

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
| `@skip`           | Scaffold gating        | Scenario scaffolded ahead of its implementation; excluded from the gating suite until the implementing Story removes the tag (the "de-skip" edit). Unlike `@flaky`, it marks planned not-yet-implemented behavior, never instability. |

Retired: `@epic-<id>-ac-N` is inert — never apply it to new scenarios;
`mandrel update` strips surviving instances from consumer files.

---

## Orchestration Submodule Boundaries

The orchestration SDK splits its largest module into cohesive submodules
behind a façade file. Only the façade path is part of the stable public
surface; submodule paths are internal implementation detail and may be renamed
without a major version bump.

| Façade (public)                          | Submodule directory                 | Internal submodules                                                                                             |
| ---------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lib/worktree-manager.js`                | `lib/worktree/`                     | `lifecycle-manager`, `node-modules-strategy`, `bootstrapper`, `inspector`                                       |

Downstream consumers must import from the façade column. Tests and
CLI entry points inside this repository also import from the façade column —
the split is internal. See `docs/architecture.md` and `docs/patterns.md` for
the responsibility map.

---

## Deliver Runner Vocabulary

Vocabulary specific to the runner over and above the existing label/comment
taxonomy. The pre-v2 Epic-runner terms (`epic-run-state` checkpoint,
`wave-<N>-start` / `wave-<N>-end` markers) are **historical** — the Epic
tier and its wave loop were deleted in v2.0.0, and no producer writes them.

| Term                       | Kind                | Definition                                                                                                                          |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `concurrencyCap`           | Config (integer)    | `delivery.deliverRunner.concurrencyCap`; max parallel Story sub-agents in flight per ready-set beat (`stories-wave-tick.js`).       |
| Blocker-escalation         | Flow state          | Runtime pause driven by `agent::blocked`; the sole HITL touchpoint during a run.                                                    |
| Status (Projects v2)       | Project field       | Single-select custom field driven by `ColumnSync` from `agent::` labels.                                                            |

`risk::high` is metadata only — it ranks work and helps
reviewers prioritize, but does not pause execution.

### Structured-comment types

`post-structured-comment.js` (the CLI behind every framework comment) writes
typed comments. Each `type` is keyed on a stable HTML marker so reads are
idempotent; `upsertStructuredComment(provider, ticketId, type, body)` replaces
any prior comment of the same type.

This table lists only the types a producer on disk actually writes today. It is
deliberately **narrower than `STRUCTURED_COMMENT_TYPES`** in
`lib/orchestration/ticketing/reads.js`: that enum is a permissive accept-list
that retains retired kinds so historical comments on old tickets still parse
(`assertValidStructuredCommentType` would otherwise throw). Presence in the
enum is not evidence of a live writer — when adding a row here, cite the
call site.

| Type                        | Writer                                                                 | Purpose                                                                  |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `story-plan-state`          | `lib/orchestration/plan-persist/run-plan-persist.js`                    | The plan summary (story set, `depends_on` order table, deliver command), upserted on every Story `/mandrel-plan` creates. Prose only — Story #5367 deleted the machine checkpoint that used to lead the body, since nothing read it back. |
| `superseded-by`             | `lib/orchestration/plan-persist/supersede-ops.js`                       | Names the Story claiming a `/mandrel-plan --tickets` source issue, posted immediately before closing it `not_planned`. The marker is what makes a re-run non-double-commenting. |
| `verification-results`      | `lib/orchestration/code-review.js` (`runCodeReview`)                    | Unified review + lens findings on the Story; critical findings block close. Read by the feedback-loop graduators and the auto-merge integration gate. |
| `notification`              | `notify.js`; `lib/orchestration/single-story-close/phases/code-review.js` | Operator-facing severity-tiered notification.                          |
| `progress`                  | `lib/orchestration/ticketing/bulk.js` (`cascadeCompletion`)             | Cascade-completion note on a parent ticket.                              |
| `friction`                  | `lib/orchestration/story-init-remote.js`; `single-story-close/phases/` (`base-sync`, `review-block`, `confirm-merge`, `wrong-tree-guard`) | Blocker observation posted on the Story. Distinct from the on-disk `friction` **signal** (`signals-writer.appendSignal` → `signals.ndjson`), which `diagnose-friction.js` writes and never posts. |
| `follow-ups`                | `lib/orchestration/run-epilogue.js`; `lib/orchestration/story-follow-ups.js` | Actionable follow-ups distilled from friction signals at Story closeout. |
| `plan-run-audit-roster`     | `lib/orchestration/run-epilogue.js`                                     | Audit lenses selected for the run, grounded in the landed diff; opt-in (`--audit-roster`). |
| `cross-repo-deferred`       | `lib/feedback-loop/graduator-core.js`                                   | Findings routed to another repository and therefore not filed here. Discriminated by a `graduator` attr so independent graduators upsert without clobbering each other. |

**Graduation off `verification-results` is retired.** Story #5003 deleted the
audit-results graduator: it read that comment off an **Epic**, and the v2
ticket model is Story-only, so it could never resolve a finding. The surviving graduator is
`lib/feedback-loop/retro-proposals-graduator.js`, which consumes pre-parsed
findings from the retro composer rather than reading any comment.

The `mcp__mandrel__post_structured_comment` tool is **gone**; the
direct CLI is the only path. Earlier dispatcher snapshots referencing the MCP
tool are obsolete.

**No structured comment is read back as a machine payload.** Epic #946
consolidated three open-coded fence parsers onto a shared
`parseFencedJsonComment` helper; Story #5367 deleted that helper along with its
last two callers, because every fenced payload left on these comments is
written for a human reader and parsed by nobody. A comment is an operator
surface here — state a reader needs belongs in the on-disk envelopes under
`temp/`, where it is not one hand-edit away from unparseable.

---

## Resilience & Throughput Primitives

| Term                                                | Kind     | Definition                                                                                                                                                                       |
| --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resumable merge-wait (`terminal: 'pending'`)        | Contract | `single-story-close.js`'s confirm-merge phase (Story #4543) bounds each invocation by `maxWaitSeconds` and the cumulative wait by `maxBudgetSeconds` (anchored at the PR's `createdAt`). An expired invocation returns a resumable `pending` terminal naming the `nextCommand` — no label mutation — so an interrupted close is re-entrant instead of stranding the Story at `agent::closing`. Under `delivery.mergeWatch.mode: "async"` (Story #4698; default `sync`) the per-invocation wait is capped to a short probe window before returning `pending`, so slow-CI merges resume via `nextCommand` rather than a long foreground wait. |
| `signals-writer.appendSignal`                       | Helper   | Append-only NDJSON writer at `lib/observability/signals-writer.js`. Writes one JSON record per line to `temp/run-<eid>/stories/story-<sid>/signals.ndjson` (standalone: `temp/standalone/stories/story-<sid>/`). Consumers: `diagnose-friction.js`, Story close / follow-up capture, the retro's gather-signals phase. Per-kind quality-gate logic formerly in `check-crap.js` / `check-maintainability.js` now lives in `lib/baselines/kinds/{lint,coverage,crap,maintainability,mutation}.js` behind `check-baselines.js`. Replaced the deleted in-process emitter class in Epic #1030 Story #1042. |
| Launcher-level config validation                    | Contract | `validateOrchestrationConfig(config)` (from `lib/config/validate-orchestration.js`) runs at launcher startup in `plan-context.js`, `plan-persist.js`, `bootstrap.js`, and `agents-bootstrap-github.js` — a schema-invalid `.agentrc.json` exits non-zero before any long-running flow begins. |

---

## GitHub Provider Contract

| Term                              | Kind                | Definition                                                                                                                                                |
| --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHubProvider` façade           | Module set          | `providers/github.js` is a thin composition root over focused modules under `providers/github/` (`tickets`, `sub-issues`, `comments`, `labels`, `mappers`, `cache`, `errors`, `prs`, `branch-protection`, `merge-methods`, `project-board`, `issues`, …). The barrel is **not** a single public re-export point: it re-exports the `GitHubProvider` class plus the five error-classification helpers (`classifyGithubError`, `extractErrorFields`, `isPermissionSignal`, `isTransientByCodeOrMessage`, `isTransientStatus`); the remaining `providers/github/*` helpers are imported **directly** at their call sites. See [`docs/architecture.md`](architecture.md) § GitHub Provider for the full layout. |
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
| `verbose` | All levels emit, including `debug` trace output.                                                      |

`VALID_LEVELS` (`resolveLevel`) accepts **only** these three. There is no
`debug` level and no backward-compat alias for one: any other value —
`debug` included — falls back to `info`, so `AGENT_LOG_LEVEL=debug`
silently suppresses the trace output it looks like it enables. Use
`verbose`.

---

## CRAP Analysis Artefacts

Per-method complexity × coverage risk gate, sibling to the maintainability
ratchet.

| Term                                                | Kind               | Definition                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baselines/crap.json`                               | Repo-root artefact | Envelope-shaped ([`crap.schema.json`](../.agents/schemas/baselines/crap.schema.json) over [`baseline-envelope.schema.json`](../.agents/schemas/baselines/baseline-envelope.schema.json), `additionalProperties: false`): `{ $schema, kernelVersion, scoringSemantics, tsTranspilerVersion, provenanceStamped, rows }` — no run timestamp and no rollup (readers derive it from `rows`). **There is no `escomplexVersion` key** — the envelope forbids one; that stamp belongs to the legacy flat `crap-baseline.schema.json`. Rows are `{ path, method, startLine, crap }` — keyed on **`path`**, not `file` — sorted by `(path, startLine)`; alphabetized keys; trailing newline. A row adds the optional `coordinateSystem: "transpiled"` key **only** when its `startLine` stayed in transpiled coordinates because the sourcemap lookup did not resolve (#4866); its absence means original-source coordinates, so a pure-JavaScript baseline is unchanged, and rows whose provenance differs are refused rather than resolved through the nearest-line drift heuristic. A row adds `anonymous: true` only when `method` is a derived enclosing-scope-path identity rather than a source name (#4969). The gate compares three stamps: `scoringSemantics` (e.g. `"method-identity-v3"`) names the scoring-and-identity semantics that produced the rows (#4775, bumped for method identity in #4969), `tsTranspilerVersion` names the transpiler whose sourcemap resolved every TS row's coordinate (#4866), and a baseline stamped differently from the running scorer on either axis is **incomparable** — it fails closed with re-baseline guidance. `floors` check the rollup the reader derives from `rows` through the kind kernel, keyed by component (`"*"` = whole repo), each entry carrying exactly `{ p50, p95, max, methodsAbove20 }`. |
| `delivery.quality.gates.crap`                       | Config block       | `{ enabled, baselinePath, tolerance, floors, components, targetDirs, newMethodCeiling, requireCoverage, minMethodResolutionRate, ignoreGlobs, incrementalCoverage.{skipWhenUnchanged,baselineJoin,baseRef} }` — `additionalProperties: false` (first five from the shared `GATE_BASE`). Defaults in `CRAP_GATE_DEFAULTS` (`lib/config/quality.js`): `tolerance: { kind: "absolute", value: 0.05 }`, `floors: { "*": { max: 30, p95: 20, methodsAbove20: 50 } }`, `targetDirs: ["src"]`, `newMethodCeiling: 30`, `minMethodResolutionRate: 0.75`, `incrementalCoverage: { skipWhenUnchanged: true, baselineJoin: false, baseRef: null }`. The refresh tag is the fixed `baseline-refresh:` (Story #5382 removed `refreshTag`, `refreshTimeoutMs` and `friction.markerKey`). List-valued keys accept `{ append }` / `{ prepend }`. |
| `coveragePath` — **on the coverage gate**           | Config key         | `delivery.quality.gates.coverage.coveragePath` (default `"coverage/coverage-final.json"`). Moved off the CRAP gate in #1737; CRAP reads it from there. Both schemas are `additionalProperties: false`, so putting it back under `crap` is a hard AJV failure, not a no-op. |
| Hybrid enforcement                                  | Decision contract  | `compareCrap()` resolves each scanned row through four match paths: exact `(file, method, startLine)`, line-drift fallback (same `(file, method)`, shifted `startLine`), new (no match → ceiling check), removed (baseline row absent → reported, never a failure).                                                                                                          |
| `fixGuidance`                                       | Report field       | Per-violation block in the `--json` envelope: `{ crapCeiling, minComplexityAt100Cov, minCoverageAtCurrentComplexity }`. Derived deterministically from the formula; `null` when unachievable at current complexity. Round-trip property: applying either single-axis fix re-scores under target.                                                                              |
| `--changed-since <ref>`                             | CLI flag           | On `quality-preview.js` (defaults to `HEAD`). Limits scoring + comparison to files changed relative to `<ref>`. The unified gate (`check-baselines.js`) scopes via `BASELINE_SCOPE` / `BASELINE_REF` instead (diff against `main` by default). |
| `--json` / `--format json`                          | CLI flag           | `quality-preview.js` takes boolean `--json` (emits the merged machine-readable envelope on stdout); `check-baselines.js` takes `--format json\|text`. The standalone per-gate `--json <path>` writers went away with `check-crap.js` / `check-maintainability.js`; per-kind logic now lives in `lib/baselines/kinds/`. |
| `CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` / `CRAP_REFRESH_TAG` | Env vars | Override `crap.newMethodCeiling`, `crap.tolerance`, and the fixed refresh tag respectively at runtime. Malformed values warn and fall back to config — a typo must never silently relax the gate. Available for local re-runs that need base-branch values. |
| `refreshTag` (commit-message convention)            | Operator convention | A baseline edit should land in a commit whose subject starts with the fixed `refreshTag` (`baseline-refresh:`) and whose body is non-empty. No CI guardrail enforces it; the operator is the gate. |

---

## Concurrency Caps

| Term                            | Kind             | Definition                                                                                                                                          |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrentMap(items, fn, opts)` | Utility         | `lib/util/concurrent-map.js`; bounded-concurrency fanout helper. Preserves result order; rejects aggregate on the first thrown error unless the callback swallows it. |
| `lib/baseline-loader.js`        | Helper           | `readBaselineAtRef(ref, path)` resolves a baseline JSON file at an arbitrary git ref (`git show <ref>:<path>`). Used by every close-validation gate so the gate compares Story-touched files in the worktree against shared baselines on the base ref, eliminating cross-Story drift on the main checkout as a close-blocker. Added in Epic #1114. |

---

## Web-Parallel Execution

| Term                              | Kind          | Definition                                                                                                                                                                                                          |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AP_WORKTREE_ENABLED`             | Env var       | Operator override for the worktree resolver. Strict string match: `"true"` forces worktrees on; `"false"` forces worktrees off. Wins over the `CLAUDE_CODE_REMOTE` auto-detect and the committed config.            |
| `CLAUDE_CODE_REMOTE`              | Env var       | Web-session marker set automatically inside claude.ai/code. When `=== "true"` and `AP_WORKTREE_ENABLED` is unset, the resolver disables worktrees. Also drives `runtime.isRemote`.                                  |
| `CLAUDE_CODE_REMOTE_SESSION_ID`   | Env var       | Anthropic-provided web session id. Preferred input to `runtime.sessionId`; sanitised to `[a-z0-9]` and truncated to 12 chars.                                                                                       |
| `runtime.sessionId`               | Runtime field | Process-local identity, **computed but not surfaced** — no `[ENV] sessionId=…` line is emitted and the field has no consumer outside `resolveRuntime` (Story #5077). Prefers `CLAUDE_CODE_REMOTE_SESSION_ID`; falls back to a hostname+pid+random short-id. Stable across the run. |
| `resolveWorktreeEnabled(opts, env)` | Helper      | `lib/config-resolver.js`. Returns the resolved boolean (env override → web auto-detect → committed config).                                                                                                          |
| `resolveSessionId(env)`           | Helper        | `lib/config-resolver.js`. Returns the sanitised, 12-char session-id behind `runtime.sessionId`. Nothing logs or otherwise consumes it today.                                                                         |
| `resolveRuntime(opts, env)`       | Helper        | `lib/config-resolver.js`. Returns `{ worktreeEnabled, sessionId, isRemote }` plus the source attribution string. Only the worktree half reaches the startup log.                                                    |

---

## Direct CLIs

The framework ships no MCP server. Every orchestration capability is a direct
Node CLI under `.agents/scripts/`, with `lib/orchestration/ticketing.js` as the
authoritative SDK.

| Term                                       | Kind     | Definition                                                                                                                                                         |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `post-structured-comment.js`               | CLI      | `--ticket <id> --marker <key> --body-file <path>`. Wraps `upsertStructuredComment(provider, ticketId, marker, body)` from `lib/orchestration/ticketing.js`; idempotent by marker. |
| `lib/audit-suite/index.js`                 | SDK barrel | `selectAudits()` / `runAuditSuite()`. Selection reads `audit-rules.json` (schema `audit-rules.schema.json`); execution loads the selected prompts. Imported by `run-epilogue.js` and the Story-close review phases — the `select-audits.js` / `run-audit-suite.js` entry scripts were deleted, so there is no audit-suite CLI. |
| `update-ticket-state.js`                   | CLI      | Covers ticket state transitions and cascade-completion. Cascade runs inline at the SDK layer when a Story reaches `agent::done`.                                    |
| `dispatcher.js`                            | CLI      | **Deleted in v2.** Pre-v2 DAG / wave / dispatch-manifest CLI. Multi-Story ordering now uses `stories-wave-tick.js` + `lib/wave-runner/ready-set.js`. |
| `process.env`-only secrets resolution      | Contract | `notifier.js` `resolveWebhookUrl()` and the GitHub provider's `GITHUB_TOKEN` lookup read **only** from `process.env`. `.mcp.json` is not consulted as a secrets backstop.       |

---

## Validation Evidence Records

Each successful local quality gate persists a small evidence record so
identical re-runs against an unchanged tree skip the second invocation.
Evidence is per-clone, gitignored, and never committed.

| Field               | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `gateName`          | Lowercase gate identifier — closed enum in `.agents/schemas/validation-evidence.schema.json`: `typecheck`, `lint`, `test`, `format`, `coverage-capture`, `check-baselines`, `check-baselines-independent`, `check-baselines-coverage`, `quality-preview` (the last five are the real close-validation gates — Story #4697, Story #5172 for the split baselines pair, where `check-baselines` remains the unsplit fail-closed fallback, and Story #5378 for the pre-push CRAP-scope preview registered beside `coverage-capture`), plus retired `check-maintainability` / `check-crap` kept so historical evidence records still validate. |
| `commitSha`         | Output of `git rev-parse HEAD` at the time the gate ran.                             |
| `commandConfigHash` | SHA-256 of the resolved command config (script path + args + env subset).            |
| `timestamp`         | ISO-8601 UTC timestamp of the successful run.                                        |
| `exitCode`          | The wrapped command's exit code (always `0` for skip-eligible records).               |

Evidence is keyed on `{ scopeId, gateName }` and lives under the run
tree at `temp/run-<id>/validation-evidence.json` (run-scoped) or
`temp/run-<id>/stories/story-<storyId>/validation-evidence.json`
(Story-scoped; standalone Stories use
`temp/standalone/stories/story-<storyId>/validation-evidence.json`).
Callers must thread both the scope id and the owning run id through the
wrapper. The wrapper at `evidence-gate.js` is the only writer;
close-validation, code-review, and `/mandrel-deliver` Story close are the
readers. `--no-evidence` on any wrapper invocation forces a re-run
and overwrites the record on success.

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
