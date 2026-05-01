# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Pool mode retired (story #909)

- **Removed.** `.agents/scripts/pool-claim.js`, `.agents/scripts/lib/pool-mode.js`,
  and `tests/pool-mode.test.js`. The claim-protocol pool mode (no-id
  `/sprint-execute`, `in-progress-by:<sessionId>` label + `[claim]` structured
  comment, race-loser release, reclaimable surfacing) is no longer part of
  the framework. Story assignment is now deterministic and operator-driven:
  `/sprint-execute` requires an explicit ticket id picked from the
  `/sprint-plan` dispatch table.
- **Config.** The `orchestration.runners.poolMode` block (`staleClaimMinutes`,
  `sessionIdLength`) is removed from the AJV schema and the published
  `agentrc.schema.json`. Existing keys in project configs become "additional
  property" validation errors and must be deleted.
- **Identity.** `runtime.sessionId` and `resolveSessionId(env)` survive as a
  stable per-process diagnostic surfaced in the startup `[ENV] sessionId=…`
  log line; they no longer drive any label writes.

## [5.30.5] - 2026-05-01

### `sprint-close` Phase 4 documents project-extended pre-push ratchets

- **`.agents/workflows/sprint-close.md`** Phase 4 now generalises the pre-push hook coverage statement (no longer implies maintainability is the only ratchet) and adds a new **4.1 — Refresh ratcheted baselines before push** sub-section. Consuming projects extend `.husky/pre-push` with lint baselines, complexity baselines, design-token audits, dependency audits, and build-output budgets that the framework's evidence-aware lint + test gate never invokes; when those drift, Phase 5.4 push fails *after* the merge has already landed locally and the fix is forced onto `[BASE_BRANCH]` instead of the Epic branch. The new sub-section directs the operator to consult `package.json` scripts referenced from the project's push hook and refresh each ratchet on the Epic branch with a `chore(baselines): refresh <name> for Epic #<id>` commit before push. A matching `Constraint` bullet is added at the bottom of the workflow. Doc-only clarification — no behavioural change to scripts.

## [5.30.4] - 2026-05-01

### Worktree cleanup wiring + Stage-2 `git worktree remove`

- **`sweepStaleStoryWorktrees` is now invoked** from `/sprint-plan-spec` and `/sprint-plan-decompose` via `drainPendingCleanupAtBoot` (with ticketing `provider`), after `forceDrainPendingCleanup`, so the pending ledger and orphan done-story worktrees self-heal during planning — not only at epic `sprint-close`.
- **`drainPendingCleanupAtBoot`** respects `orchestration.worktreeIsolation.root` (no longer hard-codes `.worktrees` under repo root).
- **`sprint-story-close`** post-merge drain now defaults to **`forceDrainPendingCleanup`** (Windows handle escalation), matching `sprint-close` Phase 7.
- **Pending-cleanup Stage 2** tries **`git worktree remove`** (then `--force`) before **`fs.rm`**. New manifest rows use **`attempts: 0`** until the first failed sweep pass (three failed sweeps → `persistent-lock`).
- **`forceDrainPendingCleanup`**: longer post-`taskkill` settle (1500ms) plus an **extra drain pass** when entries remain stuck after the first post-kill drain.

## [5.30.3] - 2026-04-30

### Worktree force-drain with Windows handle escalation

Adds Stage 3 of the Windows worktree reap fallback: when standard
`drainPendingCleanup` leaves entries stuck because user-mode processes
still hold handles inside the worktree, enumerate the holders via
PowerShell `Get-CimInstance Win32_Process` and `taskkill /T /F` them
before re-trying. Wired into both `/sprint-plan` (via `worktree-sweep`)
and `/sprint-close` (Phase 7 cleanup) so the
`.worktrees/.pending-cleanup.json` ledger self-heals across sprints
instead of accumulating persistent-lock entries that pin across runs.
Adds standalone `/drain-pending-cleanup` CLI with `--dry-run` and
`--no-escalate` for operator-driven runs. Kernel-held locks (Search
indexer, AV) remain visible-only — the no-user-mode-holders branch
logs and defers to the next sweep.

## [5.30.2] - 2026-04-27

### Close-workflow ergonomics: per-file lint diff + sprint-review severity classification

Two close-workflow ergonomic improvements driven by Phase 5 triage friction
during recent epic closes.

- **`lint-baseline.js diff` subcommand.** Operators triaging a baseline
  regression in `/sprint-close` Phase 5 had to hand-roll JSON post-processing
  to discover which files contributed the new warnings. The new `node
  .agents/scripts/lint-baseline.js diff` subcommand runs the configured
  `lintBaseline` command, compares per-file counts against the persisted
  baseline (capture now writes a `byFile` field alongside the totals), and
  prints a `File / Δ warn/err / rules` table sorted by descending warning
  delta. When the on-disk baseline lacks `byFile` (older format), a banner
  notes the limitation and treats every current regression as new since
  baseline. The `check` and `capture` modes are unchanged on the wire — the
  extra `byFile` field is additive and ignored by existing readers.
- **Sprint-code-review severity classification distinguishes runner failures
  from runner-found errors.** `parseLintOutput` previously inflated the
  unparseable-output / non-zero-exit case into one `error`, which surfaced as
  🟠 High Risk and forced operators to manually re-run `npm run lint` to
  disambiguate "real lint errors" from "binary missing / parse failure /
  environment issue". The parser now sets `executionFailed: true` for that
  case and leaves error/warning counts at zero. `buildSeverity` downgrades
  `executionFailed` to 🟢 Suggestion (gate skipped); `buildLintLine` renders
  a dedicated banner pointing operators at the canonical `npm run lint` to
  verify before merging.

### Worktree reap: bounded `--force` fallback after Windows lock/cwd retry

`removeWorktreeWithRecovery` now performs a single `git worktree remove
--force` retry on win32 when the plain remove path exhausts its lock-like /
cwd-like retry loop, before falling back to `fs.rm`. The framework-internal
fallback is scoped tightly:

- **Bounded.** One additional attempt only, after the existing 6-attempt
  retry loop, with a configurable backoff (`forceRemoveBackoffMs`,
  default 3000ms; tests inject 0).
- **Gated.** Triggers only on win32 and only when the final `lastReason`
  matches `WINDOWS_LOCK_RE` or `WINDOWS_CWD_RE`. Caller-requested `force` is
  still rejected at the top of `reap()` — the operator-only escape-hatch
  invariant is unchanged.
- **Defense-in-depth.** A failed `--force` falls through to the existing
  `fs-rm-retry` Stage 1 path; nothing about pending-cleanup hand-off
  changes.
- **Safety gate intact.** `isSafeToRemove` runs upstream in `reap()`; this
  fallback only fires after a clean-tree-or-discarded-after-merge
  precondition has already cleared.

