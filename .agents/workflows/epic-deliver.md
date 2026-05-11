---
description: >-
  Drive an Epic from `agent::ready` to a merged pull request against `main`.
  The nine-phase flow runs the wave loop, close-validation, code-review, retro,
  finalize, watch-and-iterate, conditional auto-merge, and local branch
  cleanup. When the run is end-to-end clean (zero manual interventions, zero
  🔴/🟠 review findings, compact retro) the PR auto-merges via `gh pr merge
  --squash --delete-branch`; otherwise the workflow falls back to the
  operator-merges-button path so a human inspects the surface area.
---

# /epic-deliver #[Epic ID]

## Overview

`/epic-deliver` is the **single SDL execution command** in the 5.40 surface.
It replaces the v5.39.x execute + close pair — the implicit in-script
merge to `main` from the legacy close path is reintroduced as a
**conditional** auto-merge that only fires when every signal certifies a
clean run, with the operator-merges-button path as the explicit fallback:

```text
/epic-deliver <epicId>
  → Phase 1 — prepare              (epic-deliver-prepare.js)
  → Phase 2 — wave loop            (Agent fan-out × concurrencyCap → /story-execute)
  → Phase 3 — close-validation     (lint + test + ratchets on epic/<id>)
  → Phase 4 — code-review          (helpers/epic-code-review.md, persisted as
                                    a `code-review` structured comment)
  → Phase 5 — retro                (helpers/epic-retro.md, fired locally)
  → Phase 6 — finalize             (epic-deliver-finalize.js → open PR to main)
  → Phase 7 — watch-and-iterate    (poll `gh pr checks`; fix locally until green)
  → Phase 7.5 — auto-merge gate    (epic-deliver-automerge.js — predicate +
                                    `gh pr merge --squash --delete-branch`,
                                    OR fall back to operator-merges-button)
  → Phase 8 — cleanup              (epic-deliver-cleanup.js — local worktree +
                                    branch reap, only after PR merged)
```

