# Configuration Reference

`.agentrc.json` is the single configuration contract for the Agent Protocols
framework. It is parsed at the start of every script via
[`config-resolver.js`](../.agents/scripts/lib/config-resolver.js), validated
against AJV schemas at runtime, and consumed through grouped accessors
(`getCommands()`, `getQuality()`, `getPaths()`, `getLimits()`).

This document is the reader-facing reference for the post-Epic-#730 grouped
shape. The authoritative contract is the JSON Schema mirror at
[`.agents/schemas/agentrc.schema.json`](../.agents/schemas/agentrc.schema.json),
which is itself a mirror of the AJV schemas in
[`.agents/scripts/lib/config-schema.js`](../.agents/scripts/lib/config-schema.js)
and
[`.agents/scripts/lib/config-settings-schema.js`](../.agents/scripts/lib/config-settings-schema.js).
A drift test (`tests/config-schema-mirror-drift.test.js`) keeps the static
mirror aligned with the runtime validators.

> **Editor support.** Both `.agentrc.json` and `.agents/default-agentrc.json`
> declare `"$schema": "./.agents/schemas/agentrc.schema.json"`, so any editor
> with JSON Schema support gets autocomplete and inline validation.

## Top-level shape

```jsonc
{
  "$schema": "./.agents/schemas/agentrc.schema.json",
  "agentSettings": { /* paths, commands, quality, limits, ... */ },
  "orchestration":  { /* provider, github, worktreeIsolation, deliverRunner, ... */ }
}
```

| Top-level key   | Required | Purpose                                               |
| --------------- | -------- | ----------------------------------------------------- |
| `agentSettings` | Yes      | Project-local execution behaviour (paths, commands, quality gates, limits). |
| `orchestration` | Yes      | Ticketing provider + runner tuning (GitHub, worktree, runners). |
| `release`       | No       | Release / version-bump tuning (`autoVersionBump`, `bumpFiles`, `docs`, `safetyChecks`). |
| `$schema`       | No       | JSON Schema pointer for editor tooling.               |
| `title`         | No       | Free-form display label.                              |

---

## `agentSettings`

The grouped shape post-#730. Every former flat setting now lives under one of
the four sub-blocks below: `paths`, `commands`, `quality`, `limits`. There are
no flat-key reads anywhere in the resolver or in any consumer.

The schema requires only `paths`. All other sub-blocks are optional and fall
back to documented defaults (or are no-ops when omitted).

### `agentSettings.paths` (required)

Filesystem roots the framework reads from. `agentRoot`, `docsRoot`, and
`tempRoot` are required — the resolver no longer applies code-level fallbacks
(e.g. `?? '.agents'`); a missing value is a validation error with a clear
`instancePath`.

| Field            | Required | Default                  | Purpose                                          |
| ---------------- | -------- | ------------------------ | ------------------------------------------------ |
| `agentRoot`      | Yes      | (none — must be set)     | Path to the framework submodule (e.g. `.agents`). |
| `docsRoot`       | Yes      | (none — must be set)     | Path to project documentation (e.g. `docs`).      |
| `tempRoot`       | Yes      | (none — must be set)     | Path for ephemeral artefacts (e.g. `temp`).       |
| `auditOutputDir` | No       | `temp`                   | Override for audit-orchestrator output.           |
| `scriptsRoot`    | No       | `.agents/scripts`        | Path to the framework's CLI scripts.              |
| `workflowsRoot`  | No       | `.agents/workflows`      | Path to slash-command workflow definitions.       |
| `personasRoot`   | No       | `.agents/personas`       | Path to persona behaviour packs.                  |
| `schemasRoot`    | No       | `.agents/schemas`        | Path to JSON Schemas.                             |
| `skillsRoot`     | No       | `.agents/skills`         | Path to skill library (core + stack).             |
| `templatesRoot`  | No       | `.agents/templates`      | Path to context-hydration templates.              |
| `rulesRoot`      | No       | `.agents/rules`          | Path to domain-agnostic baseline rules.           |

The seven `*Root` directories carry framework defaults; consumers only need to
override them when the bundle lives somewhere other than `.agents/<subdir>`.

### `agentSettings.commands`

