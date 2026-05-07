# Changelog

All notable changes to this project will be documented in this file.

## [5.36.3] — 2026-05-07

Patch: replace the standalone Windows git-perf doc with an automated
warn-only check, condense the changelog, and clean up stale doc pointers.

### Added

- **`.agents/scripts/check-windows-git-perf.js`** — new stdlib-only,
  warn-only probe that verifies the three host-level git settings the
  framework benefits from on Windows (`core.fsmonitor true` global,
  `feature.manyFiles true` global, per-repo `git maintenance` schedule).
  No-op on macOS / Linux. Never mutates global config; prints the exact
  commands to run for any missing setting and always exits 0.
- **`update-self.js` integration** — `/agents-update` now invokes the
  perf check after the `.claude/commands/` sync so consumers get the
  warning surface on every framework bump.
- **`/agents-bootstrap-project` Step 9** — new step in the workflow doc
  invokes the perf check during local bootstrap.

### Changed

- **CHANGELOG consolidated.** Entries for 5.0.0 – 5.29.0 (April 9 –
  April 26, 2026) moved from `docs/CHANGELOG.md` to
  `docs/archive/CHANGELOG-5.0-5.29.md` so the active changelog stays
  scoped to the current month. Main file shrank from ~2880 to ~970
  lines; full history is preserved in the archive.

### Removed

- **`docs/windows-git-performance.md`** — superseded by the automated
  check above. README and `.agents/README.md` "where to look" tables
  updated; `decisions.md` reference rewritten in place.
- **`docs/friction-logging.md`** — duplicated (and conflicted with) the
  Friction Log schema already in `docs/data-dictionary.md`. No inbound
  references; deleted outright.
- **`docs/deprecation-register.md`** — register tracked 8 active
  back-compat shims, but the only consumer of those rows was the
  register itself. Removed; the 5 inbound pointers (in `decisions.md`,
  `epic-close.md` workflow, `config-settings-schema.js`,
  `config/epic-close.js`, `process-exit.test.js`) updated to drop the
  cross-reference. Per-shim source-level comments remain authoritative
  for removal versions.

## [5.36.2] — 2026-05-06

Patch: refresh dispatch-manifest header / footer to match the current
`/epic-execute` → `/wave-execute` → `/story-execute` orchestration.

### Changed

- **Manifest "Agent Operating Procedures" block** — replaced the manual
  wave-by-wave drill (which still pointed at `/epic-execute [STORY_ID]`,
  the wrong arg type since the wave runner landed) with a three-step
  block describing the actual contract: a single `/epic-execute <epicId>`
  drives all waves, granular re-runs go through `/wave-execute` or
  `/story-execute`, and `/epic-close` is auto-chained when
  `epic::auto-close` is set. Epic ID is interpolated into the example
  commands so operators can copy-paste.
- **Manifest "How to Execute" footer** — removed. It restated (and
  contradicted) the header procedures, and its `/epic-execute #[Story
  ID]` example carried the same wrong-argument bug.
- **Manifest field/value table** — removed. Mode, Progress, Stories,
  Features, Execution Waves, Dispatched were redundant with the Sprint
  Progress hero block, the Wave Summary table, and the Story Details
  section that follow. Only `Generated <timestamp>` survived; it now
  renders as a single italic line directly under the title.

## [5.36.1] — 2026-05-06

Patch: raise the default CRAP regression tolerance from 0.001 → 0.05.

### Changed

- **`agentSettings.quality.crap.tolerance` default** — bumped from 0.001
  to 0.05 in `lib/config/quality.js` (`MAINTAINABILITY_CRAP_DEFAULTS`),
  `check-crap.js` (`resolveCrapEnvOverrides` fallback), and
  `baseline-refresh-guardrail.js` (`parseBaseBranchConfig` fallback).
  CRAP scores follow the formula `c² · (1 − cov)³ + c`, so a sub-percent
  per-method coverage rounding shift across CI environments — same code,
  different escomplex / coverage build — moves the score by ~0.01 on a
  clean rebuild. The 0.001 tolerance flagged that as a regression
  (5.36.0 CI hit it: `crap=7.01 > baseline=7.00`); 0.05 absorbs the
  rounding without missing real regressions, which cross whole-integer
  thresholds (e.g. 8 → 12). Repos that have explicitly set their own
  `tolerance` in `.agentrc.json` are unaffected. The framework's own
  `.agentrc.json` is updated in lockstep.

## [5.36.0] — 2026-05-06

Adds two new opt-in command keys so close-validation works on Prettier /
dprint repos uniformly with biome ones, plus a new stack skill that
codifies the capture-and-check baseline pattern, plus a small fix to the
decomposer prompt's `maxTickets` fallback so the cap can't silently drift
out of sync with the resolved config.

### Added

- **`agentSettings.commands.formatCheck` / `formatWrite`** — new optional
  command keys (defaults: `npx biome format .` / `npx biome format --write
  .`). The close-validation format gate (`buildDefaultGates` in
  `lib/close-validation.js`) and the story-close `runFormatAutofix` step
  now resolve their command from these instead of hardcoding biome.
  Prettier-only and dprint-only repos no longer have to bypass the format
  gate to get through close-validation. Behaviour for repos that haven't
  set the new keys is unchanged (biome defaults).
- **`.agents/skills/stack/qa/lighthouse-baseline/SKILL.md`** — codifies
  the capture-and-check baseline pattern (`baselines/<name>.json` +
  paired `:capture` / `:check` npm scripts + `--self-test` flag +
  ±tolerance gate + weekly cadence workflow) as a reusable stack skill.
  Cross-references the existing `baselines/maintainability.json` and
  `baselines/crap.json` ratchet conventions and the
  `baseline-refresh:` commit-subject contract so the new pattern slots
  into the framework's existing baseline tooling.

### Changed

- **Format gate label.** The close-validation format gate's surfaced
  label changes from `biome format` → `format` (the underlying command
  is now config-driven). The failure hint reflects the resolved
  `formatWrite` command (e.g. `pnpm exec prettier --write .`) rather
  than always quoting biome. The phase-timer keys are unchanged — only
  `lint` and `test` drive `phaseTimer.mark()`, so `phase-timings`
  comments are byte-stable across the rename.
- **`epic-plan-decompose.js --emit-context`** — logs the resolved
  `limits.maxTickets` to stderr so a misconfigured `.agentrc.json` (e.g.
  flat-key `maxTickets` instead of grouped `agentSettings.limits.maxTickets`)
  is visible to the operator instead of silently falling through to the
  framework default. The decomposer prompt template
  (`lib/templates/decomposer-prompts.js`) now imports its in-template
  fallback from `LIMITS_DEFAULTS` rather than carrying its own `40`
  literal, so the fallback can't drift out of sync.
