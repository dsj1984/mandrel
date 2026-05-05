---
description: >-
  Execute one wave of an Epic. Reads the dispatch-manifest structured comment
  on the Epic, selects the Stories assigned to wave `<N>`, fans them out as
  parallel Agent-tool calls (one assistant turn, capped by concurrencyCap),
  aggregates child returns into a `wave-run-progress` structured comment, and
  returns a structured summary to its caller.
---

# /wave-execute #[Epic ID] #[Wave N]

## Overview

`/wave-execute` is the **wave-level worker**. It sits between
[`/epic-execute`](epic-execute.md) (long-running orchestrator) and
[`/story-execute`](story-execute.md) (single-Story worker):

```text
/epic-execute <epicId>
  → for each wave N:
      /wave-execute <epicId> <N>
        → Agent tool × concurrencyCap parallel calls (one assistant turn):
            /story-execute <storyId>
```

A single invocation handles one wave end to end. The fan-out is in-session —
every child Story runs as a sub-agent that shares the parent's tool
permissions and Claude session. There is no top-level `wave-execute.js` CLI;
the skill itself emits the Agent-tool dispatch turn.

> 📎 Tech spec **#902** covers Agent-tool dispatch, the progress-collation
> contract, and the structured-comment payload shape.

## Arguments

```text
/wave-execute <epicId> <waveN>
```

- `epicId` — the GitHub Issue number of the Epic (`type::epic`).
- `waveN` — zero-indexed wave number (matches `waves[].waveIndex` in the
  dispatch manifest).

Both are **required**. The skill does not infer the active wave from Epic
state; the caller picks the right index.

---

## Step 1 — Read the dispatch manifest and plan the wave

Hand both jobs (read manifest + run `StoryLauncher.planWave`) to one CLI:

```bash
node .agents/scripts/wave-prepare.js --epic <epicId> --wave <waveN>
```

The manifest is the `dispatch-manifest` structured comment that `/epic-plan`
upserted on the Epic; its schema lives at
[`dispatch-manifest.json`](../schemas/dispatch-manifest.json). A Story
belongs to wave `N` when its manifest entry's `wave === N`. The CLI runs
`StoryLauncher.planWave` on the selection and prints
`{ epicId, wave, concurrencyCap, plan: [{ storyId, worktree? }, ...] }`.

**Failure modes.** If the manifest is missing/malformed or no Stories match,
the CLI exits with code `2` after posting a `friction` structured comment on
the Epic. **STOP** and surface the failure — do not attempt to dispatch
Stories you cannot discover deterministically.

---

## Step 2 — Fan out via Agent tool calls

Emit **one assistant turn** containing **N parallel `Agent` tool calls**, one
per Story in `plan`, where `N === min(plan.length, concurrencyCap)`. Use
`subagent_type: general-purpose`.

When `plan.length > concurrencyCap`, dispatch the first `concurrencyCap`
Stories in the assistant turn, wait for the batch to return, then emit a
follow-up turn with the next batch. **Never** dispatch more than
`concurrencyCap` Stories in flight at once.

### Per-child prompt contract

Each Agent tool call must include a self-contained prompt that:

1. Names the Story id and the Epic id.
2. Tells the sub-agent to invoke `/story-execute <storyId>`.
3. States the **return contract** the sub-agent owes its parent:

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

4. Reminds the sub-agent of the **non-interactive contract** (no clarifying
   questions, transition to `agent::blocked` and exit if truly stuck).
5. Asks the sub-agent to suppress per-Task chat relay (the wave-level
   rollup is the canonical chat surface) and instead include its
   **terminal** `renderedBody` in the JSON return so this skill can fold
   it into the wave-level Notable section.

Sub-agents inherit the parent's tool permissions and worktree context; they
do **not** require `--dangerously-skip-permissions` (no subprocess is
spawned).

---

## Step 3 — Record the wave outcome

Hand every Agent tool result to the recorder. Two input modes are
supported; pick whichever is less work for the host LLM:

```bash
# Mode A — host LLM already parsed each child return into the canonical
# /story-execute return contract.
node .agents/scripts/wave-record.js \
  --epic <epicId> --wave <waveN> [--concurrency-cap <N>] \
  --results @<file>|<inline-json>

# Mode B — pipe the raw per-Story sub-agent return texts directly. Each
# entry is parsed through `parseStoryAgentReturn`; any return that does
# not match the contract (e.g. free-text mid-task fragments) is reconciled
# from GitHub (labels + `story-run-progress`) and a friction comment is
# posted on the Epic naming each malformed child. The wave is guaranteed
# to surface a non-`complete` status if any child return failed to parse.
node .agents/scripts/wave-record.js \
  --epic <epicId> --wave <waveN> [--concurrency-cap <N>] \
  --returns @<file>|<inline-json>
# `<inline-json>` shape: [{ "storyId": <n>, "returnText": "<raw text>" }]
```

**Prefer mode B** when the host LLM cannot fully verify that every child's
return text is a parseable envelope. The reconciler downgrades each
malformed return to `failed` unless the live ticket actually carries
`agent::done`, so a wave with even one unparseable child is never reported
as `complete` (regression guard for Domio Epic #604, 2026-05-04 — a
sub-agent returned `"Clean. Now commit Task 622."` mid-task and the
runner used to propagate the fragment silently).

The CLI validates the rows, upserts the `wave-run-progress` structured
comment on the **Epic ticket** (one row per Story per wave, in place),
classifies the wave (`complete` only when every Story returned `done`;
any `blocked` or `failed` propagates), and prints:

```json
{
  "epicId": <number>,
  "wave": <number>,
  "status": "complete" | "blocked" | "failed",
  "stories": [ { "id": <n>, "status": "done|blocked|failed" }, ... ],
  "blockedStoryIds": [ ... ],
  "renderedBody": "<markdown>",
  "parseFailures": [ { "storyId": <n>, "error": "<reason>" }, ... ]  // mode B only, if any
}
```

The skill never transitions Epic-level state — that is `/epic-execute`'s
responsibility.

### Step 4 — Relay the wave rollup to chat

After `wave-record.js` returns, **emit the wave's chat update**:

1. Print the envelope's `renderedBody` verbatim — the canonical
   per-Story rollup table for this wave (header `### 🌊 Wave N — D/T done`,
   columns `ID · State · Title · Tasks`).
2. Append a short **Notable** section (host-LLM-authored, 0–4 bullets).
   Keep it terse and synthesized over signals from the child returns:
   - newly blocked / failed Stories (with `#id` references);
   - Stories that consumed an outsized share of wave wall-clock;
   - friction comments posted during the wave (count + targets);
   - anything surprising in a child's terminal `renderedBody`.
   Skip the section entirely if there is nothing notable. **Do not** invent
   bullets for happy-path waves.

### Step 5 — Return contract (sub-agent path)

When run as a sub-agent of `/epic-execute`, return the `wave-record`
envelope verbatim plus the chat block from Step 4 in your assistant text.
The parent reads `renderedBody` from the envelope to fold into its
cross-wave epic rollup; the assistant text is what the operator sees in
chat. Do not strip `renderedBody` — `/epic-execute`'s Notable synthesis
depends on it.

---

## Idempotence

Re-running `/wave-execute` for the same `<epicId> <waveN>` re-reads the
manifest, re-plans, re-dispatches, and re-upserts the `wave-run-progress`
comment in place. It does **not** dedupe at the dispatch level — already-
merged Stories re-run `/story-execute`, which short-circuits when the
Story branch is already closed. For partial-wave reruns (some Stories
done, some blocked), drive each blocked Story through `/story-execute
<id>` directly rather than re-firing `/wave-execute`.

---

## Constraints

- **Never** dispatch more than `concurrencyCap` Stories in flight.
  `concurrencyCap` is sourced from
  `orchestration.runners.epicRunner.concurrencyCap` and surfaced in the
  `wave-prepare.js` JSON.
- **Never** rename, retype, or skip the `wave-run-progress` structured
  comment — its marker is the only handle the rollup uses.
- **Never** flip Epic-level labels from inside this skill.
- **Always** include the non-interactive contract in every child prompt.
- **Always** post a `friction` comment on the Epic before returning a
  non-`complete` status. (`wave-prepare.js` and `wave-record.js` post
  their own friction comments on hard failures; the skill handles the
  soft-failure case.)