Executable strings the framework spawns for validation, testing, and baseline
ratchets. Strings must be non-empty and pass the shell-injection guard
(`safeString` — disallows `;`, `&`, `|`, backtick, `$(`).

`typecheck` and `build` are nullable to indicate "not applicable for this
repo"; `null` is the canonical disabled value, empty strings are rejected.

| Field             | Required | Default | Type            | Purpose                                                 |
| ----------------- | -------- | ------- | --------------- | ------------------------------------------------------- |
| `validate`        | No       | (none)  | `string`        | Comprehensive pre-merge check (e.g. `npm run lint`).    |
| `lintBaseline`    | No       | (none)  | `string`        | Structured-output linter for the lint ratchet.          |
| `test`            | No       | (none)  | `string`        | Project test runner.                                    |
| `typecheck`       | No       | `null`  | `string \| null` | Strict type-checking. `null` = disabled.                |
| `build`           | No       | `null`  | `string \| null` | Production build. `null` = disabled.                    |
| `formatCheck`     | No       | `npx biome format .` | `string`  | Read-only format check used by close-validation. Configurable for Prettier / dprint repos. |
| `formatWrite`     | No       | `npx biome format --write .` | `string` | Auto-format invocation used by `runFormatAutofix`. Pair with `formatCheck`. |

Read with `getCommands(config)` — see
[`config-resolver.js`](../.agents/scripts/lib/config-resolver.js).

### `agentSettings.quality`

Maintainability, CRAP, lint baseline, and PR-gate configuration. All four
sub-blocks are optional; the gates self-skip when their config is absent or
disabled.

#### `agentSettings.quality.baselines`

