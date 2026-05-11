# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [5.41.0] — 2026-05-11

The 5.41 release lands the Epic #1235 **hands-off PR pipeline**: CI is
promoted to the real merge gate, admin bypass-always is removed, a bot
identity (not the author) supplies the approving review on green CI, a
single triage comment summarizes each red run, and lint/format-only
failures self-heal once per PR. The consumer-facing
`/agents-bootstrap-github` propagates the same primitives into other
projects with an HITL diff/confirm gate so behavior shifts on existing
consumers are explicit, not silent. The comment-channel and
webhook-channel event-allowlist work that landed during the Epic also
rolls up here.

### Added — Epic #1235 (hands-off PR pipeline)

- **Ruleset enforcement on `main`.** Both CI legs
  (`Validate and Test (ubuntu-latest, node 22)` and
  `Validate and Test (windows-latest, node 22)`) are required status
  checks under ruleset `14286998`; `bypass_actors: []` removes the
  admin one-click escape. The checked-in `.github/ruleset.json`
  artifact captures the desired state. Operator setup is documented
  in `docs/runbooks/pr-pipeline.md`.
- **Squash-only + auto-merge.** Repo settings flip to
  `allow_squash_merge=true`, `allow_rebase_merge=false`,
  `allow_merge_commit=false`, `allow_auto_merge=true`,
  `delete_branch_on_merge=true`. The `git-merge-pr` skill default
  changes to `gh pr merge --auto --squash --delete-branch` so opening
  a PR with `--auto` lands it the moment CI is green.
- **PR-failure triage workflow.** `.github/workflows/triage-pr-failure.yml`
  reacts to `workflow_run: completed` with `conclusion=='failure'`,
  downloads the existing `test-results-*` and `crap-report-*` artifacts,
  and posts a single marker-keyed comment
  (`<!-- ci-triage-comment v1 -->`) summarizing the last ~30 stderr
  lines and top 5 CRAP regressions. Re-runs edit the existing comment
  rather than re-post. Pure parsers live under
  `.agents/scripts/lib/triage/`.
- **Bot approver workflow.** `.github/workflows/bot-approve.yml`
  reacts to `workflow_run: completed` with `conclusion=='success'`,
  mints an installation token via `actions/create-github-app-token@v1`,
  and POSTs an approving review as the `agent-protocols-reviewer`
  GitHub App identity. The self-approval guard no-ops on commits
  whose author matches the bot or whose subject starts with
  `[auto-fix]`. GitHub App provisioning is documented in
  `docs/runbooks/pr-pipeline.md`.