Architecture / decisions / worktree-lifecycle docs were updated to reflect
the narrower invariant ("framework never passes `--force`" → "framework
passes `--force` only inside `WorktreeManager` after safety + retry
exhaustion").

## [5.30.1] - 2026-04-27

### Typecheck gate added to sprint-story-close

Adds a TypeScript compile gate to the canonical close-validation chain so type
regressions surface in the Story that introduced them rather than in the next
Story's pre-push. Real-world driver: a Story shipped product changes that
broke types on the Epic branch; the next Story's husky `pnpm validate` hook
caught it and the next-Story owner had to commit a remediation for someone
else's behaviour.

- **New `typecheck` gate runs first in `runCloseValidation`.** The gate is
  inserted at index 0 of `DEFAULT_GATES` (before `lint` and `test`) so the
  cheapest fast-fail wins. It honours the same SHA-keyed evidence-skip path
  as `lint`/`test` — re-running close after a no-op change reuses the
  recorded pass.
- **Command sourced from `agentSettings.commands.typecheck`.** Consumers that
  declare a typecheck command in their `.agentrc.json` (e.g. `pnpm exec turbo
  run typecheck`) get that command verbatim; the framework falls back to
  `npm run typecheck` when the field is absent or empty. There is **no
  config switch to disable the gate** — the whole point of the change is to
  enforce it on every close.
- **New exports.** `buildDefaultGates({ settings })` and
  `resolveTypecheckCommand(settings)` are exported from
  `lib/close-validation.js` for call sites that have a resolved settings
  object in scope. `DEFAULT_GATES` is preserved for back-compat (it resolves
  with the `npm run typecheck` fallback).

## [5.30.0] - 2026-04-27

### Risk/HITL semantics + dispatch-manifest cleanup (Epic #857)

Cutover release that aligns the runtime metric definitions with the
post-retirement of `risk::high` as a runtime gate (it remains
informational/planning metadata only). One framework-internal field is
removed and one retro metric is redefined.

- **BREAKING (framework-internal): `heldForApproval` removed from the
  dispatch manifest.** Fixture replay confirmed the array was always `[]`
  in current usage — `dispatch-engine.js` initialised it but no producer
  ever populated it once `risk::high` stopped gating dispatch. The schema
  (`.agents/schemas/dispatch-manifest.json`) drops both
  `summary.heldForApproval` (integer) and the root `heldForApproval[]`
  array, plus the field's entry in the epic-dispatch `required` list.
  `buildManifest()`, `dispatchWave()`, and `dispatchNextWave()` no longer
  return or accept the field. The "Held for Approval" row is removed from
  the manifest markdown table and the `Held: N` segment from the
  dispatcher CLI summary line. External consumers that snapshot the
  manifest JSON should drop both keys. ADR-20260427-868a's enumeration of
  strict inner objects is updated accordingly.
- **BREAKING (framework-internal): retro `hitl` count now reflects
  `agent::blocked` events.** The Sprint Retrospective scorecard's "HITL
  Gates Triggered" row is renamed to "agent::blocked Events Raised", and
  `helpers/sprint-retro.md` instructs callers to count distinct tickets
  that received the `agent::blocked` label at any point during the sprint
  rather than tickets carrying `risk::high`. The numeric predicate
  `isCleanManifest({ hitl })` in
  `.agents/scripts/lib/orchestration/retro-heuristics.js` is unchanged —
  only the metric definition rotates. The compact-retro headline ("zero
  HITL gates") is updated to "zero agent::blocked events" so the headline
  matches the underlying signal.
- **Cleanup: retired auto-merge protocol comment removed.** The
  `risk::high auto-merge protocol` comment on the `--remove-label` path
  in `.agents/scripts/update-ticket-state.js` is replaced with an
  accurate description of the path's current usage (single-label
  mutation without an `agent::*` state transition).

## [5.29.0] - 2026-04-26

### TypeScript support for maintainability and CRAP gates

The maintainability and CRAP scoring engines now score TypeScript and TSX
sources in addition to plain JavaScript. TS-first repositories no longer
need to maintain hand-rolled `.js` shims to participate in the gates.

- **Strip-then-analyze pipeline.** `.ts`, `.tsx`, `.mts`, and `.cts`
  sources are pre-transpiled in memory via `ts.transpileModule` (with
  `JsxEmit.ReactJSX` for `.tsx`) before being fed to the existing
  `typhonjs-escomplex` kernel. Type annotations carry no control flow,
  so the transpiled JS scores identically to the original TS for every
  metric escomplex emits — the same module written in `.js` or `.ts`
  produces the same maintainability index and the same per-method CRAP.
  See ADR-20260426-829a in `docs/decisions.md` for why escomplex stays
  and `ts-morph` was rejected.
- **Scanner extensions.** `scanDirectory` now accepts `.js`, `.mjs`,
  `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts`. `coverage/` and `.next/`
  are added to `IGNORED_DIRS` so vitest's istanbul HTML scaffolding and
  Next.js build artifacts are skipped.
- **Coverage keying preserved.** CRAP's coverage lookup continues to use
  the original `.ts`/`.tsx` source path — vitest's `coverage-final.json`
  keys on the source file, not the transpiled output, so no key-mismatch
  introduces phantom misses.
- **Schema bump (kernelVersion 1.1.0).** The CRAP baseline envelope
  gains a `tsTranspilerVersion` field stamped from the resolved
  `typescript` package version. Existing consumers will see a one-time
  warning on `crap:check`/`maintainability:check` directing them to
  `npm run crap:update` / `npm run maintainability:update`. Drift on
  `kernelVersion` and `tsTranspilerVersion` is **warn**, not fail —
  consumers refresh on their own cadence. `escomplexVersion` mismatch
  continues to fail closed (different kernel semantics are not
  negotiable).
- **Byte-identical baselines for JS-only consumers.** Re-running
  `update-{maintainability,crap}-baseline` against an unchanged
  JS-only tree produces byte-identical scoring data. A snapshot test
  pins this contract.
- **`typescript` is now a peer dependency.** Wide range (`>=5.0.0`),
  shipped as a regular dep too for the offline scaffolding fallback.

## [5.28.1] - 2026-04-26

### Documentation follow-ups for Epic #817

Three small documentation deltas landing the action items from the Epic
#817 retrospective. No runtime behaviour change.

- **CLI entrypoint coverage convention is now documented.** The
  `node:coverage ignore file` directive on the 22 CLI entrypoints under
  `.agents/scripts/` is codified as a deliberate convention in
  `docs/decisions.md` (ADR-20260426-817d). Helper extraction + unit tests
  remain the canonical lowering pattern; per-line coverage of `main()`
  is intentionally not chased.
- **`/sprint-close` Phase 4 calls out `--no-evidence`.** The workflow
  doc now reminds operators that the SHA-keyed evidence wrapper is
  load-bearing on the close path and that `--no-evidence` is the
  explicit override when a flaky test slips past upstream validation.
- **`commentMinLevel` documented alongside `minLevel`.**
  `docs/configuration.md` now lists both keys in the
  `orchestration.notifications` table with a short comparison note so
  operators tuning verbosity find the new key where they expect it.

## [5.28.0] - 2026-04-26

### Sprint workflow performance — bounded context, evidence-aware gates, honest degraded modes (Epic #817)

Local hot-path performance and signal-quality pass across `/sprint-plan`,
`/sprint-execute`, and `/sprint-close`. Repeat lint/test runs against the
same tree are now skipped via commit-SHA evidence; planning context is
bounded; previously silent fail-open gates now surface their degraded state.
Sixteen stories landed across five themes; consumer-visible changes are
additive flags and config keys with safe defaults.

- **Evidence-aware gates skip duplicate runs.** Lint, test, biome format,
  maintainability, and CRAP record `{ gateName, sha, commandConfigHash,
  timestamp }` after each successful run under
  `temp/validation-evidence-<scopeId>.json`. Subsequent phases skip when
  the current `git rev-parse HEAD` and resolved command config still match.
  Pass `--no-evidence` to any `evidence-gate.js` invocation to force a
  re-run. Story-close, sprint-code-review, and sprint-close Phase 4 all
  participate.
- **`sprint-execute` Step 2 no longer requires a pre-flight lint+test.**
  `story-close.js` is the canonical local Story merge gate. The
  workflow guidance now treats interactive `npm run lint && npm test`
  before close as advisory only; the close-validation gate is authoritative.
- **Bounded planning-context budget.** Planning scripts (`epic-planner.js`,
  `epic-plan-spec.js`, `ticket-decomposer.js`,
  `epic-plan-decompose.js`) default to a summary mode emitting doc names,
  section headings, relevant excerpts, and file pointers. Add
  `--full-context` to restore the previous full-body behaviour. The new
  `agentSettings.limits.planningContext` knob controls the byte budget.
  All `--emit-context` JSON is now compact by default; pass `--pretty`
  to indent for human debugging.
- **Honest degraded modes.** `select-audits.js`, `lint-baseline.js`, and
  `baseline-refresh-guardrail.js` no longer silently fail open on diff or
  parse failures. By default they fail closed with a non-zero exit code;
  pass `--gate-mode` (or set `AGENT_PROTOCOLS_GATE_MODE=1`) for the
  authoritative behaviour, or read the structured
  `{ ok: false, degraded: true, reason }` envelope on stdout otherwise.
- **`sprint-plan-healthcheck` modes split.** `--fast` (default, config +
  git-remote checks only), `--paranoid` (re-runs hierarchy and dep
  validation), and `--prime-install` (the optional pnpm path) are now
  separate flags. Output is structured `{ ok, degraded, reason }` JSON.
  The script header now correctly documents Phase 4.
- **Audit comment shape: summaries + paths, not full prompt bodies.**
  `audit-orchestrator.js` posts audit names, paths, and a short summary
  to GitHub. Expanded prompts land at `temp/audit-<gate>-<id>.md`. Reduces
  Epic comment fanout size by an order of magnitude on multi-audit runs.
- **`sprint-code-review` no longer re-runs full lint.** The mislabelled
  "focused lint" step is now genuinely scoped to changed files. Lint
  enforcement remains at story-close, pre-push, and CI.
- **`notifications.minLevel` now applies to GitHub comments.** New
  `notifications.commentMinLevel` knob filters comment posting (defaults
  to `notifications.minLevel`). Per-Task `agent::executing` transitions
  during Story init batch into a single Story-level summary comment.
- **Health-monitor refresh cadence configurable.** New
  `agentSettings.healthMonitor.refreshCadence` config selects between
  `every-close` (legacy), `wave-boundary`, or `every-n-closes` (with
  `everyNCloses`). Defaults to `wave-boundary` so the per-close hot path
  no longer fans out a full Epic ticket re-fetch.
- **`sprint-story-init` surfaces `dependenciesInstalled` explicitly.**
  The structured comment and stdout JSON now include
  `dependenciesInstalled: 'true' | 'false' | 'skipped'` and a structured
  `installStatus`. Workflow guidance trusts this field instead of asking
  agents to infer install state from `node_modules` presence.
- **Topological-sort decomposition with fatal unresolved deps.**
  `ticket-decomposer.js` now topo-sorts within `(parent, type)` groups so
  dependency edges cannot be dropped by ordering. Unresolved slug
  references during persistence throw instead of warning.
- **Bounded-concurrency staged ticket creation.** Feature → Story → Task
  creation runs through `concurrentMap` with a configurable cap. Replaces
  the previous serial `for...of await` loop. Concurrency cap is
  configurable; default is conservative.
- **Long-tail CRAP hotspots cleared.** The 10 methods catalogued in #816
  (CRAP 50–72) are remediated via the "extract pure helpers + add tests"
  pattern. `baselines/crap.json` ratchets cleanly so consumer projects
  don't inherit a paper ceiling.
- **Sprint-plan deterministic-invariant manual checklist removed.** The
  hierarchy / acyclicity / risk-label review is already proven by
  `validateAndNormalizeTickets`; the workflow now surfaces validator
  output as the canonical proof and asks the operator only to review
  exceptions and scope-overlap notes.

## [5.27.0] - 2026-04-25

### Pre-consumer-upgrade quality pass (Epic #773)

The post-#730 quality pass that consolidates the `orchestration` namespace,
splits the `config-resolver` facade, establishes the CRAP baseline as a
hard-enforced gate, decomposes two large modules behind byte-identical
facades, and remediates the top-10 CRAP hotspots. Fifteen stories landed
across four themes; the framework is now ready for consumer projects to
pull forward.

- **CRAP gate is now hard-enforcing.** `baselines/crap.json` is bootstrapped
  and shipped; `check-crap.js` no longer self-skips on a missing baseline.
  All three firing sites (close-validation, pre-push, CI) fail closed when
  the baseline is absent or the kernel/escomplex versions drift. Operators
  bootstrap explicitly via `npm run crap:update` + a `baseline-refresh:`
  commit. The top-10 method hotspots above CRAP 50 were eliminated; ten
  long-tail methods at CRAP 50–72 are tracked as a follow-on.
- **`orchestration` is now grouped.** Flat peer keys (`worktreeIsolation`,
  `epicRunner`, `planRunner`, `concurrency`, `closeRetry`, `poolMode`)
  consolidate under `orchestration.runners` (where they describe runner
  behaviour) and `orchestration.worktreeIsolation`. The shipped configs and
  consumer sweeps land in the same atomic cutover, so no legacy-key
  fallbacks remain in the resolver.
- **`config-resolver.js` split into a facade + responsibility-bounded
  submodules.** The 930-LOC monolith is now a thin re-export over
  `quality`, `paths`, `commands`, `limits`, and `runners` accessor
  submodules. Public surface is byte-identical; only internals moved.
- **Two large modules decomposed behind byte-identical facades.**
  `providers/github.js` and `lib/worktree/lifecycle-manager.js` each split
  into ≤250 LOC facades over focused submodules under
  `providers/github/*` and `lib/worktree/lifecycle/*`. Same pattern
  documented in `docs/patterns.md` (facade + responsibility-bounded
  submodules, ctx-threading discipline, no inter-submodule imports).
- **`*Root` paths centralised under `agentSettings.paths`.** The legacy
  flat keys (`agentRoot`, `docsRoot`, `tempRoot`) are gone; consumers read
  via `getPaths()`. Both shipped configs migrated.
- **State-poller deleted.** The dormant `state-poller.js` module + solo
  test were removed; the active wave loop reads state synchronously per
  wave (the `sprint-execute.md` doc reference is updated).
- **`docs-context-bridge` removed.** Deleted
  `lib/orchestration/docs-context-bridge.js` and its test. The advisory
  friction comment ran at sprint-story-close — too late for the dev to
  act on, never read in practice, and the heuristic path-segment-vs-heading
  match was noisy. The Epic-close docs-freshness gate
  (`validate-docs-freshness.js`) is the load-bearing check and remains in
  place.

## [5.26.0] - 2026-04-25

### Config schema modernization & baseline unification (Epic #730)

`.agentrc.json` is now a fully-typed, schema-validated, structurally-grouped
configuration contract. Operational settings are organised under four
sub-blocks (`paths`, `commands`, `quality`, `limits`), the canonical ratchet
baselines live under a single `/baselines/` directory, and the sync helper is
schema-driven instead of template-diff. The full reference lives in
`docs/configuration.md`.

- **Breaking — flat `agentSettings` keys removed.** The grouped shape is the
  only shape. Migrate as follows:
  - `agentSettings.<command>Command` → `agentSettings.commands.<command>` for
    `validate`, `lintBaseline`, `test`, `exploratoryTest`, `typecheck`,
    `build`.
  - `agentSettings.{agentRoot,docsRoot,tempRoot,auditOutputDir}` →
    `agentSettings.paths.*`. `agentRoot`, `docsRoot`, and `tempRoot` are now
    required — a missing value is a validation error with a clear path.
  - `agentSettings.maintainability.*` and the previous flat lint/CRAP/MI/
    prGate keys → `agentSettings.quality.*` (with `quality.baselines.<gate>`
    holding the per-baseline `path` + optional `refreshCommand`).
  - `agentSettings.{maxInstructionSteps,maxTickets,maxTokenBudget,executionTimeoutMs,executionMaxBuffer}`
    and the friction thresholds → `agentSettings.limits.*` (friction nested
    under `limits.friction`).
- **Breaking — disabled commands declare `null`, not empty string.**
  `commands.typecheck` and `commands.build` accept `string | null`; an empty
  string is rejected. `null` is the canonical "not applicable" value.
- **Breaking — canonical baselines moved under `/baselines/`.** The framework
  reads `baselines/lint.json`, `baselines/crap.json`, and
  `baselines/maintainability.json` by default. Override per-gate via
  `agentSettings.quality.baselines.<gate>.path`. The previous root-level
  `crap-baseline.json` / `maintainability-baseline.json` no longer exist.
- **Sync helper switches to schema-driven validate-then-merge.** The
  `agents-sync-config` helper validates the project config against the
  schema, adds keys the template introduces, and preserves every project-side
  key that validates — including optional keys absent from the template
  (e.g. `orchestration.concurrency`, `closeRetry`, `poolMode`). It no longer
  silently strips unknown keys; a typo now aborts with a diagnostic instead
  of vanishing.
- **New static JSON Schema mirror.** Both shipped configs now declare
  `"$schema": "./.agents/schemas/agentrc.schema.json"`, so editors get
  autocomplete and inline validation. The runtime AJV schemas remain the
  source of truth; a drift test keeps the static mirror aligned.
- **Conditional `orchestration.github` requirement.** When
  `orchestration.provider` is `"github"`, the `github` block (with required
  `owner` and `repo`) is now schema-required — the configuration error is
  caught at validation time instead of surfacing as a runtime failure.
- **New configuration reference doc.** `docs/configuration.md` documents
  every configurable key, its default, whether it is required, and the
  baseline conventions (canonical `/baselines/` vs per-wave drift snapshots
  under `.agents/state/`).

## [5.25.0] - 2026-04-25

### Notification severity rework — unified `low | medium | high`

Collapsed the two notification subsystems (manual `notify()` API + the in-band
`Notifier` class for ticket-state transitions) into a single dispatcher with a
unified severity vocabulary.

- **Breaking — config keys renamed.** Drop `notifications.level`,
  `notifications.webhookMinLevel`, `notifications.postToEpic`, and
  `notifications.channels`. Replace with a single `notifications.minLevel`
  (`low | medium | high`, default: `medium`). The defaults preserve today's
  behaviour for everything except intermediate Story/Epic transitions, which
  are now silenced by default (only Story/Epic reaching `agent::done` rates
  `medium` and clears the filter).
- **Breaking — `notify()` payload shape.** The `type:` field
  (`progress | notification | friction | action`) and `actionRequired: true`
  flag are gone. Pass `severity: 'low' | 'medium' | 'high'` instead. `high`
  callers should also lead the message body with `🚨 Action Required:` so the
  GitHub comment mirrors the `[Action Required]` webhook prefix.
- **Breaking — `transitionTicketState` opts.** The `notifier: { emit }`
  injection point is replaced by `notify: Function`. Production callers pass
  the imported `notify` function from `notify.js`; tests pass a stub.
  `transitionTicketState` now derives severity via `eventSeverity()` and
  posts to the parent epic when the transitioned ticket carries an
  `Epic: #N` body reference.
- **Breaking — `createNotifier` and the `Notifier` class are deleted.**
  `lib/notifications/notifier.js` now exports only the shared helpers
  (`SEVERITY_RANK`, `meetsMinLevel`, `eventSeverity`,
  `renderTransitionMessage`, `resolveWebhookUrl`).
- **Breaking — log-only notification mode dropped.** The
  `channels: ['log']` config no longer exists. Every notification dispatched
  via `notify()` posts a GitHub comment (when `ticketId > 0`) and fires the
  webhook (when severity ≥ `minLevel` and a URL is configured).
- **Webhook payload format unified.** State-transition events now ship as
  `[medium] repo#357: story #357 · agent::ready → agent::done — Title` —
  the same `[severity] repo#N: ...` shape as manual `notify()` calls. State-
  change webhooks are now also signed with `WEBHOOK_SECRET` when set
  (previously only manual `notify()` calls were signed).
- **Bug fix — story-complete webhook no longer mislabels as Action Required.**
  `post-merge-pipeline.notificationPhase` previously sent
  `type: 'notification', actionRequired: true`, which forced
  `[Action Required]` on every successful merge. Now sends `severity: 'medium'`
  with no escalation flag.
- **CLI args renamed.** `node .agents/scripts/notify.js --action` is replaced
  by `--severity high` (still accepts `--severity low|medium|high`).

### `agent-protocols` MCP server retired (Epic #702)

The framework no longer ships an MCP server. Every capability the server
previously exposed remains available — the surface to invoke it is now
the Node CLI under `.agents/scripts/` only. Secrets resolution moves to
the process environment exclusively; `.mcp.json` is no longer consulted
by any framework code.

- **Breaking — secrets must live in `.env` or the web env-var UI.**
  Operators who kept `GITHUB_TOKEN` or `NOTIFICATION_WEBHOOK_URL` only
  in `.mcp.json` must move them. Locally, put them in `.env`; in a
  Claude Code web session, set them in the session's
  environment-variables UI; for GitHub Actions remote runs, populate
  the `ENV_FILE` repo secret. The notifier and provider no longer read
  `.mcp.json`.
- **Breaking — `MCP_JSON` repo secret retired from remote orchestration.**
  `.github/workflows/epic-orchestrator.yml` only consumes `ENV_FILE`
  now; existing `MCP_JSON` secrets can be removed.
- **CLI mapping for retired tools.** Each retired tool has a direct
  Node-CLI successor:

  | Retired MCP tool                                | Successor CLI                                                                |
  | ----------------------------------------------- | ---------------------------------------------------------------------------- |
  | `mcp__agent-protocols__dispatch_wave`           | `node .agents/scripts/dispatcher.js --epic <id>`                             |
  | `mcp__agent-protocols__hydrate_context`         | `node .agents/scripts/hydrate-context.js --ticket <id> --epic <id>`          |
  | `mcp__agent-protocols__transition_ticket_state` | `node .agents/scripts/update-ticket-state.js --task <id> --state <state>`    |
  | `mcp__agent-protocols__cascade_completion`      | Inlined into `update-ticket-state.js`; also fires at Story close             |
  | `mcp__agent-protocols__post_structured_comment` | `node .agents/scripts/post-structured-comment.js --ticket <id> --marker <m>` |
  | `mcp__agent-protocols__select_audits`           | `node .agents/scripts/select-audits.js --ticket <id> --gate <gate>`          |
  | `mcp__agent-protocols__run_audit_suite`         | `node .agents/scripts/run-audit-suite.js --audits <comma-list>`              |

- **Fork-aware migration for consumer repos.** Consumers that copied
  `.agents/default-mcp.json` into their own `.mcp.json` must drop the
  `agent-protocols` entry on their next submodule bump — the script
  path it points at no longer exists. Third-party MCP servers in the
  same file (e.g. `@modelcontextprotocol/server-github`, `context7`)
  are unaffected; `.mcp.json` remains a valid file in that role.
- **Documentation realignment.** The dedicated MCP docs are deleted;
  consumer-facing references move to a new "Secrets now live in `.env`"
  section in `.agents/README.md` and a refreshed web-launch runbook
  with no MCP dependency. `docs/architecture.md` and `docs/decisions.md`
  carry the corresponding ADR.

## [5.24.0] - 2026-04-24

### Parallel `/sprint-execute` on Claude Code web (Epic #668)

`/sprint-execute` now runs unchanged in claude.ai/code web sessions, including
N parallel sessions against one sprint wave. The same command, the same
ticket lifecycle, the same close-and-cascade — only the worktree layer
changes shape based on where the session runs.

- **Environment-aware worktree resolver.** `orchestration.worktreeIsolation.
  enabled` is now resolved per process. `AP_WORKTREE_ENABLED=true|false` is an
  explicit operator override, `CLAUDE_CODE_REMOTE=true` auto-disables
  worktrees for web sessions, and the committed config is the fallback. The
  committed value is never written by any runtime path.
- **Pool-mode launch.** `/sprint-execute` invoked with no story id claims the
  first eligible story from the Epic's dispatch manifest via an
  `in-progress-by:<sessionId>` label plus a `[claim]` structured comment.
  Read-back race detection releases the loser's label so the next eligible
  story can be picked. Exits 0 with a visible reason when the manifest is
  fully claimed or complete.
- **Launch-time dependency guard.** A story whose blockers have not yet
  merged refuses to launch — each blocker is printed with id, state, and URL,
  and the session exits 0 without touching branches. Identical on local and
  web; composes with pool-mode eligibility.
- **Bounded push retry on story close.** The epic-branch push wraps a
  fetch / replay / push retry loop driven by
  `orchestration.closeRetry.maxAttempts` (default 3) and
  `orchestration.closeRetry.backoffMs` (default `[250, 500, 1000]`).
  Concurrent closes from separate clones converge cleanly; real content
  conflicts abort with a clear error and a clean local tree.
- **Reclaimable claim surfacing.** `in-progress-by:*` labels older than
  `orchestration.poolMode.staleClaimMinutes` (default 60) are listed as
  reclaimable in pool-mode launch output for operator decision; no automated
  sweep.
- **New config keys.** `orchestration.closeRetry.{maxAttempts,backoffMs}` and
  `orchestration.poolMode.{staleClaimMinutes,sessionIdLength}`. Both blocks
  are optional — omitting them yields v5.23.0-equivalent behaviour.
- **Documented runbook.** New "Running sprint-execute on Claude Code web"
  section in `.agents/README.md` covers required secrets, env-var precedence,
  parallel launch, and progress-tracking across N tabs. The worktree-off
  pattern and side-by-side execution-model diagram land in
  `docs/patterns.md` and `docs/architecture.md`.

## [5.23.0] - 2026-04-24

### Framework perf & docs follow-ons from Epic #553 retro (Epic #638)

Tunes the primitives shipped in #553 with measurement data, and converts
four carry-over retro observations into durable protocol — concurrency
caps, a CHANGELOG style contract, a compact-retro short-circuit for
clean sprints, and a terminal decision on the `story-566` reap-recovery
log line.

- **Configurable concurrency caps.** New `orchestration.concurrency`
  config block exposes `waveGate` (0 = uncapped, preserves v5.21.0
  Promise.all), `commitAssertion` (default 4), `progressReporter`
  (default 8). Adoption at the three v5.21.0 `concurrentMap` sites reads
  via `ctx.concurrency`; omitting the keys reproduces v5.21.0 behaviour
  bit-for-bit.
- **phase-timings aggregator CLI.** New
  `.agents/scripts/aggregate-phase-timings.js` reads `phase-timings`
  structured comments across N Epics and prints per-phase p50/p95 plus
  recommended caps. Feeds future cap tuning without a dashboard.
- **CHANGELOG style contract.** New `.agents/rules/changelog-style.md`
  codifies the per-release format (1–3 sentence theme, bullets of
  user-visible changes, banned internal detail, breaking-change
  prominence, ≤60 soft line ceiling). Referenced from `/sprint-close`
  Phase 1.3; this entry is itself a worked example.
- **Compact-retro short-circuit.** `helpers/sprint-retro.md` now
  computes an `isCleanManifest` predicate (zero friction, parked,
  recuts, hotfixes, hitl) and emits a three-section retro on clean
  sprints. New `--full-retro` flag on `/sprint-close` forces the
  six-section format when needed. `retro-complete:` marker and
  `type: 'retro'` comment shape unchanged.
- **Reap-recovery audit closed.** Story-566's `fs-rm-retry` recovery
  was audited end-to-end and classified as self-inflicted dirty-tree
  bug. `bootstrapper.js` now guards `.agents` removal by submodule
  detection so the worktree is no longer dirtied at bootstrap.

## [5.22.0] - 2026-04-24

### CRAP analysis — complexity × coverage risk gate (Epic #596)

Sibling pipeline to the existing maintainability (MI) ratchet. CRAP scores
every JavaScript method via `c² · (1 − cov)³ + c`, combining
`typhonjs-escomplex` cyclomatic complexity with per-method coverage from the
existing `c8` artifact. No new runtime dependencies.

**Hybrid enforcement.** Tracked methods ratchet on `(file, method, startLine)`
with a line-drift fallback against `crap-baseline.json`; new (untracked)
methods must score at or below `newMethodCeiling` (default 30, the canonical
CRAP threshold). Removed methods are surfaced as a counter, never a failure.

**Gate integration.** Wired into `close-validation` after
`check-maintainability`, into `ci.yml` after `test:coverage` (diff-scoped on
PRs via `--changed-since origin/<base_ref>`, full-repo on push-to-main), and
into `.husky/pre-push`. All three sites converge on `check-crap.js`; flipping
`agentSettings.maintainability.crap.enabled` to `false` skips at every site
with a visible `[CRAP] gate skipped (disabled)` log line.

**Anti-gaming guardrail.** A new `baseline-refresh-guardrail.yml`
`pull_request` workflow reads thresholds from the **base branch**
`.agentrc.json` and re-runs `check-crap` with those values forced via
`CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` / `CRAP_REFRESH_TAG` env
overrides. Any PR touching `crap-baseline.json` or
`maintainability-baseline.json` must carry a commit whose subject starts
with the configured `refreshTag` (default `baseline-refresh:`) AND whose
body is non-empty. Baseline-only PRs receive the `review::baseline-refresh`
label idempotently across re-runs so a human sees every refresh, even on
green CI.

**Agent-era output.** `check-crap --json <path>` writes
`{ kernelVersion, escomplexVersion, summary, violations }` with deterministic
per-violation `fixGuidance` (`crapCeiling`, `minComplexityAt100Cov`,
`minCoverageAtCurrentComplexity`) — applying either single-axis fix re-scores
under target, verified by round-trip test. `check-maintainability` gains the
`--json` and `--changed-since` flags for parity.

**Consumer-repo safety.** Missing baseline → bootstrap message, exit 0 (never
hard-fails on first sync). Baseline `kernelVersion` / `escomplexVersion`
mismatch fails closed with a "scorer changed from X to Y" message rather than
silently rescoring. `enabled: false` is a single-flag opt-out for repos that
don't run coverage. Config resolver supports `{ append }` deep-merge so
consumers extend `targetDirs` without re-listing framework defaults.

## [5.21.0] - 2026-04-24

### Epic-runner throughput & caching pass (Epic #553)

Performance and observability pass across the epic-runner hot paths — wave
gating, commit assertion, progress reporting, and label polling. Caching
and bounded concurrency throughout; new per-phase timing surface; Windows
worktree-reap hardening.

**Bounded-concurrency parallelism.** New `lib/util/concurrent-map.js`
helper is the shared primitive. `sprint-wave-gate` fans out `getTicket`
loops concurrently, wave-end commit-assertion runs with cap=4, and
`ProgressReporter` fetches story states 8-way behind a 10-second TTL
cache.

**Caching.** The ticket cache grows `insertedAt` + `maxAgeMs`; every
`getTickets` sweep now primes the cache so downstream `getTicket` calls
cost zero HTTP. `gh auth token` is memoized across provider instances.
`manifest-formatter` short-circuits repeat renders via content hash, and
`scanDirectory` uses `withFileTypes` to avoid the per-entry `stat()`.

**Phase-timing observability.** New `lib/util/phase-timer.js` threads
through story-init and story-close and emits per-phase timing logs. On
story close a `phase-timings` structured comment is posted; the epic
progress comment aggregates **median / p95** across closed stories.

**State-poller bulk path.** Bulk label-poll path with malformed-response
fallback and out-of-scope filtering replaces the per-ticket probe.

**Worktree cleanup (Windows).** Recover from cwd-like removal failures;
`git worktree prune` now always runs after `remove`; Stage 1 recovery is
unconditional. Sweep/GC entry points and the pnpm-store first-install
cost are documented in `worktree-lifecycle.md`.

**Test hardening.** Webhook leaks plugged in the pre-wave smoke test and
epic-runner integration tests. Parity and dependency-source tests route
through `buildCtx`. `branchCleanupPhase` contract asserts new
`localReason` / `remoteReason` fields.

## [5.20.0] - 2026-04-23

### Notification webhook payload is now `{ text }`

All three webhook emitters (`notify.js`, `Notifier`, `NotificationHook`)
now POST a single `{ "text": "..." }` field — one consumer can receive
every event on one endpoint without branching on `event` / `kind` /
`type` discriminators. Formatting conventions: `notify.js` emits
`[TYPE] repo#id: message` (or `[Action Required] …`), `Notifier` reuses
its existing `summary`, and `BlockerHandler` uses
`[epic-blocked] Epic #N (story #M): <reason>`.

### Quieter defaults

`default-agentrc.json` ships `orchestration.notifications` as
`level: "default"`, `webhookMinLevel: "notification"`,
`mentionOperator: false`, `postToEpic: false` — roughly an order of
magnitude less chatter than the previous `verbose` / `progress` combo.
New projects land quiet; existing projects keep whatever they have.

### Fix: `Notifier` tests leaked to the real webhook

Three tests in `notifier.test.js` constructed `Notifier` without
`fetchImpl` or explicit `webhookUrl`. The constructor resolved
`NOTIFICATION_WEBHOOK_URL` + `.mcp.json` at `cwd`, so every `npm test`
run silently POSTed ~7 live messages to Slack/Discord. Tests now scrub
the env var, pin a test URL, and pass a stub `fetchImpl`.

## [5.19.2] - 2026-04-23

### Add: `/agents-update` self-update workflow

Consumer projects can now bump their `.agents/` submodule pointer via a
single slash command instead of a `postinstall` hook that silently
drifted the pointer on every `pnpm install`. Ships:

- **`update-self.js`** — stdlib-only script; refuses dirty submodule
  worktrees, runs `git submodule update --init --force --remote`, prints
  `OLD..NEW` SHA range + shortlog, and delegates `.claude/commands/`
  regeneration. `--remote` is skipped when `CI=true`.
- **`/agents-update` workflow** — operator-facing contract (pointer only
  moves on explicit invocation, no auto-commit, dirty-worktree abort).

### Retire: `/agents-sync-config` as a standalone command

Demoted to a helper and folded into `/agents-update` Step 3. The
merge-and-diff procedure is unchanged; it just runs alongside the
pointer move. Consumer-side removal of the legacy
`scripts/sync-agents.mjs` and `postinstall` hook is a follow-up in
each consuming repo.

## [5.19.1] - 2026-04-23

### Fix: `/agents-bootstrap-project` Step 8 hard-aborted

The v5.19.0 Step 8 MCP-template check looked for `.mcp.json.example` at
the repo root — but consumers install `agent-protocols` as a submodule
under `.agents/`, so root-level files never reach them. Moved the
template into the submodule at `.agents/default-mcp.json` (same pattern
as `.agents/default-agentrc.json`).

## [5.19.0] - 2026-04-23

### MCP server hardening (Epic #511)

- `tools/call` arguments are AJV-validated against each tool's
  `inputSchema`; malformed payloads now return `-32602 Invalid params`.
- Conflicting `type::*` labels on a ticket raise an explicit error
  instead of silently routing by scan order.
- Wave marker regex bounded to 1–3 digits; `wave-1000-start` rejected.
- `select_audits` glob engine replaced with `picomatch`; the
  `**.js → bundlejs` false-positive is closed and the git-spawn gets a
  30-second timeout (configurable).
- `run_audit_suite` supports declared per-audit substitutions with a
  reject-on-unknown-key policy.
- Dispatch-manifest writes are atomic (tmp + rename); `dispatch_wave`
  returns `manifestPersisted` + optional `manifestPersistError`.
- `.agents/MCP.md` is the new consumer-facing tool reference.

### `/agents-bootstrap-project` now wires `.mcp.json`

Added Step 8: scaffold `.mcp.json` from a committed template on a fresh
clone, or diff an existing one to surface missing servers and
placeholder leakage. The step never writes secrets.

## [5.18.0] - 2026-04-23

### Slash-command renames

- `/bootstrap-agent-protocols` → `/agents-bootstrap-github`.
- `/sync-agents-config` → `/agents-sync-config`.

The `agents-` prefix groups the two repo-lifecycle commands. Consumers
that invoke the old names must update — old names are no longer synced
to `.claude/commands/`.

### Demoted internal workflows to `helpers/`

Workflows an operator never invokes directly moved to
`.agents/workflows/helpers/`: `sprint-plan-spec.md`,
`sprint-plan-decompose.md`, `sprint-code-review.md`, `sprint-retro.md`,
`sprint-testing.md`, `_merge-conflict-template.md`. Parent workflows
reference helpers by path. **Breaking (remote orchestration contract).**
The spec and decompose helpers are no longer slash commands; the
`/sprint-plan` wrapper now accepts `--phase spec|decompose` and call
sites in `epic-orchestrator.yml`, `remote-bootstrap.js`, and
`plan-runner` are updated.

### Clean-code & maintainability remediation (Epic #470)

Full-repo refactor campaign across 11 Stories. No user-facing behaviour
change; the shipped surface is internal structure and correctness fixes.

- **Provider layer** split into `providers/github/{ticket-mapper,
  graphql-builder,cache-manager,error-classifier}.js` behind a façade.
- **Story/Epic orchestration** decomposed into injectable stages under
  `lib/story-init/` and `lib/orchestration/epic-runner/phases/`;
  `ctx` (`lib/runtime-context.js`) injects provider/logger/config.
- **Logger consolidation** — `VerboseLogger` + `dispatch-logger.vlog`
  retired; level-aware `Logger` (silent/info/verbose) everywhere.
- **Epic-runner correctness fixes** found mid-Epic: idle-watchdog
  re-reads the ticket and requires a grace-poll before reporting
  `failed`; Windows runner now kills the whole process tree
  (`taskkill /T /F /PID`); resumed runs short-circuit stories already
  `agent::done`.
- **`bootstrap-agent-protocols.js` maintainability** 74.4 → 94.6;
  `lib/config-schema.js` split into three files.

## [5.16.1] - 2026-04-22

### Headless hang protection for epic-runner sub-agents

Prevents `/sprint-execute` (Epic Mode) sub-agents from hanging forever
when they ask the operator a clarifying question. Root cause:
`stdio: ['ignore', …]` gives interactive prompts no reply path.

- **Non-interactive contract.** `sprint-execute.md` documents that
  headless Story runs must never ask clarifying questions — pick a
  reasonable default and log it, or transition to `agent::blocked`.
  Binds only when spawned headless.
- **Idle-output watchdog.** `defaultSpawn`/`defaultRunSkill` pipe
  stdout/stderr and reset an idle timer on every chunk. If no output
  arrives within `orchestration.epicRunner.idleTimeoutSec` (default
  900s; `0` disables), the child is killed and reported as
  `idle-timeout`.

## [5.16.0] - 2026-04-22

### Live epic-runner progress in IDE chat

Long multi-wave runs used to go silent in chat because the Bash tool's
10-min ceiling swallowed stdout and the `epic-run-progress` comment was
the only visible signal.

- **`ProgressReporter` file sink.** Accepts `logFile`; appends each
  rendered snapshot with an ISO-timestamped divider. `mkdir` is lazy.
- **Coordinator wiring.** Epic-runner resolves
  `<epicRunner.logsDir>/epic-<epicId>-progress.log` (default
  `temp/epic-runner-logs/`). Resolves to `null` when
  `progressReportIntervalSec <= 0`.
- **Skill guidance.** `sprint-execute.md` instructs IDE-chat runs to
  launch the runner with `run_in_background: true` and open a `Monitor`
  on the progress log, so each snapshot streams in as a notification.

### Workflow-to-script migration

Audit identified eight procedures where workflow markdown carried
bash/PowerShell logic that could drift from the scripts. Folded into
dedicated scripts so markdown is a launcher, not a recipe:

- **`sprint-execute-router.js`** — returns
  `{ mode: 'epic'|'story'|'reject', ticketId, … }` JSON; `/sprint-execute`
  routes on `mode` instead of re-implementing the `type::` label decision.
- **`delete-epic-branches.js`** — enumerate-and-delete for `epic/<id>`,
  `task/epic-<id>/*`, `feature/epic-<id>/*`, `story/epic-<id>/*`;
  supports `--dry-run` and `--json`.
- **`git-pr-quality-gate.js`** — runs the lint/format/test gate from
  `.agentrc.json → qualityGate.checks`.
- **`git-rebase-and-resolve.js`** — orchestrates the fetch → checkout
  → rebase retry loop; classifies outcome as `clean|conflict|error`.
- **`lib/plan-phase-cleanup.js`** — centralised temp-file cleanup
  contract for the sprint-plan split flow.
- **`validate-docs-freshness.js --json`** + **`epic-plan-healthcheck.js`
  invocation** from `/sprint-plan-decompose` — manual checklists replaced
  with deterministic checks.
- **`/git-merge-pr` Step 6** delegates to `detect-merges.js` instead of
  inline `git grep '<<<<<<<'`.

## [5.15.4] - 2026-04-22

### Decomposer ticket-cap alignment

The decomposer system prompt hardcoded `25` while
`agentSettings.maxTickets` defaulted to `40`. The LLM saw both and picked
the stricter one. `renderDecomposerSystemPrompt({ maxTickets })` now
interpolates the cap, so prompt and config can no longer drift.

## [5.15.3] - 2026-04-22

### Sprint-protocol resilience follow-ons (Epic #441)

Retro action items carried forward from Epic #413. No public API changes.

- **`variableNotUsed: $issueId` fix.** Shared GraphQL query builder no
  longer declares unused variables; wave-poller and `ColumnSync.sync`
  stop silently returning `unknown` rows.
- **Auto-post `friction` structured comments.** Reap-failure, wave-poller
  `getTicket` failure, and baseline-refresh sites emit friction comments
  via the MCP tool. Rate-limited per-Story (60s cooldown).
- **`post_structured_comment` `type` enum lift.** Added `code-review`,
  `retro`, `retro-partial`, `epic-run-state`, `epic-run-progress`,
  `wave-N-start`/`wave-N-end`, `parked-follow-ons`, `dispatch-manifest`.
- **`--reap-discard-after-merge` default.** `/sprint-close` Phase 4
  force-reaps worktrees whose Story branch is already merged,
  discarding post-merge drift. Emits a `friction` comment listing the
  discarded paths.
- **Launcher-level config validation.** `validateOrchestrationConfig`
  runs in `main()` of all runners — a schema-invalid `.agentrc.json`
  exits non-zero before anything begins.
- **`CommitAssertion` fallback** when `origin/story-<id>` is already
  deleted — counts commits on `origin/epic/<id>` whose message matches
  `resolves #<storyId>`.
- **Per-Story docs-context-bridge.** `story-close.js` emits a
  friction comment when a Story touches code paths referenced by
  `release.docs` — nudges doc updates per-Story instead of at Epic close.
- **CI captures stderr** (`2>&1 | tee` + `set -o pipefail`) so silent-
  stderr failures surface in `test-output.txt`.

## [5.15.2] - 2026-04-22

### Sprint-protocol resilience follow-ons (Epic #413)

Follow-ons from Epic #380. No public API changes.

- **Cross-platform `buildClaudeSpawn` integration test** asserts arg
  tokenisation across POSIX and Windows; honours `CLAUDE_BIN`.
- **Pre-wave spawn smoke-test.** Runner aborts before Wave 1 if
  `claude --version` fails to exit 0 in 5s; flips Epic to
  `agent::blocked` with friction comment.
- **Post-wave commit assertion.** A "done" wave with zero story-branch
  commits is reclassified as `halted`.
- **`sprint-story-close --resume / --restart`.** Detects prior failed-
  close state and offers explicit recovery instead of silently re-running
  the full chain.
- **Biome v2 format gate restored.** The
  `SPRINT_STORY_CLOSE_SKIP_VALIDATION` escape hatch is gone.
- **`/sprint-close` tagging sanity check.** Distinguishes no-tag /
  already-tagged / files-pre-bumped cases instead of double-bumping.
- **`ProgressReporter` stalled-worktree + maintainability-drift
  detectors.** Surfaced in the Notable section of each snapshot.
- **Whole-epic progress table.** Renders every wave + story with its
  current state, not just the active wave.
- **CI Node 22/24 matrix + integration-test job.**
- **Configurable runner logs dir** via
  `orchestration.epicRunner.logsDir` (default `temp/epic-runner-logs/`,
  was `.epic-runner-logs/`).

## [5.15.1] - 2026-04-22

### Sprint-protocol self-healing + orchestration refactor (Epic #380)

Closes three retro themes: sprint-protocol fragility on Windows, silent-
catch + opts-bag debt, residual dead code. No public API changes.

- **Windows worktree reap is two-stage.** `lifecycle-manager` retries
  `fs.rm` on `EBUSY`/`ENOTEMPTY`; anything still pinned is queued into
  `.worktrees/.pending-cleanup.json` and drained on next run.
- **Close-phase drift caught per-story.** `.worktrees/**`, `temp/**`,
  `dist/**` in root `biome.json` ignore; Biome v2 migration;
  `detect-merges.js` skips `.agents/workflows/`.
- **Retros never leak to Slack.** `/sprint-retro` routes through
  `provider.postComment` / MCP `post_structured_comment` instead of
  `notify.js`. Adds `retro-partial` checkpoint so a crashed retro
  resumes cleanly.
- **Cross-platform sub-agent dispatch** via new `buildClaudeSpawn`
  helper — fixes the Windows `shell: true` arg-quoting bug.
- **`OrchestrationContext` / `EpicRunnerContext` / `PlanRunnerContext`**
  at `lib/orchestration/context.js`. Every submodule accepts a `ctx`
  parameter instead of an opts bag.
- **`ErrorJournal`** writes structured JSONL to
  `temp/epic-<id>-errors.log`. Replaces silent `catch + logger.warn`
  sites.
- **Shared utilities:** `lib/util/poll-loop.js`, `label-transitions.js`.

Also: new `ProgressReporter` emits a periodic markdown table +
`epic-run-progress` structured comment during a wave (driven by
`progressReportIntervalSec`, default 120s).

### Epic-runner dependency source, auto-close, config hygiene

- **`buildStoryDag`** now derives Story-to-Story edges via
  `parseBlockedBy` on each Story's body — the same parser used by
  `manifest-builder`. Live GitHub payloads never populate `dependencies`,
  so a fresh Epic run could compute the wrong wave order.
- **`BookendChainer`** auto-invokes `/sprint-close` only when
  `epic::auto-close` was snapshotted at dispatch. `/sprint-code-review`
  and `/sprint-retro` remain operator-driven.
- **Removed** orphan fields `orchestration.epicRunner.storyRetryCount`
  and `blockerTimeoutHours`. Neither was consumed at runtime.

## [5.15.0] - 2026-04-22

### Self-serve planning, Kanban baseline, v5.14 retro fixes (Epic #349)

Planning is now a GitHub-triggered, review-first pipeline: label an Epic
`agent::planning` and the remote runner generates PRD + Tech Spec; label
`agent::decomposing` and it decomposes the hierarchy. No local IDE
needed until code review.

- **New workflow** `.github/workflows/epic-plan.yml` fires on
  `agent::planning` or `agent::decomposing`.
- **Split CLIs.** `/sprint-plan` chains `epic-plan-spec.js` → in-chat
  confirmation → `epic-plan-decompose.js`. `--auto-dispatch` applies
  `agent::dispatching` on completion.
- **`--phase` flag on `remote-bootstrap.js`** (`spec`|`decompose`|
  `execute`; `execute` is the default).
- **New labels:** `agent::planning`, `agent::review-spec`,
  `agent::decomposing`, `agent::ready`.
- **`ColumnSync`** extends to the new labels with precedence
  `done > blocked > review > spec-review > ready > planning > in-progress`.

**Default Kanban board.** `bootstrap-agent-protocols` provisions a
Projects V2 board with an eight-column Status field (`Backlog`,
`Planning`, `Spec Review`, `Ready`, `In Progress`, `Blocked`, `Review`,
`Done`) and three saved Views. Missing `project` scope degrades
gracefully to a warning pointing at `docs/project-board.md`.

**Epic #321 retro fixes:**

- **`risk::high` retired as a runtime gate.** Historical stamps remain
  as archival data; retro telemetry migrates to story count + blocker
  escalations.
- **Test-glob auto-discovery.** `npm test` uses `tests/**/*.test.js`.
- **Tightened `orchestration` config schema.** Surfaces typos at
  bootstrap rather than first use.
- **`WorkspaceProvisioner.verify`** runs in `story-init.js`;
  missing `.env` / `.mcp.json` fails with remediation instead of silent
  test breakage.
- **`/sprint-close` refactor.** Reorganised from 12 numbered steps into
  five named phases. New `--skip-retro` flag. Doc-freshness gate
  requires the Epic ID in the commit message or file body (pure-
  whitespace diffs no longer pass). Branch-protection prerequisite
  check when `epic::auto-close` is true.
- **`/sprint-execute` unification.** v5.14.0 alias is now canonical;
  `/sprint-execute-epic` and `/sprint-execute-story` retired. Routes on
  `type::` label.
- **Dispatch manifest unification.** Epic runner and planner both emit
  the frozen manifest via `renderManifest → persistManifest`.
- **Worktree reap sweep moved to plan time.**
- **Notifier wired into every orchestrator call site** that flips
  ticket state — closes the "manual label flip in the UI" blind spot.
- **Webhook config consolidated to MCP.** The webhook URL is now
  sourced exclusively from the `agent-protocols` MCP server env
  (`.mcp.json`) or `NOTIFICATION_WEBHOOK_URL`. The `.agentrc.json`
  entry points are removed.

## [5.14.0] - 2026-04-21

### Remote-orchestrator (Epic #321)

Epic-level execution now has a long-running remote runner, triggered by
a GitHub label flip and checkpointed via a structured comment.

- **New labels.** `agent::dispatching` (trigger; flipped to
  `agent::executing` on pickup). `epic::auto-close` (opt-in modifier
  for `/sprint-code-review` → `/sprint-retro` → `/sprint-close` at end
  of run).
- **Skill rename.** `/sprint-execute` → `/sprint-execute-story` (old
  name is a deprecation alias). New `/sprint-execute-epic` wraps the
  runner.
- **GitHub workflow** `.github/workflows/epic-dispatch.yml` fires on
  `agent::dispatching`, provisions secrets (`ENV_FILE`, `MCP_JSON`) via
  `::add-mask::`.
- **CLI** `remote-bootstrap.js` clones, materialises secret files at
  `0600`, runs `npm ci --ignore-scripts`, launches
  `/sprint-execute-epic`.
- **Engine** `lib/orchestration/epic-runner.js` composes wave-scheduler,
  story-launcher, state-poller, checkpointer, blocker-handler,
  notification-hook, bookend-chainer, wave-observer, column-sync.
- **`.agentrc.json`** gains `orchestration.epicRunner.{enabled,
  concurrencyCap, pollIntervalSec}`. Webhook URL sourced from MCP env
  or `NOTIFICATION_WEBHOOK_URL` (no longer readable from `.agentrc.json`).
- **`risk::high` runtime gating retired.** Label remains queryable for
  retro metrics but no longer halts dispatcher or story-close.
- **`WorkspaceProvisioner`** copies `.env` / `.mcp.json` into new
  worktrees.

## [5.13.3] - 2026-04-21

Two friction fixes bundled.

1. **Windows worktree reap hardening.** When `WorktreeManager.reap()`
   fails with a Windows rmdir-EACCES / sharing-violation class error,
   close now emits an explicit `OPERATOR ACTION REQUIRED:` line with
   remediation instead of only a `⚠️` warning. Safety-skips still use
   the quieter signal.
2. **Scope-overlap flagging at planning time.** Decomposer prompt
   instructs the host LLM to flag "docs update" / "README" Tasks that
   land downstream of an earlier Story whose AC already covers the
   same doc. Flagged Task body carries a `Scope verification note:`
   pointing at `git diff main -- <path>`.

## [5.13.2] - 2026-04-21

### Fix config-schema rejecting `release.versionFile: null`

Shell-injection guard was `not: { pattern: … }` — but JSON Schema's
`pattern` only applies to strings, so `null` vacuously passed the
inner schema and `not` flipped it into a validation failure. Every
project on the shipped default (`null`) failed config resolution.
Narrowed to `not: { type: 'string', pattern: … }`.

## [5.13.1] - 2026-04-21

### Reorder sprint-plan phases

Moved `Notification & Handoff` from Phase 3 to final phase so the
operator is notified only after Dispatch and Readiness Health Check
have run. No script changes.

## [5.13.0] - 2026-04-20

### Decompose oversized orchestration modules (Epic #297)

Three oversized modules split into cohesive submodules behind thin
façades. **No behaviour change, no public-API change** — every caller
imports the same symbols from the same paths.

- **Worktree Manager** 1,234 LOC → 223-LOC façade composing
  `lifecycle-manager`, `node-modules-strategy`, `bootstrapper`,
  `inspector` under `lib/worktree/`.
- **Dispatch Engine** 874 LOC → 196-LOC coordinator + six submodules
  (`dispatch-pipeline`, `wave-dispatcher`, `risk-gate-handler`,
  `health-check-service`, `epic-lifecycle-detector`, `dispatch-logger`).
- **Presentation Layer** 600 LOC → 175-LOC façade splitting pure
  rendering (`manifest-formatter.js`) from fs I/O
  (`manifest-persistence.js`).

`npm test` + `test:coverage` globs now descend into the new
sub-directories.

## [5.12.4] - 2026-04-20

### Performance-audit remediation

- **`dispatchWave`** now dispatches eligible tasks concurrently with
  bounded concurrency (10). A wave of N independent tasks completes in
  ~max(dispatch-time) instead of ~sum.
- **`getSubTickets`** paginates the GraphQL `subIssues` query. Previous
  50-node cap silently truncated large Epics; also pulls `databaseId`,
  `title`, `body`, `state`, `labels`, `assignees` so each node seeds
  the per-instance cache in one round-trip (kills the N+1 fan-out).
- **Context-hydration skill-path discovery** memoised in a module-scope
  `Map<skillName, absolutePath>`. O(1) lookup replaces the per-task
  `readdirSync` + `existsSync` probe.
- **`autoSerializeOverlaps`** accepts a pre-computed `reachable`
  matrix so upstream passes share one transitive-closure computation.
  `_collectPendingEdges` switches to focus-area bucketing — O(n²) →
  O(n + overlaps) on sparse manifests.
- **`labelSet: Set<string>`** added alongside `labels: string[]` for
  O(1) hot-path containment checks in `reconciler` and `dispatch-engine`.
- **`VerboseLogger.maxBufferSize`** (default 500) hard-caps the batched
  writer's in-memory buffer; drops oldest entries when the sink is
  unavailable, exposed via `stats()`.

## [5.12.3] - 2026-04-20

### Clean-code audit remediation

Internal refactor only — no behaviour change.

- **New shared utilities:** `lib/error-formatting.js`,
  `lib/path-security.js`, `lib/issue-link-parser.js`,
  `lib/risk-gate.js`, `lib/label-constants.js` (central registry of
  `AGENT_*`/`TYPE_*`/`STATUS_*`/`RISK_*` label names + `LABEL_COLORS`).
- **`lib/config-resolver.js`** — hand-rolled default dictionaries
  hoisted into module-scope `LOADED_CONFIG_DEFAULTS` /
  `ZERO_CONFIG_DEFAULTS`; 27-line default-apply block collapses to a
  loop.
- **`lib/config-schema.js`** — shell-injection regex consolidated to
  one constant; validated-string-fields pattern generated from an array.
- **Provider transport proxies removed.** `_rest` / `_graphql` /
  `_restPaginated` deleted; call sites invoke `this._http.*` directly.
  `graphql()` remains (public interface).
- **`story-close.js`** — ~10 `try/catch` phase wrappers collapse
  to a `runPhase(name, fn, fallback)` helper.
- **Consistency sweep:** all call sites use `Number.parseInt` instead
  of the global `parseInt` (43 occurrences across 27 files).

## [5.12.2] - 2026-04-20

### Runtime `--cwd` honored for config; worktree reap recovery

- `runStoryClose()` / `runStoryInit()` now pass `cwd` to
  `resolveConfig()`. Previously `--cwd` could be ignored for config
  lookup, so `worktreeIsolation` could appear disabled and reap was
  skipped entirely.
- `WorktreeManager._removeWorktreeWithRecovery()` now uses a longer
  Windows retry schedule (up to 6 attempts, 150ms–2s backoff). If
  repeated `git worktree remove` fails but `git worktree prune` clears
  the registration, reap is treated as successful for branch cleanup.

## [5.12.1] - 2026-04-20

### Harden `WorktreeManager.reap()` against submodule guard + Windows locks

- **Submodule guard retries** — the index is scrubbed of *all*
  mode-160000 gitlinks (not just `.agents`) via a generic helper, so
  consumer repos with additional submodules are covered.
- **Windows lock-like retries.** "Permission denied", "Access is
  denied", "Directory not empty", "resource busy", "sharing violation"
  now trigger short backoff (100/300ms) up to 3 attempts on win32.
- **Clear failure reason.** `remove-failed: <reason>` surfaces the real
  git stderr instead of a generic message.

## [5.12.0] - 2026-04-20

### Protocol self-healing — code review, recuts, parked follow-ons

Four related fixes landing together because they share the same data
path (Epic-level structured comments consumed at the wave-completeness
gate).

- **Maintainability scorer calibration.** `sprint-code-review` severity
  now requires an actual complexity hotspot (method < 20, or method-less
  module < 40). File-size-driven module-score drops reclassify as
  Medium — the v5.11.6 issue where well-structured multi-hundred-line
  scripts scored `0` no longer surfaces as a blocker.
- **Structured lint output.** `sprint-code-review` spawns the lint
  runner directly (previously mis-routed through `gitSpawn` and always
  failed) and parses stdout/stderr to separate errors from warnings.
- **Recut markers.** New `<!-- recut-of: #N -->` convention via
  `lib/orchestration/recut.js`. `sprint-story-init --recut-of <parentId>`
  injects the marker. Retro + wave-completeness attribute recut Stories
  back to their manifest parent so sprint counts line up.
- **Parked follow-on protocol.** Dispatcher upserts a
  `parked-follow-ons` structured comment at every cycle classifying
  every Story as manifest / recut / parked. `wave-gate.js` halts
  `/sprint-close` if any recut or parked Story is still open.
  `--allow-parked` / `--allow-open-recuts` waive the gate.

## [5.11.6] - 2026-04-20

### Fix: v5.11.5 regression — reap silently failed on drive-case mismatch

`_findByPath` compared paths with case-sensitive `===` on
`path.resolve()` output. On Windows, consumers routinely invoke
`story-close.js --cwd c:\repo` while git porcelain reports
`C:\repo` — the mismatch returned `not-a-worktree`, which was
silently swallowed. Branch delete then failed with "cannot delete
branch used by worktree".

- `_findByPath` and the `gc()` snapshot comparison now delegate to
  `_samePath` (Windows case-insensitive).
- `sprint-story-close` no longer silences `not-a-worktree`; every
  non-removed outcome is logged with a remediation hint.

## [5.11.5] - 2026-04-20

### Worktree reap hardening (Windows)

- `reap()` detects when Node's `cwd` is inside the target worktree and
  `chdir`s to `repoRoot` before `git worktree remove`. Windows holds a
  directory handle on cwd, causing silent removal failures.
- After `remove` succeeds, `reap()` verifies the directory is gone and
  falls back to `fs.rmSync` if git left the tree behind (lingering
  submodule metadata).

## [5.11.4] - 2026-04-19

### playwright-bdd skill: Epic C retro hardening

- **Pre-authoring checklist (mandatory)** in `playwright-bdd/SKILL.md`
  promotes grep-before-you-write from prose into a numbered report-back
  contract subagents must satisfy before authoring any scenario text.
- **Recommended invocation template** with verbatim
  `{{AC_TEXT}}` / `{{STEPS_DIR}}` / `{{OUTPUT_PATH}}` prompt.

## [5.11.3] - 2026-04-19

### Worktree `.agents` gitlink safeguards

- `ensure()` / `_copyAgentsFromRoot` marks the `.agents` gitlink entry
  with `update-index --skip-worktree` instead of running
  `git rm --cached`, so routine task commits can't accidentally stage
  a submodule deletion.
- `reap()` / `_removeCopiedAgents` clears `--no-skip-worktree` before
  the existing gitlink scrub. Guarded by `_isAgentsSubmodule()`.

## [5.11.2] - 2026-04-19

### Worktree reap + cancellation GC fixes

- `reapStoryWorktree` now roots `WorktreeManager` at the runtime repo
  root instead of module `PROJECT_ROOT` — reap targets the real main
  checkout when close is invoked from a copied `.agents` tree inside a
  story worktree.
- `collectOpenStoryIds` honors `worktreeIsolation.reapOnCancel`.
  Previously the flag had no effect.
- Manual dispatch output emits the safe close command with `<main-repo>`
  prefix and `--cwd <main-repo>` so operators run the closer against
  the real checkout by default.

## [5.11.1] - 2026-04-19

### HITL gate notifications

`handleRiskHighGate` and `handleHighRiskGate` now fire the configured
action webhook in addition to posting the GitHub comment. Unset
webhook URL is a graceful no-op; webhook failures are non-fatal and
never abort the HITL halt.

## [5.11.0] - 2026-04-19

### BDD / acceptance standardisation (Epic #269)

Pyramid-aware testing contract. `.feature` files are authored against a
single canonical rule, executed via a dedicated workflow, and ingested
as sprint evidence.

- **New rule:** `gherkin-standards.md` — SSOT for tag taxonomy
  (`@smoke`, `@risk-high`, `@platform-*`, `@domain-*`, `@flaky`),
  forbidden patterns (SQL, status codes, selectors, URLs, payloads,
  framework names, explicit waits), selector discipline, and the
  grep-before-you-write step-reuse protocol.
- **New skills:** `gherkin-authoring` (PRD AC → Scenario translation),
  `playwright-bdd` (config, fixtures, tag-filtered execution).
- **Rewritten rule:** `testing-standards.md` — pyramid-aware. Every
  test belongs to unit / contract / e2e with explicit scope,
  dependency, assertion, and location rules per tier.
- **New workflow:** `/run-bdd-suite` — tag-filtered acceptance runner
  producing a Cucumber HTML/JSON report as the QA evidence artifact.
- **Updated workflow:** `sprint-testing.md` consumes the Cucumber
  report; the sprint-testing ticket is gated on all scenarios passing.

No breaking changes. Projects that already author `.feature` files
should audit tag usage against the new canonical taxonomy.

## [5.10.10] - 2026-04-18

Follow-up hardening across v5.10.x worktree/sprint-close work.

- **`isSafeToRemove`** fails closed when `git merge-base` returns an
  unexpected exit rather than treating the worktree as safe to reap.
- **`remove`** refuses managed `story-N` worktrees without `epicBranch`,
  so merge verification cannot be bypassed by omission.
- **`WorktreeManager.prune()`** centralises `git worktree prune`.
- **`.gitmodules`** detection accepts quoted `path = ".agents"` entries.
- **Symlink `nodeModulesStrategy`** uses Windows `junction` (no admin
  required); retry loop replaces shelled-out `sleep` with `Atomics.wait`.
- **`epic-close.js`** now records Epic-close failures in the
  `warnings[]` buffer so a failed `updateTicket(... closed)` no longer
  slips past branch cleanup and prints 🎉.
- **`release` schema validation** — `docs` (shell-safe strings),
  `versionFile` (string or `null`), `packageJson` / `autoVersionBump`
  (booleans).
- **Tag-publication verification** moved to a new Step 7.1, immediately
  after the push — failed remote tags surface before Epic closure.

## [5.10.9] - 2026-04-17

### `reap` now purges per-worktree `modules/` directory

Git's submodule guard in `git worktree remove` fires when EITHER the
per-worktree index carries a 160000 gitlink OR
`<common-git-dir>/worktrees/<name>/modules/` exists on disk.
Previously we only handled the first. `_removeCopiedAgents` now also
calls `_purgePerWorktreeSubmoduleDir`, guarded by a containment check
so the main repo's `.git/modules/` is never touched.

## [5.10.8] - 2026-04-17

### `.agents/` copied into worktrees instead of symlinked

Consumer-project worktrees previously replaced `.agents/` with a
symlink (junction on Windows). Fragile: case/separator mismatches
caused silent cleanup failures, leaving links in place;
`git worktree remove` then refused ("submodule inside") or risked
wiping the root copy. `ensure()` now does a recursive `fs.cpSync` and
drops the submodule gitlink from the per-worktree index. Tradeoff:
mid-sprint `.agents/` updates don't propagate (recreate the worktree).

### `sprint-story-close` reaps before deleting the branch

`cleanupBranches` ran inside `finalizeMerge`, before
`reapStoryWorktree` — but git refuses to delete a branch still checked
out by a worktree. Moved out of `finalizeMerge`, now called after reap.
Result shape grows `branchLocalDeleted` + `branchRemoteDeleted` so
operators can tell which half went through.

## [5.10.7] - 2026-04-17

Bundled robustness pass — all backward-compatible unless called out.

- **`cascadeCompletion` error isolation.** `Promise.all` over parents
  swallowed every rejection except the first. Now returns
  `{ cascadedTo, failed: [{parentId, error}] }`.
- **Auto-resolved merge conflicts record an audit trailer** in the
  merge commit (`Auto-resolved-conflicts`/`Auto-resolved-file: …`) and
  return `autoResolvedFiles` so callers can surface the discarded lines.
- **`sprint-close` enumerates full Epic descendant set** via a
  BFS `collectEpicDescendantIds` walker over `getSubTickets`. Previous
  body-regex filter missed Stories whose bodies only referenced their
  Feature parent.
- **Per-ticket error isolation in `sprint-close`** — auxiliary ticket
  closure no longer rejects the whole `Promise.all` on one failure;
  exit code is `2` with a listed warning count when anything fails.
- **`batchTransitionTickets` retries transient errors** with
  exponential backoff (default 3 attempts, 500ms base). **Shape
  change:** `failed` is `{ id, error, attempts }[]` instead of `number[]`.
- **`sprint-story-init` halts by default on partial task-transition
  failure.** Opt back in with
  `orchestration.storyInit.continueOnPartialTransition: true`.
- **`ticket-validator`** fails fast on unknown `depends_on` slugs
  instead of silently dropping them at ticket-creation time.
- **Scrub `.agents` gitlink from worktree index before
  `git worktree remove`.** `skip-worktree` hid the gitlink from the
  working copy but the 160000 entry was still in the index, so the
  guard fired. Runs `git rm --cached -f -- .agents`; only active when
  the root repo declares `.agents` as a submodule.

## [5.10.6] - 2026-04-16

### Copy untracked bootstrap files into new worktrees

`git worktree add` respects `.gitignore`, so `.env` / `.mcp.json`
didn't propagate — Clerk secrets and DATABASE_URL tests failed
silently.

- **`_copyBootstrapFiles`** runs after `_applyNodeModulesStrategy` and
  before `_installDependencies`, so postinstall hooks (Prisma) see the
  propagated values.
- **Config:** `orchestration.worktreeIsolation.bootstrapFiles` (default
  `[".env", ".mcp.json"]`). `..`, absolute paths, and NUL-bytes
  rejected. Existing worktree files never overwritten.

## [5.10.5] - 2026-04-16

### Sprint-close performance: batched branch deletion

- **Batched remote deletes** — single `git push origin --delete b1 b2 …`.
  ~85% reduction in remote-cleanup wall time. Falls back per-branch on
  failure.
- **Batched local deletes** — single multi-arg `git branch -D`.
- **`git remote prune origin`** replaces unconditional
  `git fetch --prune`, skipping the object fetch entirely.

### Fix: branch cleanup blocked by stale worktrees

- **Worktree reap before branch deletion** — `sprint-close` calls
  `WorktreeManager.gc([])` before `git branch -D`.
- **Stale lock sweep** — clears orphaned `.git/index.lock` and
  per-worktree lock files.
- **Unconditional `git worktree prune`** — runs even without worktree
  isolation enabled.

### Fix: root `.agents/` wiped during sprint-close on Windows

Strict string equality in `_unlinkAgentsFromRoot` failed on drive-letter
case or separator normalisation, so `.agents` symlinks were left in
place and `git worktree remove` traversed the junction to delete the
real root `.agents`. Added `_samePath` helper (case-insensitive on
Windows, strict elsewhere) and a containment assertion in
`_linkAgentsToRoot` to refuse `fs.rmSync(recursive)` when the resolved
worktree `.agents` aliases the root.

## [5.10.4] - 2026-04-16

### Post-plan health check and pnpm store priming

New Phase 5 at the end of `/sprint-plan`.

- **`epic-plan-healthcheck.js`** — ticket hierarchy validation,
  git-remote reachability, orchestration config validation, and pnpm
  store priming.
- **pnpm store prime** — when `nodeModulesStrategy: 'pnpm-store'`,
  runs `pnpm install --frozen-lockfile` at plan time so the global
  content-addressable store is populated; worktree installs hard-link
  from the cache.
- **Non-blocking** — always exits 0; the plan is already on GitHub.

## [5.10.3] - 2026-04-16

### Robustness and performance hardening for sprint-story-init

Covers 16 findings. Highlights:

- **Batch-transition result checking** — warns on failed tasks instead
  of silently proceeding.
- **TOCTOU race in `ensureEpicBranch`** — post-checkout branch
  assertion detects concurrent HEAD switches.
- **Consistent retry on packed-refs contention** — `ensureEpicBranch`
  and `checkoutStoryBranch` use new `gitPullWithRetry`.
- **Worktree `ensure()` race** — catches "already exists" and falls
  back to reuse.
- **Upfront cycle detection** — `extractAndSortTasks` calls
  `detectCycle()` before `topologicalSort()` with named offenders.
- **Concurrency-capped ticket transitions** — batch size 10.
- **`_findByPath()` caches `git worktree list`** output for 5s.
- **Stale lock TTL** raised from 30s → 5 min.
- **Jitter in fetch retry backoff** — 0–50% random.
- **pnpm-store hardening:** retry 3× with 0s/2s/5s backoff, timeout
  raised to 300s, post-install `node_modules` verification,
  `installFailed` signal threaded through story init JSON.

## [5.10.2] - 2026-04-16

### Worktree bootstrap hardening

- **`currentBranch()` short-circuit** in `ensureEpicBranch` /
  `checkoutStoryBranch` — prevents the race where `branchExistsLocally`
  returns false while HEAD is already on the target branch.
- **`ensureEpicBranchRef()`** — HEAD-safe variant for worktree
  bootstrap using `git branch` / `git fetch` instead of `checkout`, so
  the main checkout's HEAD is never moved.
- **Auto `_installDependencies()`** in `ensure()` — runs
  `npm ci` / `pnpm install --frozen-lockfile` / `yarn install` during
  worktree creation. Non-fatal on failure.

## [5.10.1] - 2026-04-16

### Configurable ticket decomposition cap

`agentSettings.maxTickets` replaces the hardcoded 25-ticket limit.
Default raised to **40**.

## [5.10.0] - 2026-04-16

### Removed: ROADMAP.md and roadmap sync infrastructure

GitHub Issues are the single source of truth. The local `ROADMAP.md`
was a read-only mirror adding maintenance surface area for no value
beyond what GitHub shows.

Removed: `docs/ROADMAP.md`, `generate-roadmap.js`,
`update-roadmap.yml` template, `roadmap-sync.md` workflow,
`agentSettings.roadmap` config, `roadmap-exclude` label, roadmap
references across docs, and the `--install-workflows` step in
`bootstrap-agent-protocols.js` (the only installable workflow was
`update-roadmap.yml`).

### Removed: `/create-epic` and `/run-red-team`

- `/create-epic` — the agent drafts well-structured Epics in natural
  language; the workflow added ceremony without value.
- `/run-red-team` — `/audit-security` covers the same ground in a more
  structured way.

### Renamed: `/audit-dependency-update` → `/audit-dependencies`

Consistent with the other `/audit-*` naming. Output file renamed to
`audit-dependencies-results.md`.

## [5.9.0] - 2026-04-15

Bundled SDLC-review release addressing seven findings.

- **Dispatch manifest is now a structured Epic comment** —
  idempotently upserted via `postManifestEpicComment`.
- **Wave-completeness gate at sprint-close.** `wave-gate.js`
  reads the `dispatch-manifest` comment and verifies every listed
  story is closed.
- **Retro detection moved off heading-grep.** Prefers a
  `type: "retro"` structured-comment lookup; falls back to the new
  `<!-- retro-complete: <ISO> -->` marker.
- **Code-review findings persisted** via
  `upsertStructuredComment({ type: 'code-review' })`. Retro reads the
  comment to summarise blockers in its Architectural Debt section.
- **`/git-push` and `/git-commit-all` consolidated.** `git-push.md` is
  the single source of truth and accepts `--no-push`.
- **Shared merge-conflict resolution partial** at
  `_merge-conflict-template.md`; `/git-merge-pr` Step 2.5,
  `/sprint-execute` Step 1, and `/sprint-close` Step 6 reference it
  instead of inlining three copies.
- **`risk::high` resume protocol is now chat-only.** Operator types
  `Proceed` / `Proceed Option 1|2|3`; on Option 1 the agent removes
  the label via new `update-ticket-state.js --remove-label` and
  re-runs `sprint-story-close`.
- **Epic-branch merge lock** via `lib/epic-merge-lock.js` — filesystem
  mutex at `.git/epic-<epicId>.merge.lock` with PID + timestamp stale-
  lock detection. `finalizeMerge` acquires/releases in `try/finally`.

## [5.8.7] - 2026-04-15

### Robust story→epic merge at story close

Parallel wave execution kept producing conflicts — Stories branched
early in a wave landed after peers had merged. `finalizeMerge` now:

1. **Pre-merge rebase in the story worktree** onto
   `origin/<epicBranch>`, shrinking the conflict surface to the
   Story's real delta. Failed rebase is aborted and merge still
   proceeds.
2. **Conflict triage via `mergeFeatureBranch`** — same threshold-based
   triage used at integration time (major ≥3 files or ≥20 markers =
   abort; minor = auto-resolve by accepting Story's version with audit
   log).

### Per-worktree `.agents` collapsed into root symlink

Consumer projects declare `.agents` as a submodule; the per-worktree
gitlink caused `git worktree remove` to refuse. `ensure()` now
replaces the worktree's `.agents/` with a symlink (junction on
Windows) to `<repoRoot>/.agents` and marks the per-worktree index
entry `skip-worktree`. `reap()` removes the symlink before
`git worktree remove`. Auto-detected: if `.gitmodules` declares
`.agents` as a submodule path, the symlink applies.