The argument is always an Epic ID (`type::epic`). Story IDs go to
[`/story-execute`](story-execute.md); Tasks are not directly executable
(they are implemented inside their parent Story's loop).

> **Engine.** Coordinator at
> [`lib/orchestration/epic-deliver-runner.js`](../scripts/lib/orchestration/epic-deliver-runner.js).
> Story dispatch is in-session via the Agent tool; **no subprocess is
> spawned**. Tech spec **#1147** covers the SDL collapse; **#902** covers
> dispatch and collation; **#323** covers the `epic-run-state` schema.
> Waves are an internal scheduling construct — `epic-run-progress` carries
> the operator-facing per-wave rollup.

---

## Arguments

```text
/epic-deliver <epicId> [--skip-code-review] [--skip-retro] [--full-retro]
```

- `epicId` — the GitHub Issue number of the Epic. Must carry `type::epic`.
  If the ticket is not an Epic, **STOP** and tell the operator to use
  `/story-execute <id>` (for `type::story`) or open the parent Epic.
- `--skip-code-review` — log the override and skip Phase 4. Use only when
  the operator has performed the review out-of-band.
- `--skip-retro` — log the override and skip Phase 5. Use sparingly; the
  retro is how the organisation learns from each Epic.
- `--full-retro` — force the six-section retro regardless of manifest
  cleanliness (otherwise the helper picks the compact path for clean
  manifests). `--skip-retro` wins over `--full-retro`.

There are no other flags — every runtime modifier is sourced from the
Epic ticket's labels or from `orchestration.runners.deliverRunner` in
`.agentrc.json`.

---

## Contract

- **Idempotent by checkpoint.** Re-running `/epic-deliver <epicId>`
  resumes from the `epic-run-state` structured comment if present;
  otherwise it initializes a fresh run. Restarts are safe.
- **Single pause point.** Only `agent::blocked` halts execution. All other
  Epic labels are informational during the run.
- **No clarifying questions.** If the skill cannot make progress without
  input, it transitions the Epic to `agent::blocked`, posts a friction
  comment, and parks until the operator flips it back to
  `agent::executing`.
- **Two-level dispatch.** The host LLM running this skill fans out
  per-Story Agent calls directly. There is no nested wave sub-agent;
  `subagent_type` is always `general-purpose`. This sidesteps the harness
  limitation that default sub-agents do not carry the `Agent` tool.
- **Operator-merges-PR exit.** Phase 6 opens a pull request from
  `epic/<epicId>` to `main` and **stops**. The workflow never merges to
  `main` itself. The PR's existence is the operator's signal to inspect
  the required-checks summary and merge through the GitHub UI. This is
  the explicit human gate that replaces the v5.39.x implicit in-script
  merge inside the prior close workflow.

---

## Phase 1 — Prepare the Epic run

```bash
node .agents/scripts/epic-deliver-prepare.js --epic <epicId>
```

The CLI validates `type::epic`, enumerates `type::story` descendants,
parses `blocked by #N` edges plus any explicit `dependencies` field
(foreign IDs dropped), runs `Graph.computeWaves()`, and upserts the
`epic-run-state` structured comment via `Checkpointer.initialize`. The
runtime wave layout matches `/epic-plan`'s `dispatch-manifest` by
construction (shared DAG-builder rules).

Treat the printed JSON as `state` for the wave loop:
`{ epicId, totalWaves, concurrencyCap, plan, checkpointInitializedAt }`.
`plan` is an ordered array — `plan[N]` carries the Stories assigned to
wave `N` as `[{ storyId, title, worktree? }, ...]`. After the CLI
returns, flip the Epic to `agent::executing` (idempotent).

---

## Phase 2 — Wave loop

For each wave `N` from `0` to `totalWaves - 1`:

### 2a. Fan out per-Story Agent calls

> **You vs. your children — read this first.** *You* (the LLM running
> this skill) are the wave dispatcher. *You* never invoke
> `/story-execute` yourself. Your job is to **dispatch** one `Agent`
> tool call per Story in `plan[N]`. The *children* you spawn — distinct
> sub-agents, one per Agent call — are the ones that run
> `/story-execute`. **Even when `plan[N].length === 1`** you still emit
> exactly one `Agent` call (not a direct `/story-execute` invocation) —
> this preserves the parent-child boundary, keeps the per-child
> non-interactive contract enforceable, and keeps the return-parser on
> a uniform code path.

Emit **one assistant turn** containing **N parallel `Agent` tool calls**,
one per Story in `plan[N]`, where `N === min(plan[N].length,
concurrencyCap)`. Use `subagent_type: general-purpose` for every call.

When `plan[N].length > concurrencyCap`, dispatch the first
`concurrencyCap` Stories in the initial assistant turn (each as a
background `Agent` call with `run_in_background: true`). As **each**
child returns its task notification, dispatch the **next** undispatched
Story from `plan[N]` immediately — keep the in-flight count at
`concurrencyCap` until every Story has been dispatched, then drain the
remaining returns. **Never** exceed `concurrencyCap` in flight, and
**never** wait for a whole batch to return before refilling.

#### Per-child prompt contract

In the rest of this section, "**the child**" means the child sub-agent
that *this* Agent tool call is spawning — not you. Each Agent tool call
must include a self-contained prompt that:

1. Names the Story id and the Epic id.
2. Instructs **the child** to invoke `/story-execute <storyId>`.
3. States the **return contract** the child owes you (its parent):

   ```json
   {
     "storyId": <number>,
     "status": "done" | "blocked" | "failed",
     "phase": "init|implementing|closing|blocked|done",
     "tasksDone": <number>,
     "tasksTotal": <number>,
     "branchDeleted": <boolean>,
     "blockerCommentId": <string|null>,
     "detail": <string|undefined>,
     "renderedBody": <string|undefined>
   }
   ```

4. Reminds **the child** of the **non-interactive contract** (no
   clarifying questions, transition to `agent::blocked` and exit if
   truly stuck).
5. Asks **the child** to suppress per-Task chat relay and instead
   include its **terminal** `renderedBody` in the JSON return so you
   can fold it into the wave-level Notable section.

Children inherit the parent's worktree context; they do **not** require
`--dangerously-skip-permissions` (no subprocess is spawned).

### 2b. Record the wave outcome

Once every dispatched Story for wave `N` has returned, hand the
per-Story results to `epic-execute-record-wave.js`. **Prefer mode B**
when the host LLM cannot fully verify that every child's return text is
a parseable envelope.

```bash
# Mode A — host LLM already parsed each child return.
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --wave <N> [--concurrency-cap <N>] \
  --results @<file>|<inline-json>

# Mode B — pipe the raw per-Story sub-agent return texts directly.
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --wave <N> [--concurrency-cap <N>] \
  --returns @<file>|<inline-json>
# `<inline-json>` shape: [{ "storyId": <n>, "returnText": "<raw text>" }]
```

The CLI parses / reconciles the per-Story returns, verifies every
`done` claim against the live ticket label, aggregates the wave's
terminal status, appends `{ index: N, status, concurrencyCap, stories,
completedAt }` to `state.waves[]`, re-renders `epic-run-progress`, and
prints:

```json
{
  "epicId": <number>,
  "wave": <number>,
  "recorded": true,
  "status": "complete" | "blocked" | "failed",
  "stories": [ { "id": <n>, "status": "done|blocked|failed" }, ... ],
  "blockedStoryIds": [ ... ],
  "nextAction": "dispatch-next" | "halt-blocked" | "halt-failed" | "finalize",
  "remainingWaves": <number>,
  "renderedBody": "<markdown>"
}
```

### 2c. Relay the wave rollup to chat

After `epic-execute-record-wave.js` returns, print the envelope's
`renderedBody` verbatim, then optionally append a short **Notable**
section (0–5 host-LLM-authored bullets covering newly blocked / failed
Stories, slow Stories, friction comments, elapsed-time surprises).
Skip the section entirely if there is nothing notable.

### 2d. Branch on `nextAction`

- `dispatch-next` → continue with wave `N+1`.
- `halt-blocked` → park (operator flips `agent::executing` to resume).
- `halt-failed` → post a friction comment, flip Epic to
  `agent::blocked`, park.
- `finalize` → proceed to Phase 3.

When all waves return `complete`, the iteration phase is done.

---

## Phase 3 — Close-validation

Run lint + test + project-extended ratchets against `epic/<epicId>`
before opening the PR. This is the same chain v5.39.x ran inside
the v5.39.x close-validation chain, lifted into the `/epic-deliver` tail so the
operator's required-checks dashboard reflects a clean tree at PR-open
time.

```bash
node .agents/scripts/evidence-gate.js \
  --epic-id <epicId> --scope-id <epicId> --gate lint -- npm run lint
node .agents/scripts/evidence-gate.js \
  --epic-id <epicId> --scope-id <epicId> --gate test -- npm test
```

The evidence wrapper short-circuits on identical re-runs against an
already-validated tree (keyed by `git rev-parse HEAD`).

If either gate fails: **STOP**, fix the regression on a hotfix branch,
merge back into the Epic branch, and restart this phase.

### 3.1 Refresh ratcheted baselines

Inspect the scripts referenced from `.husky/pre-push` (or the project's
equivalent push hook) — type-checks (`tsc --noEmit`, `astro check`,
`vue-tsc`), lint baselines, complexity / maintainability baselines,
design-token audits, dependency audits, bundle-size budgets. Run each
ratcheted script against the Epic branch. If any drifts, refresh the
baseline file on the Epic branch and commit:

```bash
git commit -m "chore(baselines): refresh <name> for Epic #<epicId>"
```

so the PR's pre-push hook passes on first push at Phase 6.

---

## Phase 4 — Code review

Skip when `--skip-code-review` was passed. Otherwise auto-invoke the
[`helpers/epic-code-review.md`](helpers/epic-code-review.md) module
inline for `<epicId>` (read-only audit mode — no remediation). The
helper persists its findings as a `code-review` structured comment on
the Epic via `upsertStructuredComment`; that comment is the durable
audit trail subsequent retros and incident reviews read back from.

Inspect the resulting findings:

- **Any 🔴 Critical Blocker** — STOP. Relay the blockers to the
  operator and do not proceed to Phase 5. The operator decides whether
  to fix on the Epic branch and re-run `/epic-deliver`, or to override
  explicitly with `--skip-code-review`.
- **Only 🟠/🟡/🟢 findings** — log them as "non-blocking review
  findings" and continue.

---

## Phase 5 — Retro

Skip when `--skip-retro` was passed. Otherwise:

### 5.1 — Post the epic-perf-report

```bash
node .agents/scripts/analyze-execution.js --epic <epicId>
```

The `<!-- structured:epic-perf-report -->` comment must exist on the
Epic before `helpers/epic-retro.md` runs — the retro helper fetches it
by marker and surfaces its top hotspots in the "What Could Be Improved"
section. If the analyzer fails, log the failure as a warning and
continue: the retro helper falls back to its baseline behaviour when
the comment is absent.

### 5.2 — Auto-invoke the retro helper

Detect existing retros via `provider.getComments(<epicId>)` filtered
for `type === "retro"` metadata, or fall back to grepping bodies for
the `<!-- retro-complete: ... -->` marker. If no retro is present,
auto-invoke [`helpers/epic-retro.md`](helpers/epic-retro.md) inline.

Propagate `--full-retro` into the helper invocation when set so the
compact-path heuristic is bypassed and the full six-section retro is
composed regardless of dispatch-manifest cleanliness.

> **Why retro fires here, before the PR opens:** the retro stays in
> the operator's local session with full env access (env vars,
> credentials, MCP servers). Wiring it after PR-open would push it
> outside the operator's session and deny it that env access — the
> 5.40.0 PRD calls this out explicitly.