Pointers to the three canonical ratchet baseline files. See
[Baseline conventions](#baseline-conventions) below for the canonical-vs-drift
file split.

| Field                        | Required | Default                          | Purpose                                                  |
| ---------------------------- | -------- | -------------------------------- | -------------------------------------------------------- |
| `lint.path`                  | Yes\*    | `baselines/lint.json`            | Path to lint ratchet baseline (relative to repo root).   |
| `lint.refreshCommand`        | No       | (none)                           | Override command to regenerate the lint baseline.        |
| `crap.path`                  | Yes\*    | `baselines/crap.json`            | Path to CRAP per-method baseline.                        |
| `crap.refreshCommand`        | No       | (none)                           | Override command to regenerate the CRAP baseline.        |
| `maintainability.path`       | Yes\*    | `baselines/maintainability.json` | Path to maintainability per-file baseline.               |
| `maintainability.refreshCommand` | No   | (none)                           | Override command to regenerate the MI baseline.          |

\* `path` is required *if* the corresponding baseline entry is present. The
entire `baselines.<gate>` block is optional — omit it to disable the
corresponding gate.

#### `agentSettings.quality.maintainability`

| Field        | Required | Default | Purpose                                                          |
| ------------ | -------- | ------- | ---------------------------------------------------------------- |
| `targetDirs` | No       | `["src"]` (resolver fallback) | Directories scanned by the MI engine. Accepts `["a", "b"]` or `{ "append": [...] }` / `{ "prepend": [...] }` deep-merge forms. |

#### `agentSettings.quality.crap`

Per-method CRAP gate. See [`docs/quality-gates.md`](quality-gates.md)
"CRAP Gate — Consumer Onboarding" for first-run behaviour and
consumer-extension guidance.

| Field             | Required           | Default      | Purpose                                                         |
| ----------------- | ------------------ | ------------ | --------------------------------------------------------------- |
| `enabled`         | No                 | `true`       | Master switch. `false` makes all three gate sites self-skip.    |
| `targetDirs`      | No                 | `["src"]`    | Source dirs to score. Accepts list or `{ append/prepend }` form. |
| `newMethodCeiling`| No                 | `30`         | Max CRAP score allowed for methods absent from the baseline.    |
| `coveragePath`    | Conditional        | `coverage/coverage-final.json` | Required when `enabled: true` and `requireCoverage: true`. |
| `tolerance`       | No                 | `0.05`       | Floating-point slack when comparing scores against baseline. Raised 0.001 → 0.05 in 5.36.1 — cross-environment coverage rounding produces ~0.01 drift on a clean rebuild. |
| `requireCoverage` | No                 | `true`       | When `true`, methods without coverage are skipped (not failed). |
| `friction.markerKey` | No              | `crap-baseline-regression` | Friction-log marker for regressions.              |
| `refreshTag`      | No                 | `baseline-refresh:` | Subject prefix the refresh-guardrail expects on baseline-only commits. |

##### Coverage capture path

The CRAP gate reads per-method coverage from `crap.coveragePath` (default
`coverage/coverage-final.json`) and skips any method without an entry under
`requireCoverage: true`. A missing or stale artifact silently weakens the gate,
so coverage is captured in-band at every gate site:

| Site                            | Capture command                                                                  | Behaviour                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `close-validation` (pre-flight) | `node .agents/scripts/coverage-capture.js`                                       | Runs as a gate immediately before `check-crap`. Skips when the artifact's mtime is ≥ the newest mtime in `crap.targetDirs`; otherwise runs `npm run test:coverage` and propagates its exit. |
| `.husky/pre-push`               | `node .agents/scripts/coverage-capture.js --skip-when-no-crap-files --ref main`  | Same freshness check, plus a fast-path: skips entirely when no file under `crap.targetDirs` is in the `main...HEAD` diff.                                  |
| `.github/workflows/ci.yml`      | `npm run test:coverage` (existing) + `Upload Coverage Artifact` step             | The coverage map is uploaded as the `coverage-final-node-22` artifact (`if: always()`) so downstream agent workflows can replay it without re-running tests. |

Both CLI sites self-skip when `crap.enabled === false`. The capture step is
idempotent on warm worktrees — only stale or missing artifacts trigger a
test:coverage run.

##### Missing-baseline behaviour

With `crap.enabled: true` and `baselines/crap.json` absent, all three gate
sites fail closed (exit 1).
Bootstrap the baseline explicitly: `npm run test:coverage` to produce
`coverage/coverage-final.json`, then `npm run crap:update` to write
`baselines/crap.json`, and commit the file with a `baseline-refresh:` tagged
subject + non-empty body so the refresh-guardrail accepts it.

#### `agentSettings.quality.prGate`

Promoted from schema-only to default config in 5.40.0 (Epic #1142). The
`checks` array drives both the close-validation chain inside
`/epic-deliver` Phase 3 and the required-status-checks expectation that
`/epic-deliver` Phase 6 sets on the PR. `enforceBranchProtection` is the
load-bearing knob that controls whether `/agents-bootstrap-github`
creates branch protection on `main` — load-bearing because the PR merge
is now the sole promotion gate to `main`.

| Field                       | Required | Default                                                              | Purpose                                                                                                                                                                |
| --------------------------- | -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks`                    | No       | `["validate", "test", "lint-baseline", "crap-check", "maintainability"]` | Required-status-check names enforced by branch protection and re-run inside `/epic-deliver` Phase 3.                                                                  |
| `enforceBranchProtection`   | No       | `true`                                                               | When `true`, `/agents-bootstrap-github` calls `ensureMainBranchProtection({ checks })` to create or merge protection on `main`. Set to `false` to opt out (not recommended). |

Read with `getQuality(config)` (composes `getBaselines`, MI, CRAP, prGate
sub-objects).

### `agentSettings.limits`

Resource and friction-detector ceilings. All fields are positive integers; the
resolver accepts the block as a whole and exposes `getLimits()`.

| Field                | Required | Default | Purpose                                                            |
| -------------------- | -------- | ------- | ------------------------------------------------------------------ |
| `maxInstructionSteps`| No       | `5`     | Soft cap on instruction-set steps (planning hint).                 |
| `maxTickets`         | No       | `40`    | Soft cap on tickets a single Epic may decompose.                   |
| `maxTokenBudget`     | No       | `200000`| Soft cap on per-call token budget (planning hint).                 |
| `executionTimeoutMs` | No       | `300000`| Per-spawn timeout for child processes the framework launches.       |
| `executionMaxBuffer` | No       | `10485760` | Max stdout/stderr buffer (bytes) for child processes.            |

#### `agentSettings.limits.friction`

Anti-thrashing thresholds. The friction logger flips a Story to `agent::blocked`
when any of these are tripped.

| Field                    | Required | Default | Purpose                                                |
| ------------------------ | -------- | ------- | ------------------------------------------------------ |
| `repetitiveCommandCount` | No       | `3`     | Identical commands run consecutively before halting.   |
| `consecutiveErrorCount`  | No       | `3`     | Tool errors in a row before halting.                   |
| `stagnationStepCount`    | No       | `5`     | Analysis-only steps without a file edit before halting. |
| `maxIntegrationRetries`  | No       | `2`     | Retries permitted on integration-test phases.          |

#### `agentSettings.limits.planningContext`

Caps the size of `--emit-context` JSON payloads emitted during `/epic-plan`
so a runaway PRD / Tech Spec can't blow the planning agent's context budget.
Added in Epic #817 Story 9.

| Field         | Required | Default  | Purpose                                                                  |
| ------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `maxBytes`    | No       | `50000`  | Hard ceiling on the JSON payload size (bytes). Truncation is summary-mode-aware. |
| `summaryMode` | No       | `'auto'` | `'auto'` truncates intelligently; `'off'` errors over the cap; `'always'` always summarizes. |

### Other `agentSettings` keys

| Field              | Required | Default | Purpose                                                                                  |
| ------------------ | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `baseBranch`       | No       | (none)  | Default branch name (e.g. `main`). Read by close, push, and rebase paths.                |
| `release.docs`     | No       | `[]`    | Files refreshed during the post-PR-merge release tagging step.                           |
| `release.versionFile` | No    | `null`  | Path to a version file the release helper bumps. `null` skips file bumping.              |
| `release.packageJson` | No    | `false` | When `true`, the release helper bumps `package.json` `version`.                          |
| `release.autoVersionBump` | No | `false` | Enables automatic semver bumping at release tagging.                                    |
| `planning.riskHeuristics` | No | `[]`  | Free-form rubric for `risk::high` decisions (informational). Renamed in 5.40.0 (Epic #1142); the prior name lives in `docs/CHANGELOG.md` 5.40.0 entry. |
| `docsContextFiles` | No       | `[]`    | Files context-hydrator includes when assembling agent prompts.                           |

---

## `orchestration`

| Field             | Required | Default | Purpose                                                            |
| ----------------- | -------- | ------- | ------------------------------------------------------------------ |
| `provider`        | Yes      | (none)  | Ticketing provider. `"github"` is the only shipped value.          |
| `github`          | Yes\*    | (none)  | Required when `provider: "github"`. See sub-block.                 |
| `executor`        | No       | (none)  | Executor adapter id (advanced; rarely set).                        |
| `notifications`   | No       | `{}`    | Notifier behaviour. See sub-block.                                 |
| `worktreeIsolation` | No     | (see sub-block) | Worktree-per-Story isolation tuning.                            |
| `deliverRunner`   | No       | (see sub-block) | `/epic-deliver` fan-out tuning. Renamed in 5.40.0; the prior name is documented in the CHANGELOG 5.40.0 entry. |
| `planRunner`      | No       | (see sub-block) | Plan-runner tuning.                                             |
| `concurrency`     | No       | (none)  | Internal concurrency caps for wave gates and assertions.            |
| `storyMergeRetry` | No       | (none)  | Retry policy for `story-close.js` non-fast-forward pushes. Renamed in 5.40.0; the prior name is documented in the CHANGELOG 5.40.0 entry. |

### `orchestration.github`

| Field            | Required | Purpose                                                            |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `owner`          | Yes      | GitHub repository owner (user or org).                              |
| `repo`           | Yes      | GitHub repository name.                                             |
| `projectNumber`  | No       | GitHub Projects V2 number for custom field writes.                  |
| `projectOwner`   | No       | Project board owner (defaults to `owner`).                          |
| `projectName`    | No       | Optional human-readable project label.                              |
| `operatorHandle` | No       | `@`-prefixed handle used in operator @mentions.                     |

### `orchestration.notifications`

| Field              | Required | Default                                  | Purpose                                                                                                                                       |
| ------------------ | -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `mentionOperator`  | No       | `false`                                  | When `true`, friction comments @-mention `operatorHandle`.                                                                                    |
| `commentMinLevel`  | **Yes**  | `medium`                                 | Minimum severity that posts a GitHub comment (`low`/`medium`/`high`).                                                                          |
| `terminalMinLevel` | **Yes**  | `medium`                                 | Minimum severity that emits `notify()` chatter to stdout (`low`/`medium`/`high`).                                                              |
| `webhookEvents`    | **Yes**  | `["epic-started", "epic-progress", "epic-blocked", "epic-unblocked", "epic-complete"]` | Allowlist of event names that reach `NOTIFICATION_WEBHOOK_URL`. The webhook channel is curated for the epic narrative (% progress + blockers); story-level events are excluded by default. |

> **Two gating models in one block.** Comment + terminal channels are
> severity-gated (`commentMinLevel`, `terminalMinLevel`); the webhook
> channel is event-name-gated (`webhookEvents`). Severity is no longer a
> routing factor for the webhook — it is carried as envelope metadata for
> Slack consumers that color-code by it. To suppress the webhook entirely,
> set `webhookEvents: []`. To add story-level chatter back to Slack,
> extend the array (allowed values are the closed `epic-*` vocabulary in
> the schema enum; loosen the enum to add custom events).
>
> **Severity assignment by event hierarchy.** Task transitions and
> `story-run-progress` upserts fire `low` (frequency-driven). Story state
> transitions, `wave-run-progress`, `epic-run-progress`, and
> epic-completion fire `medium`. Epic blockers and HITL gates fire `high`
> (webhook prefix `[Action Required]` when an allowlisted blocker event
> reaches the webhook). Per-Task `agent::executing` transitions during
> Story init batch into a single Story-level summary comment that never
> reaches the webhook (no `event` field).
>
> **Curated webhook event vocabulary.** Five `epic-*` events drive the
> Slack narrative: `epic-started` (kickoff anchor), `epic-progress`
> (wave-boundary + post-blocker snapshots carrying
> `{ pct, done, total, currentWave, totalWaves, openBlockers }`),
> `epic-blocked` (`[Action Required]`), `epic-unblocked` (operator
> resumed), `epic-complete` (terminal). `epic-progress` fires strictly on
> event boundaries — wave N → N+1, blocker raise, blocker clear — not on
> a periodic timer, so volume tracks the epic narrative rather than
> story-execution churn.
>
> **Typed webhook envelope.** Webhook subscribers receive
> `{ text, severity, ticketId, event?, level?, epicId?, phase? }`. `text`
> stays populated for back-compat with `{text}`-only consumers; the typed
> fields let routable subscribers filter by event or hierarchy level.

### `orchestration.worktreeIsolation`

Story-level worktree isolation. When `enabled: true`, `/story-execute` runs
each Story inside `.worktrees/story-<id>/` instead of moving the main
checkout's HEAD.

| Field                            | Required        | Default          | Purpose                                                     |
| -------------------------------- | --------------- | ---------------- | ----------------------------------------------------------- |
| `enabled`                        | No              | `false`          | Master switch.                                              |
| `root`                           | Conditional     | `.worktrees`     | Required when `enabled: true`. Worktree parent directory.    |
| `nodeModulesStrategy`            | No              | `per-worktree`   | One of `per-worktree`, `symlink`, `pnpm-store`.              |
| `primeFromPath`                  | No              | `null`           | Optional source path used to prime `node_modules`.            |
| `allowSymlinkOnWindows`          | No              | `false`          | Permit symlink strategy on Windows (requires admin/dev mode). |
| `reapOnSuccess`                  | No              | `true`           | Reap the worktree after a successful Story close.            |
| `reapOnCancel`                   | No              | `true`           | Reap the worktree if the Story is cancelled.                 |
| `windowsPathLengthWarnThreshold` | No              | (none)           | Emit a warning when the worktree path exceeds this length.    |
| `bootstrapFiles`                 | No              | `[]`             | Untracked files (e.g. `.env`) copied into each new worktree. |

### `orchestration.runners`

Epic #773 (Story 7) grouped every runner-flavoured sub-block under
`orchestration.runners.*`. Pre-#773 flat keys (the legacy
`orchestration.epic-runner`-style flat layout) are no longer accepted —
the schema rejects them with `additionalProperties: false`. Epic #1142
Story #1157 renamed two of the grouped sub-blocks; the rename details
and the legacy → new key mapping live in `docs/CHANGELOG.md` under the
5.40.0 entry. The legacy names are rejected by AJV; the merged
`default-agentrc.json` ships with the new names.

#### `orchestration.runners.deliverRunner`

| Field                       | Required        | Default | Purpose                                                  |
| --------------------------- | --------------- | ------- | -------------------------------------------------------- |
| `enabled`                   | No              | `true`  | Master switch.                                           |
| `concurrencyCap`            | Conditional     | `3`     | Required unless `enabled: false`. Max parallel Story sub-agents per wave. |
| `pollIntervalSec`           | No              | `30`    | Wave-state poll interval (seconds).                      |
| `progressReportIntervalSec` | No              | `120`   | Progress-report cadence (seconds).                       |
| `idleTimeoutSec`            | No              | `900`   | Kill a Story sub-agent after this many idle seconds.     |
| `logsDir`                   | No              | `temp/epic-runner-logs` | Directory for per-Epic progress logs.            |

#### `orchestration.runners.planRunner`

| Field             | Required | Default | Purpose                                       |
| ----------------- | -------- | ------- | --------------------------------------------- |
| `enabled`         | No       | `true`  | Master switch.                                |
| `pollIntervalSec` | No       | `30`    | Plan-runner poll cadence.                     |

#### `orchestration.runners.concurrency`

| Field              | Required | Default | Purpose                                          |
| ------------------ | -------- | ------- | ------------------------------------------------ |
| `waveGate`         | No       | (none)  | Concurrency cap for wave-gate phase.              |
| `commitAssertion`  | No       | (none)  | Concurrency cap for commit-assertion phase.       |
| `progressReporter` | No       | (none)  | Concurrency cap for progress-reporter phase.      |

#### `orchestration.runners.storyMergeRetry`

| Field         | Required | Default                | Purpose                                       |
| ------------- | -------- | ---------------------- | --------------------------------------------- |
| `maxAttempts` | No       | `3`                    | Max retries on non-fast-forward push.          |
| `backoffMs`   | No       | `[250, 500, 1000]`     | Per-attempt backoff (ms).                     |

#### `orchestration.runners.decomposer`

| Field            | Required | Default | Purpose                                                          |
| ---------------- | -------- | ------- | ---------------------------------------------------------------- |
| `concurrencyCap` | No       | `3`     | Max parallel decomposer Stories during `/epic-plan` Phase 2 fan-out. |

---

## Root dogfood vs distributed template

Two `.agentrc`-shaped files live in this repository and serve different
audiences. They share the same schema but legitimately disagree on a small
number of keys.

| File                            | Audience                            | Role                                                                                                                                |
| ------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `.agentrc.json` (repo root)     | The framework dogfooding itself     | Live config used when running `/epic-*` and `/story-execute` workflows against this repo. Exercises the framework end-to-end on its own source tree. |
| `.agents/default-agentrc.json`  | Downstream consumer repos           | Template a consumer copies via `cp .agents/default-agentrc.json .agentrc.json` when bootstrapping. Sane defaults for any repo.      |

| Key                                       | Root dogfood                          | Distributed template                | Why they differ                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentSettings.commands.lintBaseline`     | `npm run lint`                        | `npx eslint . --format json`        | Root piggybacks on the repo's existing lint script; consumer template assumes a generic ESLint setup with structured output.                                                              |
| `agentSettings.quality.maintainability.targetDirs` | `[".agents/scripts", "tests"]` | `["src", "tests"]`                  | Root scans the framework's own source tree; consumer template scans the conventional `src/`.                                                                                              |
| `agentSettings.quality.crap.targetDirs`   | `[".agents/scripts"]`                 | `["src"]`                           | Same reason as MI above.                                                                                                                                                                  |
| `agentSettings.release.docs`              | `["README.md", "docs/CHANGELOG.md"]`  | `["README.md"]`                     | Root keeps a separate CHANGELOG; template starts minimal and lets consumers extend.                                                                                                       |
| `agentSettings.release.versionFile`       | `".agents/VERSION"`                   | `null`                              | Root tracks the framework's own version file; consumer template defers version-file ownership to the consumer.                                                                            |
| `orchestration.github.owner` / `.repo` / `.projectNumber` / `.projectOwner` / `.operatorHandle` | Populated for `dsj1984/agent-protocols` | `[OWNER]` / `[REPO]` / `null` / `null` / `@[USERNAME]` | Repo-specific identifiers; placeholders in the template are replaced during `/agents-bootstrap-github` (or by hand). |
| `orchestration.worktreeIsolation.nodeModulesStrategy` | `per-worktree`             | `pnpm-store`                        | Root is npm-only; template defaults to the strategy that scales best for pnpm consumers.                                                                                                  |

The two files share every other key. When a consumer runs `/agents-update`,
the [`agents-sync-config`](../.agents/workflows/helpers/agents-sync-config.md)
helper validates the project config against the schema, then adds any
template-introduced keys the project does not already define. Project-side
values that validate are preserved unconditionally — including optional keys
the template does not declare.

> **Editing rule of thumb:** edit `.agents/default-agentrc.json` for changes
> that should ship to consumers; edit `.agentrc.json` for changes that only
> affect this repo's own dogfood runs.

---

## Baseline conventions

The framework writes two distinct kinds of baseline file. They are intentionally
separated so a repo-wide grep never confuses one with the other.

### Canonical ratchet baselines — `/baselines/`

Committed, schema-pointed baselines that gate every PR via close-validation,
the lint ratchet, and the CRAP/MI gates.

| File                              | Owner                              | Refresh                                                  |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `baselines/lint.json`             | `lint-baseline.js`                 | `node .agents/scripts/lint-baseline.js --refresh`         |
| `baselines/crap.json`             | `update-crap-baseline.js`          | `npm run crap:update` (or the configured `refreshCommand`) |
| `baselines/maintainability.json`  | `update-maintainability-baseline.js` | `npm run maintainability:update` (or the configured `refreshCommand`)  |

These files are the contract. They are read by every gate (Story close, push
hook, CI) and are regenerated only via tagged `baseline-refresh:` commits with
a non-empty body — see the `baseline-refresh-guardrail` job and the CRAP
section of [`docs/quality-gates.md`](quality-gates.md) for the policy.

Paths are configured in `agentSettings.quality.baselines.<gate>.path`. The
default values match the canonical layout above; override only when a project
genuinely stores baselines elsewhere.

### Per-wave drift snapshots — `.agents/state/`

The Epic runner's progress reporter writes wave-start snapshots so that a
resumed run can detect intra-wave drift without re-reading the canonical
baseline (which may have been refreshed mid-Epic).

| File                                  | Owner                                                                                  | Lifecycle                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| `.agents/state/wave-mi-snapshot.json` | `progress-signals/maintainability-drift.js`                                            | Captured at wave-start; overwritten next wave. |
| `.agents/state/wave-crap-snapshot.json` | `progress-signals/crap-drift.js`                                                     | Captured at wave-start; overwritten next wave. |

These are **not** ratchet baselines and must not be committed as such. The
filenames intentionally differ from the canonical files so a repo-wide grep
for `baselines/maintainability.json` or `baselines/crap.json` only ever hits
the canonical paths.

The `.agents/state/` directory itself is created on demand by the progress
reporter; the framework does not require it to exist ahead of time and does
not commit its contents.

---

## How to extend

### Adding a project-specific optional key

The schema-driven sync helper preserves every project-side key that validates,
including optional keys absent from the distributed template. To add a
project-specific knob:

1. Confirm the key is **already declared in the schema** at
   [`.agents/schemas/agentrc.schema.json`](../.agents/schemas/agentrc.schema.json)
   — if it isn't, the AJV validators will reject it on the next
   `/agents-update`.
2. Set the key in `.agentrc.json`. Don't add it to the template unless it
   should ship to all consumers.
3. Run `/agents-update` to confirm the helper preserves the key on round-trip.

### Extending list-valued keys without losing template defaults

`agentSettings.quality.maintainability.targetDirs` and
`agentSettings.quality.crap.targetDirs` accept the deep-merge extender form:

```jsonc
{
  "agentSettings": {
    "quality": {
      "crap": {
        "targetDirs": { "append": ["packages/foo/src", "packages/bar/src"] }
      }
    }
  }
}
```

`{ "append": [...] }` and `{ "prepend": [...] }` extend the resolver's
fallback default. A plain array (`["packages/foo/src"]`) replaces the default
entirely — useful when the consumer wants exactly its own dirs.

### Per-machine local overrides

`.agentrc.local.json` (gitignored) is layered on top of `.agentrc.json` by the
resolver. Use it for machine-specific tuning (e.g. lower
`deliverRunner.concurrencyCap` on a laptop) that should never reach git.

### Adding a new top-level key (framework change)

This is a framework-level change, not a project-level one. The path is:

1. Add the AJV schema in `config-schema.js` or `config-settings-schema.js`.
2. Mirror it manually in `.agents/schemas/agentrc.schema.json`.
3. Add a resolver getter in
   [`config-resolver.js`](../.agents/scripts/lib/config-resolver.js).
4. Add tests under `tests/lib/config-*.test.js` and confirm
   `tests/config-schema-mirror-drift.test.js` passes.
5. Document the key in this file and update `agents-sync-config.md` only if
   the merge semantics differ from the default (project-wins) rule.

---

## Secrets now live in `.env`

As of Epic #702 the framework no longer ships an MCP server, so
`.mcp.json` is **not** a valid home for framework secrets. Every
environment variable the orchestration engine reads is sourced from the
process environment only — loaded from `.env` locally, or set in the
Claude Code web environment-variables UI for web sessions.

### Keys the framework reads

| Variable                   | Required? | Purpose                                                                                                                                                  |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`             | Yes\*     | GitHub API auth for all ticketing operations. `GH_TOKEN` is accepted as a synonym. `gh auth token` is a fallback for local sessions.                      |
| `NOTIFICATION_WEBHOOK_URL` | No        | POST target for in-band Notifier events (Make.com / Slack / Discord). Unset disables the webhook channel; `log` and `epic-comment` channels still fire. |
| `WEBHOOK_SECRET`           | No        | Shared secret used to sign outbound webhook payloads as `X-Signature-256: sha256=<hmac>`. Unset ships unsigned payloads.                                 |

\* `GITHUB_TOKEN` / `GH_TOKEN` is required for background scripts and CI;
a locally-authenticated `gh auth login` session is an acceptable
substitute in interactive developer sessions only.

### Where to put them

| Environment       | Storage location                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Local development | `.env` at the project root (auto-loaded by `config-resolver.js`). The file is `.gitignore`d; provision it per clone. |
| Web sessions      | Claude Code web UI → environment-variables panel.                                                                    |
| CI                | Repo / org secret, surfaced into the runner via `ENV_FILE` or the workflow's `env:` block.                            |

`.mcp.json` is reserved for your MCP host's own discovery of third-party
servers (e.g. `@modelcontextprotocol/server-github`, `context7`) and is
ignored by the orchestration engine. Any framework-specific keys still
present in a `.mcp.json` from a pre-#702 checkout are **dead config** —
move them to `.env` (local) or your web session's env-var UI (web).

The webhook URL for external delivery is **not** configured in
`.agentrc.json`. It is sourced from the `NOTIFICATION_WEBHOOK_URL`
process env var only — set it in `.env` locally, in the Claude Code web
environment-variables UI for web sessions, or as a repo secret via
`ENV_FILE` for GitHub Actions runs.

---

## Cross-references

- JSON Schema mirror —
  [`.agents/schemas/agentrc.schema.json`](../.agents/schemas/agentrc.schema.json)
- Runtime AJV schemas —
  [`config-schema.js`](../.agents/scripts/lib/config-schema.js),
  [`config-settings-schema.js`](../.agents/scripts/lib/config-settings-schema.js)
- Resolver entry point —
  [`config-resolver.js`](../.agents/scripts/lib/config-resolver.js)
- Sync helper —
  [`agents-sync-config.md`](../.agents/workflows/helpers/agents-sync-config.md)
- Quality gates runbook (CRAP onboarding, MI ratchet, lint ratchet) —
  [`docs/quality-gates.md`](quality-gates.md)
- Activation pointers (slash commands, personas, skills) —
  [`.agents/README.md`](../.agents/README.md)