### Sprint-close auto-invokes pre-merge gates

`/sprint-close` auto-invokes `/sprint-code-review` (new Step 1.4) and
`/sprint-retro` (revised Step 1.5) inline instead of halting to ask
the operator to run them separately. `--skip-code-review` available as
an override.

### Sprint Health ticket closed alongside PRD/Tech Spec

Step 8's closure sweep now matches any ticket carrying `type::health`
or a title starting with `📉 Sprint Health:`, in addition to
`context::prd` / `context::tech-spec`.

### Stale-lock sweep for shared `.git/` dir

`WorktreeManager.sweepStaleLocks({ maxAgeMs = 30_000 })` removes
well-known lock files (`index.lock`, `HEAD.lock`, `packed-refs.lock`,
`config.lock`, `shallow.lock`) whose mtime exceeds the threshold.
Fresh locks belonging to in-flight ops are skipped. Runs at
`/sprint-execute` start, before worktree GC.

## [5.8.6] - 2026-04-15

### Replace `risk::high` story PR creation with in-chat pause

The `risk::high` story-close gate used to branch-push and open a GitHub
PR, then exit non-zero. Now performs **zero** remote mutations — no
PR, no push, no comment, no label change. Prints a three-option HITL
prompt to stderr and exits non-zero; the `/sprint-execute` agent relays
the options to the operator in chat:

1. Proceed with auto-merge (agent removes `risk::high`, re-runs close).
2. Merge manually.
3. Reject / rework (leave branch alone, open follow-ups).

Also: `default-agentrc.json` now ships with
`worktreeIsolation.nodeModulesStrategy: 'pnpm-store'`.

## [5.8.5] - 2026-04-15

### Narrow `risk::high` rubric and add HITL opt-out

The 17-heuristic rubric had drifted to include quality/style rules, so
the gate fired on routine stories. Narrowed to 5 destructive/
irreversible categories:

1. Destructive or irreversible data mutations.
2. Shared security / auth infrastructure.
3. CI/CD, deployment, or release-gating changes.
4. Monorepo-wide parallel AST/text replacements.
5. Schema migrations rewriting rows or dropping columns without
   backfill.

New `orchestration.hitl.riskHighApproval` (default `true`) toggles
both gates. When `false`, `risk::high` stays informational on tickets
but neither dispatch nor close pauses — teams that trust the decomposer
catch high-risk work at code review instead.

## [5.8.4] - 2026-04-15

### Enforce JIT story-branch and worktree creation

`dispatch()` was eagerly creating story branches + worktrees for every
story whose tasks appeared in a ready wave, producing mysterious
`.worktrees/story-<id>/` directories for stories still on paper.
`dispatchTaskInWave()` now skips story-pattern branches with
`status: 'skipped-not-initialized'` and logs
`/sprint-execute #<storyId>`. Non-story task-level branches still get
JIT-created (no separate init step). Story branches + worktrees are
created **exclusively** by `story-init.js`.

