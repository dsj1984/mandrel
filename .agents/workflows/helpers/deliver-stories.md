---
description: >-
  Deliver one or more standalone Stories end-to-end. Accepts 1+ Story IDs,
  builds a dependency DAG, asks the operator to confirm it, then drives a
  continuous ready-set loop via `stories-wave-tick.js` (the shared
  `selectReadySet` core) — dispatching each Story the instant its own deps
  are done, under one global concurrency cap and one file-overlap guard,
  each dispatch delegating to `helpers/single-story-deliver`. Stories
  without an `Epic: #N` reference only; Epic-attached Stories use `/deliver`.
---

# helpers/deliver-stories — multi-Story delivery path (invoked by /deliver)

## Overview

This helper is the **standalone multi-Story delivery path** behind
`/deliver`. The router delegates to it whenever the supplied IDs include
standalone Stories — either as the sole route (Story-only input) or as the
**standalone segment** of a mixed segment plan (run first, before any Epic
segments; see [`deliver.md`](../deliver.md)). It takes one or more Story
IDs, builds a dependency DAG, optionally confirms it with the operator, and
then drives a **continuous ready-set loop**: it dispatches each Story the
instant its **own** dependencies are done — there is no wave barrier where a
whole group must drain before the next opens — capped by one global
concurrency limit and guarded by one file-overlap rule, the same scheduling
core (`lib/wave-runner/ready-set.js#selectReadySet`) the Epic path uses.

```text
/deliver 101 102 103
  → Phase 0 — Validate input & build DAG
  → Phase 1 — stories-wave-tick.js → DAG sanity + operator confirmation
  → Phase 2 — continuous ready-set loop:
        repeat until every Story is done:
          stories-wave-tick.js --dag … --done <doneIds> --in-flight <n>
            → ready[] = Stories dispatchable on this beat
          Agent tool × ready.length parallel calls (≤ concurrencyCap − inFlight)
            helpers/single-story-deliver <storyId>
          as each child returns done, add its id to <doneIds> and re-tick
  → Phase 3 — Summary
```

**When to use `/deliver` vs. other commands:**

| Scenario | Command |
| --- | --- |
| 1+ standalone Stories (no `Epic: #N` in body) | `/deliver <id> [<id>...]` |
| Exactly one standalone Story (lighter path) | `/single-story-deliver <id>` |
| Epic-attached Stories (have `Epic: #N`) | `/deliver <epicId>` |
| Mixed Epics + standalone Stories | `/deliver <ids...>` — the router composes a sequential segment plan; this helper delivers the standalone segment first |

This helper **refuses** Stories that carry an `Epic: #N` reference in
their body. Those Stories belong to an Epic's dispatch manifest and must flow
through `/deliver <epicId>`. Use `/single-story-deliver` for a single
Epic-free Story when you want the leaner one-story path without the
ready-set scheduling loop.

> **Concurrency cap.** The cap is resolved **deterministically in code** by
> `stories-wave-tick.js` — the same `resolveConfig` + `getRunners` seam
> `/deliver` uses — and emitted as the `concurrencyCap` field on the
> `stories-ready-set` envelope on **every** beat. The default is 3; override
> persistently via `delivery.deliverRunner.concurrencyCap` in `.agentrc.json`
> (a `.agentrc.local.json` override is honored) or per-run via the
> `--concurrency` flag below. The cap is global, not per-wave: the core caps
> each beat's `ready[]` at `concurrencyCap − inFlight`, so the workflow simply
> dispatches every id in `ready[]` — do **not** re-read or merge config
> yourself, and do **not** re-throttle the returned set.

---

## Arguments

```text
/deliver <storyId> [<storyId> ...] [--dep <fromId>:<toId> ...] [--yes] [--concurrency <n>]
```

- `storyId` — One or more GitHub issue numbers carrying `type::story` and
  **no** `Epic: #N` reference. At least one is required.
- `--dep <fromId>:<toId>` — Declare an explicit dependency edge: `<fromId>`
  must complete before `<toId>` runs. Repeat for each edge. When omitted,
  all Stories are treated as independent (every Story is dispatchable on the
  first beat) unless `blocked by #N` references between the supplied IDs are
  detected automatically.
- `--yes` — Skip the operator confirmation in Phase 1 and proceed
  immediately. Safe for scripted / sub-agent invocations.