- **`.agents/workflows/epic-plan.md`** — `maxTickets` doc text updated
  to point at `agentSettings.limits.maxTickets` and the framework-
  default location instead of repeating the literal `40`.

## [5.35.1] — 2026-05-06

Generalizes and streamlines the agent prompt surface (`agent-protocol.md`
template + `instructions.md`) so non-Node, non-Windows, and non-TypeScript
projects no longer receive irrelevant or stack-specific guidance in the
hydrated prompt.

### Changed

- **`.agents/templates/agent-protocol.md`** — replaced hardcoded
  `npm run lint && npm test` example with `{{VALIDATE_CMD}}` /
  `{{TEST_CMD}}` placeholders, and replaced the `main` / `dist` protected
  branch list with `{{PROTECTED_BRANCHES}}`. Section 5.2 wording clarified
  to separate the rule from the interactive-debugging exception.
- **`context-hydration-engine.js`** — populates the new placeholders from
  `agentSettings.commands` (via `getCommands()`) and from
  `agentSettings.git.protectedBranches` (falling back to `baseBranch`).
- **`.agents/instructions.md`** — significant streamline:
  - Title `Antigravity Agent Protocol` → `Agent Execution Protocol`
    (removes host-brand leak).
  - §1.A persona-routing trigger reworded to reflect runtime injection via
    the hydrator (not just the human "Act as …" prompt).
  - §1.F `docs/style-guide.md` duplicate reference removed (kept under §3
    Mandatory Reading).
  - §1.G "Model selection" operator-facing aside removed (not agent
    guidance).
  - §1.H Friction Telemetry trimmed from 8 lines to 4; "Throw, Never Fatal"
    contributor rule extracted to a new rules file.
  - §3 Shell & Terminal Protocol (Windows/PowerShell) removed from the
    universal prompt and extracted to a new rules file.
  - §5 Quality Discipline — TypeScript-specific (`any`, `@ts-ignore`),
    a11y/WCAG, and trailing-newline bullets moved out of the universal
    section; replaced with a pointer to stack skills and rules.
  - §8 Golden Examples empty placeholder removed; subsequent sections
    renumbered.
  - 356 lines → 307 lines (~14% reduction) with no loss of universal
    content.

### Added

- **`.agents/rules/shell-conventions.md`** — host-conditional shell
  guidance (PowerShell vs POSIX). Loaded via the §1.F modular-rules
  channel only when shell behaviour is relevant.
- **`.agents/rules/orchestration-error-handling.md`** — contributor rule
  documenting the "throw, never `Logger.fatal`" convention for
  orchestration scripts. Targets contributors editing
  `.agents/scripts/lib/orchestration/**`, not Story-execution agents.

### Internal

- **`format-autofix.js`** — code comment referencing the now-relocated
  "§H rule in instructions.md" rewritten as a self-contained comment.

### Removed

- **`.agents/rules/coding-style.md`** — generic Prettier + React/TS naming
  bullets that duplicated `instructions.md` §4 Anti-Laziness / No-Dead-Code
  rules. Zero references in skills.
- **`.agents/rules/database-standards.md`** — orphaned SQL conventions
  (zero references). Belongs in a future `stack/data/` skill if the
  content is wanted; was never wired in.
- **`.agents/rules/ui-copywriting.md`** — orphaned generic copywriting
  advice (zero references); redundant with project-level
  `docs/style-guide.md`.
- **`.agents/rules/search-and-execution-heuristics.md`** — folded into
  `shell-conventions.md` under a new "Searching the Workspace" section
  (with PowerShell-specific anti-patterns retained). Original file
  deleted.

### Fixed

- **`.agents/rules/git-conventions.md`** — three correctness/staleness
  issues:
  - Hardcoded `npm run lint` / `npm run format:check` commands replaced
    with a pointer to `agentSettings.commands.validate` + `commands.test`
    so non-Node projects get correct local-validation guidance.
  - Removed the legacy "amend the commit rather than creating 'fix lint'
    commits" rule, which contradicts the framework's standing rule
    ("Always create NEW commits rather than amending"). Replaced with
    explicit guidance to follow up with a new commit.
  - Removed the v4-era "Task-Level Branching (Legacy/Transition)" section
    (`task/epic-[EPIC_ID]/[TASK_ID]`) — v5 has been canonical for
    several releases. Story branch naming updated to canonical
    `story-<storyId>` shape.
  - Added explicit "never bypass hooks" guidance to align with project
    policy on `--no-verify` / `--no-gpg-sign`.

### Net effect

`.agents/rules/` goes from **12 → 8 files**, all referenced or scoped:
high-traffic SSOTs (`security-baseline`, `gherkin-standards`,
`testing-standards`, `api-conventions`), workflow-canonical guidance
(`changelog-style`, `git-conventions`), and host/contributor scopes
(`shell-conventions`, `orchestration-error-handling`).

The instructions.md §1.F example list is updated to reflect the surviving
high-value files.

## [5.35.0] — 2026-05-06

Renames the `/audit-accessibility` workflow to `/audit-lighthouse` and
refocuses its content. The old name was misleading — the workflow drove a
full Lighthouse run across all four categories (Performance, Accessibility,
Best Practices, SEO), and collided semantically with the unrelated
WCAG-focused QA skill at `.agents/skills/stack/qa/audit-accessibility/`.

### Changed

- **`/audit-lighthouse`** (was `/audit-accessibility`). New workflow file at
  [`.agents/workflows/audit-lighthouse.md`](../.agents/workflows/audit-lighthouse.md).
  Comprehensive guidance for running Lighthouse, parsing the full JSON
  envelope (scores, Core Web Vitals, opportunities, diagnostics, failed
  audits per category, cross-cutting patterns), and emitting a structured
  report at `{{auditOutputDir}}/audit-lighthouse-results.md`. Read-only —
  drops the verify-and-revert fix loop the prior workflow shipped with, in
  favour of consistency with the rest of the audit suite.
- **`audit-rules.json`** trigger key renamed `audit-accessibility` →
  `audit-lighthouse`; keyword set extended with `lighthouse`, `core web
  vitals`, `lcp`, `cls`. Existing `accessibility` / `wcag` / `a11y` /
  `aria` / `ui` / `frontend` keywords are preserved so a11y-tagged
  tickets still route to this audit.