---

## Phase 6 — Finalize (open PR to main)

```bash
node .agents/scripts/epic-deliver-finalize.js --epic <epicId>
```

The CLI:

1. Pushes `epic/<epicId>` to `origin` (with the validation evidence and
   the retro comment already in place).
2. Opens a pull request from `epic/<epicId>` to `main` titled
   `Epic #<epicId>: <epic title>`. The PR body links the
   `epic-run-progress`, `code-review`, and retro structured comments
   on the Epic ticket; the operator reads them in-place rather than
   duplicating into the PR description.
3. Sets the PR's required-checks expectation from
   `agentSettings.quality.prGate.checks` so the GitHub branch
   protection gate matches the Epic-level validation that just ran.
4. Posts a hand-off structured comment naming the PR URL and the
   operator's remaining action. The Epic stays at `agent::executing`
   until the operator's PR merge fires the standard transition to
   `agent::done`.
5. **Exits cleanly without merging.** The operator merges through the
   GitHub UI once the required checks are green and the review is
   accepted.

`/epic-deliver` does not run any autonomous chainer, does not invoke a
separate close command, and does not delete branches. Branch cleanup is
handled out-of-band by `/delete-epic-branches` after the PR has merged.
The v5.39.x close-path artefacts (autonomous merge to `main`, the
chainer, the separate finalize CLI) were removed in 5.40.0 — see the
`docs/CHANGELOG.md` 5.40.0 entry for the full deletion list.