- `--concurrency <n>` — Override the global concurrency cap for this run
  only. Passed through to `stories-wave-tick.js` on every beat, which validates
  it (must be a positive integer) and reflects it in the emitted
  `concurrencyCap` field. When omitted, the cap is resolved from
  `delivery.deliverRunner.concurrencyCap` (default 3).

---

## Phase 0 — Validate input and build DAG

For each supplied Story ID:

1. Confirm the issue exists and carries the `type::story` label.
2. Confirm the issue body does **not** contain an `Epic: #N` reference. If
   it does, STOP and tell the operator to use `/deliver <epicId>`
   instead.
3. Collect `blocked by #N` references between the supplied Story IDs.
   References to Story IDs outside the supplied set are advisory warnings
   only — they do not block delivery.

Construct the DAG input array:

```json
[
  { "id": 101, "dependsOn": [] },
  { "id": 102, "dependsOn": [101] },
  { "id": 103, "dependsOn": [] }
]
```

`dependsOn` is the union of:

- `blocked by #N` edges where `N` is in the supplied set.
- Explicit `--dep` edges.

---

## Phase 1 — DAG sanity check and operator confirmation

### 1a. Sanity-check the DAG (first beat, nothing done yet)

```bash
node .agents/scripts/stories-wave-tick.js --dag '<dag-json>'
# with a per-run cap override:
node .agents/scripts/stories-wave-tick.js --dag '<dag-json>' --concurrency <n>
```

When the operator passed `--concurrency <n>` to `/deliver`, forward it
verbatim to `stories-wave-tick.js`. The script resolves the cap from config
(`delivery.deliverRunner.concurrencyCap`, default 3) and the override wins for
that run.

With no `--done` / `--in-flight` (the first beat), stdout is one JSON
envelope describing the Stories dispatchable **right now** — the roots:

```json
{
  "kind": "stories-ready-set",
  "ready": [101, 103],
  "totalStories": 3,
  "concurrencyCap": 3,
  "inFlight": 0,
  "cycleError": null
}
```

- **`cycleError` non-null** → STOP. Report the cycle to the operator and
  exit. The Story set cannot be delivered until the circular dependency is
  resolved.
- **`totalStories === 0`** → STOP. Zero Stories resolved — report and exit.
- **`ready` empty with `totalStories > 0` on the first beat** → STOP. Every
  Story is gated behind a dependency outside the supplied set; report and
  exit (the operator must include the missing prerequisites).
- **`concurrencyCap`** is the resolved global cap. Phase 2 re-reads it from
  each beat's envelope and never re-derives it from config.
- An invalid `--concurrency` / `--in-flight` / `--done` value makes the
  script exit non-zero with an `inputError` → STOP and surface the message.

This first call is a **sanity gate**, not the schedule: Phase 2 re-ticks
continuously as Stories complete. The envelope no longer enumerates future
waves — ordering emerges beat by beat from the live `--done` set.

### 1b. Operator confirmation (skipped with `--yes` or for single-story runs)