- **`audit-performance.md`** cross-reference updated to point at the new
  filename and to describe scope correctly (deep architectural / runtime
  bottlenecks vs. Lighthouse's page-load surface).
- **`docs/workflows.md`** audit-suite table row replaced.
- **`tests/select-audits-cli.test.js`** assertion now expects
  `audit-lighthouse` for accessibility-keyword tickets.

### Removed

- **`.agents/workflows/audit-accessibility.md`** — superseded by
  `audit-lighthouse.md`.

## [5.34.0] — 2026-05-05

Audit remediation (Epic #990). The framework's `.agents/` surface is
hardened against three classes of drift: half-implemented features,
loose schema contracts, and reference rot in the README. Two real
workflow bugs that broke parallel-wave automation on Windows
(`withEpicMergeLock` worktree gitlink, JSON format drift propagation)
are fixed inline. Schemas now reject extra keys and free-text
discriminators that previously passed silently. The dispatch-manifest
contract is leaner — `model_tier` is gone end-to-end. The README is
≤ 150 lines of activation + canonical pointers; detailed reference
content lives at stable URLs that downstream consumers can bookmark.

See ADR `20260505-990a` in [`docs/decisions.md`](decisions.md) for the
full decision record, including rationale for the four rejected audit
findings.

### Decisions

- **Audit findings 8 and 10 (proposing an `epic::auto-spec` autonomous-planning
  branch) were considered and rejected per operator directive** — the
  STOP-then-confirm planning gate is preserved. Regrep `auto-spec` /
  `epic::auto-spec` returns zero hits.

### Removed

- **Legacy cleanup sweep** (Epic #990 Story #1006).
  - **`dispatcher.js --epic <epicId>` flag.** The legacy entrypoint and its
    doc-block in `.agents/scripts/dispatcher.js` (line 13) are gone. Auto-
    detection of Epic vs. Story via the positional `<ticketId>` is now the
    only way in. Any CI script or workflow doc still passing `--epic` must
    be updated.
  - **DEBUG-gated dispatcher exit.** The `runAsCli` `onError` handler in
    `.agents/scripts/dispatcher.js` no longer gates `process.exit(1)` on
    `process.env.DEBUG`; failures always exit non-zero. CI cannot silently
    treat a broken dispatch as success.
  - **`task/<archivedEpic>/<taskN>` branch-shape doc row.** The "Legacy
    fallback" row at `.agents/instructions.md:298` and its constraint
    paragraph are removed; grep over `.agents/scripts` confirmed zero
    code readers. Branch lifecycle is now strictly two shapes:
    `story-<storyId>` and `epic/<epicId>`.
  - **Legacy URL-sentinel arg in `notify.js`.** The
    `firstArg.startsWith('http')` branch in `.agents/scripts/notify.js`
    (~line 249) is deleted; no caller in the repo (scripts, tests, docs,
    workflows) was passing a leading webhook URL as a sentinel.
- **`model_tier` and the `complexity::high` → tier mapping** (Epic #990).
  The orchestrator no longer derives a per-Story model tier or surfaces
  one in dispatch artefacts. Concrete model selection is left entirely to
  the operator or external router. Bumping consumers will see:
  - **File deleted:** `.agents/scripts/lib/orchestration/model-resolver.js`
    (and its `resolveModelTier` export) is gone. Any importer must drop
    the dependency.
  - **Schema field removed:** the `dispatch-manifest` structured comment
    no longer carries `model_tier` on Story entries; the JSON schema in
    `.agents/schemas/dispatch-manifest.json` no longer lists it as a
    valid key.
  - **Validator clause removed:** `validateAndNormalizeTickets` no longer
    requires a `complexity::*` label on Stories. Backlogs that omit
    `complexity::*` will validate cleanly.
  - **Plan-row shape:** `StoryLauncher.planWave` and `wave-prepare` now
    emit `{ storyId, worktree? }` (and `title` from `wave-prepare`)
    without the `modelTier` field. Adapters that key on `modelTier`
    must be updated.
  - **Persona / SDLC / instructions:** prose references to
    `model_tier::*` labelling, `Model Tier` columns, and
    "complexity-derived tier" guidance have been struck.

## [5.33.0] - 2026-05-05

### Task bodies are now agent-executable (structured 4-section schema)

Tasks emitted by `epic-plan-decompose` are consumed both by humans
reviewing alongside the parent Story and by non-interactive sub-agents
running inside a worktree with no operator in the loop and possibly no
parent-Story context (when the sub-issue API link is missing). The
prior "under 2 sentences" guidance optimised for plan-time output
budget at the cost of execution-time quality — typical Epic-#689-style
output omitted test contracts, definition-of-done, and file paths.

- **Structured task `body`.** The decomposer system prompt now requires
  tasks to emit `body` as `{ goal, changes, acceptance, verify }`.
  - `goal` — one sentence, names the parent Story slug.
  - `changes` — `<file path>: <verb> <object>` bullets; vague verbs
    without a named target are rejected.
  - `acceptance` — observable from outside the agent (commands exit 0,
    files exist, snapshots match, `data-testid` resolves).
  - `verify` — name the testing tier (`unit` / `contract` / `e2e` /
    `validate`); `manual:<reason>` allowed when truly unverifiable.
  - UI tasks MUST end `changes` with a `data-testid invariance:` or
    `data-testid changes:` bullet pairing with a `tests/e2e/*.spec.ts`
    edit.
  - Brand / copy / style work MUST cite `docs/style-guide.md` (or
    note its absence) in `acceptance`.
  - The under-2-sentence rule is preserved for Features/Stories
    (navigational) — only Tasks become structured.
- **Server-side rendering.** New `task-body-renderer.js` renders the
  structured body to a four-section markdown body (`## Goal`,
  `## Changes`, `## Acceptance`, `## Verify`) plus the orchestrator
  footer. The LLM no longer spends tokens on boilerplate. The footer
  now carries an `audit-snapshot: <YYYY-MM-DD>` line so future
  consumers (story-init, manifest, close-gate) can warn when a task
  body has gone stale between waves. The existing
  `parent: #<n>` / `Epic: #<m>` / `blocked by #<x>` lines are
  preserved byte-for-byte; the orchestrator footer contract is
  unchanged.
- **Schema validation in `decomposeEpic`.** A task whose structured
  body has empty `changes`, empty `acceptance`, or empty `verify`
  (without `manual:`) — or whose `changes` bullets contain no
  path-shaped token (`/`, `*.ts`, `*.astro`, `*.mdx`, …) — fails the
  decomposer run with a structured error pointing at the offending
  slug. String / undefined bodies pass through unchanged for backward
  compatibility with Features and Stories.
- **One-shot retrofit utility.** New `retrofit-task-bodies.js` walks
  every Task under `--epic <id>`, skips ones already in four-section
  format (idempotent — header detection on `## Goal\n`), and emits a
  per-task enrichment context (current body + parent Story body +
  Tech Spec excerpt + style-guide presence flag). `--bodies <file>
  --dry-run` (default) prints unified diffs and writes a summary to
  `temp/retrofit-task-bodies-<epic>.md`; `--apply` calls
  `provider.updateTicket()` to write the new bodies. Body-only edits
  — labels and state are never touched.
- **Tests.** Renderer byte-stability fixture; validator rejects each
  empty-section variant; orchestrator footer survives renderer
  round-trip; retrofit script skips already-conforming tasks.

### `/agents-update` now reconciles consumer instructions + memories

The framework-bump workflow previously ended at "move the submodule
pointer + sync `.claude/commands/`." That left consumer-side
`AGENTS.md` / `CLAUDE.md` and per-agent memory files quietly drifting
out of sync with new framework contracts (e.g., a memory pinning a
workaround for a bug that the bump just fixed; an `AGENTS.md` line
contradicting a tightened validator).

- New **Step 4 — Review the CHANGELOG and update consumer-side
  memories** added to `.agents/workflows/agents-update.md`. The
  operator reads the framework CHANGELOG between `OLD_SHA` and
  `NEW_SHA`, sweeps consumer instructions / memories / runbooks for
  each entry, and stages every reconciliation alongside the pointer
  move so a single commit captures both "framework moved" and "what
  we changed in response."
- Step 4 explicitly disclaims "do not invent updates" — silence is a
  valid review outcome. The goal is consistency, not churn.

### Sub-issue link failures no longer silent in epic-plan-decompose

Large Epic decompositions (>~80 tickets) that hit GitHub's secondary rate
limit on the `addSubIssue` GraphQL mutation produced tickets with the
`---\nparent: #<n>\nEpic: #<m>` body footer but no native API
sub-issue relationship. Consumers that read the API relationship
(`get_sub_issues`, `parent_issue_url`, project rollups, the orchestrator's
child-state poll, `getReferencedChildren`) saw zero children. Real-world
repro: Story #728 in dsj1984/domio whose tasks #793, #794, #795 were
text-linked only.

- **`addSubIssue` retries on transient errors.** Wraps the GraphQL
  mutation in a six-attempt jittered exp-backoff loop (1 s base, 30 s
  cap) gated by `classifyGithubError`'s `transient` category. Catches
  GraphQL-200 + errors[] secondary-RL responses that the HTTP-layer
  retry cannot see.
- **`createTicket` no longer swallows the link failure.** The catch
  branch sets `subIssueLinked: false` + `subIssueError` on the returned
  metadata instead of `console.warn`-and-continue, so the decomposer
  can count and reconcile.
- **Reconciliation pass at end of `decomposeEpic`.** After all staged
  creation passes complete, the decomposer walks every child of the
  Epic, parses the `parent: #<n>` footer, and verifies the native API
  link is present. Missing links are re-established via `addSubIssue`.
  Prints `linked X/Y sub-issues (N reconciled)`; throws when gaps
  remain. Idempotent — safe to re-run on legacy partially-linked Epics.
- **Error classifier prefers rate-limit message over 401/403.** A 403
  with a "secondary rate limit" body now classifies as `transient`
  instead of `permission`, so the retry path engages even when the
  thrown error has a numeric status attached.
- **Tests.** Two new cases in
  `tests/providers-github-sub-issue-link.test.js`: (1) `addSubIssue`
  succeeds on retry after a first-call rate-limit error; (2)
  `reconcileSubIssueLinks` relinks an orphan whose body footer is
  correct but whose API parent is missing.

## [5.32.4] - 2026-05-05

### Story sub-task discovery via reverse-reference fallback

`getReferencedChildren` (Strategy 3 in `getSubTickets`) was gated to Epic
parents only. When the native sub-issues GraphQL feature was unavailable
*and* a Story's body lacked a Markdown checklist of its Tasks, the close
path saw zero children even though Tasks correctly carried `parent: #N`
in their bodies — the same shape the dispatcher's manifest builder
already resolved successfully, producing an inconsistency between the
manifest's task-grouping and the close-path's child-discovery.

- **Lift the Epic-only gate.** `getReferencedChildren` now reverse-scans
  for any parent type. The cost is one paginated `GET /issues` per
  Story/feature parent on the rare path where Strategies 1+2 yielded
  nothing; the existing try/catch keeps the call non-fatal.
- **Drop the now-unused `parentLabels` parameter** from both the helper
  and the `_getReferencedChildren` facade wrapper.
- **Tests** updated: replaced the "non-Epic parents skip reverse scan"
  case with a Story-parent case that asserts Tasks referencing
  `parent: #733` are discovered.

## [5.32.3] - 2026-05-05

### Decomposer resilience to GitHub's secondary rate limit

Five fixes against a real Epic-decomposition crash (Domio Epic #689,
121 planned tickets). The run aborted at 79/121 with HTTP 403
"secondary rate limit" and required ~10 minutes of manual `gh` recovery
because the script was neither retry-aware nor idempotent on resume.

- **HTTP client retries on secondary RL.** `_fetchWithRetry` in
  `providers/github-http-client.js` now classifies HTTP 403 with body
  matching `/secondary rate limit|abuse detection/i` as transient,
  honours `Retry-After`, and falls back to a 30–120 s jittered backoff
  (capped at 5 attempts). Generic 403s (auth failures, "Resource not
  accessible by integration") are still surfaced to the caller
  untouched. Logging moved from `console.warn` to `Logger.warn`.
  New `onTransientFailure` callback hook fires on every retry so
  callers can react adaptively.
- **`decomposeEpic` is idempotent on re-run.** Before the staged create
  loop, the decomposer fetches existing Epic children and indexes them
  by title. Planned tickets whose title matches an OPEN child of the
  same type are skipped — the existing issue id flows into `slugMap`
  so parent/dep wiring resolves to the surviving issue. CLOSED matches
  log a warning and re-create. Cross-type title collisions throw a
  single batched error before any create runs.
- **New `--resume` CLI flag** on `epic-plan-decompose.js` and
  `ticket-decomposer.js`. Identical to the implicit re-run path but
  errors loudly when the Epic has no existing children, giving
  operators an explicit recovery command alongside `--force`.
  Mutually exclusive with `--force`.
- **Adaptive concurrency.** `decomposeEpic` subscribes to the
  http-client's `onTransientFailure`; the first time a secondary RL is
  observed it drops `concurrencyCap` to 1 for every remaining staged
  pass. Within-pass throttling is still handled by the http-client's
  retry/backoff loop. Static default `concurrencyCap: 3` is preserved
  for fast small-Epic runs; the trade-off is documented in
  `config-schema.js`.
- **Crash-path diagnostics in `epic-plan-decompose.js`.** `main()`
  wraps `runDecomposePhase` in try/catch; on failure it prints the
  Epic's current `agent::*` lifecycle label, the count of currently-open
  children, and the explicit recovery command
  (`epic-plan-decompose.js --epic <id> --resume`) to stderr before
  re-throwing, so exit code stays non-zero and CI fails as expected.
- **Workflow doc.** `.agents/workflows/epic-plan.md` Troubleshooting
  section now covers the secondary RL, the `--resume` flow, and the
  `concurrencyCap: 1` opt-in for known-large Epics.

## [5.32.2] - 2026-05-04

### Wave-runner trust boundary + complexity-tier parity

Two bug fixes surfaced during a real Epic run (Domio Epic #604,
2026-05-04). Both were operator-recoverable but eroded trust in the
v5 fan-out path.

- **`/wave-execute` rejects malformed sub-agent returns.**
  `wave-record.js` now accepts a `--returns` flag (alternative to
  `--results`) that takes raw per-Story sub-agent return texts. Each is
  parsed through the new `parseStoryAgentReturn` helper; entries that
  don't match the `/story-execute` return contract are reconciled from
  GitHub (labels + `story-run-progress` comment) and the wave is
  guaranteed to surface a non-`complete` status. A single rolled-up
  friction comment is posted on the Epic naming each malformed child
  and quoting the original return text. Reproducer regression test pins
  the exact mid-task fragment from Epic #604: `"Clean. Now commit Task
  622."` → reconciler invoked → `status: failed`. Also exposed:
  `reconcileStoryFromGitHub` for direct use.
- **`StoryLauncher.planWave` honors `complexity::high` parity.** The
  `epic-execute-prepare.js` plan was reporting `modelTier: "low"` for
  every Story while `dispatcher.js`'s dispatch table correctly showed
  `high`. Both code paths now share `resolveModelTier(storyLabels)`
  from `model-resolver.js` (canonical `complexity::high` → `"high"`).
  Regression test asserts the parity for the four Epic #604
  high-complexity Stories.

## [5.32.1] - 2026-05-03

### Cross-wave rollup, cascade safety, and wave verification

Four targeted fixes against gaps surfaced during a recent epic run. None
change public APIs.

- **`wave-run-progress` is now keyed per wave.** Each wave's snapshot
  carries a `wave="N"` discriminator on its structured-comment marker, so
  a later wave no longer overwrites the prior wave's comment. Operators
  watching the cumulative `epic-run-progress` rollup table see every wave's
  rows instead of only the most recent one. Reading code (`epic-rollup.js`,
  `parseWaveRunProgressComment`) is unchanged — the fix lives in the
  upsert path.
- **Cascade-close re-fetches sibling state.** Before flipping a Feature to
  `agent::done`, the cascade now invalidates each sibling's ticket cache
  and reads it back fresh. A stale cache entry showing a sibling as
  closed-when-actually-open can no longer let the cascade close the parent
  prematurely. Cost is bounded — one HTTP read per sibling, only on the
  cascade hot path.
- **`/wave-execute` verifies each Story actually closed.** Before
  classifying the wave as `complete`, `wave-record.js` re-reads each Story
  ticket whose sub-agent claimed `done` and downgrades the row to
  `failed` if the live label isn't `agent::done` (or the issue isn't
  closed). Discrepancies are surfaced in the envelope's new
  `discrepancies` field so the wave-level rollup reflects the regression
  rather than silently marking the wave complete.
- **`/epic-close` Phase 4 documents the type-check timing.** Phase 4.1
  now lists "type-checks" (`tsc --noEmit`, `astro check`, framework
  equivalents) as the first ratchet category, with an explicit note that
  the evidence-gated Phase 4 covers `npm run lint` + `npm test` only.
  This is the gate most often missed: too slow for `npm test`, too late
  at push time after the merge has already landed locally.

`structuredCommentMarker`, `findStructuredComment`, and
`upsertStructuredComment` now accept an optional `attrs` object. Existing
call sites (passing only `type`) are unaffected.

## [5.32.0] - 2026-05-02

### Notification webhook aligned with execution-workflow status reporting

The `NOTIFICATION_WEBHOOK_URL` channel now mirrors the same structured-comment
cadence that GitHub watchers see in the issue thread. Operators monitoring
Slack / Discord / Make.com get the same wave + epic rollup signals that
appeared in `wave-run-progress` and `epic-run-progress` comments — previously
those were GitHub-only and the webhook only fired on label flips.

**Breaking config change.** `orchestration.notifications.minLevel` and
`commentMinLevel` are removed and replaced with three **mandatory** per-
channel gates, each defaulting to `medium`:

- `commentMinLevel` — gates GitHub comment posting.
- `webhookMinLevel` — gates `NOTIFICATION_WEBHOOK_URL` deliveries.
- `terminalMinLevel` — gates `notify()`'s stdout chatter.

Each channel filters independently; there is no fallback chain. Operators
with a custom `notifications` block in `.agentrc.json` must rename
`minLevel` → `webhookMinLevel` (and `terminalMinLevel`), keep
`commentMinLevel` if already set, and add the missing keys at `medium`.

#### Webhook mirrors structured-comment upserts (Option A)

The three progress writers now fire the webhook after a successful upsert,
with `skipComment: true` so the GitHub comment isn't double-posted:

- [`upsertStoryRunProgress`](../.agents/scripts/lib/orchestration/epic-runner/story-run-progress-writer.js) — `low` (frequency-driven; fires on every Task transition).
- [`upsertWaveRunProgress`](../.agents/scripts/lib/orchestration/epic-runner/wave-run-progress-writer.js) — `medium` (per-wave snapshot).
- [`ProgressReporter`](../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js) — `medium` (interval ticks + final snapshot at end of run).

Severity assignment lines up with the execution hierarchy: Task transitions
and `story-run-progress` are `low`; Story state transitions, wave + epic
progress, story merged, and epic-complete are `medium`; epic blockers and
HITL gates are `high`.

#### Typed webhook envelope (back-compat preserved)

Webhook subscribers now receive
`{ text, severity, ticketId, event?, level?, epicId?, phase? }` instead of
the flat `{ text }`. `text` stays populated and prefixed exactly as before
(`[medium] repo#123: …`, `[Action Required] repo#456: …`) so `{text}`-only
consumers (Slack incoming webhooks, Discord, Make.com) keep working
unchanged. Routable subscribers can filter by `event` —
`state-transition` / `story-run-progress` / `wave-run-progress` /
`epic-run-progress` / `epic-blocked` / `epic-complete` / `story-merged` —
or by `level` (`task` / `story` / `wave` / `epic`).

#### NotificationHook consolidated into `notify()`

The standalone [`NotificationHook`](../.agents/scripts/lib/orchestration/epic-runner/) (its only consumer was the
epic blocker handler) is removed. [`BlockerHandler`](../.agents/scripts/lib/orchestration/epic-runner/blocker-handler.js) now calls `notify()`
directly with `severity: 'high'`, `event: 'epic-blocked'`, `level: 'epic'`
— so blocker events flow through the same severity gates as everything
else and the typed envelope reaches webhook subscribers.

#### Terminal channel filter

`notify()`'s own `console.log` chatter (`[Notify] Sending MEDIUM to Issue
#…`, `[Notify] Firing webhook…`) is now gated by `terminalMinLevel`. At the
default `medium` it behaves identically to before; setting
`terminalMinLevel: high` silences the dispatcher's chatter for routine
events while keeping comment + webhook on their own thresholds.

#### Migration

```diff
 "notifications": {
   "mentionOperator": false,
-  "minLevel": "medium"
+  "commentMinLevel": "medium",
+  "webhookMinLevel": "medium",
+  "terminalMinLevel": "medium"
 }
```

Schema validation (`validateOrchestrationConfig`) now rejects a
`notifications` block missing any of the three keys. The merged
[`default-agentrc.json`](../.agents/default-agentrc.json) provides them at
`medium` for operators that don't override the block at all.

#### MI/CRAP baseline-refresh delta

Baselines refreshed atomically with the change (touched: `notify.js`,
`config-schema.js`, `ticketing.js`, `blocker-handler.js`, `factory.js`,
`progress-reporter.js`, the two run-progress writers, three CLI scripts
that call them, and the matching tests; deleted: `notification-hook.js` +
its test). Net change vs 5.31.2: 13 files ratcheted (most -0.1 to -1.7 MI),
all in modified files; 0 regressions outside the modified set;
CRAP 0 regressions.

## [5.31.2] - 2026-05-02

### Hierarchical chat rollups + three sprint-protocol bug fixes

A two-part patch release: the execution-hierarchy chat rollup work that started this branch, plus three corrective fixes that surfaced from the post-rollup sprint review (story-init payload completeness, story-close already-merged recovery, Windows worktree reap stickiness).

#### Hierarchical chat rollups for `/epic-execute`, `/wave-execute`, `/story-execute`

Each level of the execution hierarchy now surfaces a rendered markdown progress table directly to the operator's chat, layered top-down so a long-running Epic produces three nested views: Epic-wide cross-wave rollup, per-wave Story rollup, and per-Story task rollup. Previously the rendered tables only existed as `epic-run-progress` / `wave-run-progress` / `story-run-progress` structured comments on GitHub — operators had to flip to the issue tab to see them in flight.

- **Writers expose the rendered body.** [`upsertStoryRunProgress`](../.agents/scripts/lib/orchestration/epic-runner/story-run-progress-writer.js) and [`upsertWaveRunProgress`](../.agents/scripts/lib/orchestration/epic-runner/wave-run-progress-writer.js) now return `{ body, payload }` (matching the long-standing `upsertEpicRunProgress` shape), so callers can both pass the payload up the orchestration tree and surface the body to chat without re-rendering.
- **CLI envelopes carry `renderedBody`.** [`story-execute-prepare.js`](../.agents/scripts/story-execute-prepare.js), [`story-task-progress.js`](../.agents/scripts/story-task-progress.js), [`wave-record.js`](../.agents/scripts/wave-record.js), and [`epic-rollup.js`](../.agents/scripts/epic-rollup.js) all add a `renderedBody` field to their stdout JSON envelope. The skill markdowns instruct the host LLM to relay it verbatim as a chat message after each transition (`/story-execute`), after fan-out (`/wave-execute`), and after each wave's rollup (`/epic-execute`).
- **Skill markdowns prescribe a hierarchical Notable section.** [`/wave-execute`](../.agents/workflows/wave-execute.md) and [`/epic-execute`](../.agents/workflows/epic-execute.md) ask the host LLM to author a short, synthesized **Notable** section after the rollup body — newly blocked / failed children, outsized wall-clock consumers, friction comments posted in-segment, anomalies in child returns. The framework supplies the table mechanically; the LLM authors the notable narrative on top of it (per Epic #380's UX spec). Sub-agents suppress per-Task chat relay when running underneath a wave so the wave-level rollup remains the canonical chat surface.
- **Sub-agent return contracts grow `renderedBody`.** `/story-execute` returns its terminal `renderedBody` to its parent `/wave-execute`; the wave-execute envelope likewise carries `renderedBody` upward. `/epic-execute`'s rollup uses these for its cross-wave Notable synthesis.

#### Bug fix — `story-init` payload now embeds `tasks[]`

[`renderStoryInitCommentBody`](../.agents/scripts/story-init.js) was building the fenced JSON payload from a hand-picked subset of `result` and silently dropping the canonical task list. The downstream consumer [`story-execute-prepare.js`](../.agents/scripts/story-execute-prepare.js) read `initPayload.tasks`, found it missing, fell back to `[]`, and seeded an empty `story-run-progress` snapshot — silently breaking every later [`story-task-progress.js`](../.agents/scripts/story-task-progress.js) call (the task id wasn't present in the snapshot). Two-layer fix:

1. The renderer now embeds `tasks: result.tasks.map({ id, title })` as a single source of truth.
2. The prepare CLI gained a `fetchTasksFallback` defensive path: when `initPayload.tasks` is missing or empty (legacy comment from a pre-fix run), it pulls the Story's child Tasks via `provider.getSubTickets` so resumed runs against historical comments still seed correctly.

#### Bug fix — `story-close` recognizes the `already-merged` recovery state

[`story-close-recovery.js`](../.agents/scripts/lib/orchestration/story-close-recovery.js) treated the post-merge partial-reap case (merge + push succeeded, but ticket transitions / cascade / dashboard regen stalled — typical Windows worktree-reap recovery) as `fresh`, sending the script back through rebase + merge a second time. The repeat merge invariably failed (the story branch had been deleted by the prior push) and operators had to drive `update-ticket-state.js` by hand. New `ALREADY_MERGED` prior-state branch:

- Detected when either the local `story-<id>` branch's HEAD is reachable from `origin/epic/<id>` **or** the remote `origin/story-<id>` ref is reachable from the same — covering the local-survives-remote-deleted and remote-survives-local-deleted cases.
- Auto-resumes via the new `RESUME_FROM_POST_MERGE` action (no `--resume` flag required — re-running close on a successfully merged Story is the canonical recovery path).
- [`runStoryClose`](../.agents/scripts/story-close.js) skips both the pre-merge gates and the merge runner on this path, delegating straight to `runPostMergeClose` for ticket transitions, cascade, health, and dashboard regen.

#### Bug fix — Windows worktree reap force-drain hardening

The Stage 1 `fs-rm-retry` budget (5 × 200ms) was too short for c8 to release the file handles it holds across the close-validation chain on Windows, leaving `node_modules/.cache` and `coverage/` paths un-removable. Even when the deferred-to-sweep manifest correctly recorded the residue, [`removeWorktreeWithRecovery`](../.agents/scripts/lib/worktree/lifecycle/reap.js) returned `branchDeleted: false` because the local-and-remote branch cleanup was gated on Stage 1 success — operators had to follow up with manual `git branch -D` and `push --delete` (memory: feedback_sprint_story_close_reap). Two changes:

1. **New Stage 1.5 coverage-leak quiesce.** On `win32`, after Stage 1 retries exhaust, the reap sleeps `forceRemoveBackoffMs` (default 3s) to let coverage / AV / Search-indexer holds release, then attempts one extended `fs.rm` call with `maxRetries: 10, retryDelay: 500` (Node's own retry budget), lifting the wall-clock budget to ~10s on the failure path without touching happy-path latency.
2. **Branch cleanup runs unconditionally.** The local `git branch -D` and (when `push: true`) `git push --delete` calls were lifted into a shared `deleteBranchAfterReap` helper and now run on both the Stage 1 success path and the Stage 2 deferred-to-sweep path. The deferred return surfaces `branchDeleted` / `remoteBranchDeleted` even when the on-disk worktree is stuck.

#### MI/CRAP baseline-refresh delta

Baselines refreshed atomically with all four changes. Net change vs 5.31.1: 18 files ratcheted (-0.08 to -2.69 MI), all in modified files; 0 regressions outside the modified set; CRAP 0 regressions.

## [5.31.1] - 2026-05-02

### Clean-code & maintainability refactor — orchestrator split, duplication harvest, dead-export retirement, baseline lift (Epic #946)

A maintainability-only release. No public-facing rename, no breaking change, no consumer-visible config delta — every change is internal restructuring of the orchestration tree, plus a single defensive bug fix in the merge orchestrator. The clean-code audit under `/audit-clean-code` flagged a tight cluster of structural drag points; this release sweeps them.

- **Story-close split (Theme A).** [`.agents/scripts/story-close.js`](../.agents/scripts/story-close.js) was a 938-line CLI orchestrator doing four jobs with two near-duplicate merge-finalization paths. Three modules were extracted under [`.agents/scripts/lib/orchestration/story-close/`](../.agents/scripts/lib/orchestration/story-close/) — `merge-runner`, `cleanup-reconciler`, and `comment-bodies` (#955) — and the CLI was trimmed to a 189-line shell wiring those modules (#956, #972). The duplicated lock try/finally + `PushRetryConflictError` shim now live in one place.
- **Duplication-harvest helpers (Theme B).** Six verbatim copies of the `provider.primeTicketCache` capability check were collapsed by promoting `primeTicketCache` to a default no-op on `ITicketingProvider` (#957). Three open-coded fenced-JSON regex parsers were consolidated into a shared `parseFencedJsonComment` helper under `lib/orchestration/structured-comment-parser.js` (#954). The `ProgressReporter` dual constructor (`opts.X` vs `opts.ctx.X`) was flattened onto a single options bag (#958, #976). Inconsistent error termination inside `runStoryClose` — `Logger.fatal` (which `process.exit(1)`s) mixed with thrown errors — was converted to throws across the close surface (#959, #973), eliminating the silent fall-through under mocked `process.exit` documented in the function header.
- **Worktree-manager API trim (Theme C).** [`tests/lib/worktree-manager.test.js`](../tests/lib/worktree-manager.test.js) was migrated off the five `_`-prefixed delegate methods on `WorktreeManager` and the delegates were deleted (#960, #977). Production callers used none of them — they existed solely to keep the legacy 1504-line test file probing internals.
- **Dead-export retirement (Theme D).** 41 `export` qualifiers attached to symbols that no other file (production, tests, workflows, docs, CI) imports were triaged and removed across `.agents/scripts/` (#961). The audit had flagged 45 candidates; the four retained were genuine consumer entry points the audit's heuristic had missed.
- **CLI runner extractions (Theme E).** Two `main()` CLIs gained extracted runners — `runEvidenceGate` and `runEpicCodeReview` — split out of [`.agents/scripts/evidence-gate.js`](../.agents/scripts/evidence-gate.js) and [`.agents/scripts/epic-code-review.js`](../.agents/scripts/epic-code-review.js) so the orchestration logic is callable in-process by tests without spawning a subprocess (#962, #979). The 0.0-MI `run-audit-suite.js` was decomposed into [`lib/audit-suite/`](../.agents/scripts/lib/audit-suite/) helpers (#963). New support CLIs were added under the same pattern for the four-skill split: `wave-prepare.js` + `wave-record.js` (#966), `epic-execute prepare/record-wave/rollup/finalize` (#965), and `story-execute-prepare.js` + `story-task-progress.js` + `task-commit.js` (#967, #987). Manifest-handling gaps — missing rollup exports + a `dispatch-manifest` field-name inconsistency — were closed in (#964).
- **Workflow rationalization (Theme G).** The four execution-skill markdowns (`epic-execute.md`, `wave-execute.md`, `story-execute.md`, `helpers/task-execute.md`) were rewritten onto the new CLI surface, replacing inline shell-step prose with single-line CLI invocations (#968, #988). A `tests/docs/no-js-fences.test.js` regression test pins the markdowns against re-introducing `js`-tagged fences for things that should be `bash`/`text`.
- **Bug fix: merge-orchestrator short-circuit.** [`.agents/scripts/lib/git-merge-orchestrator.js`](../.agents/scripts/lib/git-merge-orchestrator.js)`mergeFeatureBranch` now treats a non-zero `git merge` exit with zero unmerged files (no UU markers, no leftover conflict markers) as `{ merged: true, alreadyMerged: true }` instead of falling through to `commitAutoResolution`. The previous code attempted `git commit` against an empty index, failed with "nothing to commit", and turned a successful merge into a fatal — stranding ticket transitions, cascade, and worktree reap. Reproduced live during the `/story-execute 969` close.
- **MI/CRAP baseline-refresh delta.** Baselines were refreshed atomically with the refactor bundle (#969). Net change vs 5.31.0:
  - **Maintainability:** 445 → 446 files tracked (+1 from the new merge-orchestrator test); the merge-orchestrator file itself ratcheted from 97.676 → 96.52 (-1.156, justified by the new defensive branch). All other files held or improved.
  - **CRAP:** 835 methods scanned; 0 regressions, 0 new-method violations; 12 anonymous rows for methods that lived in `story-close.js` before the (#972) split were dropped — those methods now live in `lib/orchestration/story-close/*` and were re-baselined under their new locations.

## [5.31.0] - 2026-05-01

### Epic-centric workflow rework — drop sprint nomenclature, split execution by hierarchy level, retire GitHub triggers

The single `/sprint-execute` mega-skill, the GitHub-triggered remote orchestrator,
the claim-based pool mode, and the `sprint-*` nomenclature are all retired in
favour of a four-skill split that mirrors the ticket hierarchy. Stories now run
as Agent-tool sub-agents inside the operator's Claude session — no subprocess
spawn, no GitHub Actions runner — so the operator can stop or resume at any
level (Epic / Wave / Story / Task) and the dispatch surface stops carrying dead
process-boundary machinery.

This is a **breaking change** for any downstream `.agents/` consumer that types
`/sprint-*` commands directly, applies the trigger labels by hand, or reads
`agentSettings.sprintClose.runRetro` from config. The migration block below is
the complete consumer-visible delta.

#### Migration

- **Slash commands renamed.** `/sprint-plan` → `/epic-plan`. `/sprint-close` →
  `/epic-close`. The two terminal skills keep their phase structure; only the
  front door changes.
- **`/sprint-execute` removed; four-skill split is the replacement.**
  - `/epic-execute <epicId>` owns the wave loop and fans out via
    `/wave-execute`.
  - `/wave-execute <epicId> <waveN>` runs one wave; launches up to
    `concurrencyCap` Story sub-agents through the Agent tool.
  - `/story-execute <storyId>` runs init → task loop → close for one Story.
  - `helpers/task-execute.md` is read inline per Task by `/story-execute`
    (not a slash command).
- **Trigger-only labels removed:** `agent::dispatching`, `agent::planning`,
  `agent::decomposing`. Delete them from any project board or workflow that
  references them. The lifecycle labels `agent::review-spec`, `agent::ready`,
  `agent::executing`, `agent::review`, `agent::blocked`, `agent::done` are
  unchanged.
- **Remote-trigger surface removed:** `.github/workflows/epic-orchestrator.yml`
  and `.agents/scripts/remote-bootstrap.js` are deleted. Repos that only used
  the GitHub-Action path must drive Epics from a local Claude Code session
  going forward.
- **Pool mode retired.** `.agents/scripts/pool-claim.js`,
  `.agents/scripts/lib/pool-mode.js`, the `in-progress-by:<sessionId>` claim
  label scheme, and the `orchestration.runners.poolMode` config block are
  gone. Story assignment is parent-driven and deterministic; sibling sessions
  never race on the same Story. `runtime.sessionId` survives as a stable
  per-process diagnostic in the startup `[ENV]` log line.
- **Subprocess fan-out machinery removed.**
  `.agents/scripts/lib/orchestration/epic-runner/build-claude-spawn.js` and
  `spawn-smoke-test.js` are deleted, along with the
  `agentSettings.runners.epicRunner.idleTimeoutSec`, `pollIntervalSec`, and
  `logsDir` config keys. Keep `concurrencyCap` and `progressReportIntervalSec`.
- **Top-level scripts renamed in lockstep** with the slash commands. Update
  any `package.json` script or `.husky/*` hook that references the old
  filenames:
  - `sprint-plan-spec.js` → `epic-plan-spec.js`
  - `sprint-plan-decompose.js` → `epic-plan-decompose.js`
  - `sprint-plan-healthcheck.js` → `epic-plan-healthcheck.js`
  - `sprint-plan.js` → `epic-plan.js`
  - `sprint-story-init.js` → `story-init.js`
  - `sprint-story-close.js` → `story-close.js`
  - `sprint-wave-gate.js` → `wave-gate.js`
  - `sprint-hierarchy-gate.js` → `hierarchy-gate.js`
  - `sprint-code-review.js` → `epic-code-review.js`
  - `sprint-close.js` → `epic-close.js`
- **Helper `.md` files renamed in lockstep.**
  `helpers/sprint-plan-spec.md` → `epic-plan-spec.md`,
  `helpers/sprint-plan-decompose.md` → `epic-plan-decompose.md`,
  `helpers/sprint-code-review.md` → `epic-code-review.md`,
  `helpers/sprint-retro.md` → `epic-retro.md`,
  `helpers/sprint-testing.md` → `epic-testing.md`.
- **Config key renamed:** `agentSettings.sprintClose.runRetro` →
  `agentSettings.epicClose.runRetro`. The resolver reads the legacy key as a
  fallback and emits a one-shot deprecation warning; **removal version 5.32.0**.
  Update consumer `.agentrc.json` files now to avoid the warning.
- **`/epic-plan` CLI flags removed:** `--phase spec|decompose` and
  `--auto-dispatch`. The unified two-phase flow with the operator confirmation
  gate is the only mode. The `epic-plan-state` checkpoint comment is unchanged.
- **What did not change.** Structured-comment markers (`epic-run-state`,
  `epic-plan-state`, `dispatch-manifest`, `story-init`, `code-review`,
  `retro-complete`) are kept. `.agents/scripts/lib/orchestration/*` internal
  module paths are unchanged. The Slack/Discord notifier on `agent::blocked`
  still fires from `notification-hook.js`. Worktree filesystem isolation
  rules in `worktree-lifecycle.md` are unchanged in substance — only the
  process boundary around each Story is gone.

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
  `helpers/epic-retro.md` instructs callers to count distinct tickets
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

---

## Earlier releases (v5.0.0 – v5.29.0)

Entries for releases prior to **5.30.0** (April 9 – April 26, 2026) have been
archived to keep the active changelog scoped to the current month. See
[`archive/CHANGELOG-5.0-5.29.md`](archive/CHANGELOG-5.0-5.29.md) for the full
list.

For releases prior to v5.0.0, see [`archive/CHANGELOG-v4.md`](archive/CHANGELOG-v4.md).
