# Changelog Archive — pre-v6 (v1.x – v5.41.x)

Consolidated archive of every changelog entry that predates the v6.0.0
cut. Three sources were merged here at Epic #1184 close:

1. The 5.30.x – 5.41.x history that previously lived in `docs/CHANGELOG.md`.
2. The 5.0.0 – 5.29.0 history from `docs/archive/CHANGELOG-5.0-5.29.md`.
3. The 1.x – 4.x history from `docs/archive/CHANGELOG-v4.md`.

Entries are listed newest → oldest, matching the Keep-a-Changelog
convention used by `docs/CHANGELOG.md`. The active changelog —
starting at v6.0.0 — is [`../CHANGELOG.md`](../CHANGELOG.md).

---

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
- **`epic-runner.js` (top-level CLI).** Renamed to the deliver-runner
  CLI wrapper (see Renamed). The library at
  `lib/orchestration/epic-runner.js` and the `lib/orchestration/epic-runner/`
  submodule directory are preserved — only the operator-facing entry
  point moved. _(The deliver-runner CLI wrapper was itself retired in
  Story #2259 / Epic #2172; `/epic-deliver` is now the sole entry
  point.)_
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
| `.agents/scripts/epic-runner.js`                               | deliver-runner CLI wrapper (later retired in Epic #2172)           | Top-level CLI only; the library at `lib/orchestration/epic-runner.js` is unchanged.                |
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
  from the deliver runner Phase 4. Halts the runner on critical
  findings (sets `agent::blocked`, posts structured friction comment,
  exits non-zero).
- **`lib/orchestration/retro-runner.js`.** In-process module callable
  from the deliver runner Phase 5. Aggregates perf signals,
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

### `/agents-update` now reconciles consumer instructions + runbooks

The framework-bump workflow previously ended at "move the submodule
pointer + sync `.claude/commands/`." That left consumer-side
`AGENTS.md` / `CLAUDE.md` and project runbooks quietly drifting out of
sync with new framework contracts (e.g., a runbook pinning a workaround
for a bug that the bump just fixed; an `AGENTS.md` line contradicting a
tightened validator).

- New **Step 4 — Review the CHANGELOG and update consumer-side
  guidance** added to `.agents/workflows/agents-update.md`. The
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

The Stage 1 `fs-rm-retry` budget (5 × 200ms) was too short for c8 to release the file handles it holds across the close-validation chain on Windows, leaving `node_modules/.cache` and `coverage/` paths un-removable. Even when the deferred-to-sweep manifest correctly recorded the residue, [`removeWorktreeWithRecovery`](../.agents/scripts/lib/worktree/lifecycle/reap.js) returned `branchDeleted: false` because the local-and-remote branch cleanup was gated on Stage 1 success — operators had to follow up with manual `git branch -D` and `push --delete`. Two changes:

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
- **Compact-retro short-circuit.** `helpers/epic-retro.md` now
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
`.agents/workflows/helpers/`: `epic-plan-spec.md`,
`epic-plan-decompose.md`, `epic-code-review.md`, `epic-retro.md`,
`epic-testing.md`, `_merge-conflict-template.md`. Parent workflows
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
- **Updated workflow:** `epic-testing.md` consumes the Cucumber
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
*For historical changes prior to v5.0.0, see the [Legacy Changelog (v1.0.0 – v4.7.2)](CHANGELOG-v4.md).*

## [4.7.2] - 2026-04-05

### Added

- **Main-First Sprint Planning**: Restructured the `/plan-sprint` workflow to
  generate and commit planning artifacts (PRD, Tech Spec, Playbook) to the base
  branch (`main`) _before_ the sprint branch is created. This ensures the sprint
  branch inherits a fully-audited, committed set of planning documents.
- **Clean-Slate Planning**: Added a strict "Purge Prior Artifacts" step to the
  planning workflow that deletes any existing sprint documents for the target
  sprint number before generation. This prevents prior context or failed
  planning runs from influencing new artifact generation.

### Changed

- **Robust Directory Setup**: Updated `sprint-setup.md` to use `mkdir -p` when
  initializing sprint directories, ensuring compatibility with the new
  "Main-First" planning flow where directories are created during the document
  generation phase.

## [4.7.1] - 2026-04-05

### Fixed

- **Critical: Command Injection via Shell Interpolation
  (`sprint-integrate.js`)**: Replaced the single `spawnSync` call that chained
  lint, typecheck, and test commands via `;` separators with `shell: true` —
  which was both a command-injection vector and a fragile cross-platform pattern
  — with three sequential, shell-free `spawnSync` calls routed through
  `diagnose-friction.js`. Each verification step now has granular error
  reporting, per-step timing, and early-exit on first failure.
- **Critical: Dirty-State Cleanup (`sprint-integrate.js`)**: `cleanup()` now
  calls `git merge --abort` before attempting checkout, preventing the repo from
  being left in a broken merge state when cleanup is invoked during an active
  conflict resolution.
- **CLI Argument Parsing (`sprint-integrate.js`)**: `--sprint` and `--task` now
  validate that the following argument exists and is not another flag,
  preventing out-of-bounds access and silent misassignment (e.g.,
  `--sprint --task` no longer assigns `"--task"` as the sprint number).
- **Feature Branch Existence Check (`sprint-integrate.js`)**: Added
  `git rev-parse --verify` before the merge attempt. Previously, a nonexistent
  feature branch (typo, deleted) would fall through to the conflict analysis
  path and produce cryptic, misleading errors.
- **Consolidation Checkout Guard (`sprint-integrate.js`)**: The `git checkout`
  before the final consolidation merge now checks its return code and exits
  cleanly instead of silently merging into the wrong branch.
- **Binary-Safe Conflict Analysis (`sprint-integrate.js`)**: Replaced manual
  `fs.readFileSync` + regex conflict marker counting with `git diff --check`,
  which is binary-safe and avoids loading large files into memory.
- **Auto-Resolution Audit Trail (`sprint-integrate.js`)**: Minor conflict
  auto-resolution now logs the discarded sprint-base content via `VerboseLogger`
  before accepting `--theirs`, making silent data loss auditable.
- **Path Anchoring (`sprint-integrate.js`)**: The `--sprint` path passed to
  `diagnose-friction.js` is now anchored to `PROJECT_ROOT`, fixing a CWD
  mismatch where friction logs could be written to the wrong directory.

### Changed

- **Dead Code Removal (`sprint-integrate.js`)**: Removed unused `execFileSync`
  import and the no-op `maxBuffer` option (which has no effect with
  `stdio: 'inherit'`).

## [4.7.0] - 2026-04-05

### Changed

- **Code-review pass on v4.6.1 remediations** — post-merge review against all 10
  `audit-clean-code-results` findings. Three follow-up issues were surfaced and
  closed:
  1. **`verify-prereqs.js` — corrupted import line (Finding #8, final close)**:
     The previous edit left a CRLF-mangled line that concatenated two import
     statements on a single line
     (`import { resolveConfig } … \rimport { Logger }…`). Also removed trailing
     empty statements that followed `Logger.fatal()` calls (dead code after a
     non-returning call). File is now fully LF-normalised with clean, separate
     imports.

  2. **`aggregate-telemetry.js` — hardcoded paths and padding (Finding #10)**:
     `process.cwd()` replaced with the canonical `PROJECT_ROOT` from
     `config-resolver.js`. `'docs', 'sprints'` path segments replaced with
     `agentConfig.sprintDocsRoot`. `padStart(3, '0')` replaced with
     `agentConfig.sprintNumberPadding`. An `AGENT_PROJECT_ROOT` environment
     variable override is exposed so integration tests can point the script at a
     fixture directory without altering the real project root.

  3. **`generate-playbook.js` — dead imports after delegation refactor**:
     `buildGraph`, `assignLayers`, `transitiveReduction`,
     `computeChatDependencies` (all now internal to `PlaybookOrchestrator`) and
     `analyzeAndSplit`, `loadComplexityConfig` (delegated to
     `ComplexityEstimator` inside the orchestrator) were still imported at the
     top of the CLI entry point but never referenced. Removed.

- **`audit-clean-code-results.md` deleted** — all findings closed; the report is
  superseded by this changelog entry.

### Added

- **Verbose Interaction Logging**: Introduced an opt-in `verboseLogging`
  configuration in `.agentrc.json` that records all agentic interactions and
  responses as structured JSONL files for post-hoc analysis (model evaluation,
  cost attribution, prompt engineering, debugging).
  - New `VerboseLogger` class (`.agents/scripts/lib/VerboseLogger.js`) with
    singleton factory, graceful no-op degradation when disabled, and per-sprint
    JSONL file output.
  - Configuration: `agentSettings.verboseLogging.enabled` (default: `false`) and
    `agentSettings.verboseLogging.logDir` (default: `temp/verbose-logs`).
  - Integrated into `AgentLoopRunner.js` (action dispatches, observations,
    errors), `sprint-integrate.js` (merge, conflict, verify, consolidate
    phases), and `run-agent-loop.js` (CLI entry point initialization).
  - Updated `config-resolver.js` with zero-config defaults and schema boundary
    validation for `verboseLogging.logDir`.
  - Updated `instructions.md` §1.H with documentation for the verbose logging
    feature.

## [4.6.1] - 2026-04-05

### Changed

- **Refactored — `generate-playbook.js` god function**: `generateFromManifest()`
  is now a thin 8-line wrapper that delegates entirely to
  `PlaybookOrchestrator.run()`. The 143-line duplicated pipeline body has been
  removed. Tests continue to exercise the production code path through this
  delegation.

- **Canonical auto-serialization in `Graph.js`**: Extracted the focusArea
  overlap detection algorithm into a new exported function
  `autoSerializeOverlaps(manifest, adjacency)`. Both `generateFromManifest` and
  `PlaybookOrchestrator.build()` now delegate to this single optimized
  implementation (bulk-accumulate pattern, single graph rebuild). The previous
  O(N⁵) loop inside `generateFromManifest` has been eliminated.

- **Centralized bookend detection via `task-utils.js`**: Created a new module
  `.agents/scripts/lib/task-utils.js` exporting `isBookendTask(task)`. Replaced
  7+ verbatim instances of the compound boolean
  `task.isIntegration || task.isQA || task.isCodeReview || task.isRetro || task.isCloseSprint`
  across `generate-playbook.js`, `PlaybookOrchestrator.js`, `Renderer.js`, and
  `ComplexityEstimator.js`.

- **Extended `config-resolver.js`**: `resolveConfig()` now returns a `raw` field
  containing the full parsed `.agentrc.json` object (not just `agentSettings`).
  Exported `PROJECT_ROOT` as a shared constant. Error handling now distinguishes
  `ENOENT` (safe fallback to defaults) from JSON parse failures (now thrown
  immediately as fatal errors, not silently swallowed).

- **Eliminated redundant file I/O in `loadValidModelNames`**: Now uses
  `resolveConfig().raw.models.categories` — removing the second
  `fs.readFileSync` that re-parsed `.agentrc.json` on every call.

- **`CacheManager.js` proxy replaced**: Removed the hand-rolled proxy object
  with manual method forwarders. `instance` is now a clean `re-export` of
  `getInstance`, callable as `instance()`. Updated all consumer call sites in
  `generate-playbook.js`.

- **`ComplexityEstimator.js` error hardening**: `loadComplexityConfig()` now
  only silences `ENOENT` errors; all other errors (JSON parse failures,
  permission errors) are re-thrown. Replaced inline bookend boolean with
  `isBookendTask()`.

- **`Renderer.js` decomposed**: `renderPlaybook()` has been split into two
  independently testable sub-functions exported from the module:
  - `renderHeader(manifest, options)` — title block + blockquote metadata +
    sprint summary section.
  - `renderTaskBlock(task, session, taskIdToNumber, chatDeps, taskIndex, options)`
    — full per-task block including metadata, agent prompt fence, branching,
    close-out, and optional manual-fix block. Replaced all inline bookend
    booleans with `isBookendTask()`.

### Added

- **`lib/task-utils.js`**: New shared module with `isBookendTask(task)`
  predicate.
- **`tests/lib/task-utils.test.js`**: 10 unit tests covering all bookend flag
  variants, multi-flag scenarios, and truthy/falsy coercion.
- **`tests/lib/config-resolver.test.js`**: 5 tests verifying `PROJECT_ROOT` is
  absolute, caching is consistent, `raw` is populated, and malformed JSON
  throws.
- **`tests/lib/renderer.test.js`**: 16 unit tests for the extracted
  `renderHeader()` and `renderTaskBlock()` sub-functions, covering all rendering
  branches in isolation.

### Fixed

- **Lint**: Fixed three `markdownlint` violations in
  `audit-clean-code-results.md` (MD036 emphasis-as-heading, MD031 fence blank
  lines).

## [4.6.0] - 2026-04-04

### Added

- **Lint Baseline Ratcheting Mechanism**: Integrated a
  `.agents/scripts/lint-baseline.js` checker into the sprint workflows to
  prevent pre-existing ESLint warnings from blocking sprint integrations.
  - `sprint-setup.md` captures an initial baseline (`capture` mode).
  - `sprint-finalize-task.md` and `sprint-integrate.js` verification phases run
    against the baseline (`check` mode).
  - The script enforces zero-deterioration: integrations fail if new warnings
    are introduced, and dynamically ratchets the baseline down when the codebase
    health improves.
  - Added new configuration keys `lintBaselineCommand` and `lintBaselinePath` to
    `.agentrc.json`.
- **Ephemeral State Cleanup Protocol**: Updated the `sprint-close-out.md`
  workflow to strictly enforce the purging of local temporary state at the end
  of the sprint lifecycle.
  - Added localized removal steps for `temp/workspaces` and `temp/task-state` to
    prevent project bloat and ensure isolation between sequential sprints.
  - Hardened Step 0 of the close-out workflow with explicit path resolution for
    `WORKSPACES_ROOT` and `TASK_STATE_ROOT`.

## [4.5.0] - 2026-04-04

### Added

- **Two-Tier Skill Library Architecture**: Restructured `.agents/skills/` into a
  `core/` + `stack/` two-tier system to separate universal process protocols
  from tech-stack-specific knowledge:
  - **`core/`** (20 skills): Universal, process-driven skills adopted from the
    `potential-skills` library. Covers the full SDLC:
    `api-and-interface-design`, `browser-testing-with-devtools`,
    `ci-cd-and-automation`, `code-review-and-quality`, `code-simplification`,
    `context-engineering`, `debugging-and-error-recovery`,
    `deprecation-and-migration`, `documentation-and-adrs`,
    `frontend-ui-engineering`, `git-workflow-and-versioning`, `idea-refinement`,
    `incremental-implementation`, `performance-optimization`,
    `planning-and-task-breakdown`, `security-and-hardening`,
    `shipping-and-launch`, `spec-driven-development`, `test-driven-development`,
    and `using-agent-skills`.
  - **`stack/`** (14 skills): Tech-stack-specific skills retained from the
    previous library and reorganized under `stack/architecture/`,
    `stack/backend/`, `stack/frontend/`, `stack/qa/`, and `stack/security/`.
- **Anti-Laziness Coding Rules**: Merged the `autonomous-coding-standards` skill
  rules directly into `instructions.md` §5 Quality Standards, making them
  universal system-level constraints rather than an opt-in skill.

### Changed

- **Skill Activation Protocol (§1.B)**: Updated `instructions.md` to document
  the two-tier skill system with path conventions and selection guidance.
- **`using-agent-skills` Meta-Skill**: Updated skill discovery tree to reference
  renamed `idea-refinement` skill.
- **Playbook Bookend Task Skills**: Updated `sprint-generate-playbook.md`
  bookend recommendations to reference new `core/` and `stack/` paths.
- **`architect.md` Protocol Evolution**: Updated skill path references to
  `core/` and `stack/` tiers.
- **`engineer-web.md`**: Updated `stack/frontend/` skill path reference.

### Removed

- **Superseded Process Skills** (deleted, now covered by `core/`):
  - `architecture/autonomous-coding-standards` → merged into `instructions.md`
  - `architecture/markdown` → superseded by `core/documentation-and-adrs`
  - `conventional-commits-enforcer` → superseded by
    `core/git-workflow-and-versioning`
  - `devops/git-flow-specialist` → superseded by
    `core/git-workflow-and-versioning`
  - `qa/resilient-qa-automation` → superseded by `core/test-driven-development`
  - `security/zero-trust-security-engineer` → superseded by
    `core/security-and-hardening`
- **Root-Level Duplicate Skills** (11 deleted, canonical versions retained in
  `stack/`): `astro-react-island-strategist`, `cloudflare-hono-architect`,
  `cloudflare-queue-manager`, `expo-react-native-developer`,
  `monorepo-path-strategist`, `resilient-qa-automation`,
  `secure-telemetry-logger`, `sqlite-drizzle-expert`, `stripe-billing-expert`,
  `ui-accessibility-engineer`, `zero-trust-security-engineer`.
- **`idea-refine` Skill**: Renamed to `idea-refinement` for grammatical
  consistency with the rest of the skill library.

## [4.4.0] - 2026-04-04

### Added

- **DFS-Based Graph Algorithms (`Graph.js`)**: Replaced the O(N³) Floyd-Warshall
  implementations in `computeReachability` and `transitiveReduction` with
  O(V·(V+E)) DFS-based algorithms.
- **Bulk-Accumulate DAG Serialization (`PlaybookOrchestrator.js`)**: Eliminated
  the O(N⁵) thrashing in the auto-serialization loop via `Set` intersections and
  bulk edge application.
- **Async Command Dispatch (`AgentLoopRunner.js`)**: Migrated
  `ExecuteSafeCommand` to `util.promisify(exec)` to maintain event-loop
  responsiveness.
- **Complexity Estimator Optimization**: Removed redundant O(N) `manifest.find`
  lookups in the splitting logic.
- **Improved E2E Test Reliability**: Updated `run-agent-loop-e2e.test.js` with
  async/await and task flushing to support new non-blocking dispatch patterns.
- **Cross-Artifact Version Lineage**: Implemented systemic protocol version
  tracking to ensure deterministic consistency across the planning pipeline.
  - Added `protocolVersion` to `task-manifest.schema.json`.
  - Added `Protocol Version` fields to `prd-template.md`,
    `technical-spec-template.md`, and `sprint-playbook-template.md`.
  - Updated `PlaybookOrchestrator.js` to automatically verify that the
    manifest's version matches the system's current version in
    `.agents/VERSION`, emitting a warning on mismatch.
- **Mandatory Alignment Audit**: Integrated a protocol version verification step
  into the `plan-sprint.md` master workflow, requiring agents to explicitly
  confirm version consistency across all planning artifacts (PRD, Tech Spec,
  Manifest, Playbook).

### Changed

- **Workflow Governance**: Updated `sprint-generate-prd.md`,
  `sprint-generate-tech-spec.md`, and `sprint-generate-playbook.md` to mandate
  the injection of the current protocol version from `.agents/VERSION` into all
  generated artifacts.
- **Parallelism Guardrails**: Hardened the `sprint-generate-playbook.md`
  workflow with explicit "Diamond Fan-out" pattern guidance and a list of
  dependency anti-patterns (Linear Chain Bias, Shared Focus Serialization) to
  prevent unnecessary task serialization.

## [4.3.0] - 2026-04-04

### Fixed

- **Critical: Agent Hang Prevention in Integration Pipeline**: Added
  configurable `timeout` and `maxBuffer` to the `spawnSync` call in
  `sprint-integrate.js` (verification suite) and `diagnose-friction.js` (inner
  command wrapper). Both now respect `executionTimeoutMs` and
  `executionMaxBuffer` from `.agentrc.json`, eliminating the primary cause of
  indefinite agent stalls during `lint`/`typecheck` runs.
- **Critical: Cascading Pipeline Stall in `hydrate-cache.js`**: Added timeout to
  the `execFileSync` subprocess call that invokes `update-task-state.js`,
  preventing cascading stalls in the APC hydration pipeline.
- **Non-Blocking APC Extraction**: Converted the synchronous `execFileSync` call
  to `extract-intent.js` in `update-task-state.js` to an async fire-and-forget
  `spawn` (detached, unref'd). APC intent extraction is a best-effort
  optimization that no longer blocks the critical path of task state updates.

### Changed

- **Config Resolver Caching**: `resolveConfig()` now caches results at module
  level, eliminating 3-4 redundant file reads and JSON parses per execution run.
  A `bustCache` option is available for scripts that need to force re-read.
- **Lazy CacheManager Singleton**: The `CacheManager` singleton is now
  instantiated lazily on first access instead of eagerly at import time,
  avoiding unnecessary I/O for scripts that never use the cache.
- **Optimized Directory Walk**: `context-indexer.js` now uses
  `fs.readdirSync(dir, { withFileTypes: true })` instead of separate
  `fs.statSync()` calls per entry, halving syscall count during index builds.
- **Pre-compiled Regex Patterns**: Icon selection regex patterns in
  `generate-playbook.js` are now compiled once at module level instead of on
  every `selectIcon()` invocation.
- **Pre-computed Sort Keys**: `harvest-golden-path.js` now pre-computes `mtime`
  values into a Map before sorting, eliminating redundant `statSync` calls
  inside the sort comparator.
- **Model Name Loader**: `loadValidModelNames()` now includes explanatory
  comments about OS-level filesystem caching for its config file read.

## [4.2.0] - 2026-04-04

### Added

- **Complexity-Aware Task Decomposition**: Introduced a new
  `ComplexityEstimator` module (`.agents/scripts/lib/ComplexityEstimator.js`)
  that scores task complexity based on instruction length, estimated file count,
  scope breadth, focus area count, cross-package language indicators, and
  bullet-point density. Tasks exceeding the configurable `maxComplexityScore`
  threshold (default: 8) are automatically split into sequentially-chained
  sub-tasks when explicit `substeps` are provided in the manifest, or flagged
  with an inline `⚠️ COMPLEXITY WARNING` to instruct agents to self-decompose.
- **Manifest Schema Extensions**: Added two optional properties to the task
  manifest schema (`task-manifest.schema.json`):
  - `estimatedFiles` (integer): Approximate file count hint for the complexity
    estimator.
  - `substeps` (array): Pre-decomposed sub-steps enabling automatic task
    splitting with correct dependency chaining.
- **Complexity Configuration**: Added configurable `complexity` settings block
  to `.agentrc.json` with tunable thresholds: `maxComplexityScore`,
  `instructionLengthBreakpoints`, `estimatedFilesBreakpoints`,
  `focusAreasBreakpoints`, `enableAutoSplit`, `enableComplexityWarnings`, and
  `maxSubstepsPerTask`.
- **Complexity-Aware Execution Protocol (§9)**: Added a new section to
  `instructions.md` mandating agents self-decompose when encountering complexity
  warnings, enforcing a 5-file-per-substep rule and incremental commit
  discipline.
- **Renderer Enhancements**: Auto-split tasks display `🔀 Auto-split` badges
  with part numbering and parent task origin. High-complexity unsplittable tasks
  receive prominent `⚠️ COMPLEXITY WARNING` blocks in the rendered playbook.
- **Shared Branch Strategy**: Sub-tasks from auto-split share the parent task's
  branch (`task/sprint-XXX/{parentId}`) and follow the natural
  `sprint.chat.step` numbering (e.g. `045.1.1`, `045.1.2`, `045.1.3`).
- **Test Coverage**: Added `tests/complexity-estimator.test.js` with 27 tests
  covering scoring heuristics, task splitting, dependency rewiring, config
  toggles, and edge cases.

### Changed

- **Pipeline Integration**: The complexity analysis phase runs between
  `enrichManifest` and `validateManifest` in both `generate-playbook.js` and
  `PlaybookOrchestrator.js`, ensuring sub-task IDs are present before schema
  validation.
- **SDLC Documentation**: Updated the Sprint Planning section in `SDLC.md` with
  guidance on using `estimatedFiles` and `substeps` for complexity-aware
  planning.

## [4.1.3] - 2026-04-04

### Fixed

- **Shell Compatibility Hardening**: Updated `instructions.md` to strictly
  forbid `&&` chaining in PowerShell environments, mandating the more robust
  `; if ($?) { ... }` success-chaining pattern.
- **Cross-Platform Git Helper**: Introduced
  `.agents/scripts/git-commit-if-changed.js` to handle conditional git commits
  without relying on shell-specific logical operators.
- **Renderer Robustness**: Updated `Renderer.js` templates to utilize the new
  cross-platform commit script, ensuring generated playbooks are 100% compatible
  with Windows/PowerShell 5.1.
- **Documentation Alignment**: Updated `README.md` examples and `package.json`
  script guidance to reflect cross-platform best practices and avoid
  shell-related parser errors.

## [4.1.2] - 2026-04-04

### Fixed

- **Legacy Config Cleanup**: Replaced 30+ stale references to deprecated
  `.agents/config/` files (`config.json`, `models.json`, `tech-stack.json`)
  across `instructions.md`, `SDLC.md`, `README.md`, personas, templates, and
  workflows. All documentation now consistently references `.agentrc.json`.
- **Notification Enhancement**: prepended specific task/sprint IDs to webhook
  notifications across all sprint workflows for improved channel visibility.
- **Task State ID Validation**: Added format guard to `update-task-state.js`
  rejecting non-numeric slugs (e.g., `directories-db-migrations`). Only dotted
  playbook IDs (e.g., `045.2.1`) are now accepted. Disambiguated `[TASK_ID]`
  token definition in `sprint-finalize-task.md` and fixed the dangerously
  ambiguous "extract from branch name" instruction in `sprint-integration.md`.
- **Legacy Fallback Removal**: Removed the deprecated
  `.agents/config/config.json` fallback path from `config-resolver.js`.
  Resolution is now `.agentrc.json` → built-in defaults.
- **SDLC Diagram Correction**: Fixed Mermaid diagram in `SDLC.md` to show the
  correct bookend order (Integration → Code Review → QA) and updated the
  "Closing the Loop" section to match.
- **Read Context Grounding**: Improved the generator's `Read Context`
  instruction with explicit sprint-relative file paths (`prd.md`,
  `tech-spec.md`) and a direct reference to `.agentrc.json`'s `techStack`
  section.

## [4.1.1] - 2026-04-04

### Fixed

- **Playbook Pipeline Hardening**: Resolved "split-brain" dependency graph
  issues where parallel feature tracks were artificially serialized.
- **Global Context Synchronization**: Migrated the Project Reference Document
  list to `instructions.md`, establishing a global protocol for architectural
  grounding without redundant injections in every playbook task.
- **Instruction Injection**: Mandatory `Read Context` instruction step now
  auto-injected for non-bookend tasks to ensure grounding in PRD/Tech Specs and
  global project reference docs.
- **Bookend Sequence**: Established the bookend session order to **Integration →
  Code Review → QA** facilitating architectural alignment and pattern-level
  fixes before formal QA testing cycles begin.
- **Auto-Serializer Guard**: Fixed over-aggressive serialization logic to
  prevent feature tracking collisions based on bare scope matches.
- **Config Standardization**: Renamed `webhookUrl` to `notificationWebhookUrl`
  in `.agentrc.json` and all associated workflows to explicitly define its
  purpose for status notifications.

## [4.1.0] - 2026-04-04

### Added

- **Coverage Verification Phase**: Integrated a mandatory "Step 2.5" into the
  `sprint-generate-playbook.md` workflow to cross-check Tech Spec coverage and
  scope completeness before manifest finalization.
- **Model Registry Validation**: Added automated warnings during playbook
  generation for unrecognized model strings, validating against the
  `.agentrc.json` registry.

### Changed

- **Feature Track Isolation**: Hardened dependency rules to prevent artificial
  cross-feature serialization that destroys parallelism.
- **Mandatory Context Sync**: Every non-bookend agent prompt now mandates
  reading the PRD and Tech Spec before execution to prevent hallucination of
  architecture/schema details.
- **Strict Execution Ordering**: Reordered task instructions to ensure
  `Mark Executing` is the first action performed by the agent.
- **Explicit Branch Merges**: Renderer now injects concrete
  `git merge origin/<branch>` commands for all task dependencies, eliminating
  branching ambiguity.
- **Human-Operator Clarification**: Clearly labeled the
  `Manual Fix Finalization` block as a human-operator task in `Renderer.js` to
  prevent agent execution confusion.

## [4.0.0] - 2026-04-03

### Added

- **Cryptographic Provenance**: Integrated automated ED25519 PKI digital
  signatures into the agent receipt pipeline. By enabling
  `requireCryptographicProvenance` in `.agentrc.json`, the framework establishes
  a Zero-Trust immutable chain of custody for playbook integration gates.
- **Universal Protocol Standardization**: Consolidated all previously fragmented
  agent configuration into a single `.agentrc.json` at the project root. The
  canonical default is shipped as `.agents/default-agentrc.json` for consumers
  to copy and customise. All orchestration scripts now use the shared
  `lib/config-resolver.js` utility, which resolves `.agentrc.json` first, falls
  back to the legacy path with a deprecation warning, then applies built-in
  defaults as a final safety net.
- **Perception-Action Event Stream Protocol**: Implemented the core architecture
  for decoupling agent reasoning from environment execution. Playbooks now
  strictly enforce discrete, atomic environmental interactions via a localized
  event ledger.
- **Atomic Action Schema**: Introduced a formal JSON schema
  (`.agents/schemas/atomic-action-schema.json`) defining the structured API
  boundaries for agent environment interactions (ReadFile, WriteFile,
  ExecuteSafeCommand, ConcludeTask).
- **Isolated Multi-Agent Parallelization**: Eliminated Git lock race conditions
  during concurrent executions. The `run-agent-loop.js` orchestrator now
  natively intercepts branch instructions and creates isolated task execution
  environments using `git worktree` under `temp/workspaces/<task-id>`.
- **Strict Workflow Patterns**: Integrated `--pattern` parameterization into the
  Event Stream loop to enforce specialized AI architectures (e.g., Evaluator-
  Optimizer, Prompt Chaining) decoupled from monolithic playbook generation.
- **Event Stream Orchestrator**: Shipped `.agents/scripts/run-agent-loop.js`, a
  secure JSON-based REPL that manages the perception-action cycle and maintains
  an append-only JSONL audit trail in `temp/event-streams/`.
- **Agentic Plan Caching (APC)**: Implemented a novel test-time memory
  architecture to extract structured intent from successful executions.
  Standardized intent extraction now stores semantic logic in `temp/apc-cache/`
  to bypass redundant generative dependencies for identical tasks.
- **Speculative Execution & Cache-Aware Scheduling**: Integrated the
  `CacheManager` into the `generate-playbook.js` engine. The engine now
  mathematically identifies tasks that match previously cached intent and
  automatically tags them as `SpeculativeCache` for autonomous hydration.
- **Speculative Execution Hydration System**: Created `hydrate-cache.js` to
  natively apply cached diff parameterizations, allowing the framework to skip
  generative LLM cycles and bypass expensive planning for repetitive structural
  work.
- **Global APC Configuration**: Centralized cache settings, including TTL,
  hashing strictness, and execution toggles, into the global `.agentrc.json`
  schema under `apcCacheSettings`.

## [3.5.0] - 2026-04-03

### Added

- **`typecheckCommand` config key**: Configurable TypeScript compiler command
  (default: `pnpm turbo run typecheck`). Previously hardcoded across four
  heuristic rules.
- **`buildCommand` config key**: Configurable production build command (default:
  `pnpm turbo run build`). Previously hardcoded in the `.astro`/`.tsx`
  verification heuristic.

### Changed

- **Heuristics decoupled from commands**: All four heuristic rules that
  referenced `pnpm turbo run typecheck` or `pnpm turbo run build` now reference
  the configured `typecheckCommand` and `buildCommand` keys, making the protocol
  portable across monorepos using different package managers or task runners.

### Fixed

- **Task State Stagnation**: Simplified agent "Close-out" instructions in
  `Renderer.js` to eliminate redundant inline Git steps that were causing agents
  to skip the mandatory `sprint-finalize-task` workflow and its state update
  (`committed`).
- **Hardened Prerequisite Verification**:
  - Updated `Renderer.js` to explicitly pass the `taskStateRoot` argument to the
    `verify-prereqs.js` pre-flight command.
  - Upgraded `verify-prereqs.js` with internal configuration resolution to
    correctly identify the decoupled task state directory even when CLI
    arguments are omitted, matching the robustness of the primary status update
    utility.
- **Model Fallback Dead Code**: Fixed a logic ordering bug in `enrichManifest`
  where the `.includes()` substring dedup check always fired before the exact
  equality cross-assignment branch, causing the secondary model to be silently
  nullified instead of cross-assigned from the opposite tier. Tasks now
  consistently display both a First Choice and Second Choice model.

## [3.4.6] - 2026-04-03

### Changed

- **UI Prompt Layout**: Added double newlines after `=== SECTION ===` headers in
  the agent prompt and architectural review prompt. This fixes a rendering issue
  where headers and content were collapsed into a single line in some markdown
  readers, significantly improving legibility.

## [3.4.5] - 2026-04-03

### Fixed

- **Remote-Tracking Merge Refs**: Fixed dependency-chaining branching in
  `Renderer.js` to use `origin/task/sprint-N/...` remote-tracking refs instead
  of local branch names, preventing `not something we can merge` crashes in
  ephemeral environments.
- **Scope Auto-Expansion for E2E**: Added `e2e`, `playwright`, and `test` to the
  cross-package detection keywords, ensuring E2E-scoped tasks auto-expand to
  `root` when their instructions reference testing workspaces.

### Added

- **Bookend Completeness Warning**: Post-generation validation now emits
  warnings if any mandatory bookend task type (Integration, Code Review, QA,
  Retro, Close-Sprint) is missing from the manifest.

## [3.4.4] - 2026-04-03

### Fixed

- **Close-out Literal Variable Trap**: Separated the cognitive instruction
  ("Analyze your diff, then run this command with your generated message") from
  the executable bash pattern, preventing agents from literally committing
  placeholder strings into git history.
- **Model Duplication Bug**: Fixed the fallback dedup check to use `.includes()`
  substring matching instead of strict `===` equality, eliminating triple-model
  strings like
  `Claude Sonnet 4.6 (Think) OR Gemini 3.1 Pro (High) OR Gemini 3.1 Pro (High)`.
- **HITL Over-Flagging**: Engine now strips `requires_approval` from non-bookend
  development tasks during enrichment, reserving HITL stops exclusively for
  Integration, Code Review, and Close-Sprint phases.

### Added

- **Cache/Eviction Test Heuristic**: Tasks modifying caching or memory
  management logic must include explicit test-writing instructions.
- **Soft-Verb Replacement Heuristic**: Instructions using "validate that" /
  "ensure that" must be replaced with explicit CLI execution commands.
- **Astro Build Verification Heuristic**: `.astro`/`.tsx` text replacements must
  mandate both `typecheck` AND `build` to catch structural HTML errors.

## [3.4.3] - 2026-04-03

### Fixed

- **Auto-Serialization Guard Widened**: Changed the overlap detection from `&&`
  (both global) to `||` (either global) in `generate-playbook.js`, ensuring any
  `scope: root` task forces serialization with all parallel tasks to prevent
  merge conflicts.
- **Scope Auto-Expansion**: Added cross-package instruction analysis in
  `enrichManifest` that auto-expands task scope to `root` when instructions
  reference 2+ workspace indicators (e.g., "Astro" + "Expo"), preventing agent
  sandbox crashes.
- **Close-out Clean Tree Crash**: Replaced prose-only commit instructions in
  `Renderer.js` with a crash-safe bash pattern
  (`git diff --staged --quiet || git commit`) that returns `exit 0` on clean
  working trees.
- **Branching Fetch Injection**: Moved `git fetch origin` from a regex on the
  task instructions field (which agents don't copy) into the actual
  `branchInstruction` builder (which agents do copy) across all three code paths
  (default, bookend, dependency-chaining).
- **Bookend Model Elevation**: Added `model` overrides to `isQA`,
  `isCodeReview`, and `isRetro` bookend requirements in `.agentrc.json`, and
  wired `enrichManifest` to apply them to the primary model field.

## [3.4.2] - 2026-04-03

### Fixed

- **Structural Global Sweep Serialization**: Hardened the `generate-playbook.js`
  engine to mathematically detect and auto-serialize parallel monorepo-wide
  sweep tasks (e.g. `scope: root`), eliminating merge conflict vectors without
  manual AI intervention or brittle prompt heuristics.
- **Literal Execution Protocol Hardening**: Removed all literal string examples
  (e.g., git commit messages) in the `Renderer.js` Close-out protocols to
  prevent autonomous agents from hyper-literally copying placeholder values into
  production Git histories.
- **Compute Allocation Elevation**: Exposed and upgraded the default planning
  model to High/Thinking tiers (e.g., Claude Sonnet 3.6 OR Gemini 3.1 Pro) in
  `.agentrc.json` to ensure sufficient reasoning capacity for complex monorepo
  AST operations.

## [3.4.1] - 2026-04-03

### Fixed

- **Universal Remote State Sync**: Refactored the internal `Renderer.js`
  branching protocol to mandate an explicit `git fetch origin` before any
  checkout or merge, ensuring ephemeral runners never crash due to stale local
  branch lists.
- **Architectural Scope Validation**: Implemented a core heuristic in
  `.agentrc.json` that restricts Planner-defined task scopes to valid monorepo
  workspace names (e.g. `@repo/web`) or the literal string `root`, preventing
  `pnpm --filter` tool crashes.
- **Ambiguous UI Constraint Guardrail**: Added systemic planner heuristics that
  force the grounding of UI standardization tasks against the official design
  system documentation, eliminating subjective hallucination vectors for
  autonomous styling agents.
- **Monorepo-Wide Verification**: Codified a mandatory
  `pnpm turbo run typecheck` requirement for all cross-cutting type-safety
  refactors to ensure architectural boundaries remain unbroken.

## [3.4.0] - 2026-04-03

### Fixed

- **Parallel Fan-Out Merge Collision Detection**: Integrated a transitive
  closure reachability matrix into the core graph engine (`Graph.js`) which
  proactively identifies when concurrent tasks share focusArea patterns without
  explicit sequencing, throwing a fatal validation error to prevent git merge
  conflicts.
- **Literal Bash Instruction Decoupling (Final)**: Completely decoupled
  non-executable cognitive variables from bash backticks in `Renderer.js`,
  preventing hyper-literal agents from corrupting commit messages with
  placeholder templates.

### Added

- **Protocol Lineage Tracking**: Embedded an automatic version indicator at the
  top of all generated Playbook files to streamline traceability and protocol
  debugging across multiple sprint versions.

## [3.3.9] - 2026-04-03

### Fixed

- **Bash Command Literal Execution**: Refactored `Renderer.js` prompt logic to
  explicitly decouple cognitive instructions from bash command strings,
  preventing agents from hyper-literally executing the text `<generate...>`
  instead of an actual message.
- **Model Fallback Determinism**: Overhauled `generate-playbook.js` manifest
  enrichment to automatically invert default fallback assignments when the
  primary model matches the fallback family, ensuring 100% diversity in the
  retry loop.

### Added

- **Zod Schema Bridge Heuristic**: Added a systemic guardrail to `.agentrc.json`
  enforcing the generation and export of validation schemas (Zod) during
  database migration tasks to proactively stabilize downstream API consumption.

## [3.3.8] - 2026-04-03

### Fixed

- **Multi-Dependency Branching Collision**: Updated `Renderer.js` to
  intelligently chain `git merge` commands during task initialization when
  multiple fan-in dependencies are present, ensuring all required context is
  available.
- **Graceful "Clean Tree" Commits**: Refactored the universal
  `AGENT EXECUTION PROTOCOL` to make commits conditional on staged changes
  (`git diff --staged --quiet || git commit`), preventing exit code crashes in
  headless terminals on zero-diff tasks.
- **Semantic Commit Enforcement**: Replaced hardcoded `feat:` prefixes with a
  dynamic instruction for agents to generate context-aware Conventional Commit
  messages based on their actual diffs.
- **Code Review Push Stability**: Standardized the manual fix prompt to push to
  `HEAD` instead of hardcoded sprint branches, resolving detached state
  conflicts.

### Added

- **Architectural Risk Gate Heuristics**: Expanded the global `.agentrc.json`
  risk gates with mandatory systemic guardrails enforcing programmatic tests
  (Playwright/Vitest), type-check verification after AST refactors, and
  synchronous DB schema pushes.

## [3.3.7] - 2026-04-03

### Added

- **Configurable Golden Example Storage**: Introduced `goldenExamplesRoot` in
  `.agentrc.json` to allow custom paths for harvested golden paths (defaulting
  to `temp/golden-examples`).
- **Dynamic Playbook Reinforcement**: Updated `Renderer.js` and
  `harvest-golden-path.js` to dynamically resolve the golden example store using
  the new configuration property, enabling project-specific few-shot prompt
  reinforcement.

## [3.3.6] - 2026-04-03

### Changed

- **Native Bookend Workflows**: Restructured post-integration workflows
  (`sprint-testing`, `sprint-code-review`, `sprint-retro`, `sprint-close-out`)
  to execute natively on the base `sprint-[NUM]` branch, completely eliminating
  the creation of post-integration feature branches.
- **Workflow Cleanup**: Removed the self-cleanup branch deletion step from
  `sprint-integration` as the agent now executes natively on the base
  integration branch.

## [3.3.5] - 2026-04-03

### Fixed

- **Markdown Code Block Collisions**: Upgraded the outer agent prompt wrapper in
  `Renderer.js` to use 4 backticks (` `markdown ````). This prevents Golden
  Example triple-backticks from prematurely closing the prompt and corrupting
  the playbook's structure.

## [3.3.4] - 2026-04-03

### Added

- **Manual Fix Finalization Prompt**: Updated `Renderer.js` to automatically
  inject a specialized **DevOps/Git-Flow** cleanup prompt into Code Review
  tasks. This ensures manual architectural fixes are correctly committed and
  merged back into the sprint base branch before QA begins.

## [3.3.3] - 2026-04-03

### Changed

- **Nomenclature Realignment**: Updated all visual and textual references in the
  playbook and integration workflows to use `Pending Integration` and
  `Integrated` instead of the ambiguous "Not Started" vs "Complete".

## [3.3.2] - 2026-04-03

### Changed

- **Cross-Platform State Tracking**:
  - Replaced manual `mkdir -p` and `echo` JSON commands in
    `sprint-finalize-task.md` with invocations of the `update-task-state.js`
    Node script to ensure cross-platform compatibility (preventing execution
    spinning/hanging on Windows PowerShell).
  - Updated `update-task-state.js` to automatically generate the
    `[TASK_ID]-test-receipt.json` artifact when instructed with the `passed`
    state.
  - Updated `verify-prereqs.js` to recognize decoupled `passed` states as
    logically equivalent to `committed`, ensuring dependent tasks seamlessly
    unblock.

## [3.3.1] - 2026-04-02

### Fixed

- **Ghost Branching & Uncommitted Changes**:
  - Updated `Renderer.js` to explicitly mandate a `git add . && git commit` step
    in the `AGENT EXECUTION PROTOCOL` before pushing.
  - Hardened root task branching: agents now explicitly reset to the sprint base
    branch (`git checkout sprint-[NUM]`) before creating new feature branches,
    preventing uncommitted changes from being dragged across parallel roots.

## [3.3.0] - 2026-04-02

### Changed

- **Refactored Playbook Generation**:
  - Replaced abstract `/[.agents/workflows/... ]` commands with explicit natural
    language instructions to prevent LLMs from hallucinating bash commands.
  - Added explicit instructions for agents to push their integrated branches
    using `git push -u origin HEAD`.
  - Modified task instructions presentation so bulleted lists format correctly
    under the task header line.
  - Reordered bookend pipeline: **Code Review** now strictly precedes **QA
    Audit** to ensure tests run on architecturally approved code.
  - Enforced deterministic ordering by recalculating graph adjacency after
    grouping, ensuring the markdown execution plan matches the logical flow.

### Fixed

- **Execution & Branching Bugs**:
  - Implemented **chained branching commands** for dependent tasks: agents now
    explicitly checkout their prerequisite branch before creating their own
    feature branch.
  - Added **intelligent pathspec mapping**: dependencies on integration, QA, or
    Code Review tasks now correctly resolve to the `integration` branch.
  - Optimized administrative workflows: **Sprint Close Out** now reuses the
    retro branch to minimize redundant git tree clutter.
  - Enforced **universal pre-flight validation**: EVERY task (including roots)
    now executes `verify-prereqs.js` for environment and state consistency.
  - Fixed implicit dependency flaws where task steps without explicit
    `dependsOn` declarations were bypassing pre-flight `verify-prereqs`
    execution instructions inside the agent context.
  - Enforced structured `🚨 HITL REQUIRED` stopping points dynamically within
    the volatile task context instead of just as metadata.

## [3.2.1] - 2026-04-02

### Changed

- **Refactored Playbook Task Layout**:
  - Grouped task metadata, dependencies, and agent prompts into a single,
    unified, sequential block per task for better readability and execution
    clarity.
  - Removed top-level `#### Tasks` and `#### Agent Prompt` headings to
    streamline the execution plan.
  - Unified the checkbox format to `[ ] **{taskId}** {taskTitle}` without
    leading markdown dashes.

### Fixed

- **Resilient Prerequisite Verification**:
  - Updated `verify-prereqs.js` regex logic to support both legacy (`- [ ]`) and
    new (`[ ]`) checkbox formats, ensuring backward compatibility for concurrent
    sprints.

## [3.2.0] - 2026-04-02

### Added

- **Exploratory Testing Integration**:
  - Enhanced the `/sprint-testing` workflow with a mandatory **Exploratory
    Testing** step (Step 5) to identify edge cases and regressions outside the
    formal test plan.
  - Mandated a remediation loop where agents must address and verify any issues
    found during exploratory testing before finalizing the task.
  - Introduced the `exploratoryTestCommand` configuration property in
    `.agentrc.json` (default: `pnpm test:exploratory`) to ensure the testing
    suite is fully configurable.

## [3.1.3] - 2026-04-02

### Fixed

- **Decoupled Playbook Prompts**: Fixed a regression where consolidated
  phase-based Chat Sessions (e.g., "Merge & Verify") were erroneously rendering
  multiple distinct tasks inside a single `#### Agent Prompt` block.
- Refactored `Renderer.js` to iterate over session tasks and generate distinct
  LLM instruction blocks (`#### Agent Prompt: [Title]`) for each task within a
  consolidated session, ensuring clear, distinct execution bounds.

## [3.1.2] - 2026-04-02

### Fixed

- **ESM Notification Script**: Converted `.agents/scripts/notify.js` to a native
  ES module to resolve `ReferenceError: require is not defined`.
- **Structured Friction Logging**:
  - Replaced brittle shell-based `echo` appending with a robust Node.js utility:
    `.agents/scripts/log-friction.js`.
  - This ensures valid JSONL formatting and eliminates stray characters or
    newlines that caused JSON parsing failures in previous versions.
  - Updated `sprint-setup`, `sprint-finalize-task`, `sprint-integration`, and
    `sprint-close-out` workflows to use the new logging script.

## [3.1.1] - 2026-04-02

### Added

- **Decoupled Task State Management**:
  - Introduced `.agents/scripts/update-task-state.js` utility for standardized
    JSON-based task state tracking.
  - Refactored the `AGENT EXECUTION PROTOCOL` to include a mandatory **Mark
    Executing** step using the new utility.
  - Formally aligned the playbook with the **v2.18.3+ simplified protocol**,
    removing all instructions for manual checkbox editing (`- [ ]` -> `- [/]`).

- **Config-Driven Playbook Generation**:
  - Refactored `generate-playbook.js` and `Renderer.js` to eliminate hardcoded
    `docs/sprints` paths and `3`-digit padding.
  - The generation pipeline now dynamically respects `sprintDocsRoot` and
    `sprintNumberPadding` defined in `.agentrc.json`.

- **Intelligent Model Fallbacks**:
  - Restored the dual-model enforcement protocol in `generate-playbook.js`.
  - Every task now guarantees both a **First Choice** and **Second Choice**
    model.
  - Implemented configurable fallbacks (Planning -> Pro Low, Fast -> Flash)
    defined in `.agentrc.json`.

- **Enhanced Task Branching Logic**:
  - Updated `Renderer.js` to inject explicit `git checkout -b` commands for
    every task directly into the agent instructions.
  - Standardized the feature branch naming convention:
    `task/sprint-[NUM]/[TASK_ID]`.

- **Conditional Pre-flight Verification**:
  - Refactored the `AGENT EXECUTION PROTOCOL` to conditionally omit the
    pre-flight dependency check for tasks with zero dependencies.
  - This streamlines execution for independent tasks while maintaining strict
    verification for chained work.

### Changed

- **Human-Centric Model Recommendations**:
  - Refactored the playbook layout to move `Mode` and `Model` identifiers above
    the `Agent Prompt` block.
  - This ensures recommendations are clearly visible for human consumption and
    manual model selection while keeping the automated prompt block focused on
    execution logic.

### Fixed

- **Task ID Resolution Bug**: Fixed a logic error where the pre-flight
  verification script was being generated with incorrect internal manifest IDs
  (e.g., `043.1.a`) instead of the required numeric identifiers (e.g.,
  `043.1.1`).

## [3.1.0] - 2026-04-02

### Added

- **Optional Style-Guide Support**:
  - Introduced support for a `docs/style-guide.md` file to house
    project-specific writing standards, aesthetic constraints, and UI
    copywriting rules.
  - Updated all core personas (`technical-writer`, `ux-designer`, `product`,
    `engineer-web`, `engineer-mobile`) and the `Markdown Mastery` skill to
    conditionally defer to the style guide if present.
  - Added a high-fidelity "Golden Sample" style guide to
    `.agents/sample-docs/style-guide.md` based on the KinetixID design system.
  - MARKED `docs/style-guide.md` as an optional artifact in the SDLC
    documentation and global instructions.

- **Context Caching Prompt Architecture**:
  - Restructured the `playbook.md` generation logic in `Renderer.js` to strictly
    separate static framework rules from volatile task state.
  - Implemented a two-layer prompt architecture with an immutable
    `=== SYSTEM PROTOCOL & CAPABILITIES ===` header at the start of every agent
    prompt block.
  - This optimization maximizes character-for-character prefix matching,
    enabling 100% native LLM API token caching for protocol-level instructions.
  - Promoted task-specific "Pre-flight Task Validation" to a clearly labeled
    volatile section to maintain both discoverability and cache consistency.

- **Automated Context Pruning ("Gardener")**:
  - Implemented `run-context-pruning.md` workflow for systematic archiving of
    stale architectural decisions and patterns.
  - Updated `context-indexer.js` to explicitly ignore the `docs/archive/`
    directory, preventing stale context from polluting Local RAG.
  - Integrated the Gardener workflow into `epic-retro.md` as a mandatory
    close-out step.
  - Updated SDLC and README to reflect the new documentation lifecycle and the
    `docs/archive/` directory standard.

- **Zero-Touch Remediation Loop**:
  - Automates the transition from a failed `/sprint-integration` candidate check
    into an immediate `/sprint-hotfix` loop.
  - Introduced `maxIntegrationRetries` to `.agentrc.json` (default: 2) to
    control the automated remediation depth.
  - Integrated diagnostic capturing via `diagnose-friction.js` directly into the
    integration verification step.
  - Mandated recursive integration attempts within `sprint-hotfix.md` until the
    retry threshold is reached, minimizing human-in-the-loop dependencies for
    integration failures.

- **Dynamic Golden-Path Harvesting (Agentic RLHF)**:
  - Created `harvest-golden-path.js` script to automatically extract
    Zero-Friction implementation diffs and instruction pairings into a local
    `.agents/golden-examples/` repository.
  - Updated `diagnose-friction.js` to support `--task` tagging, enabling precise
    association of friction points with specific task IDs.
  - Integrated harvesting into the `/sprint-finalize-task` workflow as a
    standard completion step.
  - Modified `Renderer.js` to dynamically inject harvested golden paths as
    few-shot prompts into new playbooks, facilitating autonomous project
    alignment and reinforcement learning.

- **Semantic Risk & Blast-Radius Gates**:
  - Upgraded static keyword `riskGates.words` in `.agentrc.json` to a semantic
    `riskGates.heuristics` framework.
  - Updated `sprint-generate-tech-spec.md` to instruct the AI Architect to act
    as a semantic classifier for blast-radius analysis.
  - Updated `sprint-generate-playbook.md` to enforce Human-In-The-Loop (HITL)
    approval for tasks flagged by semantic security assessments.
  - Refined documentation (SDLC, README) to reflect the transition from brittle
    deterministic checks to contextual AI-driven risk mitigation.

- **Adversarial Red-Teaming (Tribunal)**:
  - Introduced the on-demand `/run-red-team` workflow for cross-examining and
    hardening code via dynamic fuzzing and mutation tests.
  - Assigned the `security-engineer` persona to provide adversarial scrutiny on
    branches or directories before functional QA.

## [3.0.0] - 2026-04-02

### Added

- **Local RAG & Semantic Context Retrieval**:
  - Implemented `.agents/scripts/context-indexer.js`, a zero-dependency TF-IDF
    engine for local documentation indexing and semantic search.
  - Updated `.agents/workflows/sprint-gather-context.md` to prioritize semantic
    retrieval over monolithic file reading.
  - Refined `instructions.md` to mandate Local RAG for efficient context
    gathering, mitigating context window bloat.
  - Added repository-wide Guiding Principles to `docs/roadmap.md` focusing on
    flexibility and self-contained architecture.

- **FinOps & Economic Guardrails**:
  - Added `maxTokenBudget` and `budgetWarningThreshold` properties to
    `.agentrc.json`.
  - Updated `instructions.md` (Section 2) with mandatory token tracking,
    soft-warning (80%), and hard-stop (100%) protocols to prevent budget
    overruns.
  - Enriched `.agentrc.json` with `finops_recommendations` to guide agents
    toward cost-effective API tiering.

- **HITL Risk Gates for Safe Execution**:
  - Added `riskGates` configuration to `.agentrc.json` with default trigger
    keywords (`DROP`, `DELETE`, `IAM`, etc.).
  - Updated the Task Manifest schema with a `requires_approval` property.
  - Automated Tech Spec phase to flag destructive workflows natively in the
    playbook, halting the execution sequence until explicitly human-approved.
  - Solidified the safety guidelines in the core `instructions.md`.

- **Telemetry-Driven Retro Recommendations (Self-Healing)**:
  - Enhanced `.agents/workflows/epic-retro.md` and the `architect` persona to
    mandate macro-analysis of `agent-friction-log.json`.
  - Modified `.agents/templates/sprint-retro-template.md` to format Protocol
    Optimization Recommendations as "agent-ready" markdown snippets, creating an
    evolving library immune loop.

- **Macroscopic Telemetry Observer**:
  - Created `.agents/scripts/aggregate-telemetry.js`, a script that parses
    structured telemetry across an entire sprint range.
  - Auto-generates `docs/telemetry/observer-report.md` tracking long-term
    efficiency bottlenecks and framework tool failures.

- **Unified Quality Auditing**:
  - Renamed `audit-qa` workflow to `audit-quality` to better reflect its
    comprehensive scope (Infrastructure, Coverage, Fragility, and Strategy).
  - Updated all internal documentation, personas, and file links to the new
    `/audit-quality` standard.

## [2.24.0] - 2026-04-02

### Added

- **Enhanced Diagnostic Tools & Passive Telemetry**:
  - Implemented `.agents/scripts/diagnose-friction.js`, replacing the "honor
    system" for logging tool failures. This script wraps failing commands, logs
    execution details (stdout/stderr) natively to `agent-friction-log.json`, and
    outputs structured remediation steps back to the agent to prevent thrashing.
  - Updated `instructions.md` to formally mandate the use of the new diagnostic
    interceptor for unrecoverable errors.
  - Refined `SDLC.md` to articulate the expanded Observability loop using this
    automated telemetry approach.
  - Shifted the corresponding roadmap item from **Planned** to **Completed**.

## [2.23.0] - 2026-04-02

### Added

- **Persona Specialization & Framework Handshake**:
  - Introduced the mandatory **Framework Handshake** protocol in
    `engineer-web.md`, forcing agents to read framework-specific skills before
    execution.
  - **Astro 5 (Iron) Modernization**: Updated `astro/SKILL.md` to enforce Server
    Islands (`server:defer`), Astro Actions for data mutations, and the new
    Content Layer API.
  - **Tailwind CSS v4 (CSS-First)**: Hardened the `tailwind-v4/SKILL.md` and
    `ux-designer.md` persona to enforce a strict CSS-only configuration using
    the `@theme` directive, banning legacy `tailwind.config.ts/js` files and
    arbitrary utility values.
  - **Task State Tracking**: Created localized task and walkthrough artifacts
    for traceable implementation.

## [2.22.0] - 2026-04-02

### Added

- **Hybrid Integration & Blast-Radius Containment (Option 3)**:
  - Introduced the "Integration Candidate" protocol to ensure the shared
    `sprint-[NUM]` branch never enters a broken state.
  - **Ephemeral Verification**: Merges are now performed on temporary
    `integration-candidate-[TASK_ID]` branches first.
  - **Fail-Safe Rollback**: If tests fail on the candidate branch, the branch is
    purged, and the failure is logged to `agent-friction-log.json` without
    polluting the sprint base.
  - **`sprint-hotfix` Workflow**: Created a dedicated workflow for rapid
    remediation of broken features directly on their original branch, unblocking
    other parallel integrations.
  - **SDLC Documentation**: Updated `SDLC.md` and the `roadmap.md` to reflect
    the completion and adoption of the hybrid containment model.

## [2.21.0] - 2026-04-02

### Added

- **Advanced Concurrency & Merge Conflict Protocols**:
  - Introduced a hybrid concurrency model (Option C) to eliminate complex
    structural merge conflicts during execution.
  - **Schema Update**: Added `focusAreas` property to
    `task-manifest.schema.json` to allow static prediction of high-risk file
    overlaps during the planning phase.
  - **Runtime Rebase Wait-Loop**: Refactored the `sprint-finalize-task` workflow
    to force agents to run `git pull --rebase origin sprint-[NUM]` and manually
    resolve structural conflicts against the remote base branch _before_ running
    validation tests and pushing their feature branch.
  - **SDLC Documentation**: Updated `SDLC.md` to formally outline the new
    Advanced Concurrency Protocols.

## [2.20.0] - 2026-04-02

### Added

- **"Shift-Left" Agentic Testing Protocol**:
  - Introduced a mandatory validation step where agents must run isolated tests
    on their feature branch before finalizing a task.
  - Implemented **Option B (Agentic Test Receipt)**: Agents execute the
    configured `testCommand` and generate a `[TASK_ID]-test-receipt.json` in the
    decoupled state folder as evidence of a green state.
  - Updated the `sprint-integration` workflow to act as a strict gatekeeper,
    blocking the merge of any branch that lacks a valid "passed" test receipt.
  - This protocol eliminates the "happy path" anti-pattern by ensuring only
    verified code enters the shared sprint branch, matching CI-like standards in
    a local-first environment.

### Changed

- **Modernized Validation Commands**:
  - Updated `validationCommand` and `testCommand` in `.agentrc.json` to leverage
    **pnpm turbo** for faster, cached execution.
  - Default `validationCommand`: `pnpm turbo run lint`.
  - Default `testCommand`: `pnpm turbo run test`.
- **Workflow Hardening**:
  - Updated `sprint-finalize-task` to enforce the new testing requirement and
    receipt generation.
  - Updated `sprint-integration` to verify receipt existence and status before
    commencing merges.
- **SDLC Documentation**:
  - Formally documented the Shift-Left testing requirements and the
    "cryptographic-like" evidence of the test receipt in `SDLC.md`.

## [2.19.0] - 2026-04-02

### Changed

- **Unified Webhook Failure Logging**:
  - Deprecated the legacy `WEBHOOK_FAILURE.md` file requirement.
  - Updated `sprint-finalize-task`, `sprint-integration`, and `sprint-close-out`
    workflows to mandate logging notification failures directly to the
    structured `agent-friction-log.json` file (JSONL format).
  - This change aligns webhook telemetry with the project's broader
    "agent-friction" observability protocol, improving error traceability and
    reducing per-sprint documentation clutter.

## [2.18.3] - 2026-04-02

### Added

- **Configurable Task State Root**:
  - Introduced `taskStateRoot` in `.agentrc.json` to allow custom paths for
    decoupled task state files.
  - Set the default path to `temp/task-state/` (in the project root) to keep the
    repository clean and avoid polluting Git history with transient state.
  - Updated `instructions.md`, `SDLC.md`, and the `sprint-finalize-task`
    workflow to dynamically resolve the task state path.
  - Implemented conditional Git tracking: state files in `/temp/` are
    local-only, while those in project directories (e.g., `docs/sprints/`)
    continue to be committed for cross-agent synchronization.

### Changed

- **Simplified Playbook State Tracking**:
  - Removed intermediate `[- [~]]` (Executing) and `[- [/]]` (Committed)
    statuses from the sprint playbook entirely.
  - The playbook now only tracks `[- [ ]]` (Not Started) and `[- [x]]`
    (Complete).
  - All intermediate states are now exclusively managed by decoupled JSON state
    files located in `taskStateRoot`.
  - Refactored `verify-prereqs.js` to parse both the playbook `[x]` markers and
    the decoupled `committed` state files when evaluating dependencies, ensuring
    concurrent feature branches don't prematurely block execution.
  - Simplified the visually generated Mermaid DAG, condensing it to only
    `⬜ Not Started` and `🟩 Complete` nodes.

## [2.18.2] - 2026-04-02

### Fixed

- **Parallel Task Generation**:
  - Overhauled `groupRegularTasks` in `generate-playbook.js` to correctly emit
    independent, parallelizable tasks as distinct Chat Sessions.
  - Removed logic that inadvertently grouped same-layer tasks into single
    sequential windows based on shared scope (e.g., `root`), which was falsely
    representing parallel work as sequential in the Mermaid graph and execution
    prompts.

## [2.18.1] - 2026-04-02

### Added

- **Automated Manifest Enrichment**:
  - Introduced `enrichManifest` function to `generate-playbook.js` to
    automatically inject required personas and skills for bookend tasks.
  - Reduces boilerplate in `task-manifest.json` and prevents validation errors
    for missing mandatory fields in Integration, QA, Code Review, Retro, and
    Close Sprint tasks.

## [2.18.0] - 2026-04-02

### Changed

- **Extracted Base Branch Configuration**:
  - Centralized the primary development branch (default: `main`) into
    `.agentrc.json`.
  - Extracted the sprint documentation root (`sprintDocsRoot`: `docs/sprints`),
    sprint number padding (`sprintNumberPadding`: 3), validation command
    (`validationCommand`: `npm run lint`), and notification webhook
    (`webhookUrl`) into the configuration.
  - Updated all core workflows (sprint planning, setup, execution, and closure)
    to dynamically resolve paths using these configuration variables.
- **Improved Branch Naming Consistency**:
  - Updated `sprint-integration` and `sprint-close-out` workflows to expect and
    manage branches with the `task/` prefix (e.g.,
    `task/sprint-[SPRINT_NUMBER]/[TASK_ID]`), aligning with the established
    conventions in `instructions.md`.
- **Introduced Cross-Platform Execution Scripts**:
  - Created `.agents/scripts/notify.js` to handle webhook JSON payloads
    programmatically, replacing OS-dependent `curl` commands.
  - Created `.agents/scripts/detect-merges.js` to ensure reliable conflict
    marker detection across all files, replacing `git grep`.
  - Updated `sprint-integration`, `sprint-close-out`, and `sprint-finalize-task`
    to execute these local Node.js scripts.
  - Created `.agents/scripts/verify-prereqs.js` to deterministically evaluate
    task dependencies and chat predecessors by parsing the `playbook.md`.
- **Decoupled Task State Management**:
  - Refactored `sprint-finalize-task.md` to exclusively use
    `task-state/[TASK_ID].json` files for status tracking, removing manual
    `playbook.md` editing to eliminate race conditions during concurrent
    execution.
- **Clarified Testing Responsibilities**:
  - Updated `epic-testing.md` and `audit-quality.md` to explicitly demarcate
    that Software Engineers (SWEs) are responsible for unit and integration
    testing during development, while the QA persona focuses exclusively on E2E
    automation and documentation during integration.
- **Hardened Final Sprint Integration**:
  - Added a mandatory **Final Integration Audit** (Step 3) to the
    `sprint-close-out` workflow. This step enforces a check for unmerged task
    branches and prevents sprint closure if remediation work is detected.
  - Updated the `sprint-integration` workflow to explicitly recommend rerunning
    the integration process whenever new feature or remediation branches are
    created after the initial integration.

## [2.17.3] - 2026-04-02

### Added

- **Configurable Friction Thresholds**:
  - Extracted hardcoded agent-friction and anti-thrashing thresholds into
    `.agentrc.json` under `frictionThresholds`.
  - Thresholds for consecutive errors, stagnation steps, and repetitive command
    detection are now fully configurable.
  - Updated `instructions.md`, `SDLC.md`, and project READMEs to reference the
    dynamic configuration values.

## [2.17.2] - 2026-04-01

### Changed

- **Standardized QA Workflow Naming**:
  - Renamed the `plan-qa-testing` workflow to `sprint-testing` across all
    protocols, documentation, and tooling.
  - Aligned the QA phase with the `sprint-[action]` naming convention used by
    other core workflows.
  - Updated the `project-manager` and `qa-engineer` personas, SDLC
    documentation, and the playbook generation script to utilize the new
    workflow command.

## [2.17.1] - 2026-04-01

### Added

- **Workspace & File Hygiene Protocol**:
  - Introduced a mandatory global instruction in `instructions.md` to store all
    temporary files, scratch scripts, and intermediate outputs in a root
    `/temp/` directory.
  - Automatically excluded the `/temp/` directory from Git to prevent repository
    pollution and history bloat.

## [2.17.0] - 2026-04-01

### Added

- **Architecture Decisions & Code Patterns Context**:
  - Elevated `docs/decisions.md` (ADRs) and `docs/patterns.md` to core context
    requirements in `instructions.md`.
  - Added sample references for these files in `.agents/sample-docs/`.
  - Updated `sprint-gather-context` to explicitly read these artifacts before
    sprint execution.
  - Updated `sprint-code-review` to verify new code against established
    patterns.
  - Updated `sprint-retro` to close the feedback loop by formally documenting
    newly emerged rulings and architectural decisions into these files.

## [2.16.0] - 2026-04-01

### Added

- **Roadmap Review Workflow**:
  - Introduced the `/sprint-roadmap-review` workflow (formerly `scope-roadmap`)
    to assist Product Managers with sprint grooming and feature decomposition in
    `docs/roadmap.md`.
  - Updated the `product` persona and SDLC documentation to integrate the new
    roadmap scoping command into Phase 1 of the development lifecycle.
  - Renamed all audit-related workflows from `[feature]-audit.md` to
    `audit-[feature].md` for better discoverability and sorting.
  - Renamed all sprint-related workflows to follow the `sprint-[action]` pattern
    (e.g., `close-sprint.md` → `sprint-close-out.md`, `generate-prd.md` →
    `sprint-generate-prd.md`).
  - Updated internal artifact filenames, headers, and slash commands across the
    entire protocol to ensure consistency.

## [2.15.0] - 2026-04-01

### Added

- **Configurable Efficiency Guardrails**:
  - Introduced **Instruction Density** as the core complexity metric, replacing
    file counts. Configurable via `maxInstructionSteps` in `.agentrc.json`
    (default: 5 logical steps).
  - Updated the **Anti-Thrashing Protocol** with clear error and research
    thresholds to prevent agent stagnation.
  - Added a dedicated **🛡️ Efficiency & Guardrails** section to all project
    READMEs and SDLC documentation to improve protocol transparency.

### Changed

- **Version Bump**: Incremented project version to `2.15.0`.

## [2.14.0] - 2026-04-01

### Added

- **Repetitive Task Capture & Automation Recommendations**:
  - Introduced the `AutomationCandidate` telemetry type in
    `agent-friction-log.json` to identify boilerplate and repetitive agent
    tasks.
  - Updated the **Sprint Retrospective** template and workflow to systematically
    analyze execution logs for automation opportunities.
  - Provided a dedicated **Protocol Automation & Optimization Recommendations**
    section in the retro report to surface protocol improvements without
    polluting the project roadmap.

### Changed

- **Version Bump**: Incremented project version to `2.14.0`.

## [2.13.0] - 2026-04-01

### Added

- **Master Planning Alignment Audit**:
  - Introduced a mandatory **Alignment & Consistency Audit** (Step 4) in the
    `plan-sprint` orchestrator.
  - The `architect` persona now performs cross-artifact reviews of the PRD, Tech
    Spec, and Playbook to ensure logical unity, strict 3-digit padding
    adherence, and mandatory bookend protocol compliance.

### Changed

- **Hardened Git & Sprint Protocols**:
  - **Strict Branch Naming**: Mandated the `task/sprint-[XXX]/[ID]` branch
    naming convention in global `instructions.md` and `finalize-sprint-task` to
    eliminate graph visual clutter.
  - **Standardized Status Commits**: Enforced the
    `chore(sprint): update task [ID] status to [STATUS]` commit template for all
    lifecycle events.
  - **Decoupled State Tracking**: Implemented a "decoupled" status tracking
    mechanism. Agents now write lifecycle updates to individual
    `task-state/[ID].json` files to prevent merge conflicts and history
    pollution on the primary sprint branch.
- **Version Bump**: Incremented project version to `2.13.0`.

## [2.12.0] - 2026-03-31

### Added

- **Agent Friction Telemetry**:
  - Introduced a mandatory **Agent Friction Logging** protocol to capture
    consecutive tool validation errors, command execution failures, and prompt
    ambiguities in a per-sprint `agent-friction-log.json` file.
  - Updated the `sprint-setup` workflow to automatically initialize an empty
    JSONL telemetry file during sprint directory creation.
  - Structured logs (Timestamp, Tool, Error, Context) enable systemic auditing
    of agentic "struggle points" to inform protocol and tool refinements.

### Changed

- **Version Bump**: Incremented project version to `2.12.0`.

## [2.11.0] - 2026-03-31

### Changed

- **Playbook Generator Optimizations**:
  - **Transitive Dependency Reduction**: Overhauled `generate-playbook.js` with
    a Floyd-Warshall transitive reduction algorithm. The Mermaid graph and
    task-level `Prerequisite Check` blocks now automatically strip redundant
    edges, significantly reducing visual clutter and agent prompt bloat.
  - **Hardened Standard Sprint IDs**: Enforced strict **3-digit zero-padding**
    (e.g., `040.1.1`) for all task identifiers to ensure deterministic
    alphanumeric sorting across the sprint lifecycle.
  - **Unique Model Fallbacks**: Implemented a mandatory uniqueness constraint
    for task models. If a manifest provides a single model, the generator now
    automatically assigns a diverse second-choice model from a different family
    (e.g., Claude -> Gemini) to prevent rate-limit deadlocks.
  - **Domain Emoji Accuracy**: Fixed session-to-icon mapping logic to correctly
    align `@repo/api`, `@repo/mobile`, and `@repo/web` workspaces with their
    respective legend tokens.
- **Version Bump**: Incremented project version to `2.11.0`.

## [2.10.0] - 2026-03-31

### Added

- **`sprint-setup` Workflow**: Introduced a new automated workflow to handle
  sprint branch creation and directory initialization, resolving race conditions
  during sprint kickoff.
- **Master Planning Orchestration**: Integrated `sprint-setup` as the first
  mandatory step (Step 0) in the `plan-sprint` orchestrator.

### Changed

- **Standardized Sprint Numbering**:
  - Overhauled `generate-playbook.js` to enforce **3-digit padding** (e.g.,
    `sprint-040`) for all directory paths, task IDs, and branch checkouts.
  - Implemented **Robust Directory Resolution** in the generation script to
    gracefully handle both padded and unpadded directory inputs with automatic
    fallback.
- **Version Bump**: Incremented project version to `2.10.0`.

## [2.9.4] - 2026-03-31

### Changed

- **Automated Protocol Maintenance**:
  - **Submodule Refresh**: Integrated a mandatory `.agents` submodule refresh
    step into the `close-sprint` workflow. The terminal sprint agent will now
    automatically pull the latest protocols from the pinned `dist` branch,
    ensuring consistency and cleaning up phantom Git changes.
  - **Playbook Finalization**: Added a terminal step to `close-sprint` to ensure
    the closure task itself is marked as Complete in the playbook and Mermaid
    diagram, providing a 100% finished artifact.
- **Version Bump**: Incremented project version to `2.9.4`.

## [2.9.3] - 2026-03-31

### Changed

- **Hardened Git & Branch Protocols**:
  - **Naming Enforcement**: Standardized the `sprint-[NUM]/[TASK_ID]` branch
    naming convention in `finalize-sprint-task` with explicit instructions to
    use forward slashes, preventing glob discovery failures.
  - **Self-Cleaning Integration**: Added a mandatory "Self-Cleanup" step to the
    `sprint-integration` workflow to ensure the integration task's own feature
    branch is purged after completion.
  - **End-to-End Orchestration**: Linked the `sprint-testing`,
    `sprint-code-review`, and `sprint-retro` workflows to `finalize-sprint-task`
    to ensure bookend tasks correctly push branches and track status.
  - **Catch-All Branch Audit**: Updated `close-sprint` to perform an aggressive
    remote branch scan that catches and deletes branches using non-standard
    naming conventions (e.g., dash-separated instead of slash-separated).
- **Version Bump**: Incremented project version to `2.9.3`.

## [2.9.2] - 2026-03-31

### Changed

- **Hardened Webhook Notifications**:
  - **Cross-Platform Compatibility**: Standardized the `curl` payload syntax in
    `finalize-sprint-task`, `sprint-integration`, and `close-sprint` workflows
    to ensure reliable execution across Bash and PowerShell/CMD.
  - **Increased Visibility**: Injected mandatory notification steps into the
    `sprint-integration` and `close-sprint` workflows to track major sprint
    milestones.
  - **Failure Auditing**: Requirement for agents to log `WEBHOOK_FAILURE.md` in
    the event of network/configuration errors, preventing silent notification
    drops.
- **Version Bump**: Incremented project version to `2.9.2`.

## [2.9.1] - 2026-03-31

### Changed

- **Harden Playbook Generation Logic**:
  - **Categorization Improvements**: Patched `selectIcon` to explicitly support
    `isCloseSprint` (Ops icon) and prioritized DevOps/Infra keyword matching to
    prevent monorepo "Web" mention false-positives.
  - **Regex Security**: Implemented word-boundary (`\b`) matching for all domain
    keywords to prevent accidental substring hits (e.g., "props" triggering
    "ops").
  - **Dual Model Enforcement**: Every task now guarantees both a **First
    Choice** and **Second Choice** model, with intelligent, mode-aware fallbacks
    (Planning -> Pro Low, Fast -> Flash) if the manifest provides only one.
  - **Visual Refinement**: Updated task headers to use a pipe (`|`) delimiter
    for cleaner separation between Mode, First Choice, and Second Choice models.
  - **Sequential Dependency Logic**: Fixed a bug where tasks in a sequential
    group (e.g., `39.1.2`) were missing their predecessor (`39.1.1`) as a
    mandatory prerequisite in the `AGENT EXECUTION PROTOCOL`.
- **Version Bump**: Incremented project version to `2.9.1`.

## [2.9.0] - 2026-03-31

### Added

- **`devops/git-flow-specialist` Skill**: A comprehensive repository health
  skill that centralizes branch safety, base alignment, and conventional commit
  rules. Includes **Emergency Recovery Protocols** for accidental commits to
  main, unresolved merge markers, and diverged branches.
- **`/close-sprint` Workflow**: A new terminal bookend step that promotes the
  sprint branch to `main`, enforces a completeness gate (all tasks must be
  `[x]`), cleans up sprint branches, and runs a final conflict marker scan.

### Changed

- **Hardened Sprint Generation Pipeline**:
  - Updated `generate-playbook.js` to inject a mandatory **Environment Reset**
    step at the start of every task, forcing base branch alignment (Fix 1).
  - Injected `devops/git-flow-specialist` as a mandatory requirement for all
    Integration and Code Review tasks (Fix 4).
  - Added `isCloseSprint` bookend stage to the generation script and task
    manifest schema, ensuring the close-sprint workflow is automatically wired
    as the final step in every sprint playbook.
- **Workflow Guardrails**:
  - `finalize-sprint-task`: Added a **Branch Guard** to prevent accidental
    pushes to `main` (Fix 2) and explicit base branching (Fix 5).
  - `sprint-integration`: Added a mandatory **Conflict Marker Scan** with
    zero-tolerance for residual `<<<<<<<` markers (Fix 3).
  - `verify-sprint-prerequisites`: Added **Branch Validation** to ensure agents
    are on the correct sprint base (Fix 6).
  - **Pre-Commit Hardening**: Integrated mandatory `npm test` execution into the
    Husky pre-commit hook to match GitHub CI standards and prevent regressions.
- **Skill Retirement**: Retired and removed the
  `architecture/conventional-commits-enforcer` skill (consolidated into
  `git-flow-specialist`).
- **Version Bump**: Incremented project version to `2.9.0`.

## [2.8.1] - 2026-03-31

## [2.8.0] - 2026-03-30

### Added

- **Dynamic Mermaid Legend**: The sprint playbook execution flow diagram now
  includes a categorical legend for chat session icons (🗄️ DB, 🌐 Web, 📱
  Mobile, 🧪 Test, 📝 Docs, 🛡️ Ops, ⚙️ Gen).
- **Mandatory Bookend Validation**: Implemented strict persona and skill
  assertions in `generate-playbook.js` for Integration, QA, Code Review, and
  Retro tasks.

### Changed

- **Redefined Chat Icons**: Simplified the chat session icon set to 6 meaningful
  categories with automatic keyword-based selection logic.
- **Improved Dependency Logic**:
  - Reduced redundant prerequisites for sequential tasks within the same Chat
    Session (Linearized `1 -> 2 -> 3` logic).
  - Automated bookend pipeline wiring (Integration → QA → Code Review → Retro)
    in the Mermaid DAG.
- **Hardened Execution Protocol**: Added node-specific Mermaid class
  instructions (e.g., `set the Mermaid class for node C1`) with idempotency
  hints `(if not already)` to prevent state-tracking ambiguity.
- **Version Bump**: Incremented project version to `2.8.0`.

## [2.7.0] - 2026-03-30

### Added

- **Sprint Retro Action Item Capture**:
  - Mandated the capture of action items identified in retrospectives into the
    `roadmap.md` file to ensure they are tracked.
  - Updated the `sprint-retro` workflow step 4 to include sub-tasks for marking
    completed items and capturing new ones.

### Changed

- **Persona Alignment**: Updated the **Product Manager** persona to explicitly
  own the roadmapping of retro action items.
- **Documentation**: Synchronized `SDLC.md` and `README.md` to reflect the full
  end-to-end retrospective process.
- **Version Bump**: Incremented project version to `2.7.0`.

## [2.6.0] - 2026-03-30

### Added

- **Per-Sprint Branch Protocol**:
  - Implemented a standardized branching model where all sprint tasks occur on
    `sprint-N/chat-session-X` branches.
  - Updated `verify-sprint-prerequisites` and `sprint-integration` to support
    the new branch hierarchy.

### Changed

- **SDLC Hardening**: Refined integration and finalization workflows to enforce
  branch naming consistency and dependency across branches.
- **Version Bump**: Incremented project version to `2.6.0`.

## [2.5.1] - 2026-03-30

### Added

- **Shell & Terminal Protocol (Windows Compatibility)**:
  - Introduced a mandatory protocol for Windows (PowerShell) environments to use
    `;` as a statement separator instead of `&&`.
  - Updated `instructions.md` with Section 2: "Shell & Terminal Protocol
    (Windows Compatibility)".
  - Provided clear examples for command chaining (e.g.,
    `git add . ; git commit -m "..."`).

### Changed

- **Version Bump**: Incremented project version to `2.5.1` across
  `package.json`, `.agents/VERSION`, and documentation.

## [2.5.0] - 2026-03-30

### Added

- **4-State Playbook Status Model**:
  - Expanded sprint playbook tracking from 3 states to 4 states to capture the
    full agent task lifecycle:
    - ⬜ **Not Started** (`- [ ]`, `not_started`) — Task hasn't begun.
    - 🟨 **Executing** (`- [~]`, `executing`) — Agent is actively working.
    - 🟦 **Committed** (`- [/]`, `committed`) — Feature branch pushed, awaiting
      integration.
    - 🟩 **Complete** (`- [x]`, `complete`) — Merged/integrated and verified.
  - Introduced amber Mermaid `classDef executing` styling for the new state.
  - Added **Mark Executing** as the first step in every Agent Execution Protocol
    block, injected by `generate-playbook.js`.

### Changed

- **Breaking: Status Contract Migration**:
  - Renamed Mermaid class `in_progress` to `committed` across all playbook
    artifacts.
  - The `- [/]` marker now means "Committed" (branch pushed) instead of the
    previous "In Progress" interpretation.
  - Updated Mermaid legend to display all 4 states.
- **Workflow Updates**:
  - `finalize-sprint-task`: Now transitions Executing → Committed (4-State
    Track). Added a state progression reference table.
  - `sprint-integration`: Updated to transition Committed → Complete, replacing
    the old `in_progress` → `complete` references.
  - `verify-sprint-prerequisites`: Added explicit state reference table
    clarifying that only `[x]` (Complete) satisfies dependencies.
- **Sample Playbook**:
  - Updated golden sample to showcase all 4 states (C1=complete, C2=committed,
    C3=executing, C4-C7=not_started).

## [2.4.0] - 2026-03-30

### Added

- **Golden SDLC Samples**:
  - Introduced a comprehensive `.agents/sample-docs/` directory containing
    benchmark PRDs, Technical Specs, Roadmaps, and Architecture documents.
  - Included a complete "locked-in" Sprint 001 sample with a functional task
    manifest and playbook.

### Changed

- **SDLC Visualization**:
  - Overhauled the core SDLC Mermaid diagram in `SDLC.md` to a Left-to-Right
    (`LR`) layout to better represent chronological phase transitions.
- **Sprint Test Plan Relocation**:
  - Migrated sprint-specific test plans from
    `docs/test-plans/sprint-test-plans/` to a more contextual
    `docs/sprints/sprint-[##]/test-plan.md` location.
  - Updated the `qa-engineer` persona and `sprint-testing`/`qa-audit` workflows
    to adhere to the new directory structure.
- **Documentation Hardening**:
  - Standardized all internal documentation with relative links, replacing
    absolute file system paths.
  - Updated `README.md` and `SDLC.md` to provide clearer onboarding guidance
    referencing the new "Golden Samples."

## [2.3.2] - 2026-03-30

### Fixed

- **Mermaid Default Styling**:
  - Switched from `style default` to an explicit `classDef not_started` model
    for initial node coloring. This ensures all nodes default to light gray
    without creating orphaned "default" nodes in the diagram.
- **Mermaid Script Robustness**:
  - Updated `generate-playbook.js` to automatically assign the `not_started`
    class to every node upon creation.

## [2.3.1] - 2026-03-30

### Fixed

- **Webhook Notification Format**:
  - Refined the `finalize-sprint-task` workflow to explicitly require a JSON
    payload with a `message` parameter, ensuring compatibility with Make.com
    webhooks.

### Changed

- **UI Simplification**:
  - Removed redundant "💬" chat emoji from Chat Session headers and Mermaid
    diagram labels for a cleaner, professional look.

## [2.3.0] - 2026-03-30

### Added

- **Feature Branching & 3-State Tracking**:
  - Implemented a zero-conflict Git orchestration model using isolated feature
    branches for concurrent Chat Sessions.
  - Introduced **3-State Playbook Tracking**: Tasks now transition from Pending
    (`- [ ]`) to Pushed/Ready (`- [/]`) and finally to Complete (`- [x]`).
  - Added **Real-time Progress Visualization**: Automated blue (`in_progress`)
    and green (`complete`) highlighting for Mermaid diagram nodes in the
    playbook.
- **Sprint Integration Workflow**:
  - Added a new automated `isIntegration` bookend task that merges feature
    branches and performs bulk playbook state synchronization before QA.

## [2.2.1] - 2026-03-30

### Added

- **Strict Dependency Rules**:
  - Updated JSON Schema and workflow documentation to strictly mandate
    direct-only dependencies, preventing transitive bloat in the playbook.
- **Bookend Optimization**:
  - Added persona and skill guidance specifically for the automated QA, Code
    Review, and Sprint Retrospective bookend sessions.

## [2.2.0] - 2026-03-30

### Added

- **Explicit Dependency Injection**:
  - The playbook generation script now deterministically tracks dependent task
    numbers and injects them precisely into the `AGENT EXECUTION PROTOCOL`.
  - Added a self-referencing `Playbook Path` header to the top of every
    generated playbook for easier agent discovery.
- **Dynamic Prerequisite Logic**:
  - Tasks with no dependencies now automatically omit the "Prerequisite Check"
    step to streamline execution prompts.
- **Expanded Bookend Tracking**:
  - Split the "Code Review & Retro" session into two dedicated Chat Sessions:
    `Code Review` (Sequential) and `Sprint Retrospective` (PM-led, always last).

### Changed

- **Workflow Simplification**:
  - Moved detailed dependency verification logic into the
    `verify-sprint-prerequisites` workflow, reducing prompt bloat in the
    playbook.
  - Added repository `scope` annotations to Sequential sessions (not just
    Concurrent ones) to ensure clear boundary enforcement.
  - Manifest schema now allows omitting `instructions` for bookend tasks (QA,
    Review, Retro) since they use auto-injected workflow commands.
- **Topological Sorting Improvements**:
  - Dependencies are now sorted numerically in task prompts for better
    scannability.

## [2.1.1] - 2026-03-30

### Added

- **Graceful "Technical Chore" Fallbacks**:
  - Updated `prd-template.md` and `technical-spec-template.md` to officially
    support `(N/A - Technical Operations Chore)` or `None required` for purely
    technical/backend sprints. This prevents LLM hallucinations in non-UI tasks.

### Changed

- **Strict Playbook Formatting**:
  - Updated `task-manifest.schema.json` to mandate `\n-` markdown list
    formatting for task instructions.
  - Updated `generate-sprint-playbook` workflow to enforce bulleted instruction
    scoping for better agent readability.
- **Robust Path Handling**:
  - Fixed `generate-playbook.js` to preserve leading zeros in sprint numbers
    (e.g., `037`) when resolving directory paths.

## [2.1.0] - 2026-03-30

### Added

- **Script-Assisted Playbook Generation**:
  - Introduced `.agents/scripts/generate-playbook.js`, a deterministic Node.js
    script to generate sprint playbooks from a structured JSON manifest.
  - Introduced `.agents/schemas/task-manifest.schema.json` to define the
    contract for playbook generation.
  - Updated `generate-sprint-playbook` workflow to use the new two-phase
    generation pipeline (JSON manifest output -> script execution).
  - Added automated topological sorting for task dependencies and intelligent
    chat session grouping by workspace scope.
  - Added comprehensive unit tests for the playbook generation logic.

### Changed

- **Submodule Distribution Alignment**: Moved the playbook generation script
  into the `.agents/` directory to ensure it is correctly distributed to
  consumer projects via git submodules.
- **Workflow Improvements**: Updated `generate-sprint-playbook` and
  `sprint-playbook-template` to support the new generation model and provide
  better execution rule guidance.

## [2.0.0] - 2026-03-29

### Major Architectural Overhaul

- **Persona Expansion (12-Role Architecture)**:
  - Expanded from 4 to 12 specialized personas to eliminate role conflation:
    `architect`, `engineer`, `engineer-web`, `engineer-mobile`, `product`,
    `ux-designer`, `qa-engineer`, `devops-engineer`, `sre`, `security-engineer`,
    `technical-writer`, and `project-manager`.
  - **Automatic Referral Protocol**: Standardized **Scope Boundaries** across
    all personas, enabling agents to automatically detect out-of-scope tasks and
    switch to the appropriate persona without user intervention.

- **Structured Configuration Centralization**:
  - Created a dedicated `.agents/config/` directory to house all JSON
    configuration files.
  - **Model Selection (`.agentrc.json`)**: Extracted model tiers and chaining
    logic for better maintainability.
  - **Tech Stack (`.agentrc.json`)**: Extracted all project-specific technology
    references (ORM, DB, API, UI, etc.) to ensure protocol portability across
    different tech stacks.
  - **Agent Config (`.agentrc.json`)**: Centralized operational limits and
    auto-run permissions.

- **Expanded Sprint Lifecycle**:
  - Introduced mandatory **Sprint Code Review** (Chat Session 5) and **Sprint
    Retrospective** (Chat Session 6) into the core workflow.
  - Added 6 new internal sprint workflows: `gather-sprint-context`,
    `verify-sprint-prerequisites`, `finalize-sprint-task`, `sprint-testing`,
    `sprint-code-review`, and `sprint-retro`.

- **Generic & Portable Templates**:
  - Refactored `technical-spec-template.md` and `prd-template.md` to be
    tech-agnostic, dynamically pulling project details from `.agentrc.json`.
  - Standardized `Output Artifacts` sections across all personas for consistent
    artifact ownership.

### Documentation

- **README Overhaul**: Updated `.agents/README.md` and root `README.md` to
  reflect the new 12-persona structure, categorized workflows table, and
  centralized config folder.

## [1.13.5] - 2026-03-29

### Workflow Enhancements

- **Agent Notification Webhook**:
  - Updated the `generate-sprint-playbook` workflow to include a mandatory
    notification step in the `AGENT EXECUTION PROTOCOL`.
  - Agents will now attempt to call a webhook URL defined as
    `AGENT_NOTIFICATION_WEBHOOK` in the `AGENTS.md` file upon completing a
    sprint step.
  - Implemented graceful failure logic if the variable is not set.

## [1.13.4] - 2026-03-29

### Workflow Enhancements

- **Enhanced Model Selection Guidance**:
  - Overhauled the `generate-sprint-playbook` workflow with detailed model
    personas (Architects, Workhorses, Sprinters, Specialists).
  - Introduced explicit **Planner-Executor-Reviewer** chaining logic to optimize
    agentic performance across Claude 4.6 and Gemini 3.1 models.
  - Added specific guidance for utilizing **Opus (Thinking)** as an escalation
    model and **Flash** for the "inner loop" of development.

## [1.13.3] - 2026-03-28

### Workflow Enhancements

- **Standardized Sprint Retrospectives**:
  - Introduced `.agents/templates/sprint-retro-template.md` to ensure
    consistent, metric-driven retrospectives.
  - Updated the `generate-sprint-playbook` workflow (via
    `sprint-playbook-template.md`) to explicitly mandate retro generation using
    the new template.
  - Standardized retro sections for Scorecard, Architectural Debt, and Action
    Items.

## [1.13.2] - 2026-03-27

### Workflow Enhancements

- **Sprint Test Plan Customization**: Updated `generate-sprint-playbook` to
  ensure sprint-specific test plans are stored in the
  `test-plans/sprint-test-plans/` folder instead of the generic
  `docs/test-plans/` directory.
- **Improved QA Persona Alignment**: Enhanced the QA Automation Engineer persona
  instructions to strictly use sprint-numbered test plan filenames.

## [1.13.1] - 2026-03-27

### Workflow Enhancements

- **Audit Output Standardization**: Standardized all audit workflows to append
  `-results.md` to their output filenames (e.g., `sre-audit-results.md`,
  `accessibility-audit-results.md`).
- **Improved Contextual Clarity**: Updated documentation to reflect these new
  output patterns, ensuring agents produce consistently named artifacts across
  all audit types.

## [1.13.0] - 2026-03-27

### Protocol Refinements

- **Concurrent Sprint Prerequisite Logic**:
  - Overhauled the `generate-sprint-playbook` workflow to correctly handle
    Fan-Out (concurrent) chat sessions.
  - Replaced the ambiguous "previous chats" check with explicit mandatory
    dependency lists in task templates.
  - Updated the `AGENT EXECUTION PROTOCOL` to eliminate out-of-order execution
    blocks in parallel development tracks (e.g., Web vs. Mobile).

## [1.12.0] - 2026-03-26

### Protocol Hardening

- **Improved Sprint Playbook Generation**:
  - Moved the `AGENT EXECUTION PROTOCOL` to the top of task blocks for improved
    agent visibility and adherence.
  - Introduced a mandatory **Sample Data Maintenance** step for Chat Session 4
    (QA) to ensure dev data (seeds, mocks) stays in sync.
  - Strengthened protocol language to strictly enforce prerequisites and state
    updates.

## [1.11.0] - 2026-03-26

### Refinements & Standardization

- **Audit Workflow Harmonization**: Synchronized 7 new audit workflows with the
  standardized `devops-audit` and `qa-audit` structure. All audits now include
  mandatory Dimension/Category, Impact, Current State, Recommendation, and
  copy-pasteable **Agent Prompts** for safe remediation.
- **Improved Read-Only Guardrails**: Reinforced the non-mutating nature of audit
  workflows to ensure purely diagnostic behavior.

### Fixes

- **ESLint Compliance**: Resolved `no-console` warnings in the `athlete-portal`
  scripts (specifically `self-healing-agent.ts`) that were blocking Husky
  pre-commit hooks.

## [1.10.0] - 2026-03-26

### Workflow Enhancements

- **Audit & Automation Expansion**: Introduced 7 new comprehensive workflows:
  - `privacy-audit`: Data privacy and PII compliance checking.
  - `clean-code-audit`: Maintainability and technical debt analysis.
  - `security-audit`: Vulnerability scanning and OWASP alignment.
  - `performance-audit`: Deep architectural and stack-wide bottleneck analysis.
  - `generate-release-notes`: Automated synthesis of git commits into
    user-facing changelogs.
  - `dependency-update-audit`: Security and bloat auditing for modern package
    managers.
  - `ux-ui-audit`: Design system consistency and UX best-practice reviews.

### Domain Skills

- **Ecosystem Expansion**: Added 14 new foundational skills to the
  `.agents/skills/` directory:
  - **Frontend**: `astro`, `tailwind-v4`, `google-analytics-v4`.
  - **Backend**: `cloudflare-workers`, `turso-sqlite`, `clerk-auth`,
    `stripe-payments`, `highlevel-crm`.
  - **QA**: `vitest`, `playwright`, `accessibility-audit`.
  - **Architecture**: `subagent-orchestration`, `structured-output-zod`,
    `markdown`.

## [1.9.0] - 2026-03-25

### Workflow Enhancements

- **Hardened Test Execution**: Updated `run-test-plan` workflow to prevent
  repository mutations:
  - Mandated the creation of a local `*-RESULTS.md` copy for all test results
    instead of inline updates to original files.
  - Explicitly prohibited automatic commits, staging, or check-ins of test
    results or temporary scripts.
  - Enforced strict local-only persistence for artifact review.

## [1.8.0] - 2026-03-25

### Workflow Enhancements

- **Protocol & Formatting Hardening**: Overhauled `generate-sprint-playbook` to
  enforce strict output standards:
  - Introduced the **"No Outer Wrapper"** rule, mandating raw Markdown output
    instead of fenced code blocks for the entire playbook.
  - Implemented the **"No-Summarization Rule"** to ensure the
    `AGENT EXECUTION PROTOCOL` is copied word-for-word into every task without
    modification.
  - Standardized **Chat Session Headers** with sequence indicators and icons.
  - Integrated a required **Mermaid diagram** into the playbook template to
    visualize the Fan-Out architecture.
  - Refined task scoping and template structure for improved agent readability.

## [1.7.0] - 2026-03-25

### Workflow Enhancements

- **Integrated QA Lifecycle**: Hardened `generate-sprint-playbook` by coupling
  test plan generation with execution:
  - Mandated a dedicated Chat Session (Session 4) for updating
    `docs/test-plans/*.md` with new features before running them.
  - Expanded the **QA Automation Engineer** persona to include manual test plan
    authoring and documentation tasks.
  - Defined explicit **Dual-Purpose Testing** standards (semantic locators and
    SQL assertions) for robust validation.
  - Refined model routing to prefer **Claude Sonnet 4.6 (Planning)** for
    producing high-quality QA documentation.

## [1.6.0] - 2026-03-25

### Workflow Enhancements

- **Fan-Out Architecture**: Overhauled `generate-sprint-playbook` with a robust
  multi-agent orchestration model:
  - Introduced explicit Chat Session modeling (Backend, UI, QA, Retro) for
    parallelized agent execution and data contract locking.
  - Added strict Model Routing and Persona Assignment rules to optimize for
    specialized task execution.
  - Implemented a mandatory `Agent Execution Protocol` within task templates to
    enforce dependency checking, state updates, and hook-based validation.
  - Standardized QA tasks to leverage existing test plans via `/run-test-plan`
    instead of ad-hoc test generation.

## [1.5.0] - 2026-03-25

### Core Improvements

- **Sprint Playbook Checks**: Introduced mandatory prerequisite validation and
  final sprint audits:
  - Added `PREREQUISITE CHECK` to all playbook task templates to prevent
    out-of-order execution.
  - Added `FINAL SPRINT AUDIT` to the retro workflow to verify completion
    against PRDs.
  - Updated `generate-sprint-playbook` to explicitly list task dependencies.
- **Update Documentation**: Restored comprehensive submodule update strategies
  (Bash, PowerShell, and `package.json`) to the root `README.md` and
  de-duplicated the `.agents/README.md` user guide.

## [1.4.1] - 2026-03-25

### Fixes

- **Slash Command Discovery**: Flattened the `workflows/` directory back to the
  root level. This restores native Antigravity IDE auto-registration for all `/`
  commands which was inadvertently broken by subdirectory categorization in
  v1.3.0.
- **CI/CD Validation**: Hardened the `dist` branch publication process to
  strictly validate the presence of the new `rules/` and `.agentrc.json` files.

## [1.4.0] - 2026-03-25

### Core Improvements

- **Modular Global Rules**: Introduced the `.agents/rules/` directory containing
  foundational, domain-agnostic standards:
  - `git-conventions.md`: Conventional Commits and branch naming.
  - `api-conventions.md`: JSON formatting, error shapes, and status codes.
  - `testing-standards.md`: Arrange-Act-Assert patterns and naming.
  - `database-standards.md`: Naming conventions and soft-deletion policies.
  - `security-baseline.md`: Zod validation and PII protection.
  - `ui-copywriting.md`: Sentence case and empathetic tone guidelines.
- **Local Overrides**: Added support for `.agents/instructions.local.md` and
  `config.local.json` to allow personal developer preferences.
- **Structured Config**: Introduced `.agents/.agentrc.json` for programmatic
  agent guardrails.

### Documentation

- **User Guide Updates**: Documented the new rules and localization features in
  `.agents/README.md`.
- **System core**: Updated `instructions.md` to bootstrap the new rules and
  config system.

## [1.3.0] - 2026-03-25

### Core Improvements

- **Structural Organization**: Categorized all `skills` (into `frontend`,
  `backend`, `security`, `qa`, `architecture`) and `workflows` (into `audits`,
  `sdlc`, `testing`) to support future expansion.

### Documentation

- **User Guide Updates**: Overhauled `.agents/README.md` with new directory
  structures and categorized tables for skills and workflows.
- **Instructional Updates**: Updated `.agents/instructions.md` to support the
  new categorized skill paths.

## [1.2.0] - 2026-03-25

### Documentation

- **Personal Stack**: Added details on the agent-first personal development
  stack (Google AI Ultra, Antigravity IDE, Wispr Flow) in the root `README.md`.

## [1.1.1] - 2026-03-25

### Core Improvements

- **Workflow Renaming**: Standardized sprint planning workflows from `plan-*` to
  `generate-*` for clarity.
- **Git Integration**: Added mandatory git commit steps to all sprint playbook
  tasks to ensure progress is saved and pre-commit hooks are enforced.

## [1.1.0] - 2026-03-25

### Key Improvements

- **Automated Sprint Planning**: Restructured `SDLC` folder into automated
  `/plan-sprint` workflows.
- **Consolidated Instructions**: Merged `system-prompt.md` into
  `instructions.md` for a single system core.
- **Streamlined Structure**: Flattened `.agents/` directory by moving templates
  to root.

## [1.0.0] - 2026-03-25

### Initial Release

- **Initial Stable Release**: Standardized Agent Protocols for LLM-based coding
  assistants.
- **Global Instructions**: Foundational rules for context-first, plan-first, and
  security-first agent behavior.
- **Persona System**: Role-specific constraints for AI agents (Architect,
  Engineer, Product, SRE).
- **Domain Skills**: Modular tech-stack guardrails (SQLite/Drizzle, Cloudflare
  Workers, Astro, Expo, etc.).
- **SDLC Workflows**: Standardized sprint planning, PRD, and technical spec
  templates.
- **Slash Command Audits**: Integrated workflows for accessibility,
  architecture, devops, and SRE reviews.
- **Consumer Distribution**: Submodule-based delivery via the `dist` branch.
- **Cross-Platform Support**: Added PowerShell compatibility for manual
  submodule update commands.

---

## Appendix: Version History Summaries (from roadmap.md)

The following summaries were previously maintained in `docs/roadmap.md` and are
archived here for historical reference.

### Version 4.x — Autonomous Efficiency & Scalability

- ✅ **Agentic Plan Caching (APC):** Test-time memory architecture to extract
  structured intent from successful executions, bypassing expensive generative
  dependencies for semantically similar tasks.
- ✅ **Speculative Execution & Cache-Aware Scheduling:** Global prompt cache
  mapping deterministic operation inputs to previously computed outputs.
- ✅ **Perception-Action Event Stream:** Decoupled core logic from the
  environment via an event-stream abstraction where agents read history and
  produce atomic actions.
- ✅ **Isolated Multi-Agent Parallelization**: Eliminated Git lock race
  conditions during concurrent executions via `git worktree` isolation.
- ✅ **Strict Workflow Patterns**: Integrated Evaluator-Optimizer and Prompt
  Chaining pattern enforcement into the core orchestration loop.
- ✅ **Cryptographic Provenance:** Digitally signed agent-generated test
  receipts via asymmetric PKI for immutable chain of custody.
- ✅ **Universal Protocol Standardization:** Merged all agent configuration into
  a unified `.agentrc.json` standard at the project root.

### Version 3.x — Optimization & Refinement

- ✅ **Exploratory Testing Integration**: Enhanced `sprint-testing` with
  mandatory exploratory step and configurable command.
- ✅ **Context Caching Prompt Architecture**: Restructured playbook execution
  prompts to separate static rules from volatile task state for LLM API caching.
- ✅ **Automated Context Pruning ("Gardener")**: Background archiving workflow
  to curate stale patterns into `docs/archive/`.
- ✅ **Dynamic Context Boundaries (Local RAG)**: Zero-dependency TF-IDF engine
  for semantic retrieval and context gathering.
- ✅ **FinOps & Token Budgeting**: `maxTokenBudget` with soft-warning and
  hard-stop protocols.
- ✅ **Zero-Touch Remediation Loop**: Automatic transition from failed
  integration to hotfix loop.
- ✅ **Dynamic Golden-Path Harvesting (Agentic RLHF)**: Automated harvesting of
  zero-friction instruction-to-diff mappings for few-shot prompt reinforcement.
- ✅ **Semantic Risk & Blast-Radius Gates**: AI-driven semantic classification
  of destructive operations and architectural anomalies.
- ✅ **Adversarial Red-Teaming (Tribunal)**: On-demand `/run-red-team` workflow
  for high-assurance code hardening.
- ✅ **Self-Healing Protocols (Retro-Augmentation)**: Agent-ready optimization
  snippets generated from friction logs.
- ✅ **Granular HITL Gates**: `riskGates` keyword scanning during planning for
  mandatory human approval.
- ✅ **Global Telemetry Reporting (Observer MVP)**: `aggregate-telemetry.js` for
  structured macroscopic reports on efficiency and tool failures.

### Version 2.x — Continuous Evolution

- ✅ **Hybrid Integration & Blast-Radius Containment**: Ephemeral integration
  candidates and `/sprint-hotfix` workflows.
- ✅ **Advanced Concurrency Protocols**: `focusAreas` for static prediction of
  high-risk file overlaps and runtime rebase wait-loop.
- ✅ **Shift-Left Agentic Testing**: Pre-merge testing on feature branches with
  cryptographic-like test receipts.
- ✅ **Decoupled Task State Tracking**: Migrated from Git-tracked playbook
  checkmarks to decoupled JSON state files.
- ✅ **Passive Telemetry & Diagnostic Tools**: `diagnose-friction.js` for
  failing command interception and auto-remediation.
- ✅ **Framework Handshakes**: Hardened personas to explicitly require ruleset
  ingestion before code execution.

### Version 1.x — Foundations

- ✅ **Core Architecture**: Standardized framework including Global
  Instructions, Persona constraints, and domain-specific Skills.
- ✅ **Automated Sprint Planning Pipeline**: Deterministic generation of PRDs,
  Technical Specs, and Playbooks via slash commands.
- ✅ **Fan-Out Orchestration**: Multi-agent parallel execution via distinct Chat
  Sessions.
- ✅ **Modular Global Rules**: Domain-agnostic standards for Git, APIs,
  databases, and UI copywriting.
- ✅ **Submodule Distribution**: `dist` branch mechanism for consumer
  consumption.
