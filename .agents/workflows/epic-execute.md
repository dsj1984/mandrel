---
description: >-
  Execute an Epic end-to-end. Snapshots `epic::auto-close` once at startup,
  flips the Epic to `agent::executing`, writes the initial `epic-run-state`
  checkpoint, computes waves via `Graph.computeWaves()`, and invokes
  `/wave-execute <epicId> <waveN>` per wave through the Agent tool. Rolls up
  child `wave-run-progress` comments into a single `epic-run-progress`
  operator-facing summary on the Epic ticket. The only runtime pause point is
  `agent::blocked`.
---

# /epic-execute #[Epic ID]

## Overview

`/epic-execute` is the **long-running orchestrator** in the Epic-centric
workflow. It composes the wave loop and delegates each wave to
[`/wave-execute`](wave-execute.md), which fans out per-Story Agent-tool
calls into [`/story-execute`](story-execute.md):

```text
/epic-execute <epicId>
  → for each wave N (computed from the Epic's child Stories):
      /wave-execute <epicId> <N>
        → Agent tool × concurrencyCap parallel calls (one assistant turn):
            /story-execute <storyId>
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
> covers the `epic-run-state` schema.

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
After the CLI returns, flip the Epic to `agent::executing` (idempotent).

---

## Step 2 — Iterate waves

For each wave `N` from `0` to `totalWaves - 1`:

1. **Dispatch** one Agent tool call (`subagent_type: general-purpose`) whose
   prompt names the Epic id and wave index, instructs the sub-agent to
   invoke `/wave-execute <epicId> <N>`, restates the wave-skill return
   contract (defined in [`wave-execute.md`](wave-execute.md#step-3--record-the-wave-outcome)),
   and reminds it of the non-interactive contract. The prompt **must**
   spell out, in those words, that the wave sub-agent's job is to
   *dispatch further Agent tool calls* (one per Story in the wave plan, up
   to `concurrencyCap`) — it is **not** to invoke `/story-execute` itself.
   Without this clause, a general-purpose sub-agent reading
   [`wave-execute.md`](wave-execute.md) has been observed to misread "the
   sub-agent" as itself and collapse the wave to a single `/story-execute`
   call (regression: 2026-05-07).

   The wave-level fan-out depends on the wave sub-agent having the `Agent`
   tool. The default `general-purpose` sub-agent type does **not** carry
   `Agent` in this Claude Code release — see
   [Harness constraint — no nested Agent by default](wave-execute.md#harness-constraint--no-nested-agent-by-default)
   in `wave-execute.md` for the full rationale and the emergency-only
   host-driven flat-fan-out fallback. The custom `wave-runner` agent type
   (`.claude/agents/wave-runner.md`) is the supported way to grant the
   `Agent` tool to a wave-level sub-agent.
2. **Read the wave summary** from the Agent tool result. `/wave-execute` has
   already upserted a `wave-run-progress` comment on the Epic — that is the
   source of truth for per-Story state.
3. **Roll up `epic-run-progress`** (Step 3).
4. **Advance the checkpoint** (Step 4). The CLI's printed `nextAction` is
   `continue`, `block`, or `finalize`.
5. **Branch on status.** `complete` → next wave. `blocked` → Step 5 and
   park. `failed` → post a friction comment, flip Epic to `agent::blocked`,
   park.

When all waves return `complete`, the iteration phase is done.

---

## Step 3 — Roll up `epic-run-progress`

After each wave returns, refresh the operator-facing summary on the Epic:

```bash
node .agents/scripts/epic-rollup.js \
  --epic <epicId> --current-wave <N> --total-waves <totalWaves> \
  [--started-at <iso8601>]
```

The CLI reads every `wave-run-progress` structured comment on the Epic,
folds them into the canonical `epic-run-progress` payload defined in tech
spec #902, and upserts it in place. The collation reader **never re-derives
Story state from labels** — it trusts the wave snapshots, which were
themselves computed from each Story's `story-run-progress` comment. Missing
or unparseable wave snapshots fall back to `{ wave: N, stories: [] }`.

The CLI's stdout JSON envelope carries a `renderedBody` field — the
markdown body of the cross-wave epic rollup (header
`### 📊 Epic Progress — Wave N/M · D/T stories done`, columns
`Wave · ID · State · Title`). After the CLI returns:

1. **Relay `renderedBody` to chat verbatim** — this is the operator's
   top-of-funnel view of the Epic. The body unifies every completed wave
   alongside the in-flight one in a single table.
2. Append a short **Notable** section (host-LLM-authored, 0–5 bullets).
   Keep it synthesized over signals from the just-completed wave's
   summary plus anything surprising in the wave-level chat blocks the
   children produced:
   - new blockers crossing the wave boundary;
   - Stories whose terminal state contradicts what their wave-level
     summary reported (rare — rollup-vs-summary drift);
   - friction comments posted on the Epic itself during this wave;
   - elapsed-time surprises vs. earlier waves of comparable size;
   - anything the operator should look at before greenlighting the next
     wave.
   Skip the section entirely if there is nothing notable. **Do not**
   invent bullets for happy-path waves.

---

## Step 4 — Advance the checkpoint

Record the just-completed wave on `epic-run-state` and read back the next
action:

```bash
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --wave <N> --result @<file-or-inline-json>
```

`--result` is the wave summary JSON returned by `/wave-execute`. The CLI
re-reads the checkpoint, appends the wave outcome, re-writes
`epic-run-state` via `Checkpointer.write`, and prints
`{ epicId, wave, recorded, nextAction, remainingWaves }`. `nextAction` is
one of `continue` (dispatch wave `N+1`), `block` (Step 5), or `finalize`
(Step 6). The checkpoint is upserted before every wave dispatch and after
every completion, which is what makes restarts idempotent.

---

## Step 5 — Blocker handling

When a wave returns `blocked` (or the Epic label transitions to
`agent::blocked` mid-run via the `BlockerHandler`'s observer), the handler
flips the Epic to `agent::blocked`, posts a friction comment listing
`blockedStoryIds`, fires the notification hook (`notification-hook.js`),
halts dispatch of the next wave, and parks at the wait loop. Step 2 reads
the wave's Agent-tool result synchronously, so in-flight Stories have
already returned by this point. Resume is operator-driven — the handler
polls labels via `labelFetcher` and returns when the operator flips back
to `agent::executing`.

---

## Step 6 — Finalize

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
on the Epic ticket, upserted in place after every wave.

---

## Constraints

- **Never** honor a mid-run change to `epic::auto-close` — the startup
  snapshot is authoritative.
- **Always** checkpoint via `epic-execute-prepare.js` /
  `epic-execute-record-wave.js`; never write run state anywhere else.
- **Never** dispatch more than one wave at a time. Concurrency lives
  **inside** `/wave-execute`.
- **Never** flip Story-level labels from inside this skill. Story-state
  ownership belongs to `/story-execute`.
- **Never** re-derive `epic-run-progress` from raw Story labels. The
  rollup reads the per-wave `wave-run-progress` comments.
- **Always** post a friction structured comment on the Epic before
  returning a non-`complete` outcome.
- **Never** spawn a subprocess to dispatch a Story or a wave. In-session
  Agent-tool fan-out is the only supported dispatch path.
