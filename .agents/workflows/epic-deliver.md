---
description: >-
  Drive an Epic from `agent::ready` to an open pull request against `main`. The
  six-phase flow folds today's `/epic-execute` wave loop with the
  `/epic-close` close-tail (validation, code-review, retro) and ends by opening
  a PR — the operator merges through the GitHub UI. There is no in-script
  merge to `main`. The runtime engine is `epic-deliver-runner` (the renamed
  `epic-runner`); `epic-deliver-prepare` (the renamed `epic-execute-prepare`)
  builds the wave plan; `epic-deliver-finalize` opens the PR.
---

# /epic-deliver #[Epic ID]

## Overview

`/epic-deliver` is the **single SDL execution command** in the 5.40 surface.
It replaces the v5.39.x `/epic-execute → /epic-close` pair — the implicit
in-script merge to `main` from `/epic-close` becomes an explicit human PR
merge through the GitHub UI:

```text
/epic-deliver <epicId>
  → Phase 1 — prepare           (epic-deliver-prepare.js)
  → Phase 2 — wave loop         (Agent fan-out × concurrencyCap → /story-execute)
  → Phase 3 — close-validation  (lint + test + ratchets on epic/<id>)
  → Phase 4 — code-review       (helpers/epic-code-review.md, persisted as
                                 a `code-review` structured comment)
  → Phase 5 — retro             (helpers/epic-retro.md, fired locally)
  → Phase 6 — finalize          (epic-deliver-finalize.js → open PR to main)
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
  the explicit human gate that replaces v5.39.x's implicit in-script
  merge inside `/epic-close`.

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
`/epic-close` Phase 4, lifted into the `/epic-deliver` tail so the
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
4. Flips the Epic to `agent::review` and posts a hand-off structured
   comment naming the PR URL and the operator's remaining action.
5. **Exits cleanly without merging.** The operator merges through the
   GitHub UI once the required checks are green and the review is
   accepted.

There is no `epic-finalize.js` from the v5.39.x close path —
`/epic-deliver` does not run `BookendChainer`, does not auto-invoke
`/epic-close`, and does not delete branches. Branch cleanup is handled
out-of-band by `/delete-epic-branches` after the PR has merged.

---

## Operator-merges-PR exit condition

`/epic-deliver` ends at the moment the PR is open, the required-checks
expectation is configured, and the Epic carries `agent::review`. The
**operator** is the gate that promotes the Epic branch into `main` —
the workflow never executes `git merge` against `main`. This is the
explicit human decision point that replaces v5.39.x's implicit
in-script merge inside `/epic-close`.

When the operator merges the PR via the GitHub UI:

- the Epic-to-`main` merge lands as a real PR merge with a real
  reviewer-trail and required-checks history;
- branch cleanup runs out-of-band via `/delete-epic-branches`;
- the operator-driven workflow is done — no separate `/epic-close`
  invocation, no separate retro command, because the retro already
  fired locally inside Phase 5.

If the operator chooses **not** to merge (rolling back, deferring,
re-scoping), `/epic-deliver` has not poisoned `main` and the Epic
branch can be amended in place. Re-running `/epic-deliver <epicId>`
after a force-pushed Epic-branch change re-runs Phase 3 / 4 / 5 (the
evidence wrapper picks up the new `HEAD`) and updates the same PR.

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

- **Never** merge `epic/<epicId>` into `main` from inside this
  workflow. Phase 6 opens the PR and stops; the operator merges
  through the GitHub UI.
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