## [5.8.3] - 2026-04-15

### Remove no-op "Live Integration Tests" CI job

The `e2e` job was a placeholder that ran `npm ci` and echoed a TODO —
blocking `publish` for zero coverage.
`tests/integration/parallel-sprint.test.js` was likewise dead (outside
the `tests/*.test.js` + `tests/lib/*.test.js` glob). Both removed.

### `techStack` moved from config to `docs/architecture.md`

The `techStack` block was never read by any script — it was
prose-referenced guidance. Stuffing opinionated stack defaults into
`default-agentrc.json` meant every new project inherited a
Hono + Cloudflare + Turso + Clerk + Astro + Expo template. Architecture
context belongs in architecture docs.

**Breaking (config shape):** `techStack` removed from `.agentrc.json`
and `default-agentrc.json`. Consumers should migrate the same content
into their own `docs/architecture.md` under `## Tech Stack`.

## [5.8.2] - 2026-04-15

### `agentSettings` audit & reorganization

**Breaking (config shape):**

- **Renamed:** `agentSettings.roadmapPath` → `agentSettings.roadmap.path`
  (nests alongside `roadmap.autoGenerate` / `excludeLabels`).
- **Removed:** `agentSettings.autoRunSafeCommands`,
  `agentSettings.defaultPersona`, `agentSettings.protocolRefinement`
  — none were read by any code or workflow.