- **Auto-fix loop.** `.github/workflows/auto-fix.yml` reacts to the
  same CI-failure trigger as the triage workflow. Failure-class
  detection (pure function under `.agents/scripts/lib/auto-fix/`)
  splits lint/format → run `biome check --apply` and
  `biome format --write` (tests/** excluded), commit as the bot
  identity with a `[auto-fix]` subject, push, set the
  `auto-fix-attempted` label. Coverage, CRAP, maintainability, and
  test failures bail with a marker-keyed comment
  (`<!-- auto-fix-bail v1 -->`). Hard caps: 1 attempt per PR, no
  action on fork PRs, no edits to test files.
- **Consumer parity via `/agents-bootstrap-github`.** The bootstrap
  entrypoint now applies the merge-method settings, extends the
  branch-protection writer with `enforce_admins=true` and
  `required_approving_review_count=0`, and copies the Story 2 +
  Story 4 workflow files from `.agents/templates/` into the
  consumer's `.github/workflows/` and `.agents/scripts/` trees.
  Every behavior-shifting change diffs against current consumer
  state and pauses for operator confirmation via
  `lib/bootstrap/hitl-confirm.js`. In non-TTY contexts the gate
  defaults to **abort** with an explicit stderr message — silent
  applies on existing consumers are impossible.
- New defaults in `.agents/default-agentrc.json`:
  `agentSettings.quality.mergeMethods`,
  `agentSettings.quality.prGate.enforceAdmins` (true),
  `agentSettings.quality.prGate.requiredApprovingReviewCount` (0),
  `agentSettings.quality.botApprover.enabled` (false; surfaces the
  runbook link when off).

### Changed

- **Comment channel is now event-allowlist-gated, not severity-gated;
  terminal channel removed.** `orchestration.notifications.commentMinLevel`
  is replaced by `commentEvents` (analogous to `webhookEvents`).
  `terminalMinLevel` is removed entirely — the terminal channel was
  effectively dead in the host-LLM `/epic-deliver` flow because nothing
  captures or surfaces the Logger.info chatter it controlled. Default
  `commentEvents` is `["state-transition", "story-merged",
  "operator-message"]`. To preserve the previous "only story / epic →
  `agent::done` lands on the ticket" behavior, `transitionTicketState`
  now suppresses the `notify()` dispatch entirely for low-severity
  transitions (task-level, non-terminal story / epic flips); the noise
  filter moved from the channel boundary to the emit point. Severity is
  carried as envelope metadata and still drives `@mention` behavior on
  the comment channel (high always mentions; medium mentions when
  `mentionOperator: true`), but no longer routes either channel. CLI
  invocations of `notify.js` now carry an `operator-message` event by
  default so they route through the same allowlist.
- **Webhook channel is now event-allowlist-gated, not severity-gated.**
  `orchestration.notifications.webhookMinLevel` is removed. Its
  replacement, `orchestration.notifications.webhookEvents`, is an explicit
  allowlist of event names. The default vocabulary is the curated
  `epic-*` set: `["epic-started", "epic-progress", "epic-blocked",
  "epic-unblocked", "epic-complete"]`. Severity is carried as webhook
  envelope metadata, but it is no longer a routing factor for the
  webhook. The Slack feed consequently focuses on the epic narrative —
  % progress + blockers — instead of every per-story state transition.
  Set `webhookEvents: []` to suppress the webhook entirely.
- **`epic-progress` is the curated rollup event.** Previously the
  ProgressReporter periodic timer mirrored `epic-run-progress` to the
  webhook every `progressReportIntervalSec`. The webhook fire is now
  strictly event-driven: it emits only at wave boundaries (wave N →
  N+1) and immediately after `epic-blocked` and `epic-unblocked`
  transitions, carrying the payload
  `{ pct, done, total, currentWave, totalWaves, openBlockers }`. The
  `epic-run-progress` structured-comment kind on the Epic ticket is
  unchanged — it remains the operator-facing per-poll snapshot in
  GitHub.

### Added

- **`epic-started` webhook event.** Fired at `/epic-deliver` kickoff
  with `{ totalWaves, totalStories, title }`. Anchors the rest of the
  epic narrative in the Slack channel.
- **`epic-unblocked` webhook event.** Fired after the operator flips
  the Epic label back to `agent::executing`, paired with `epic-blocked`
  so downstream consumers can track open-blocker lifecycle.

### Migration

Operators with a custom `notifications` block in `.agentrc.json` must
drop `commentMinLevel`, `terminalMinLevel`, and `webhookMinLevel`, and
add `commentEvents` + `webhookEvents`. The new schema requires exactly
this:

```diff
 "notifications": {
   "mentionOperator": false,
-  "commentMinLevel": "medium",
-  "terminalMinLevel": "medium",
-  "webhookMinLevel": "medium"
+  "commentEvents": [
+    "state-transition",
+    "story-merged",
+    "operator-message"
+  ],
+  "webhookEvents": [
+    "epic-started",
+    "epic-progress",
+    "epic-blocked",
+    "epic-unblocked",
+    "epic-complete"
+  ]
 }
```

Configs that retain any of the `*MinLevel` keys will fail AJV validation
against the new schema. There is no alias. `commentEvents` accepts the
closed enum `["state-transition", "story-merged", "operator-message"]`;
`webhookEvents` accepts the closed enum `["epic-started",
"epic-progress", "epic-blocked", "epic-unblocked", "epic-complete"]`.

## [5.40.0] — 2026-05-10

The 5.40 release collapses the v5.39 SDL critical path from three slash
commands (`/epic-plan` + `/epic-execute` + `/epic-close`) to two
(`/epic-plan` + `/epic-deliver`); folds the retro into the new deliver
tail; expands `/epic-plan` with a raw-idea entry mode; fixes the
resolver-key naming bug that silently dropped `.agentrc.json` overrides;
lands three honest config renames; bumps the `maxTickets` default 40 →
60; promotes `prGate` to default config with a new
`enforceBranchProtection` boolean; and wires branch protection on `main`
into `/agents-bootstrap-github`. The 25 advanced/operator workflows are
explicitly preserved — only the SDL critical path, the config layer, and
the docs that describe them are touched.

This is a hard cut. There are no aliases. v5.39.x configs that ship
deleted/renamed keys will fail AJV validation against the 5.40 schema
with actionable errors. Follow the migration block at the bottom.

### Removed

- **`/epic-execute` and `/epic-close` slash commands.** Replaced by
  `/epic-deliver`, which fans out the wave loop, runs close-validation,
  fires the retro, and opens a pull request to `main` in one continuous
  flow. The operator merges the PR through the GitHub UI; the workflow
  never executes `git merge` against `main` itself.
- **`epic-runner.js` (top-level CLI).** Renamed to
  `epic-deliver-runner.js` (see Renamed). The library at
  `lib/orchestration/epic-runner.js` and the `lib/orchestration/epic-runner/`
  submodule directory are preserved — only the operator-facing entry
  point moved.
- **`epic-execute-prepare.js`.** Renamed to `epic-deliver-prepare.js`.
- **`epic-finalize.js`.** Renamed to `epic-deliver-finalize.js` with a
  new responsibility: open a PR to `main` instead of merging.
- **`epic-close.js`.** Deleted entirely. Close-tail logic folded into
  the deliver runner alongside two new in-process modules
  (`lib/orchestration/code-review.js` extracted from
  `helpers/epic-code-review.md`, and `lib/orchestration/retro-runner.js`
  extracted from the now-deleted retro helper).
- **`workflows/helpers/epic-retro.md`.** Retro logic moved in-process
  to `lib/orchestration/retro-runner.js`; the helper was the only
  consumer.
- **`BookendChainer` and `epic::auto-close`.** The autonomous-merge
  authorization flow no longer makes sense in a world where the human
  PR merge is the sole promotion gate. The chainer module, the
  `epic::auto-close` snapshot label, the `bookend-chainer` filename,
  and every `epic::auto-close` mention in the bootstrap label
  taxonomy are deleted.
- **`agent::review` epic-level label.** The PR opened by
  `/epic-deliver` Phase 6 is the equivalent "ready to merge" signal at
  the Epic level; an on-Issue marker is redundant. Removed from
  `label-constants.js`, `label-taxonomy.js`, and the
  `dispatch-manifest.json` `finalState` enum.
- **`risk::medium` label.** The entire `RISK_LABELS` constant is
  removed. `risk::high` survives as planning-metadata only (it has not
  gated runtime behaviour since v5.14).
- **`execution::sequential` and `execution::concurrent` labels.** The
  `EXECUTION_LABELS` constant and `LABEL_COLORS.EXECUTION` palette are
  deleted. Wave-level execution mode is an internal scheduling
  property, not a label.
- **`agentSettings.epicClose` config block.** Including
  `agentSettings.epicClose.runRetro` — the retro is always-on inside
  `/epic-deliver` Phase 5 (override with the `--skip-retro` CLI flag
  on a one-off basis).
- **`agentSettings.riskGates` config block.** The heuristics array
  moved to `agentSettings.planning.riskHeuristics` (see Renamed).
  The `riskGates` name implied runtime gating that has not existed
  since v5.14.
- **`orchestration.hitl` empty placeholder block.** Carried no
  consumers.
- **`orchestration.executor` (audit & delete).** Audited as unread by
  the runtime in 5.40; removed from the schema. The
  `IExecutionAdapter` interface and `ManualDispatchAdapter` ship
  unchanged for downstream consumers, but the `executor` config key
  is no longer recognised.
- **`/wave-execute` artefacts** (residual references). Already
  removed in v5.39.0; the deletion-completeness test now enforces
  there is no resurrection path.
- **The "settings" wrapper key on `resolveConfig()`'s return value.**
  See "Resolver-key alignment" below.

### Renamed

| Before                                                         | After                                                              | Notes                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `/epic-execute` + `/epic-close` slash commands                 | `/epic-deliver`                                                    | Single SDL execution command. PR-open exit; operator merges via GitHub UI.                         |
| `.agents/scripts/epic-runner.js`                               | `.agents/scripts/epic-deliver-runner.js`                           | Top-level CLI only; the library at `lib/orchestration/epic-runner.js` is unchanged.                |
| `.agents/scripts/epic-execute-prepare.js`                      | `.agents/scripts/epic-deliver-prepare.js`                          | Same JSON envelope contract for the slash-command parser.                                          |
| `.agents/scripts/epic-finalize.js`                             | `.agents/scripts/epic-deliver-finalize.js`                         | New responsibility: open PR to `main` instead of merging.                                          |
| `.agents/workflows/epic-execute.md`                            | `.agents/workflows/epic-deliver.md`                                | Six-phase merged execute + close workflow.                                                         |
| `agentSettings.riskGates.heuristics`                           | `agentSettings.planning.riskHeuristics`                            | Honesty rename — riskGates implied runtime gating that does not exist.                             |
| `orchestration.runners.epicRunner`                             | `orchestration.runners.deliverRunner`                              | Whole sub-block (`enabled`, `concurrencyCap`, `progressReportIntervalSec`, `idleTimeoutSec`, …).   |
| `orchestration.runners.closeRetry`                             | `orchestration.runners.storyMergeRetry`                            | Honesty rename — the retry was always for non-fast-forward push of the Story merge to the Epic.    |
| `resolveConfig()` wrapper key `settings`                       | `resolveConfig()` wrapper key `agentSettings`                      | Matches `.agentrc.json`'s literal top-level key; fixes the silent override-drop bug.               |

### Added

- **`/epic-plan` ideation entry.** Run with no arguments (or
  `--idea "<seed>"`) to enter ideation mode: the
  `idea-refinement` skill drives a divergent → convergent → sharpen
  loop, the new `lib/duplicate-search.js` module surfaces overlapping
  open Epics, the operator confirms the rendered Epic body, and the
  GitHub Issue is opened with only `type::epic`. The existing-Epic
  mode (`/epic-plan <id>`) is preserved verbatim.
- **`/epic-deliver` workflow.** Six phases run end-to-end:
  1. Prepare (`epic-deliver-prepare.js`) — snapshot, build wave DAG,
     initialise `epic-run-state`.
  2. Wave loop — Agent-tool fan-out per Story per wave at
     `concurrencyCap` (today's `/epic-execute` mechanics).
  3. Close-validation — lint, test, and project-extended ratchets
     (MI, CRAP, lint baseline) against the Epic branch.
  4. Code-review — `lib/orchestration/code-review.js` (extracted
     from the helper); halts on critical findings; persists results
     as a `code-review` structured comment on the Epic.
  5. Retro — `lib/orchestration/retro-runner.js` (extracted from
     the helper); fires before the PR opens to keep full env access
     in the operator's local session; posts the structured retro
     comment.
  6. Finalize (`epic-deliver-finalize.js`) — verifies FF, pushes
     `epic/<id>`, opens the PR, sets the required-checks expectation
     from `agentSettings.quality.prGate.checks`, posts the hand-off
     comment naming the PR URL, and exits.
- **`lib/duplicate-search.js`.** Cross-Epic title + body keyword
  search. Given a sharpened one-pager, scores open Epics and returns
  candidates above a threshold. Returns `[]` when nothing significant
  matches.
- **`lib/orchestration/code-review.js`.** In-process module callable
  from `epic-deliver-runner.js` Phase 4. Halts the runner on critical
  findings (sets `agent::blocked`, posts structured friction comment,
  exits non-zero).
- **`lib/orchestration/retro-runner.js`.** In-process module callable
  from `epic-deliver-runner.js` Phase 5. Aggregates perf signals,
  friction counts, hotfix counts, recut counts, parked counts, and
  HITL count using `retro-heuristics.js`.
- **`agentSettings.quality.prGate.enforceBranchProtection`.** Boolean,
  default `true`. When `true`, `/agents-bootstrap-github` calls
  `ensureMainBranchProtection({ checks })` to create or merge branch
  protection on `main` with `prGate.checks` as required status checks.
- **`agentSettings.planning.riskHeuristics`.** Replaces
  `agentSettings.riskGates.heuristics`. Same shape; same consumer
  (the decomposer system prompt). Rename only — no behaviour change.
- **`agentSettings.epicClose` removed.** Not added — listed in
  Removed for completeness.
- **`agents-bootstrap-github.js` `ensureMainBranchProtection` step.**
  Idempotent and additive: existing protections are preserved; missing
  required checks are added. Gated behind
  `agentSettings.quality.prGate.enforceBranchProtection: true`
  (default).
- **`tests/deletion-completeness.test.js`.** Ripgrep-based regression
  test that asserts zero references to the removed concepts
  (`BookendChainer`, `epic::auto-close`, `agent::review`, `runRetro`,
  `risk::medium`, `execution::sequential`, `execution::concurrent`,
  `epicClose` config key, `orchestration.hitl`, `epicRunner` config
  key, `closeRetry` config key, `riskGates` config key,
  `bookend-chainer` filename, `epic-finalize` filename, `epic-close`
  filename, plus a heuristic regex for `\.settings\b` reads against
  `resolveConfig()` return values) outside an allowlist of
  `docs/CHANGELOG.md`, `docs/decisions.md`, `docs/archive/`, and the
  test file itself. Each forbidden term registers as a per-term
  subtest so failures pinpoint the offending concept and file:line.
- **`tests/lib/config/limits-override.test.js`.** Regression test for
  the resolver-key alignment. Constructs a fixture `.agentrc.json`
  with `agentSettings.limits.maxTickets: 75`, calls
  `resolveConfig({ cwd: fixturePath })` then `getLimits(resolved)`,
  and asserts the returned `maxTickets` is `75`. Without the fix,
  this test fails (returns `60`, the new framework default).

### Changed

- **Resolver-key alignment.** `resolveConfig()` now returns
  `{ agentSettings, orchestration, raw, source }` instead of
  `{ settings, orchestration, raw, source }`. Every accessor in
  `lib/config/*.js` already reads
  `cfg?.agentSettings?.X ?? cfg?.X` — under v5.39.x the wrapper's
  `settings` key never matched, so passing the wrapper directly to
  an accessor silently fell through to framework defaults. 5.40 picks
  one canonical name end-to-end. The framework's ~50 destructure
  sites are updated mechanically; the seven accessor JSDocs document
  only two accepted shapes (the wrapper and the bare `agentSettings`
  bag). This is a breaking API change for any consumer of the
  resolver — see Migration.
- **`agentSettings.limits.maxTickets` default** bumped 40 → 60.
  Reflects the observed working range across recent dogfood Epics
  and removes the per-project override that 80% of consumers were
  carrying anyway.
- **`agentSettings.quality.prGate` promoted from schema-only to
  default config.** The default `checks` array ships as
  `["validate", "test", "lint-baseline", "crap-check",
  "maintainability"]` — the same gate names already enforced by
  close-validation, pre-push, and CI. Consumers who already had
  `prGate` populated keep their values (project-wins on merge).
- **Retro timing.** Today's retro fires after merge-to-main from
  inside `/epic-close`. Under 5.40 it fires inside `/epic-deliver`
  Phase 5, **before** the PR is opened. Retro analyses still see all
  completed work (every Story has merged into the Epic branch) but
  reflect on it before the human merge gate, not after. Programmatic
  consumers that ingest retro output downstream should review the
  timing change.
- **HITL touchpoints reduced from "blocker resolution + close
  hand-off" to "blocker resolution + PR merge".** The PR is the
  explicit, auditable promotion gate.
- **`epic-run-state` checkpoint schema.** Gains a `phase` field
  tracking which of the six `/epic-deliver` phases is in flight, so a
  mid-flight crash during code-review resumes at code-review (not
  at the start of the wave loop). The `autoClose` field is removed
  from new writes; existing in-flight Epics from v5.39.x carrying
  `autoClose` are tolerated by the 5.40 reader (the field is ignored,
  not rejected) so a v5.39 → 5.40 upgrade mid-Epic does not strand
  the run.

### Migration

The 5.40 schema rejects every removed/renamed v5.39.x key with a clear
AJV error. Follow these steps in order; each is a single mechanical
edit.

#### 1. Rename the resolver wrapper destructure (~50 sites in-tree;
likely 1–5 sites in your project)

```js
// Before — silently dropped overrides
const { settings, orchestration } = resolveConfig();

// After — overrides flow through correctly
const { agentSettings, orchestration } = resolveConfig();
```

Every internal reference that previously read `cfg.settings` becomes
`cfg.agentSettings`.

#### 2. Update `.agentrc.json` deleted/renamed keys

```jsonc
// Before (v5.39.x)
{
  "agentSettings": {
    "epicClose": {
      "runRetro": true,
      "skipDocsFreshness": false
    },
    "riskGates": {
      "heuristics": ["destructive-migration", "auth-change"]
    }
  },
  "orchestration": {
    "hitl": {},
    "runners": {
      "epicRunner": {
        "enabled": true,
        "concurrencyCap": 3,
        "progressReportIntervalSec": 120
      },
      "closeRetry": {
        "maxAttempts": 3,
        "backoffMs": [250, 500, 1000]
      }
    }
  }
}
```

```jsonc
// After (5.40.0)
{
  "agentSettings": {
    "planning": {
      "riskHeuristics": ["destructive-migration", "auth-change"]
    },
    "quality": {
      "prGate": {
        "checks": ["validate", "test", "lint-baseline", "crap-check", "maintainability"],
        "enforceBranchProtection": true
      }
    }
  },
  "orchestration": {
    "runners": {
      "deliverRunner": {
        "enabled": true,
        "concurrencyCap": 3,
        "progressReportIntervalSec": 120
      },
      "storyMergeRetry": {
        "maxAttempts": 3,
        "backoffMs": [250, 500, 1000]
      }
    }
  }
}
```

#### 3. `maxTickets` default bump

The framework default is now `60` (was `40`). If your project pinned
`agentSettings.limits.maxTickets: 40` solely to override the old
default, remove the override and inherit the new value:

```jsonc
// Before (v5.39.x)
{
  "agentSettings": {
    "limits": {
      "maxTickets": 40
    }
  }
}
```

```jsonc
// After (5.40.0) — drop the override; inherit default 60
{
  "agentSettings": {
    "limits": {}
  }
}
```

If your project genuinely needs a lower or higher cap, keep the
override at the value you want.

#### 4. `prGate` promotion + branch protection

`agentSettings.quality.prGate.enforceBranchProtection` defaults to
`true`. After upgrading, re-run `/agents-bootstrap-github` once so
the bootstrap step calls `ensureMainBranchProtection({ checks })`
and creates or merges branch protection on `main`. The step is
idempotent: existing protections are preserved, missing checks are
added.

If you maintain branch protection by hand and want to opt out, set:

```jsonc
{
  "agentSettings": {
    "quality": {
      "prGate": {
        "enforceBranchProtection": false
      }
    }
  }
}
```

#### 5. SDL command change

Wherever your runbooks, README, or onboarding docs say:

```text
# v5.39.x
/epic-plan <id>
/epic-execute <id>
/epic-close <id>
```

…replace with:

```text
# 5.40.0
/epic-plan          # ideation entry — sharpens raw idea, opens Epic, decomposes
/epic-plan <id>     # existing-Epic entry — PRD + Tech Spec + decomposition
/epic-deliver <id>  # wave loop → close-validation → review → retro → open PR to main
```

The operator merges the PR through the GitHub UI. There is no
separate close command. The retro fires automatically inside
`/epic-deliver` Phase 5 before the PR opens.

#### 6. Remove `epic::auto-close` references

`epic::auto-close` is no longer recognised. Drop the label from any
Epic Issue templates, automation rules, or runbook macros. The
removal is purely cosmetic in 5.40 — the runner ignores the label —
but the deletion-completeness test will fail on any in-tree
reference outside the allowlist (CHANGELOG, decisions, archive,
test file).

#### 7. Re-run lint and test

```powershell
npm run lint
npm test
```

The new deletion-completeness test (`tests/deletion-completeness.test.js`)
will fail loudly if any forbidden token survives in the tree. Each
failure carries a `file:line` pointer to the offending reference.

## [5.39.2] — 2026-05-09

Sprint Health residue removed. The `health-monitor.js` writer was deleted
in 5.37.0, but the **creator** of the `📉 Sprint Health: …` /
`type::health` issue was left in the dispatch pipeline, so every
`/epic-plan` Phase 4 still scaffolded a ticket that nothing ever wrote
to. This patch removes the creator, the close-side reaping, the
`type::health` label constant, the dead `epicRunner.healthRefresh`
config knob (cadence for the deleted health refresh), and all related
tests.

### Removed

- **`lib/orchestration/health-check-service.js`** (creator) and its
  test. Called from `dispatch-pipeline.js::reconcileEpicState`; that
  call is gone too.
- **`epic-close.js` Sprint Health closure branch.** Auxiliary close now
  matches `context::prd` / `context::tech-spec` only. The `type::health`
  / `📉 Sprint Health:`-title fallbacks are deleted.
- **`hierarchy-gate.js` auxiliary classification of `type::health`.**
  The label no longer exists, so the gate no longer needs to defer it.
- **`TYPE_LABELS.HEALTH`** in `lib/label-constants.js`.
- **`orchestration.runners.epicRunner.healthRefresh`** config schema
  block (`HEALTH_REFRESH_SCHEMA`, `DEFAULT_HEALTH_REFRESH`, the
  `agentrc.schema.json` `$defs.healthRefresh` mirror, and the three
  `config-schema-mirror-drift` tests). The cadence knob existed only to
  configure the deleted health-monitor; nothing reads it anywhere in
  the codebase.

### Migration

- Repos that already have an open `📉 Sprint Health: …` ticket from a
  previous run will need to close it manually (or via `gh issue close`).
  The new `epic-close.js` will not touch it. New Epics never get one.
- `.agentrc.json` files that set `orchestration.runners.epicRunner.healthRefresh`
  must drop the field — `additionalProperties: false` on `epicRunner` will
  now reject it.

## [5.39.1] — 2026-05-09

Documentation patch — warn `/story-execute` sub-agents to invoke
`story-init.js` synchronously with the 10-minute Bash timeout instead of
`run_in_background` + `Monitor`. Closes the bail-out failure mode observed
in Wave 0 of Epic #961 in the `athlete-portal` consumer, where three of six
parallel Story sub-agents exited mid-`transitionTaskStates` because they
treated a `Monitor` return as script exit. The script itself was already
idempotent on partial-batch state (`batchTransitionTickets` skips tasks
already at the target label, `postBatchedTransitionSummary` no-ops on an
empty list, the `story-init` structured comment is upserted), so the fix
is prevention at the prompt layer rather than recovery at the script
layer.

### Changed

- **`.agents/workflows/story-execute.md` Step 0 callout.** Added an
  explicit "Execution mode" note instructing sub-agents to call
  `node .agents/scripts/story-init.js --story <id>` with
  `Bash(timeout: 600000)` and to never background the call with
  `Monitor`. Documents the recovery (re-run synchronously) and the
  reason (the script is idempotent, so prevention is cheaper than the
  half-initialized worktree it leaves behind on a mid-flight kill).

## [5.39.0] — 2026-05-08

CI hardening — the `validate` job now runs on a `[ubuntu-latest,
windows-latest]` × Node 22 matrix with `fail-fast: false`. Closes the
single-OS gap flagged in the `/audit-quality` report: Windows is a
first-class supported platform (twelve Windows-specific feedback memories
on file, Story-close worktree reap, PowerShell vs bash separator, etc.)
but CI was previously ubuntu-only, so Windows-only regressions could land
on `main` undetected.

### Changed

- **`.github/workflows/ci.yml` `validate` job is now a matrix.** `runs-on`
  resolves to `${{ matrix.os }}`; `node-version` resolves to
  `${{ matrix.node-version }}`. `fail-fast: false` so a failure on one
  leg does not mask the other. `publish` already gates on
  `needs: [validate]`, which under a matrix means "every leg must pass"
  — no change required there.
- **"Run Tests with Coverage" and "CRAP Check" pinned to `shell: bash`.**
  Both steps use `set -o pipefail`, `tee`, `mkdir -p`, and `[[ ... ]]`,
  none of which work under the default Windows shell (pwsh). Git for
  Windows ships bash, so `shell: bash` resolves on both legs.
- **Artifact names are matrix-aware.** `test-results-*`, `coverage-final-*`,
  and `crap-report-*` now carry `${{ matrix.os }}-node-${{ matrix.node-version }}`
  suffixes — `actions/upload-artifact@v4` errors on duplicate names within
  a workflow run, and the previous flat names would collide across legs.

### Skipped on non-Linux

- **TruffleHog secret scan** is gated on `runner.os == 'Linux'`. The
  `trufflesecurity/trufflehog` action is a Docker container action and
  only executes on Linux runners. The Linux leg remains the source of
  truth for the secret-scan gate.

### Removed — `/wave-execute` and the `wave-runner` agent type

`/wave-execute` is retired. `/epic-execute` (the host LLM) now owns the
wave loop and fans Stories out directly, with `subagent_type:
general-purpose`. This eliminates the dependency on a custom sub-agent
type that the framework documented but never scaffolded into consumer
projects (the failure surfaced in agent-protocols Epic #32: "Agent type
not found" at wave 0). The host-driven flat fan-out documented as
emergency-only in #1072 / #1114 is now *the* architecture.

See ADR `20260508-flatten` for full rationale.

#### Deleted surface

- `.agents/workflows/wave-execute.md` and `.claude/commands/wave-execute.md`
  (auto-removed by `npm run sync:commands`).
- `.claude/agents/wave-runner.md`.
- `.agents/scripts/wave-prepare.js`.
- `.agents/scripts/wave-record.js`.
- `.agents/scripts/epic-rollup.js`.
- `.agents/scripts/lib/orchestration/epic-runner/wave-run-progress-writer.js`.
- `parseWaveRunProgressComment` and `WAVE_RUN_PROGRESS_TYPE` exports from
  `progress-reporter.js`.
- `tests/wave-runner-probe.test.js`,
  `tests/wave-execute/{wave-prepare,wave-record}.test.js`,
  `tests/epic-runner/wave-run-progress-writer.test.js`,
  `tests/epic-execute/epic-rollup.test.js`.
- The `wave-run-progress` structured-comment type. `epic-run-progress`
  now carries the entire run state, grouped by wave. Existing Epics with
  legacy `wave-run-progress` comments are unaffected — nothing reads
  them anymore; resume continues to work from the `epic-run-state`
  checkpoint.

#### Reshaped surface

- **`epic-execute-record-wave.js` absorbs `wave-record` + `epic-rollup`.**
  The CLI now accepts the full per-Story return contract via `--results`
  (parsed) or `--returns` (raw sub-agent text, with parse-failure
  reconciliation). It parses, reconciles, verifies live `done` claims,
  aggregates the wave-level status, appends the wave outcome to
  `state.waves[]`, re-renders `epic-run-progress` from the checkpoint,
  and prints the next-action envelope (`dispatch-next` / `halt-blocked`
  / `halt-failed` / `finalize`). One CLI per wave; no separate rollup
  step.
- **`epic-execute.md` Step 2 absorbs the per-wave fan-out.** The host
  LLM emits one assistant turn per wave with `min(plan[N].length,
  concurrencyCap)` parallel `Agent` tool calls (all
  `subagent_type: general-purpose`), pumping refills as background
  children return. The "you vs. your children" disambiguation and the
  per-child prompt contract from `wave-execute.md` move into Step 2's
  prose verbatim.
- **`story-execute.md` and `worktree-lifecycle.md`** dropped their
  `/wave-execute` cross-references; the topology is now
  `/epic-execute → /story-execute`.
- **`SDLC.md` and `docs/architecture.md`** updated to describe the
  three-skill execution surface (`/epic-plan`, `/epic-execute`,
  `/story-execute`) instead of the four-skill split.

#### Operator impact

- `/epic-execute <epicId>` resumes from the checkpoint after this
  upgrade — no manual migration needed. A blocked Epic at wave N
  re-fires wave N on resume; an in-progress wave whose checkpoint was
  written by 5.38.0 reads cleanly because the schema (`state.waves[]`)
  is unchanged.
- Per-wave operator re-entry (`/wave-execute <epicId> <waveN>`) is no
  longer available. Manual re-entry is `/epic-execute <id>` (resumes
  from checkpoint) or `/story-execute <id>` per Story.

## [5.38.0] — 2026-05-07

Epic #1114 — orchestration framework hardening from #1072's retro. Close-time
validation moves off the main checkout into the per-Story worktree; the
WorktreeManager auto-reap predicate is replaced with a real reachability check;
baseline refreshes attribute to the Story whose diff caused them; and the
analyze-execution CLI advertised in 5.37.0 finally ships and is wired into
both the post-merge pipeline and the Epic close phase.

### Added

- **`analyze-execution.js`** — Story-mode (`--story <id> --epic <id>`) and
  Epic-mode (`--epic <id>`) CLI that reads each Story's `signals.ndjson` and
  upserts the `story-perf-summary` / `epic-perf-report` structured comments
  the retro composer consumes. Wired into `post-merge-pipeline` (Story mode
  per close) and Epic close Phase 6.0 (Epic mode per close). The retro's
  Top hotspots subsection finally renders.
- **Custom `wave-runner` sub-agent type.** `.claude/agents/wave-runner.md`
  declares an agent with the `Agent` tool in its frontmatter, intended to
  hold nested fan-out for `/wave-execute`. Skill files (`wave-execute.md`,
  `epic-execute.md`) now dispatch via `subagent_type: wave-runner`.
- **Decomposer freshness gate.** `/epic-plan` decomposition fails when any
  Task body or AC names a `.agents/scripts/`, `lib/`, or `tests/` JS file
  that does not exist on the Epic base branch. Catches the Task #1109
  class of bug (a deleted file referenced from a planned AC) at planning
  time instead of at execute time.

### Changed

- **Close-validation gates run inside the worktree, read baselines from the
  Epic ref.** Lint, format-check, maintainability, CRAP, audit, typecheck,
  and the evidence-gate wrapper all execute in `.worktrees/story-<id>/` and
  read baseline files at `epic/<id>` HEAD via the new
  `lib/baseline-loader.js` helper. Cross-Story drift on the main checkout
  no longer blocks unrelated Story closes.
- **`WorktreeManager.isSafeToRemove` uses `git merge-base --is-ancestor`.**
  Replaces the unmerged-commits heuristic that produced 5 false-positive
  manual reap recipes during Epic #1072. Includes a merge-commit fallback
  for force-pushed Story branches.
- **Story-close blocks on non-attributable baseline drift.** Auto-refresh
  is allowed only for files the Story's diff actually touched. Drift on
  un-touched files surfaces as a friction comment naming the suspect
  sibling Story and blocks the close until operator triage. No more
  baseline-refresh fix-up commits attributed to the wrong Story.

### Removed

- **Legacy `dispatch-manifest-<id>.{md,json}` orphans** in `temp/epic-<id>/`
  are now swept on every manifest render, closing the Epic #1030 Story
  #1040 per-Epic-layout migration. Idempotent — safe to run twice.

## [5.37.1] — 2026-05-07

Epic #1072 — scripts cleanup: dead surfaces, dependency direction, and
bounded concurrency. Previously unbounded loops over GitHub and the
filesystem now run through `concurrentMap` at sensible caps; module
boundaries are tightened (HTTP client lives under `providers/github/`,
audit-suite has its own SDK, the orchestration barrel no longer re-exports
upward); and several dead modules are gone.

### Added

- **Canonical branch-name safety guard** at `lib/branch-name-guard.js`
  exporting `assertBranchSafe` / `isSafeBranchName`. Replaces the two
  duplicate implementations that lived in `git-branch-lifecycle.js` and
  `git-branch-cleanup.js`. Optional protected-mode mode rejects deletes
  against `main` / `master` / `HEAD` / `refs/*`.
- **`.agents/scripts/README.md`** — a script index classifying every
  top-level CLI by entry-point role, so consumers can find the right
  script without reading source.

### Changed

- **Bounded fanout across the board.** GitHub mutation paths (force-close
  closePromises, planning-state-manager close/detach, epic-close auxiliary
  ticket close) and read paths (`cascadeCompletion`, reconciler, issues
  link reconciliation, delete-epic, detect-merges fs scan) now run
  through `concurrentMap` at story-specific caps (3, 8, or 64) instead of
  unbounded `Promise.all`.
- **Atomic writes in `render-manifest.js`** — both manifest paths route
  through `atomicWrite` so a crash mid-write leaves either the prior
  artefact intact or no file at all, never a truncated one.
- **HTTP client moved** to `providers/github/http-client.js` (was
  `providers/github-http-client.js`); orchestration barrel no longer
  re-exports providers/scripts upward; new `lib/audit-suite/` SDK owns
  `runAuditSuite` / `selectAudits`.
- **Three-context naming discipline** — `docs/patterns.md` now describes a
  single `ctx` shape with three typed constructors
  (`OrchestrationContext`, `EpicRunnerContext`, `PlanRunnerContext`) and
  the data dictionary points at `lib/orchestration/context.js` as the
  owner.

### Removed

- `lib/fs-utils.js` and `lib/runtime-context.js` — dead modules with no
  remaining importers; documentation references migrated to the new
  three-context pattern.

### Fixed

- **`/wave-execute` rolling concurrency.** The fan-out contract is no
  longer strict-batch (one slow Story stalled all sibling slots); each
  child return now refills the next undispatched Story up to
  `concurrencyCap`.
- **Manifest progress symbols.** The wave-grouped Story table renders
  `🚧` (any task `agent::blocked`), `🔄` (some task done or executing),
  `✅` (all done), `⬜` (untouched) — previously binary `✅` / `⬜`
  conflated blocked stories with unstarted ones.

## [5.37.0] — 2026-05-07

Epic #1030 — performance-signal telemetry beyond friction. Runtime events
(hotspot, rework, tool churn, idle gap, retry density) now stream into a
per-Story `signals.ndjson` and roll up into Story- and Epic-level perf
summaries that feed the retro. The architecture is consolidated under one
rule: tickets carry decisions and summaries; NDJSON carries events.

### Added

- **Performance-signal taxonomy.** Five new detectors run during execution
  — hotspot (phase elapsed vs baseline p95), rework (edits-per-file),
  churn (repeated tool sequences), idle (gap-second threshold), retry
  (repeat-count threshold). Thresholds live in
  `agentSettings.limits.signals` with sensible defaults, all overridable
  per-project.
- **`story-perf-summary` and `epic-perf-report` structured comments.**
  One per Story (posted at close) and one per Epic (posted at retro);
  both consumed by the retro composer for the perf section.
- **`analyze-execution` CLI** — Story- and Epic-mode analyzer that reads
  the NDJSON signal stream and emits the summary/report payloads.
- **PreToolUse / PostToolUse trace hook** — wired into the Claude Code
  settings so runtime tool activity feeds the signal stream automatically.
- **Per-Epic durable temp tree.** All Epic artifacts now live under
  `temp/epic-<id>/{prd.md, techspec.md, manifest.md, retro.md,
  perf-report.md, story-<sid>/...}` — a stable layout for forensics and
  the retro, with no auto-cleanup.

### Changed

- **Friction handling re-architected.** The friction detector no longer
  posts a ticket comment per occurrence; it appends an NDJSON event that
  rolls up into the perf summary at close. The pre-existing per-comment
  cooldown layer is gone with it.
- **Retro reads perf summaries.** The retro composer now pulls
  `story-perf-summary` and `epic-perf-report` comments and mirrors the
  composed retro to `temp/epic-<id>/retro.md`.

### Removed

- **Per-occurrence friction comments + cooldown.** The friction-emitter
  module and the rate-limit cooldown that propped it up are deleted.
  Friction now surfaces only via the rolled-up perf summary; tickets
  carry decisions, NDJSON carries events.
- **Health-monitor and post-merge health-monitor phase.** Superseded by
  the signal stream + perf summaries. The `aggregate-phase-timings` and
  `telemetry` helpers are deleted alongside.

### Migration

- Consumer projects that read `temp/*-epic-<id>.*` paths directly must
  migrate to the per-Epic tree (`temp/epic-<id>/...`). The framework's
  own writers and readers are migrated; only out-of-tree tooling is
  affected.
- Consumers of friction *comments* on tickets must switch to reading the
  rolled-up `story-perf-summary` / `epic-perf-report` comments. Per-event
  comments no longer exist.
- Add an `agentSettings.limits.signals` block to `.agentrc.json` if you
  need to override the default thresholds; otherwise the defaults apply
  on first run.

## [5.36.4] — 2026-05-07

**Breaking change for consumer `.agentrc.json` files that still set
`agentSettings.sprintClose.runRetro`.** The one-release shim shipped in
5.31.0 was originally targeted for removal in 5.32.0; it has overstayed
that window by five releases. This patch removes it.

### Removed

- **`agentSettings.sprintClose.runRetro` back-compat shim.** Both the
  resolver fallback (in `lib/config/epic-close.js`) and the `SPRINT_CLOSE_SCHEMA`
  back-compat property (in `lib/config-settings-schema.js`) have been
  deleted. The static mirror at `.agents/schemas/agentrc.schema.json` no
  longer declares `sprintClose`. With `additionalProperties: false` on
  the agentSettings root, any `.agentrc.json` that still sets
  `sprintClose.*` will now fail AJV validation at startup with a clear
  `additionalProperty` error.
- **`_legacyWarned` / `_resetLegacyWarned`** — internal state that
  rate-limited the deprecation warning. Gone.
- **Shim-fallback test cases** — replaced with a positive assertion that
  the legacy key is *ignored* (returns the default `runRetro: true`)
  rather than read.

### Migration

Rename the key in `.agentrc.json`:

```diff
 "agentSettings": {
   ...
-  "sprintClose": { "runRetro": true }
+  "epicClose":   { "runRetro": true }
 }
```

That is the entire migration. The block shape is byte-identical; only
the parent key changed.

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

### Documentation pass (audit + consolidate)

A full-set documentation review against the codebase landed in this
patch alongside the automated git-perf check. High-impact accuracy
fixes:

- **`docs/configuration.md`** — `orchestration.{epicRunner,planRunner,
  concurrency,closeRetry}` rewritten as `orchestration.runners.*` to
  match the post-Epic-#773 schema; consumers copying the doc literally
  no longer hit AJV validation errors. Added documentation for
  `commands.formatCheck/formatWrite`, `limits.planningContext`, the
  seven `paths.*Root` keys, and `runners.decomposer`. Removed the
  phantom `audits` top-level entry; replaced `npm run mi:update` with
  the actual `maintainability:update` script.
- **`docs/data-dictionary.md`** — Friction Log section rewritten to
  match `friction-event.schema.json` (was diverged on field names,
  required list, and category enum casing). Stale `dispatch-logger` /
  `state-poller` references rewritten or removed.
- **`docs/architecture.md`** — removed two dead module references
  (`state-poller.js`, `dispatch-logger.js`); replaced one with the
  correct current home (`providers/github/issues.js`).
- **`docs/quality-gates.md`** — fixed the `mi:update` script reference
  and the pre-#773 `orchestration.closeRetry` path.
- **`README.md`** — corrected directory counts (rules: 10 → 8;
  workflows: 25 → 28; skills/stack expressed as 5 categories).
- **`docs/workflows.md`** — added missing rows for
  `/agents-bootstrap-project` and `/drain-pending-cleanup`.
- **`docs/project-board.md`** — corrected "eight options" → "seven";
  cross-referenced `label-taxonomy.js` for the "Current Sprint" view
  name (which is set in code).
- **`.agents/SDLC.md`** — same `orchestration.closeRetry` →
  `orchestration.runners.closeRetry` fix.

Consolidations:

- **`README.md`** trimmed from 197 → 124 lines: removed the
  Architecture-Overview mermaid (lives in `architecture.md`), the
  duplicated Documentation table (lives in `.agents/README.md`'s
  "where to look"), and the duplicated How-to-execute-an-Epic table
  (lives in `workflows.md`).
- **`docs/data-dictionary.md`** trimmed from 429 → 342 lines: removed
  the four sections that duplicated `configuration.md` (worktree-
  isolation config, grouped agentSettings contract, baseline
  conventions, notification filters). Stale `Impact Report` /
  `Epic Health State` blocks (referencing non-existent
  `ImpactTracker` / `topFrictionCategories` fields) removed.
- **`docs/quality-gates.md`** anti-thrashing table de-duplicated to a
  single cross-ref into `configuration.md#agentsettingslimits`.
- **`docs/patterns.md`** trimmed from 1201 → 1092 lines: collapsed
  the verbose "Worktree-per-Story Isolation" + "Worktree-off Mode"
  sections into one shorter "Per-agent filesystem isolation" pattern
  with cross-refs to `architecture.md` / `configuration.md`. The
  long-form "Quality gates: maintainability vs CRAP" runbook
  collapsed to a sibling-gate pattern entry with a cross-ref to
  `quality-gates.md`.
- **`docs/decisions.md`** — legacy ADRs 001 / 002 / 003 (April 9–17,
  pre-Epic-#900 sprint→epic rename) moved to
  `docs/archive/decisions-pre-900.md`. ADR 004 (Gherkin Standards)
  remains active in the main file.

`sprintClose.runRetro` shim removal was deferred (was originally
slated for 5.32.0, but the shim is still load-bearing in
`config-resolver.js`); the doc text now reads "scheduled for removal
in a future release" pending a deliberate removal pass.

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