---

## Phase 7 — Watch-and-iterate until CI is green

The PR is now open. The required-checks gate on `main` is CI-only
(`Validate and Test (ubuntu-latest, node 22)`) — there is no bot
approver, no auto-triage comment, and no auto-fix push. The host LLM
owns the green-bar loop until the operator merges.

Poll the PR's check-run state and, on every failure, pull the failing
log, diagnose locally, push a fix to `epic/<epicId>`, and loop again.

```bash
# Poll loop — exits 0 when every required check is success/neutral/skipped.
gh pr checks <prNumber> --watch
```

`gh pr checks --watch` blocks until the check-runs settle. Treat its exit
code as the loop verdict:

- **Exit 0** (all required checks green) → proceed to Phase 7.5 (auto-merge
  gate). Do not stop at PR-URL relay anymore; the gate decides whether to
  fire the merge or hand the button to the operator.
- **Non-zero exit** (any required check failed) → drop into the
  remediation loop below.

### 7.1 Remediation loop

For each failed required check:

1. **Fetch the failing job's log directly** — do not wait for a triage
   comment, none will appear.

   ```bash
   gh run view <runId> --log-failed
   # or scope to a specific job:
   gh run view <runId> --job <jobId> --log
   ```

2. **Classify the failure** by reading the log:
   - `lint` / `format` → run `npm run lint` and `npm run format:check`
     locally, fix with `npx biome check --apply` /
     `npx biome format --write` (exclude `tests/**` only when the failure
     is in production code), commit, push.
   - `maintainability` / `crap` baseline drift → re-run the appropriate
     ratcheted script locally, refresh the baseline file with a
     `chore(baselines): refresh <name> for Epic #<epicId>` commit if and
     only if the drift is justified by the diff (treat unjustified drift
     as a real regression that must be fixed in source, not papered over
     in the baseline).
   - `test` failure → reproduce locally with `npm test`, fix the source
     or the test, commit, push.
   - `coverage` threshold failure → add tests (preferred) or refresh the
     coverage baseline only when the diff demonstrably can't be covered
     (rare).
   - Anything else → read the log carefully, fix at the source.

