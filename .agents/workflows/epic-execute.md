---
description: >-
  Execute an Epic end-to-end. Snapshots `epic::auto-close` once at startup,
  flips the Epic to `agent::executing`, writes the initial `epic-run-state`
  checkpoint, computes waves via `Graph.computeWaves()`, and fans each wave
  out as parallel Agent-tool calls (one assistant turn per wave, capped by
  concurrencyCap) directly to `/story-execute`. Records each wave outcome
  via `epic-execute-record-wave.js`, which advances the checkpoint and
  upserts the unified `epic-run-progress` rollup on the Epic. The only
  runtime pause point is `agent::blocked`.
---

# /epic-execute #[Epic ID]

## Overview

`/epic-execute` is the **long-running orchestrator** in the Epic-centric
workflow. The host LLM owns the wave loop and the per-wave Story fan-out
directly — there is no intermediate `/wave-execute` skill and no custom
`wave-runner` sub-agent type:

```text
/epic-execute <epicId>
  → for each wave N (computed from the Epic's child Stories):
      Agent tool × concurrencyCap parallel calls (one assistant turn):
        → /story-execute <storyId>
      → epic-execute-record-wave.js (parse / verify / checkpoint / rollup)
```

The argument is always an Epic ID (`type::epic`); Story IDs go to
`/story-execute`. There is no router script — the operator picks the right
entry point by hierarchy level.

> **Engine.** Coordinator at
> [`lib/orchestration/epic-runner.js`](../scripts/lib/orchestration/epic-runner.js)
> with submodules under
> [`lib/orchestration/epic-runner/`](../scripts/lib/orchestration/epic-runner/).
> Story dispatch is in-session via the Agent tool; **no subprocess is
> spawned**. Tech spec **#902** covers dispatch and collation; **#323**
> covers the `epic-run-state` schema. Waves are an internal scheduling
> construct — `epic-run-progress` carries the operator-facing per-wave
> rollup; there is no separate `wave-run-progress` comment.

---

## Arguments

```text
/epic-execute <epicId>
```

- `epicId` — the GitHub Issue number of the Epic. Must carry `type::epic`. If
  the ticket is not an Epic, **STOP** and tell the operator to use
  `/story-execute <id>` (for `type::story`) or open the parent Epic (for
  `type::feature` / `type::task`).

There are no flags — every runtime modifier is sourced either from the Epic
ticket's labels (e.g. `epic::auto-close`) or from
`orchestration.runners.epicRunner` in `.agentrc.json`.

---

## Contract

- **Idempotent by checkpoint.** Re-running `/epic-execute <epicId>` resumes
  from the `epic-run-state` structured comment if present; otherwise it
  initializes a fresh run. Restarts are safe.
- **Single pause point.** Only `agent::blocked` halts execution. All other
  Epic labels are informational during the run.
- **Snapshot modifier.** `epic::auto-close` is read **once** at run start.
  Mid-run changes are ignored — the captured value lives in the
  `epic-run-state` checkpoint and survives restarts.
- **No clarifying questions.** If the skill cannot make progress without
  input, it transitions the Epic to `agent::blocked`, posts a friction
  comment, and parks until the operator flips it back to `agent::executing`.
- **Two-level dispatch.** The host LLM running this skill fans out per-Story
  Agent calls directly. There is no nested wave sub-agent; `subagent_type`
  is always `general-purpose`. This sidesteps the harness limitation that
  default sub-agents do not carry the `Agent` tool.

---

## Step 1 — Prepare the Epic run

```bash
node .agents/scripts/epic-execute-prepare.js --epic <epicId>
```

The CLI validates `type::epic`, captures `epic::auto-close` as the
authoritative `autoClose` boolean **at this exact moment**, enumerates
`type::story` descendants, parses `blocked by #N` edges plus any explicit
`dependencies` field (foreign IDs dropped), runs `Graph.computeWaves()`,
and upserts the `epic-run-state` structured comment via
`Checkpointer.initialize`. The runtime wave layout matches `/epic-plan`'s
`dispatch-manifest` by construction (shared DAG-builder rules).

Treat the printed JSON as `state` for the wave loop:
`{ epicId, autoClose, totalWaves, concurrencyCap, plan, checkpointInitializedAt }`.
`plan` is an ordered array — `plan[N]` carries the Stories assigned to
wave `N` as `[{ storyId, title, worktree? }, ...]`. After the CLI returns,
flip the Epic to `agent::executing` (idempotent).

