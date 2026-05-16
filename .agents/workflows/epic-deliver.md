---
description: >-
  Drive an Epic from `agent::ready` to a merged pull request against `main`.
  The nine-phase flow runs the wave loop, close-validation, code-review, retro,
  finalize, watch-and-iterate, conditional auto-merge, and local branch
  cleanup. When the run is end-to-end clean (zero manual interventions, zero
  🔴/🟠 review findings, compact retro) the PR auto-merges via `gh pr merge
  --squash --delete-branch`; otherwise the workflow falls back to the
  operator-merges-button path so a human inspects the surface area.
recommendedModel: opus
---

<!-- recommendedModel rationale: nine-phase delivery orchestrator coordinates wave fan-out, code review, retro, and merge gating — reasoning-heavy, advisory hint for operators. -->

# /epic-deliver #[Epic ID]

## Overview

`/epic-deliver` is the **single SDL execution command** in the 5.40 surface.
It opens a PR against `main` and auto-merges when every signal certifies a
clean run; otherwise it falls back to the operator-merges-button path.

```text
/epic-deliver <epicId>
  → Phase 1 — prepare              (epic-deliver-prepare.js)
  → Phase 2 — wave loop            (wave-tick.js + Agent fan-out × concurrencyCap)
  → Phase 3 — close-validation     (lint + test + ratchets on epic/<id>)
  → Phase 4 — code-review          (helpers/epic-code-review.md)
  → Phase 5 — retro                (.agents/scripts/lib/orchestration/retro-runner.js)
  → Phase 6 — finalize             (epic-deliver-finalize.js → open PR to main)
  → Phase 7 — watch-and-iterate    (poll `gh pr checks`; fix locally until green)
  → Phase 7.5 — auto-merge gate    (epic-deliver-automerge.js)
  → Phase 8 — cleanup              (epic-deliver-cleanup.js — only after merge)
```

The argument is always an Epic ID (`type::epic`). Story IDs go to
[`/story-execute`](story-execute.md); Tasks are not directly executable.
Story dispatch is in-session via the Agent tool — no subprocess is
spawned.

---

## Arguments

```text
/epic-deliver <epicId> [--skip-code-review] [--skip-retro] [--full-retro]
```

- `epicId` — must carry `type::epic`. Otherwise STOP and tell the operator
  to use `/story-execute <id>` or open the parent Epic.
- `--skip-code-review` — skip Phase 4 (log the override).
- `--skip-retro` — skip Phase 5 (use sparingly).
- `--full-retro` — force the six-section retro regardless of manifest
  cleanliness. `--skip-retro` wins over `--full-retro`.

Every other runtime modifier is sourced from the Epic's labels or from
`delivery.deliverRunner` in `.agentrc.json`.

---

## Contract

- **Idempotent by checkpoint.** Re-runs resume from `epic-run-state`.
- **Single pause point.** Only `agent::blocked` halts execution. No
  clarifying questions — if stuck, flip to `agent::blocked`, post a
  friction comment, park.
- **Two-level dispatch.** Host LLM fans out per-Story Agent calls
  directly with `subagent_type: general-purpose`. Sub-agents do not
  carry the `Agent` tool, so this stays flat.
- **Operator-merges-PR exit.** Phase 6 opens the PR; the workflow
  never merges to `main` itself. Phase 7.5 may fire auto-merge when
  every signal is clean.

---

## Phase 1 — Prepare the Epic run

```bash
node .agents/scripts/epic-deliver-prepare.js --epic <epicId>
```

Validates `type::epic`, enumerates `type::story` descendants, parses
`blocked by #N` plus explicit `dependencies`, runs `Graph.computeWaves()`,
and upserts the `epic-run-state` checkpoint. Treat the printed JSON as
`state`: `{ epicId, totalWaves, concurrencyCap, plan, checkpointInitializedAt }`.
`plan[N]` is the Stories assigned to wave `N`. Flip the Epic to
`agent::executing` (idempotent) after the CLI returns.

---

## Phase 2 — Wave loop

