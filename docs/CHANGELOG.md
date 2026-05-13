# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

The next release will be **v6.0.0** — the Mandrel rebrand + breaking-change
cut (Epic #1184). All pre-v6 history (v1.x – v5.41.x) is consolidated into
[`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md). The live
changelog starts at v6 — there are no v5.x entries below.

### Added (Epic #1185 — Dispatch performance pass — model hints + parallelism conventions)

Four additive, opt-in surfaces ship together. **All four are optional and
non-breaking** — every consumer of the affected schemas, skills, and
helpers keeps working unchanged when none of the new fields are set.

1. **Workflow frontmatter — optional `recommendedModel` field.** Skill
   authors can hint at the model class best suited for a workflow (`haiku`
   | `sonnet` | `opus`). Consumers that ignore the field behave exactly as
   before; the dispatcher reads it as a non-binding suggestion only.

2. **Workflow frontmatter — optional `dispatchModel` field.** Skill
   authors can pin the dispatch-time model class for a workflow's
   sub-agent calls (same enum). Absent → dispatcher falls back to its
   existing default. No schema field becomes required.

3. **`.agents/workflows/helpers/parallel-tooling.md` convention.** A new
   helper documents the canonical "fan out independent tool calls in a
   single assistant turn" pattern audit-\* skills reference inline. Pure
   documentation; no runtime contract change.

4. **`audit-fan-out` skill.** A new audit workflow that demonstrates the
   parallel-tooling convention end-to-end. Opt-in: only invoked when an
   operator runs `/audit-fan-out` (or a future audit driver enumerates
   it); no existing skill is altered.

5. **`epic-perf-report` schema — optional `dispatchModel` on per-Story
   records.** `mostFrictionStories[]` items may now carry an optional
   `dispatchModel` enum (`haiku` | `sonnet` | `opus`). The field is
   omitted entirely (never `null`) when absent so pre-Epic payloads remain
   byte-identical to the pre-#1185 shape. `perf-aggregator.js`
   propagates the value through from the per-Story summary when present
   and ignores invalid strings. Story #1178's calibration estimator can
   bucket by model once the upstream signal carries the hint.

See PRD #1276, Tech Spec #1277, and Stories #1326–#1329 for the full
rollout.

### Changed (Epic #1178 — Decomposition + manifest sharpening)

Four breaking changes ship as a coordinated cut. Hard cut — no aliases, no
back-compat shims. Consumer `.agentrc.json` files must be updated in
lockstep; the schema and validator reject the legacy shapes.

1. **Concurrency caps flatten to `orchestration.concurrency.*`.** The three
   independent "concurrency" sites (`runners.decomposer.concurrencyCap`,
   `runners.epicRunner.concurrencyCap` / `runners.deliverRunner.concurrencyCap`
   after Epic #1142, and `runners.concurrency.{waveGate, commitAssertion,
   progressReporter}`) collapse into one flat namespace. The schema drops
   `runners.decomposer`, `runners.concurrency`, and the `concurrencyCap`
   property on `runners.deliverRunner`; consumer reads now go through
   `resolveConcurrency(orchestration)` against the flat block exclusively.

   ```jsonc
   // before — three separate sites called "concurrency"
   {
     "orchestration": {
       "runners": {
         "decomposer": { "concurrencyCap": 3 },
         "deliverRunner": {
           "enabled": true,
           "concurrencyCap": 3,
           "progressReportIntervalSec": 120
         },
         "concurrency": {
           "waveGate": 0,
           "commitAssertion": 4,
           "progressReporter": 8
         }
       }
     }
   }
   ```

   ```jsonc
   // after — one flat block under orchestration
   {
     "orchestration": {
       "runners": {
         "deliverRunner": {
           "enabled": true,
           "progressReportIntervalSec": 120
         }
       },
       "concurrency": {
         "decomposer": 3,
         "deliverRunner": 3,
         "waveGate": 0,
         "commitAssertion": 4,
         "progressReporter": 8
       }
     }
   }
   ```

2. **New `sizingProfile` field on dispatch-manifest Task bodies.** Tasks that
   touch more files than `agentSettings.planning.taskSizing.softFileCount`
   (default 3) must declare a `sizingProfile` so the validator can tell a
   justified wide Task (`mechanical-sweep`, `atomic-rewrite`, `scaffolding`)
   from an over-stuffed one. Narrow Tasks omit the field freely.

   ```jsonc
   // before — width passed silently; an unjustified 8-file Task validated
   {
     "kind": "task",
     "title": "rewrite-six-docs-and-add-ripgrep-test",
     "changes": [/* 7 file entries */],
     "acceptance": [/* 4 items */]
   }
   ```

   ```jsonc
   // after — width must be justified or the validator rejects the Task
   {
     "kind": "task",
     "title": "rename-settings-to-agent-settings-across-consumers",
     "sizingProfile": "mechanical-sweep",
     "changes": [
       { "path": "consumers/**/*.{ts,js}", "summary": "rename settings → agentSettings" }
     ],
     "acceptance": [
       "ripgrep \"\\bsettings\\b\" returns zero matches under consumers/"
     ]
   }
   ```

3. **New `agentSettings.planning.taskSizing` config block.** The validator's
   hard ceilings and soft signals are now project-tunable. Defaults match
   the Epic's design (6 acceptance items, 8 changes entries, 3 files as the
   `sizingProfile` threshold). Hard ceiling violations (`maxAcceptance`,
   `maxChanges`) and missing `sizingProfile` on wide Tasks emit structured
   `oversized-task` / `missing-sizing-profile` findings that the
   re-decomposition loop in `epic-plan-decompose` consumes (bounded retry,
   default 2 attempts). Soft heuristic violations (`softFileCount`,
   `softAcceptanceCount`) report as planning warnings only — they never
   trigger re-prompt.

   ```jsonc
   // before — limits hard-coded inside ticket-validator.js, no override
   {
     "agentSettings": {
       "planning": {
         "riskHeuristics": [/* … */]
       }
     }
   }
   ```

   ```jsonc
   // after — limits live in config, sensible defaults preserved
   {
     "agentSettings": {
       "planning": {
         "riskHeuristics": [/* … */],
         "taskSizing": {
           "maxAcceptance": 6,
           "maxChanges": 8,
           "softFileCount": 3,
           "softAcceptanceCount": 4
         }
       }
     }
   }
   ```

4. **Dispatch manifest collapses to a single nested Wave → Story → Task
   layout.** The legacy three-section split (`## Wave Summary` aggregates +
   `## Execution Plan` per-wave story tables + `## Story Details` prose) is
   gone. The new layout flows: Sprint summary → dashboard TOC table with
   anchor links to each wave H2 → inline legend blockquote → per-wave H2
   sections that nest Stories (with branch + per-Story progress bar +
   estimate placeholder) and Tasks (native `- [ ]` markdown checkboxes in
   execution order with `*(after #N)*` dependency callouts). A per-wave
   "Decomposition notes" subsection surfaces inferred file-contention edges
   when the analyzer's static file-path scan adds edges beyond what the LLM
   declared in `focusAreas`. Operating Procedures and the symbol legend
   collapse into a single bottom `<details>` block — the only HTML in the
   document. Pure markdown elsewhere preserves GitHub's native sub-issue /
   task-list rollup.

   ```markdown
   <!-- before — three disjointed sections describing the same Stories -->
   ## Wave Summary

   | Wave | Stories | Tasks |
   | :--- | :--- | :--- |
   | 0 | 3 | 8 |

   ## Execution Plan

   ### Wave 0
   | Story | Branch | Status |
   | :--- | :--- | :--- |
   | #1152 | story-1152 | Ready |

   ## Story Details

   ### Story #1152 — epic-plan-ideation-mode
   Tasks: #1160, #1162 (depends on #1160).
   ```

   ```markdown
   <!-- after — single nested flow, anchor TOC, native checkboxes -->
   ## Wave Summary

   | Wave | Status | Progress | Stories | Tasks |
   | :--- | :--- | :--- | :--- | :--- |
   | [Wave 0](#-ready-wave-0) | 🚀 Ready | ░░░░░░░░ 0% | 0/3 | 0/8 |

   > **Legend:** ⬜ not started · 🔄 in progress · 🚧 blocked · ✅ done

   ## 🚀 Ready Wave 0

   > **Decomposition notes:** inferred file-contention edge added between
   > #1153 and #1164 (both modify `.agents/workflows/epic-deliver.md`)

   > 3 stories · 0/8 tasks (0%) · ✅ 3 stories can run in parallel

   ### ⬜ #1152 — epic-plan-ideation-mode · `story-1152` · ░░░░░░░░░░ 0% · ~?

   - [ ] #1160 — wire-idea-refinement-skill-into-epic-plan
   - [ ] #1162 — render-epic-body-from-one-pager *(after #1160)*

   <details>
   <summary>🤖 Agent Operating Procedures &amp; symbol reference</summary>
   …
   </details>
   ```

   The end-to-end fixture in
   `tests/lib/presentation/manifest-formatter-end-to-end.test.js` is the
   canonical regression: it renders a synthetic Epic exercising every
   Acceptance-Criteria item in the PRD's Manifest-rendering section
   (anchor-link round-trip, decomposition-notes subsection, dispatch-round
   columns, single-`<details>`-block invariant, native checkbox rendering,
   per-Story progress bar + estimate placeholder).

### Removed

- **Bot approver, auto-triage, auto-fix, and baseline-refresh-guardrail
  CI jobs removed.** Epic #1235's "hands-off PR pipeline" was generating
  more friction than it removed: the bot approver depended on a GitHub
  App identity the operator had to provision and rotate, the auto-fix
  loop's `[auto-fix]` commit + bot-approver self-check produced a
  cascade of post-merge push-hook failures, the baseline-refresh
  guardrail flapped on every benign baseline edit, and the triage
  comment duplicated information the operator already gets from
  `gh run view --log-failed`. The replacement is a Phase 7
  watch-and-iterate loop inside `/epic-deliver` that polls
  `gh pr checks --watch` and drives the open PR to green via local
  fixes — see [`.agents/workflows/epic-deliver.md`](../.agents/workflows/epic-deliver.md).
  Deletions:
  - `.github/workflows/{bot-approve,auto-fix,triage-pr-failure,baseline-refresh-guardrail}.yml`
  - `.agents/scripts/{auto-fix-step,auto-fix-bail,triage-ci-failure,baseline-refresh-guardrail}.js`
  - `.agents/scripts/lib/auto-fix/`, `.agents/scripts/lib/triage/`,
    `.agents/scripts/lib/bootstrap/workflow-templates.js`
  - `.agents/templates/scripts/`, `.agents/templates/workflows/`
  - `tests/auto-fix/`, `tests/triage/`,
    `tests/baseline-refresh-guardrail.test.js`,
    `tests/bootstrap/workflow-templates.test.js`
  - `.github/ruleset.json` — `pull_request` rule
    (`required_approving_review_count: 1`) removed. The live ruleset
    must be re-PUT to match: `gh api -X PUT
    repos/:owner/:repo/rulesets/14286998 --input .github/ruleset.json`.
    `BOT_APPROVER_APP_ID` / `BOT_APPROVER_PRIVATE_KEY` secrets become
    orphan and should be deleted from the repo settings UI; the
    `agent-protocols-reviewer` GitHub App can be suspended or deleted.
  - `agents-bootstrap-github` no longer copies CI workflow templates
    into consumer repos (`copyWorkflowTemplates` import and call site
    removed from `.agents/scripts/agents-bootstrap-github.js`).

### Changed

- **Tasks close at commit-time; Story stays `agent::executing` until merge.**
  `story-task-progress.js --state done --commit-sha <sha>` now flips the
  Task ticket to `agent::done` and closes the GitHub issue immediately
  rather than waiting for `story-close.js` to batch all child Tasks
  post-merge. Cascade is suppressed (`cascade: false` on
  `transitionTicketState`, a new opt that defaults to `true` for
  backward-compat) so closing the last Task of a Story does not
  auto-close the Story before its branch is merged into the Epic. The
  post-merge `ticketClosurePhase` batched closer is unchanged and stays
  idempotent against the commit-time closes via
  `batchTransitionTickets`'s already-`agent::done` short-circuit.

- **Mid-Story `/story-execute` resume skips already-closed Tasks.**
  `story-task-progress.js --state executing` now short-circuits with
  `{ ok: true, skip: true, reason: 'task-already-complete-and-reachable' }`
  when the Task is already `agent::done` AND its recorded `commitSha`
  is reachable from the current Story branch's `HEAD`. The workflow loop
  reads `skip` and advances to the next Task instead of bouncing off
  `task-commit.js`'s empty-diff guard. A Task labeled done whose commit
  is missing from `HEAD` (reset, force-push, branch loss) is NOT skipped
  — it re-runs.

- **`epic-complete` webhook deferred to PR-ready.** The fire moved out of
  `epic-execute-record-wave.js` (post-final-wave / pre-finalize) into
  `epic-deliver-finalize.js`, called immediately after `gh pr create`
  succeeds. Operators no longer get an "Epic complete" ping minutes
  before the PR exists; the new payload also carries `prUrl` and embeds
  it in the message so the notification is clickable. The legacy
  dispatcher path's own duplicate webhook fire
  (`epic-lifecycle-detector.js`) is removed for the same reason; the
  operator-visible comment on the Epic ticket is preserved.

- **Maintainability tolerance default raised 0.001 → 0.5; configurable.**
  The MI gate was using a near-zero noise floor, so the routine ±0.05–0.3
  drift introduced by Node-version churn / `escomplex` / `typhonjs-escomplex`
  internals triggered a "regression" on every PR. The pre-push hook would
  then auto-ratchet `baselines/maintainability.json`, the
  `baseline-refresh-guardrail` would see an unlabeled baseline edit and
  fail the PR, and the dev had to manually carve a separate
  `baseline-refresh:`-tagged commit. The new default is 0.5 — well below
  "actually less maintainable" but above typical noise. Projects can
  override via `agentSettings.quality.maintainability.tolerance` in
  `.agentrc.json`; CI can still force a value via the existing
  `CRAP_TOLERANCE` env var (the guardrail's base-branch-config replay path
  is unchanged). This project sets `tolerance: 0.5` explicitly so the
  intent is auditable in `.agentrc.json`. Resolver precedence:
  `CRAP_TOLERANCE` env → `quality.maintainability.tolerance` config →
  default.

### Removed

- **Windows CI leg removed.** The `windows-latest` runner in
  `.github/workflows/ci.yml` was producing repeated c8/timing
  coverage flap with no corresponding source defects, forcing per-PR
  `baseline-refresh:` ratchets on otherwise-unchanged files. Since the
  maintainer runs Windows locally, the pre-push hook is already the
  real Windows gate. Removed from the workflow matrix and from the
  live ruleset `14286998` required-status-checks set (only the Ubuntu
  leg is now required). The `.github/ruleset.json` artifact tracks the
  new shape. See #1267 for the per-OS baseline plan if Windows-leg CI
  is reinstated later.