---

## Step 2 — Iterate waves

For each wave `N` from `0` to `totalWaves - 1`:

### 2a. Fan out per-Story Agent calls

> **You vs. your children — read this first.** *You* (the LLM running this
> skill) are the wave dispatcher. *You* never invoke `/story-execute`
> yourself. Your job is to **dispatch** one `Agent` tool call per Story in
> `plan[N]`. The *children* you spawn — distinct sub-agents, one per Agent
> call — are the ones that run `/story-execute`. **Even when
> `plan[N].length === 1`** you still emit exactly one `Agent` call (not a
> direct `/story-execute` invocation) — this preserves the parent-child
> boundary, keeps the per-child non-interactive contract enforceable, and
> keeps the return-parser on a uniform code path.

Emit **one assistant turn** containing **N parallel `Agent` tool calls**,
one per Story in `plan[N]`, where `N === min(plan[N].length,
concurrencyCap)`. Use `subagent_type: general-purpose` for every call. The
Story sub-agent only iterates child Tasks sequentially via
[`helpers/task-execute.md`](helpers/task-execute.md), so it does not need
the `Agent` tool itself.

When `plan[N].length > concurrencyCap`, dispatch the first
`concurrencyCap` Stories in the initial assistant turn (each as a
background `Agent` call with `run_in_background: true`). As **each** child
returns its task notification, dispatch the **next** undispatched Story
from `plan[N]` immediately — keep the in-flight count at `concurrencyCap`
until every Story has been dispatched, then drain the remaining returns.
**Never** exceed `concurrencyCap` in flight, and **never** wait for a
whole batch to return before refilling — strict batching wastes capacity
(one slow Story stalls all sibling slots) and is forbidden.

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

4. Reminds **the child** of the **non-interactive contract** (no clarifying
   questions, transition to `agent::blocked` and exit if truly stuck).
5. Asks **the child** to suppress per-Task chat relay (the wave-level
   rollup is the canonical chat surface) and instead include its
   **terminal** `renderedBody` in the JSON return so you can fold it into
   the wave-level Notable section.

Children inherit the parent's worktree context; they do **not** require
`--dangerously-skip-permissions` (no subprocess is spawned).

### 2b. Record the wave outcome

Once every dispatched Story for wave `N` has returned, hand the per-Story
results to `epic-execute-record-wave.js`. Two input modes are supported;
**prefer mode B** when the host LLM cannot fully verify that every child's
return text is a parseable envelope.

```bash
# Mode A — host LLM already parsed each child return into the canonical
# /story-execute return contract.
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --wave <N> [--concurrency-cap <N>] \
  --results @<file>|<inline-json>

# Mode B — pipe the raw per-Story sub-agent return texts directly. Each
# entry is parsed through `parseStoryAgentReturn`; any return that does
# not match the contract is reconciled from GitHub (labels +
# `story-run-progress`) and a single rolled-up friction comment is posted
# on the Epic naming each malformed child. The wave is guaranteed to
# surface a non-`complete` status if any child return failed to parse.
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --wave <N> [--concurrency-cap <N>] \
  --returns @<file>|<inline-json>
# `<inline-json>` shape: [{ "storyId": <n>, "returnText": "<raw text>" }]
```

The CLI:

1. Parses / reconciles the per-Story returns.
2. Verifies every `done` claim against the live ticket label
   (`agent::done` or `state: closed`); any unverified claim is downgraded
   to `failed` so the wave-level rollup reflects the regression rather
   than silently classifying the wave `complete` (regression guard for
   Domio Epic #604, 2026-05-04).
3. Aggregates the wave's terminal status (`complete` only when every
   Story returned `done`; any `blocked` or `failed` propagates).
4. Appends `{ index: N, status, concurrencyCap, stories, completedAt }`
   to `state.waves[]` (replacing any prior record at the same index — the
   checkpoint is idempotent), bumps `state.currentWave` on `complete`,
   and re-writes `epic-run-state`.
5. Re-renders `epic-run-progress` from `state.waves[]` and upserts the
   structured comment in place. There is no separate per-wave structured
   comment; the unified rollup is the single operator-facing summary,
   grouped by wave.
6. Posts one rolled-up friction comment if any child return failed to
   parse (mode B only).