The wave-loop state machine lives in
[`lib/wave-runner/tick.js`](../scripts/lib/wave-runner/tick.js) — one
stateless `tick({ epic })` call returns one `WaveTickResult` describing
the next action. The slash command's job is to call `tick()` via its CLI
shim, dispatch from `nextAction.stories` via the Agent tool, persist the
outcome, and loop until terminal.

### 2a. Tick — plan the next action

```bash
node .agents/scripts/wave-tick.js --epic <epicId>
```

Stdout is one `WaveTickResult` envelope:

```json
{
  "nextAction":
      { "kind": "dispatch",      "stories": [{ "id": <n>, "title": "…", "worktree"?: "…" }, ...] }
    | { "kind": "observe",       "waitingOn": [<storyId>, ...] }
    | { "kind": "wave-complete", "index": <n> }
    | { "kind": "epic-complete" },
  "blockedStories": [{ "storyId": <n>, "reason": "…", "detail"?: "…" }, ...],
  "gateFailures":   [{ "storyId": <n>, "gate": "…", "detail"?: "…" }, ...],
  "currentWave":    <n>,
  "totalWaves":     <n>
}
```

The CLI emits `wave-tick` (every call) plus `wave-start` /
`wave-complete` / `epic-complete` at transitions to the per-Epic
`signals.ndjson`; `/signals` renders them in the span-tree view.

### 2b. Dispatch — fan out per-Story Agent calls

*You* (the LLM running this skill) are the wave dispatcher; you never
invoke `/story-execute` yourself. Emit **one `Agent` tool call per
Story** in `nextAction.stories` (even when `length === 1` — the
parent-child boundary keeps the return-parser uniform). The *children*
run `/story-execute`. Use `subagent_type: general-purpose`.

Emit **one assistant turn** with **N parallel `Agent` calls** where
`N === min(nextAction.stories.length, concurrencyCap)`. When the wave
exceeds `concurrencyCap`, dispatch the first `concurrencyCap` Stories
as background calls (`run_in_background: true`) and refill from
`nextAction.stories` immediately as each child returns — never exceed
the cap, never wait for a whole batch before refilling.

Each Agent call's prompt must (1) name the Story + Epic ids, (2)
instruct the child to invoke `/story-execute <storyId>`, (3) state the
**return contract** below, (4) remind the child of the
**non-interactive contract** (no clarifying questions; transition to
`agent::blocked` and exit if stuck), and (5) ask the child to suppress
per-Task chat relay and include its **terminal** `renderedBody` in the
JSON return.

```json
{
  "storyId": <number>,
  "status": "done" | "blocked" | "failed",
  "phase": "init|implementing|closing|blocked|done",
  "tasksDone": <number>, "tasksTotal": <number>,
  "branchDeleted": <boolean>,
  "blockerCommentId": <string|null>,
  "detail": <string|undefined>,
  "renderedBody": <string|undefined>
}
```

**Dispatch-model resolution.** For `model:`, precedence (highest
wins): per-call literal → workflow `dispatchModel` frontmatter →
inherit (emit no argument). The unset case is today's behaviour — full
inheritance via the `general-purpose` sub-agent definition. Children
inherit the parent's worktree context; no
`--dangerously-skip-permissions` (no subprocess is spawned).

### 2c. Record the wave outcome

Once every dispatched Story has returned, persist via
`epic-execute-record-wave.js`:

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

**Prefer mode B** when the host LLM can't fully verify every child's
return is a parseable envelope. The CLI reconciles parse failures from
GitHub, aggregates terminal status, appends to `state.waves[]`,
re-renders `epic-run-progress`, and prints
`{ status, nextAction, renderedBody, ... }`. Print `renderedBody`
verbatim, then optionally append a short **Notable** section (0–5
bullets on newly blocked / failed / slow Stories, friction,
elapsed-time surprises).

### 2d. Loop on `nextAction`

After `2c`, re-run `wave-tick.js`. Branch on the new envelope:

- `dispatch` → repeat 2b/2c for the same wave (refill) or the next wave.
- `observe` → poll the Epic (children may still be in flight, or some
  are `agent::blocked`). If `blockedStories` is non-empty, post a
  friction comment, flip Epic to `agent::blocked`, park.
- `wave-complete` → loop to the next wave.
- `epic-complete` → proceed to Phase 3.

---

## Phase 3 — Close-validation

Run lint + test + ratchets against `epic/<epicId>` before opening the PR:

```bash
node .agents/scripts/evidence-gate.js \
  --epic-id <epicId> --scope-id <epicId> --gate lint -- npm run lint
node .agents/scripts/evidence-gate.js \
  --epic-id <epicId> --scope-id <epicId> --gate test -- npm test
```

If either gate fails: STOP, fix on a hotfix branch, merge back to the
Epic branch, restart this phase.

### 3.1 Refresh ratcheted baselines

Inspect the scripts in `.husky/pre-push` (typecheck, lint, maintainability,
design tokens, dependency audits, bundle-size budgets). Run each against
the Epic branch; if any drifts, refresh and commit
`chore(baselines): refresh <name> for Epic #<epicId>`.

---

## Phase 4 — Code review

Skip when `--skip-code-review`. Otherwise auto-invoke
[`helpers/epic-code-review.md`](helpers/epic-code-review.md) inline
(read-only audit). The helper persists findings as a `code-review`
structured comment on the Epic.

- **Any 🔴 Critical Blocker** — STOP. Relay to the operator.
- **Only 🟠/🟡/🟢** — log as non-blocking and continue.

---

## Phase 5 — Retro

Skip when `--skip-retro`. Otherwise post the `epic-perf-report` via
`node .agents/scripts/analyze-execution.js --epic <epicId>` (failure →
warn and continue; the retro runner falls back). Then invoke the retro
runner inline — the canonical surface lives at
[`.agents/scripts/lib/orchestration/retro-runner.js`](../scripts/lib/orchestration/retro-runner.js)
and is driven by `epic-deliver.js`. Propagate `--full-retro` to bypass
the compact-path heuristic.

Retro fires here (before the PR opens) so it stays in the operator's
local session with full env access (env vars, credentials, MCP).

---

## Phase 6 — Finalize (open PR to main)

```bash
node .agents/scripts/epic-deliver-finalize.js --epic <epicId>
```

Pushes `epic/<epicId>`, opens a PR to `main` (title
`Epic #<epicId>: <title>`, body links run-progress / code-review /
retro comments), sets required-checks from
`github.branchProtection.checks`, enables GitHub native auto-merge
(`gh pr merge --auto --squash --delete-branch`), and posts a hand-off
comment with the PR URL. Auto-merge enablement failures are non-fatal
(operator can merge through the UI). Branch cleanup is out-of-band
(`/delete-epic-branches`).

---

## Phase 7 — Watch-and-iterate until CI is green