**Auto-skip rule (Story #3302):** When `totalStories === 1`, skip the
confirmation prompt automatically and proceed. A single-Story run has no
ordering ambiguity and no meaningful operator decision to make — the run
*is* "deliver this one Story". Prompting for confirmation would just be
friction.

Otherwise, present the dependency DAG to the operator in a readable table —
the roots dispatch immediately, dependents unlock as their prerequisites
complete:

```text
Delivery plan — 3 Stories (continuous, dependency-driven)
  Ready now: #101 "<title>", #103 "<title>"
  Unlocks after its deps complete: #102 "<title>" (needs #101)

Proceed? [Y/n]
```

Wait for the operator to confirm before dispatching. When the operator
types `n` or `N`, abort cleanly with a summary of the plan that was
declined. When `--yes` was passed, skip this step and proceed regardless
of Story count.

---

## Phase 2 — Continuous ready-set loop

Drive a single loop, re-ticking after every child returns. Maintain two
pieces of state across the loop:

- **`doneIds`** — the set of Story IDs that have returned `status: 'done'`
  (start empty).
- **`inFlight`** — the count of Stories dispatched but not yet returned
  (start at 0).

Each iteration (one **beat**):

### 2a. Tick the ready set

```bash
node .agents/scripts/stories-wave-tick.js --dag '<dag-json>' \
  --done '<comma-separated doneIds>' --in-flight <inFlight> [--concurrency <n>]
```

The envelope's `ready[]` is the set of Stories whose **own** dependencies
are all in `doneIds` and that fit the remaining capacity
(`concurrencyCap − inFlight`) without a file-overlap collision — the core
has already applied the global cap and the overlap guard, so the list is
safe to dispatch verbatim. **Termination:** when `ready` is empty **and**
`inFlight === 0` **and** `doneIds` covers every Story, the run is complete →
go to Phase 3. When `ready` is empty but `inFlight > 0`, dispatch nothing
and wait for an in-flight child to return (a dependent is waiting on it).

### 2b. Fan out per-Story Agent calls

Emit **one `Agent` tool call per Story ID in `ready[]`**, all with
`run_in_background: true`. The list is already capped, so dispatch the whole
of `ready[]` and increment `inFlight` by `ready.length`. Do **not** re-derive
or re-throttle the cap here; the core sized `ready[]` for you.

Each Agent call:

1. Names the Story ID and instructs the child to invoke
   [`helpers/single-story-deliver`](single-story-deliver.md)
   for that Story.
2. States the **return contract** (see § 2c) and the **no-park rule**: the
   child MUST drive the close → CI-watch → merge-confirm → `agent::done`
   sequence to a terminal state *within its own turn* and end **only** by
   returning the § 2c JSON object. The auto-merge wait is an
   internally-blocking step (`pr-watch-with-update.js` blocks the turn), **not**
   a reason to suspend and hand back. A child that ends its turn with
   free-form prose and an unconfirmed merge (e.g. "I'll wait for the
   background watch task…") has violated the contract — the loop cannot
   advance, and the Story strands at `agent::closing` (the Story #1553 /
   PR #1554 failure mode). There is no "pending" return status: the child
   returns `done` (merge confirmed), `blocked` (transitioned + friction
   posted), or `failed`.
3. Reminds the child of the **non-interactive contract**: no clarifying
   questions — if stuck, transition to `agent::blocked`, post a
   `friction` comment, and exit non-zero.
4. Requests the child suppress per-phase chat relay and include its
   **terminal** `renderedBody` in the JSON return.

Use `subagent_type: general-purpose`.

### 2b′. Collect each return and re-tick

As each child returns, decrement `inFlight` by 1 and apply its outcome
(§ 2d). When a child returns `done`, add its id to `doneIds`. Then **re-tick
immediately** (§ 2a) so a newly-unblocked Story dispatches the instant its
last dependency clears — do not wait for the whole batch to drain. This is
the no-false-barrier behavior: an unrelated still-running Story never holds
back a Story whose own deps are already done.

### 2c. Per-Story return contract

Each child ends its turn by returning **exactly one** JSON object — never
free-form prose:

```json
{
  "storyId": <number>,
  "status": "done" | "blocked" | "failed",
  "phase": "init|implementing|closing|blocked|done",
  "branchDeleted": <boolean>,
  "blockerCommentId": <string|null>,
  "detail": "<one-liner>",
  "renderedBody": "<terminal story body>"
}
```

The status enum is **closed** — `done`, `blocked`, or `failed`. There is no
"pending" / "waiting" status, because the close-phase auto-merge wait is
**not** a returnable suspension: the child blocks on `pr-watch-with-update.js`
*inside its own turn*, confirms the merge, flips `agent::done`, and only then
returns `status: "done"`. A child that returns prose instead — parking on the
CI wait with an unconfirmed merge — breaks the loop's ability to advance
and leaves the Story at `agent::closing` (Story #1553 / PR #1554). The
single-homed restatement of this no-park rule for the child's own perspective
is [`single-story-deliver.md` § Step 7](single-story-deliver.md#return-contract).

### 2d. Per-return outcome handling

As each child returns (before the next re-tick):

- **`status === 'done'`** → Add its id to `doneIds` and re-tick. Print a
  one-line per-Story complete summary.
- **`status === 'blocked'`** → STOP dispatching new Stories. Drain the
  Stories still in flight (let them return), then post a summary of blocked
  Stories and their `blockerCommentId` references. Do not dispatch any
  further beat. Wait for the operator to resolve each blocker and re-run
  `/deliver` with the same set (already-done Stories will short-circuit
  because `single-story-close.js` is idempotent).
- **`status === 'failed'`** → STOP dispatching new Stories, drain the
  in-flight set, and report the failures. The operator must fix the failing
  Stories before re-running.

---

## Phase 3 — Summary

Print a final run summary listing every delivered Story in completion order:

```text
/deliver — 3 Stories delivered (continuous, dependency-driven)

  #101 ✅ done, #103 ✅ done (dispatched first — roots)
  #102 ✅ done (after #101 cleared)

All Stories delivered. PRs opened, auto-merge armed. CI will merge each
PR when checks pass; each child then confirms the merge and flips its
Story to `agent::done` (Story #3385 — until the merge confirms, a Story
rests at `agent::closing` with its issue OPEN).
```

Then **fast-forward `main` yourself** — do not instruct the operator to run it
after the last merge. The delivering flow owns bringing the local base branch
up to whatever has merged so far:

```bash
node .agents/scripts/git-cleanup.js --fast-forward-main --execute --yes
```

This runs only the fast-forward-main phase (`git fetch origin main` →
`git merge --ff-only`); it is idempotent and a no-op when `main` is already
current, so it is safe to run even while some PRs are still queued in
auto-merge. Report its one-line result in the summary. Merged Story branches
themselves are reaped by the boot sweep at the next `/plan` / `/deliver` boot —
see [`.agents/rules/git-conventions.md` § Local checkout hygiene](../../rules/git-conventions.md).

When some Stories are blocked or failed, list them explicitly with the
`blockerCommentId` or failure detail so the operator knows where to look.

---

## Opt-in post-green refactor stage (`delivery.refactorStage`)

When `delivery.refactorStage.enabled` is `true` in `.agentrc.json`, each
per-Story worker runs an **advisory** post-green refactor pass after the
Story's suite is green and the close-validation gates already pass — and
**before** close. The stage is **strictly opt-in and default-OFF**: when the
key is unset or `false`, story-deliver behaves exactly as documented above
and this stage is skipped entirely.

The stage adopts the [`refactorer`](../../personas/refactorer.md) persona and the
[`core/refactoring-discipline`](../../skills/core/refactoring-discipline/SKILL.md)
skill to drive a behaviour-preserving pass that lowers CRAP and removes
duplication on the files the Story already touched:

- **Post-green only.** It runs after the suite is green and the gates pass —
  never from red, and never to make a failing test pass.
- **Behaviour-preserving.** Existing tests MUST keep passing without
  modification; if a test had to change, the change was a behaviour change and
  must be reverted.
- **Advisory, not a gate.** This stage does **not** introduce a new
  close-validation gate and does **not** change the semantics of the existing
  [close-validation](../../scripts/lib/close-validation/runner.js) chain (typecheck,
  lint, test, format, maintainability, coverage, crap). The canonical gates
  remain the single source of pass/fail at close; the refactor stage only adds
  an extra behaviour-preserving cleanup commit when enabled.

> **Default-OFF guarantee.** Consumers who do not set
> `delivery.refactorStage.enabled` (or set it to `false`) see no change in
> delivery behaviour — no extra stage, no new gate, identical close semantics.

---

## Idempotence

`/single-story-deliver` is idempotent at every phase:
`single-story-init.js` reuses an existing worktree and
`single-story-close.js` short-circuits when the Story is already closed.
Re-running `/deliver` with the same Story set after a partial
failure is safe — already-done Stories produce no-op outcomes; only the
blocked or unstarted Stories execute.

---

## Constraints

- **Never** pass Epic-attached Stories to this command. Detect `Epic: #N`
  in Phase 0 and STOP.
- **Never** dispatch a new beat once any Story has returned `blocked` or
  `failed` — drain the in-flight set and stop.
- **Never** exceed the resolved `concurrencyCap` (emitted by
  `stories-wave-tick.js` on every beat) parallel Agent calls at any moment.
  The core caps each beat's `ready[]` at `concurrencyCap − inFlight`;
  dispatch the whole list and never add to it.
- **Always** confirm the dependency DAG with the operator before dispatching,
  unless `--yes` was passed.
- **Label transitions**: drive every `agent::*` state change through
  `node .agents/scripts/update-ticket-state.js --ticket <id> --state <state>`.
  This CLI is the authoritative mechanism — there is no separate
  state-mutation MCP server to degrade from (see
  [`.agents/instructions.md` § 1.D](../../instructions.md)).

---

## See also

- [`helpers/single-story-deliver`](single-story-deliver.md) — the
  per-Story worker this command delegates to.
- [`/deliver`](deliver-epic.md) — full Epic wave loop for
  Epic-attached Stories.
- [`helpers/epic-deliver-story`](epic-deliver-story.md) — the
  per-Story worker `/deliver` uses internally.