7. Prints:

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
     "renderedBody": "<markdown>",
     "discrepancies": [ ... ],     // only if any `done` claim was downgraded
     "parseFailures": [ ... ]      // mode B only, if any
   }
   ```

### 2c. Relay the wave rollup to chat

After `epic-execute-record-wave.js` returns:

1. Print the envelope's `renderedBody` verbatim — this is the
   operator-facing canonical view of the Epic, with one row per Story per
   wave (header `### 📊 Epic Progress — Wave N/M · D/T stories done`,
   columns `Wave · ID · State · Title`).
2. Append a short **Notable** section (host-LLM-authored, 0–5 bullets).
   Keep it terse and synthesized over signals from the just-completed
   wave's child returns plus anything surprising in the wave-level chat
   blocks the children produced:
   - newly blocked / failed Stories (with `#id` references);
   - Stories that consumed an outsized share of wave wall-clock;
   - friction comments posted during the wave (count + targets);
   - elapsed-time surprises vs. earlier waves of comparable size;
   - anything the operator should look at before greenlighting the next
     wave.
   Skip the section entirely if there is nothing notable. **Do not**
   invent bullets for happy-path waves.

### 2d. Branch on `nextAction`

- `dispatch-next` → continue with wave `N+1`.
- `halt-blocked` → Step 3 and park.
- `halt-failed` → post a friction comment, flip Epic to `agent::blocked`,
  park.
- `finalize` → Step 4.

When all waves return `complete`, the iteration phase is done.

---

## Step 3 — Blocker handling

When `nextAction` is `halt-blocked` (or the Epic label transitions to
`agent::blocked` mid-run via the `BlockerHandler`'s observer), the
handler flips the Epic to `agent::blocked`, posts a friction comment
listing `blockedStoryIds`, fires the notification hook
(`notification-hook.js`), halts dispatch of the next wave, and parks at
the wait loop. Step 2b reads each child's Agent-tool result
synchronously, so in-flight Stories have already returned by this point.
Resume is operator-driven — the handler polls labels via `labelFetcher`
and returns when the operator flips back to `agent::executing`.

---

## Step 4 — Finalize

When the wave loop completes without an unresumed halt:

```bash
node .agents/scripts/epic-finalize.js --epic <epicId>
```

The CLI re-reads `epic-run-state` to recover the snapshotted `autoClose`,
flips the Epic to `agent::review`, runs `column-sync`, and invokes
`BookendChainer`:

- `autoClose === true` → auto-invokes `/epic-close <epicId>` via the
  `runSkill` adapter. `/epic-code-review` and `/epic-retro` remain
  operator-driven; the chainer always lists them in the hand-off comment.
- `autoClose === false` → posts the hand-off comment listing the operator's
  remaining bookends (`helpers/epic-code-review.md`, `helpers/epic-retro.md`,
  `/epic-close <epicId>`) and exits cleanly.

The chainer never auto-runs review or retro on its own — autonomous closure
must be a single, explicit action.

---

## Idempotence and resume

Re-runs pick up at the next undispatched wave (in-flight Stories finish via
`/story-execute`'s own checkpointing). A completed Epic
(`currentWave === totalWaves`) skips iteration and goes straight to
finalize. A blocked Epic re-enters the blocker handler's wait loop.

The authoritative live view is the `epic-run-progress` structured comment
on the Epic ticket, upserted in place after every wave from the merged
checkpoint state.

---

## Constraints

- **Never** honor a mid-run change to `epic::auto-close` — the startup
  snapshot is authoritative.
- **Always** checkpoint via `epic-execute-prepare.js` /
  `epic-execute-record-wave.js`; never write run state anywhere else.
- **Never** dispatch more than one wave at a time. Concurrency lives
  **inside** a single wave's fan-out (Step 2a).
- **Never** dispatch more than `concurrencyCap` Stories in flight per wave.
  `concurrencyCap` is sourced from
  `orchestration.runners.epicRunner.concurrencyCap` and surfaced in the
  `epic-execute-prepare.js` JSON.
- **Never** flip Story-level labels from inside this skill. Story-state
  ownership belongs to `/story-execute`.
- **Never** invoke `/story-execute` yourself. Your sole dispatch primitive
  is the `Agent` tool — children run `/story-execute`, you do not. This
  holds even for single-Story waves.
- **Always** post a friction structured comment on the Epic before
  returning a non-`complete` outcome.
- **Never** spawn a subprocess to dispatch a Story or a wave. In-session
  Agent-tool fan-out is the only supported dispatch path.