**Default changed:** `maxTokenBudget` default `80000` → `200000` to
match modern model windows.

Reorganised field order inside `agentSettings` (no behavior change):
identity → docs/roadmap → lifecycle → runtime caps → commands →
telemetry/safety.

## [5.8.1] - 2026-04-15

### Model selection simplified to a binary tier

Concrete model selection removed from the protocol. Stories carry a
binary `model_tier` (`high` for deep-reasoning / `low` for fast
execution) derived solely from `complexity::high`. Picking a specific
model is left to the operator or an external router.

**Breaking (config + manifest shape):**

- **Removed:** `agentSettings.defaultModels`,
  `agentSettings.bookendRequirements`, top-level `models` block
  (categories / chaining / finops).
- **Removed:** `resolveModel()`, `resolveRecommendedModel()`, `Model`
  field on task tickets, `recommendedModel` property on story manifest
  and Story Dispatch Table.
- **Renamed:** `model_tier` enum value `fast` → `low`.

## [5.8.0] - 2026-04-15

### CI Auto-Heal removed

The `auto-heal.js` CLI, risk-tier resolver, Jules / GitHub Issue
adapters, `/ci-auto-heal` workflow, reference Actions template, and
the `autoHeal` config block are gone. Shipped in v5.3.0, never wired
into the active CI workflow, and had no usage in practice. Removed
~850 LOC + config surface.