The host LLM owns the green-bar loop until the operator merges. Use
the shared watch-and-recover helper, which wraps `gh pr checks --watch`
and additionally auto-recovers from `mergeStateStatus: BEHIND` by
calling `gh pr update-branch` once every required check is green
(branch-protection rules requiring "up to date before merging"
otherwise park the PR until the operator clicks **Update branch**
manually):

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>
```

`<agentRoot>` resolves from `project.paths.agentRoot` (default
`.agents`). Pass `--max-updates N` (default 3) to cap update-branch
calls per session and `--poll-interval-ms MS` (default 10000) to
override the polling cadence.

Exit 0 → proceed to Phase 7.5. Non-zero → remediate (below) and re-run
the helper. Auto-merge stays armed across retries; Phase 7.5
(`epic-deliver-automerge.js`) still re-checks `mergeStateStatus` before
firing merge, so a second BEHIND that arrives between the helper
exiting clean and Phase 7.5 starting is also caught.

### 7.1 Remediation

For each failed required check: fetch the log
(`gh run view <runId> --log-failed`), classify and fix:

- **lint / format** → `npm run lint` + `npx biome check --apply` (or
  `format --write`); commit, push.
- **maintainability / crap baseline drift** → re-run the ratcheted
  script. Refresh the baseline only when drift is justified by the
  diff; otherwise fix at source.
- **test failure** → reproduce with `npm test`, fix source or test.
- **coverage threshold** → add tests (preferred); refresh baseline only
  when the diff demonstrably can't be covered.
- **anything else** → read the log, fix at source.

Push to `epic/<epicId>` and re-run
`node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>`.

### 7.2 When to halt

Three consecutive iterations on the same failure class without
convergence → friction comment, flip to `agent::blocked`, park. Unknown
failure class on first encounter → attempt source-level fix; log
friction if diagnosis takes more than one round.

### 7.3 Hard prohibitions

**Never** `gh pr merge` from Phase 7 (Phase 7.5 is the only merge
site). **Never** force-push to `main`. **Never** push empty commits or
refresh baselines to dodge a red check.

---

## Phase 7.5 — Auto-merge gate

After Phase 7 exits 0, evaluate the auto-merge predicate:

```bash
node .agents/scripts/epic-deliver-automerge.js --epic <epicId> --pr <prNumber>
```

`clean: true` only when **all** of:

- `state.manualInterventions[]` is empty;
- every wave's `status === "complete"`;
- no story envelope carries a `blockerCommentId` or non-`done` status;
- code-review reports `0` 🔴 + `0` 🟠 findings;
- the retro is the compact "🟢 Clean sprint" body.

When clean, fires `gh pr merge --squash --delete-branch`. Otherwise
prints disqualifying reasons and exits without merging — operator
merges manually.

### Recording manual interventions

Whenever you step outside the happy path during a delivery, record it
(each entry disqualifies auto-merge):

```bash
node .agents/scripts/epic-deliver-note-intervention.js \
  --epic <epicId> --reason "<one-line description>"
```

Triggers: `AskUserQuestion` mid-run; `git restore`/`reset` against the
tree; child-reported `--no-ff` recovery, stash dance, or out-of-band
merge surgery; child closes via `--skipValidation`; force-pushing or
empty-committing to dodge CI diagnosis.

---

## Phase 8 — Local branch cleanup

After Phase 7.5 has merged the PR (auto or manual), reap local refs:

```bash
node .agents/scripts/epic-deliver-cleanup.js --epic <epicId>
```

Enumerates `epic/<id>` + every `story-<storyId>`, removes worktrees,
prunes the registry, drops local refs. Remote branches are out of
scope (`gh pr merge --delete-branch` handled them). Fall back to
`/delete-epic-branches` for the wider "scrap and reset" flow that
walks remote `task/*` and `feature/*` refs.

If Phase 7.5 fell back to the operator-merges-button path, **do not**
run Phase 8 yourself — the operator runs
`node .agents/scripts/epic-deliver-cleanup.js --epic <epicId>` (or
`/delete-epic-branches` for the wider scrap-and-reset flow) after they
merge.

---

## Idempotence and resume

Re-runs pick up at the next undispatched wave (in-flight Stories finish
via `/story-execute`'s own checkpointing). The PR from Phase 6 is
updated in place on subsequent runs. The authoritative live view is
the `epic-run-progress` structured comment.

---

## Constraints

- **Never** merge `epic/<epicId>` to `main` outside Phase 7.5.
- **Never** dispatch more than one wave at a time; concurrency lives
  inside a single wave's fan-out, capped at `concurrencyCap`.
- **Never** flip Story-level labels from this skill; **never** invoke
  `/story-execute` yourself (children run it via Agent fan-out, even
  for single-Story waves); **never** spawn a subprocess for dispatch.
- **Always** checkpoint via `epic-deliver-prepare.js` /
  `epic-execute-record-wave.js`; never write run state elsewhere.
- **Always** post a friction structured comment before a non-`complete`
  outcome.
- **Always** auto-invoke the code-review and retro helpers (Phases 4–5)
  when their artefacts aren't already present.
- **Always** drive Phase 7 to green CI before returning control — the
  host LLM owns the loop until the PR is mergeable or the Epic is
  parked at `agent::blocked`.