3. **Push the fix to `epic/<epicId>`** (the PR's head branch):

   ```bash
   git push origin epic/<epicId>
   ```

4. **Re-arm the watch loop**:

   ```bash
   gh pr checks <prNumber> --watch
   ```

Repeat until the watch loop exits 0. There is no per-PR attempt cap —
the loop is human-in-the-loop by design; the operator can cancel at any
time.

### 7.2 When to halt

- **Three consecutive watch-loop iterations on the same failure class**
  without convergence → post a friction structured comment on the Epic
  ticket naming the failing check, the loop count, and the last fix
  attempt; flip the Epic to `agent::blocked`; park. The operator
  diagnoses the loop and flips back to `agent::executing` to resume.
- **A failure class outside the four canonical buckets** (lint / test /
  coverage / maintainability) on first encounter → still attempt a
  source-level fix, but log a friction comment if the diagnosis takes
  more than one round of investigation. Unknown CI behaviour is worth
  the operator's attention.

### 7.3 What you must not do

- **Never** `gh pr merge` from inside Phase 7. Phase 7.5 is the only legal
  merge site, and only when the auto-merge predicate certifies a clean
  run.
- **Never** force-push to `main`. The Epic branch is the only legal
  push target.
- **Never** re-run a check by pushing an empty commit to dodge the
  diagnosis — fix the real failure, or halt and ask.
- **Never** refresh a baseline file solely to make a red check go
  green; the baseline-refresh anti-gaming guardrail was removed
  alongside the bot pipeline, so the operator is now the only thing
  standing between an honest refresh and a gamed one. Self-police
  accordingly.

---

## Phase 7.5 — Auto-merge gate

After Phase 7's watch loop exits 0, evaluate the auto-merge predicate.
This is the gate that decides whether the operator's "click merge" button
is doing real work or just rubber-stamping a clean run. When every signal
is clean, the workflow fires `gh pr merge --squash --delete-branch`
itself; otherwise it relays the disqualifying reasons and hands the
button to the operator.

```bash
node .agents/scripts/epic-deliver-automerge.js --epic <epicId> --pr <prNumber>
```

The CLI:

1. Reads the `epic-run-state` checkpoint, the `code-review` structured
   comment, and the `retro` / `retro-partial` structured comment via
   `lib/orchestration/automerge-predicate.js`.
2. Returns `clean: true` only when **all** of the following hold:
   - `state.manualInterventions[]` is empty;
   - every wave's `status === "complete"`;
   - no story envelope carries a `blockerCommentId` or a non-`done` status;
   - the code-review comment reports `0` 🔴 Critical Blockers **and** `0`
     🟠 High Risk findings;
   - the retro is the compact "🟢 Clean sprint" body.
3. When `clean: true`, fires `gh pr merge <prNumber> --squash --delete-branch`.
4. When `clean: false`, prints the disqualifying reasons and exits without
   merging — the workflow falls back to the operator-merges-button path.

Branch on `merged`:

- **`merged: true`** → proceed to Phase 8 (cleanup).
- **`merged: false`** → relay the verdict to the operator with the PR URL
  and the reasons list, **STOP**. The operator inspects the surface area
  and either clicks merge themselves or amends the Epic branch and
  re-runs `/epic-deliver`.

### Recording manual interventions

The auto-merge predicate's manual-intervention signal exists because *the
host LLM* is the only thing that knows when it stepped outside the happy
path. Any time you do one of the following during a delivery, **append a
record to the checkpoint** with:

```bash
node .agents/scripts/epic-deliver-note-intervention.js \
  --epic <epicId> --reason "<one-line description>"
```

Triggers — non-exhaustive but covers the patterns observed to date:

- you call `AskUserQuestion` to the operator mid-run;
- you `git restore` or `git reset` against the working tree to discard
  drift;
- a Story child reports manual `--no-ff` recovery, a stash dance, or any
  out-of-band merge surgery in its return contract;
- a Story child closes via `--skipValidation` (currently universal due
  to `feedback_close_validation_main_drift` — see "Open caveats" below
  for the version-1 carve-out);
- you discard CI failures by force-pushing or empty-committing to dodge
  diagnosis.

Each entry disqualifies the Epic from auto-merge. The cost of forgetting
to log an intervention is that the predicate certifies the run as clean
when it wasn't — be conservative.

### Open caveats

- **`--skipValidation` is excluded from v1 predicate.** While
  `feedback_close_validation_main_drift` remains unresolved, every story
  closes via the programmatic skip path. Counting that as a manual
  intervention would prevent auto-merge from ever firing. Once the
  underlying gate is fixed, tighten the predicate so `skipValidation`
  becomes a disqualifier and remove this carve-out.

---

## Phase 8 — Local branch cleanup

Once Phase 7.5 has merged the PR (auto or via the operator-merges-button
fallback), reap the Epic's local branches + worktrees:

```bash
node .agents/scripts/epic-deliver-cleanup.js --epic <epicId>
```

The CLI reads the `epic-run-state` checkpoint, enumerates `epic/<id>`
plus every `story-<storyId>`, removes any still-registered worktree
(with the Windows-lock fallback recipe from
`feedback_sprint_story_close_reap`), prunes the worktree registry, and
drops the local refs. Remote branches are out of scope —
`gh pr merge --delete-branch` already deleted `origin/epic/<id>` and
the story branches were deleted at story-close time.

Fall back to `/delete-epic-branches` for the "scrap and reset" flow that
also walks the remote refs (`task/epic-<id>/*`, `feature/epic-<id>/*`).
Phase 8 is narrower by design — post-merge, the only refs that remain
are local, and the cleanup script is purpose-built for that pattern.

### When the PR did not auto-merge

If Phase 7.5 fell back to the operator-merges-button path, **do not**
run Phase 8 yourself. The operator merges via the GitHub UI when they
are ready; they can invoke `/epic-deliver-cleanup <id>` (or
`/delete-epic-branches <id>`) after the merge to reclaim the local refs.

---

## Idempotence and resume

Re-runs pick up at the next undispatched wave (in-flight Stories
finish via `/story-execute`'s own checkpointing). A completed wave
loop with a clean evidence record skips Phase 3 in milliseconds.
A blocked Epic re-enters the blocker handler's wait loop. The PR
created in Phase 6 is updated in place on subsequent runs (no
duplicate PRs are opened against the same Epic branch).

The authoritative live view is the `epic-run-progress` structured
comment on the Epic ticket, upserted in place after every wave from
the merged checkpoint state.

---

## Constraints

- **Never** merge `epic/<epicId>` into `main` from anywhere other than
  Phase 7.5's auto-merge CLI. Phase 6 opens the PR, Phase 7 drives it
  to green, Phase 7.5 evaluates the predicate; everything else hands
  the button to the operator.
- **Never** dispatch more than one wave at a time. Concurrency lives
  **inside** a single wave's fan-out (Phase 2a).
- **Never** dispatch more than `concurrencyCap` Stories in flight per
  wave. `concurrencyCap` is sourced from
  `orchestration.runners.deliverRunner.concurrencyCap` and surfaced in
  the `epic-deliver-prepare.js` JSON.
- **Never** flip Story-level labels from inside this skill. Story-state
  ownership belongs to `/story-execute`.
- **Never** invoke `/story-execute` yourself. Your sole dispatch
  primitive is the `Agent` tool — children run `/story-execute`, you
  do not. This holds even for single-Story waves.
- **Never** spawn a subprocess to dispatch a Story or a wave.
  In-session Agent-tool fan-out is the only supported dispatch path.
- **Always** checkpoint via `epic-deliver-prepare.js` /
  `epic-execute-record-wave.js`; never write run state anywhere else.
- **Always** post a friction structured comment on the Epic before
  returning a non-`complete` outcome.
- **Always** auto-invoke the code-review helper (Phase 4) and the
  retro helper (Phase 5) when they have not already produced their
  artefacts. Do not halt and ask the operator to run them separately.
- **Always** persist the code-review output as a `code-review`
  structured comment on the Epic — `epic-code-review.js` already does
  this via `upsertStructuredComment`; do not bypass it.
- **Always** drive Phase 7 to a green CI verdict before returning
  control to the operator. There is no longer a bot approver, an
  auto-triage comment, or an auto-fix push; the host LLM owns the
  iteration loop until the PR is mergeable or the operator parks the
  Epic at `agent::blocked`.