### `/sprint-execute` simplified to Story-only

**Breaking (skill contract):** `/sprint-execute` no longer accepts
Epic IDs. Every invocation runs one Story end-to-end:
init → worktree → implement → validate → merge → reap. Epic-level
planning (waves, Story Dispatch Table) lives in `/sprint-plan` Phase
4, which is where operators were picking stories anyway.

`story-init.js` now honors
`orchestration.worktreeIsolation.enabled` and seeds the story branch
ref in the main checkout without moving HEAD. Returned JSON exposes
`workCwd`, `worktreeEnabled`, `worktreeCreated`. Agent `cd`s into
`workCwd` before Step 1 and passes `--cwd <main-repo>` to
`story-close.js`.

**Deprecated (not yet removed):** `dispatcher.js` agent-launch loop,
`IExecutionAdapter`, Jules/queue adapter plumbing, story-wave
execution tests.

### Retros move to GitHub Epic comments + `runRetro` toggle

Retros are no longer written to `docs/retros/retro-epic-<id>.md`.
Every retro posts as a structured comment on the Epic issue,
beginning with a `## 🪞 Sprint Retrospective — Epic #<id>` marker.

**Breaking (config shape):** `agentSettings.retroPath` removed; new
`agentSettings.sprintClose.runRetro` (default `true`) controls the
close-time retro gate.

### Config defaults

- `worktreeIsolation.enabled: true` by default —
  `/sprint-execute <StoryID>` produces `.worktrees/story-<id>/` out of
  the box.
- `sprintClose.runRetro: true` (replacing `retroPath`).

## [5.7.0] - 2026-04-15

### Worktree-per-story isolation (Epic #229)

Parallel sprint execution now runs each dispatched story in its own
`git worktree` at `.worktrees/story-<id>/`. Fixes the 2026-04-14
incident where five concurrent agents raced on the main checkout's
HEAD and cross-contaminated a commit.

- **`WorktreeManager`** owns `ensure`, `reap`, `list`, `isSafeToRemove`,
  `gc`. Refuses `--force`.
- **New config block:** `orchestration.worktreeIsolation` — `enabled`,
  `root`, `nodeModulesStrategy` (`per-worktree` | `symlink` |
  `pnpm-store`), `primeFromPath`, `allowSymlinkOnWindows`,
  `reapOnSuccess`, `reapOnCancel`, `warnOnUncommittedOnReap`,
  `windowsPathLengthWarnThreshold`.
- **`--cwd` flag** and `AGENT_WORKTREE_ROOT` env precedence on
  `sprint-story-init`, `sprint-story-close`, `assert-branch`.
- **`git-branch-lifecycle.js`** — shared branch state machine consumed
  by both `sprint-story-init` and `dispatch-engine`.
- **`gitFetchWithRetry`** — bounded retry (250/500/1000 ms) on known
  packed-refs lock-contention signatures.
- **Reap-on-merge** and **gc-on-start** — `sprint-story-close` reaps
  the story's worktree after a successful merge; `dispatch()` GC
  sweeps orphaned worktrees on start.
- **Windows:** `core.longpaths=true` set on each new worktree;
  pre-flight path-length warning posted to the Epic when estimated
  deepest path exceeds the configured threshold.

### Performance

- **Per-instance ticket memoization** on `GitHubProvider.getTicket`
  with `primeTicketCache` / `invalidateTicket`.
- **Batched `VerboseLogger`** — entries buffer until 50 rows / 1000 ms
  / `process.exit` / explicit `flush()`.
- **`isSafeToRemove`** collapsed to a single
  `git merge-base --is-ancestor` probe. ~40% fewer git spawns.
- **Context-hydration file cache** memoises templates / personas /
  skills by absolute path (`__resetContextCache()` for tests).
- **Pre-compiled task-metadata regexes.**

### Clean code

- **`dispatch()`** split into step helpers. Orchestrator shrinks from
  184 LOC to ~40 LOC.
- **`runStoryClose`** split into `reapStoryWorktree`,
  `notifyStoryComplete`, `updateHealth`, `refreshDashboard`,
  `cleanupTempFiles`. Each phase individually testable.
- **`Logger.debug()` / `Logger.error()`** — `debug` gated behind
  `AGENT_LOG_LEVEL=debug`.
- **Silent failures fixed:** topological-sort failure throws with
  context; refinement-service cleanup logs at debug instead of
  `catch {}`.
- **Removed over-defensive `(t.labels ?? [])` guards** on provider-
  sourced tickets (`ITicketingProvider` guarantees `labels: string[]`).

## [5.6.0] - 2026-04-14

### Planning pipeline — host LLM authors PRD / Tech Spec / tickets

Removed the standalone external-LLM dependency from planning scripts.
The host LLM driving the harness now authors planning artifacts
directly; Node scripts become deterministic GitHub I/O wrappers.

**Breaking (CLI + config):**

- **Removed:** `lib/llm-client.js` and its test. No more
  `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` usage.
- **Removed:** `orchestration.llm` config block and schema entry.
- **`epic-planner.js` has two modes.** `--emit-context` prints a JSON
  envelope (epic body, scraped docs, recommended system prompts).
  Default mode takes `--prd <file> --techspec <file>` and creates the
  two planning issues.
- **`ticket-decomposer.js` has two modes.** `--emit-context` prints
  PRD/Tech-Spec bodies + decomposer system prompt. Default mode takes
  `--tickets <file>` and validates + creates issues.

## [5.5.3] - 2026-04-14

### Planning hardening — close silent task-drop paths

Every path where Tasks could be silently dropped between LLM output
and GitHub issue creation has been converted from "silently continue"
to either "throw" or "warn loudly":

- **Duplicate slug detection** — validator's `Map.set()` silently
  overwrote earlier tickets with the same slug; now throws naming both
  colliding titles.
- **Unresolved `parent_slug`** — decomposer used to default to the
  Epic ID when a Story or Task parent was missing, silently orphaning
  tickets. Now throws.
- **Unresolved `depends_on`** — `.map(slugMap.get).filter(Boolean)`
  silently discarded unresolved slugs. Now warns per unresolved dep.
- **LLM truncation heuristic** — warns when the response has 25+
  tickets so operators can split the Epic.
- **Per-Story task-count invariant.** Validator now builds a
  `taskCountByStory` map after hierarchy validation and throws when
  any Story has no child Tasks.
- **Decomposer system prompt** — mandatory cardinality clause: every
  Story MUST decompose into at least one Task.

## [5.5.2] - 2026-04-14

### `.agents/` consolidation pass

- **Schemas:** Removed obsolete `dispatch-manifest.schema.json` (never
  referenced). Renamed `audit-rules.json` → `audit-rules.schema.json`
  for consistency.
- **Stack skills:** Pruned ~23 empty `examples/` / `resources/` /
  `scripts/` stub subdirectories.
- **Skill merges:** `stripe-payments` + `stripe-billing-expert` →
  `backend/stripe-integration`; `backend/clerk-auth` +
  `security/secure-telemetry-logger` →
  `security/backend-security-patterns`. Stack skill count 22 → 20.

## [5.5.1] - 2026-04-14

### Planning hardening (parallel-story contention)

- **`computeStoryWaves`: focus-area overlap serialization.** Stories
  with no dependency edge but overlapping target directories (e.g.
  five stories editing `apps/api/src/routes/v1/media/`) previously
  landed in the same wave. Now rolls task-level `focusAreas` up to
  the story and adds deterministic ordering edges on overlap.
  Global-scope stories serialize after everything else.
- **`sprint-story-init`: tri-state Epic branch bootstrap.** Old logic
  only inspected `ls-remote`. If `epic/<id>` existed locally but not
  remotely (prior partial init, parallel bootstrap), the script ran
  `checkout -b` and crashed. Now checks local + remote independently
  and handles all four states. Dirty-working-tree guard runs before
  any branch switch.
- **`assert-branch.js`** — pre-commit branch guard that verifies
  `git branch --show-current` matches the expected branch. Intended
  to run before every `git add` / `git commit` in shared-tree
  workflows.
- **`git add .` → explicit staging** in every sprint-time workflow.
  `git add .` sweeps untracked files that may belong to another agent
  under parallel execution.

Root cause: a multi-story sprint where HEAD swapped
`epic/267 → story-329 → story-307 → story-302 → story-304` in seconds,
and a `git add -A && git commit` intended for `story-329` ran while
the working dir was on `story-304`.

## [5.5.0] - 2026-04-14

### New features

- **`retroPath`** — configurable retrospective output location (default
  `docs/retros/retro-epic-{epicId}.md`).

### Workflow hardening

- **Retrospective Gate (Step 1.5)** in `/sprint-close` halts when the
  retro document does not exist at `[RETRO_PATH]`. Previously
  `/sprint-retro` could be silently skipped because the dispatcher's
  Bookend Lifecycle only announced phases without executing them.
- **Dispatcher Epic-complete comment** lists the four bookend slash
  commands with the Epic ID pre-filled and warns that skipping
  `/sprint-retro` trips the new Retrospective Gate.

### Clean-code refactor

- **`lib/cli-utils.js`** — shared `runAsCli()` helper replaces 15
  duplicated main-guard + error-handling blocks.
- **`lib/story-lifecycle.js`** — shared Story helpers
  (`resolveStoryHierarchy`, `fetchChildTasks`,
  `batchTransitionTickets`) used by both story-init and story-close.
- **`providers/github-http-client.js`** — testable HTTP transport
  extracted from the 899-LOC `GitHubProvider`. Accepts injectable
  `fetchImpl` + `tokenProvider`.
- **`lib/orchestration/dispatcher.js` → `dispatch-engine.js` (SDK
  rename).** Two files named `dispatcher.js` (CLI wrapper and SDK
  engine) → renamed SDK files while leaving CLI entry points untouched.
- **Deferred module-level side effects.** `config-resolver` no longer
  calls `loadEnv()` at module scope; `dispatch-engine` lazily resolves
  config + initialises `VerboseLogger` via a Proxy.
- **Removed orphan "Refinement Loop" cluster** — `refinement-agent.js`,
  `friction-service.js`, `impact-tracker.js` had zero non-test
  consumers. ~300 LOC removed.

## [5.4.6] - 2026-04-14

- **`sprint-close`: Explicit skip for `autoVersionBump: false`.**
  Guard at the top of Step 3 instructs the agent to skip the entire
  Version Bump & Tag step; previously only the `true` path was
  documented.

## [5.4.5] - 2026-04-13

- **`auditOutputDir`** — configurable audit report destination
  (default `temp`). All 12 audit workflows use a `{{auditOutputDir}}`
  placeholder resolved by `runAuditSuite`.
- **`sprint-story-close` webhook fires on story-complete** — added
  `actionRequired: true` to the notification payload.

## [5.4.4] - 2026-04-12

- **`sprint-close`: Resilient branch cleanup.** Runs `git stash clear`
  before branch deletion; each remote delete is individually
  try/catch'd so one failure doesn't abort the pass.
- **`update-roadmap.yml`: Robust CI push** — `git pull --rebase`
  before pushing.

## [5.4.3] - 2026-04-12

- **`sprint-story-close`: Automated story-complete notifications** —
  INFO-level notification that @mentions the operator on the Epic
  when a story merges.

## [5.4.2] - 2026-04-12

- **Commitlint `subject-case` fix.** `finalizeMerge` lowercases the
  first character of `storyTitle` before interpolating into
  `feat: <title> (resolves #N)`.
- **Dispatch manifest never updated after story close.** Dashboard
  refresh was behind an opt-in `--refresh-dashboard`. Inverted: now
  on by default; pass `--skip-dashboard` to opt out.
- **Ephemeral story manifest cleanup.** After successful merge +
  branch delete, `temp/story-manifest-<storyId>.{md,json}` is deleted.

## [5.4.1] - 2026-04-12

- **Enforced quality gates.** Removed `--no-verify` from
  `/git-commit-all`.
- **New `/git-push` workflow** — stages, commits, pushes while
  strictly prohibiting hook bypass.

## [5.4.0] - 2026-04-12

### Performance & Scalability (Epic 227)

- **Parallel execution engine** — sequential loops replaced with
  `Promise.all` for task status transitions, nested ticket closure
  cascades, and the multi-step audit orchestrator.
- **Async I/O migration** — project documentation scraping and file
  traversal moved to `fs.promises`.
- **Graph optimization** — high-efficiency topological sort for
  complex dependency trees.

### New workflows

- **Batch merge support** — `/git-merge-pr` accepts multiple PR numbers.

### Refactors

- **Audit suite — workflow-first.** `.agents/scripts/audits/` removed
  entirely. `run-audit-suite.js` now resolves the corresponding
  `.agents/workflows/<auditName>.md` and returns its markdown as a
  structured result. The calling agent executes it as a prompt-driven
  analysis — no separate Node scripts.

### Workflow hardening

- **Robust remote cleanup** — branch deletion in merge workflow uses
  two-stage strategy: `git push --delete` first, automatic fallback
  to the **GitHub REST API via credential extraction** so remote
  branches are pruned even when Husky pre-push hooks block them.

## [5.3.0] - 2026-04-11

### CI Auto-Heal Pipeline

Autonomous self-remediation engine with a governance-tiered risk
model (Green/Yellow/Red tiers resolved from failed CI stages).

- **`auto-heal.js`** — best-effort CLI that assembles AI prompts from
  CI logs and dispatches to specialized adapters without failing the
  pipeline.
- **Risk resolver** — pure-function governance logic for modification
  constraints + auto-approval eligibility.
- **Prompt builder** — log collection, truncation, context hydration
  from the GitHub graph.
- **Adapters:** `JulesAdapter` (Jules API v1alpha),
  `GitHubIssueAdapter` (labeled Issues + optional Copilot Workspace
  assignment).
- **Config:** `autoHeal` block with full AJV validation.
- **Workflow:** `/ci-auto-heal` slash command +
  `ci-auto-heal-job.yml` Actions template.

(Removed in v5.8.0 — never wired into an active CI workflow.)

## [5.2.3] - 2026-04-11

- **New `/git-merge-pr` workflow** — automated analysis, conflict
  resolution, quality validation, merging.
- **`GitHubProvider`** — extracted duplicate Epic fetch/mapping logic
  into `_getEpics` helper.

## [5.2.2] - 2026-04-10

- **`ensureProjectFields`** bug fix — signature expected `fieldDefs`
  cleanly (unused `_ticketId` parameter issue), resolving a
  referential error during bootstrap.

## [5.2.1] - 2026-04-10

### Cross-owner project support

- **`projectOwner`** config field allows issues/PRs to be managed on a
  Projects V2 board owned by a different org or user — decouples repo
  owner from board host. Defaults to repo `owner` when omitted
  (backward-compatible).

## [5.2.0] - 2026-04-10

### Quality hardening

- **85%+ test coverage milestone** — 89.57% line coverage. Strict 85%
  CI coverage ratchet using native Node 22+ test-coverage runner.
- **Stryker mutation testing** — `tap-runner` plugin; weekly CI
  workflow and `npm run mutate` script.
- **Refinement loop reverted** — removed `friction-analyzer.js` and
  `refine-protocols.yml`. Protocol refinement is now a manual operator
  review of friction logs, not autonomous PRs.
- **Automated branch hygiene** — `branch-cleanup` CI job prunes
  merged `epic/` and `story/` branches on merge to `main`.
- **CI pinned to Node 22.**

## [5.1.0] - 2026-04-09

### Autonomous protocol refinement (Epic 74)

Self-healing feedback loop that analyzes sprint friction logs to
suggest and track protocol improvements.

- **Friction analyzer** — ingests structured friction logs, classifies
  into actionable categories (Prompt Ambiguity, Tool Limitation, etc.).
- **`ProtocolRefinementAgent`** — identifies recurring patterns and
  generates targeted refinements via GitHub PRs.
- **Impact tracker** — monitors reduced friction rates in sprints
  following a refinement merge, posting performance reports on the
  original PR.
- **Health monitor** — real-time visualization updating a
  "Sprint Health" issue with MCP tool success rates and active
  friction events.

(Largely reverted in v5.2.0; scripts removed in v5.5.0 as unused.)

## [5.0.0] - 2026-04-05

### Major rewrite

**No backward compatibility with v4.x.x or earlier.**

- **Architecture.** GitHub-native Epic Orchestration with four-tier
  hierarchy (**Epic → Feature → Story → Task**). Provider-agnostic
  `ITicketingProvider` abstraction with native GitHub integration
  (GraphQL Sub-Issues and Projects V2).
- **GitHub as single source of truth** — eliminates local docs /
  metadata persistence.
- **Self-contained dependencies** — core orchestration uses native
  Node 20+ `fetch` with minimalist JS; no SDK bloat.
- **Orchestration SDK (Epic 71)** — scripts migrated into a shared
  SDK, exposed to agent environments via an MCP server.
- **Audit orchestration (Epic 72)** — automated static analysis + audit
  pipeline at sprint lifecycle gates. Maintainability ratchet.
- **Execution model (Epic 98)** — deprecated monolithic Epic branches
  in favor of Story-Level Branching.
- **Removed:** legacy local docs system (`sample-docs/`), v4 protocol
  version enforcement, legacy telemetry/indexing scripts.

---
*For historical changes prior to v5.0.0, see the [Legacy Changelog (v1.0.0 – v4.7.2)](docs/CHANGELOG-v4.md).*
