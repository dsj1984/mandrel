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
[`/wave-execute`](wave-execute.md), which in turn fans out per-Story Agent-tool
calls into [`/story-execute`](story-execute.md):

```text
/epic-execute <epicId>
  → for each wave N (computed from the Epic's child Stories):
      /wave-execute <epicId> <N>
        → Agent tool × concurrencyCap parallel calls (one assistant turn):
            /story-execute <storyId>
```

The skill is the **single entry point** for Epic-level execution. The argument
is always an Epic ID (`type::epic`); Story IDs go to `/story-execute`. There
is no router script — the operator (or a calling skill) picks the right entry
point by hierarchy level.

> **Engine.** The wave loop is composed by the coordinator at
> [`lib/orchestration/epic-runner.js`](../scripts/lib/orchestration/epic-runner.js)
> from the submodules under
> [`lib/orchestration/epic-runner/`](../scripts/lib/orchestration/epic-runner/):
> `wave-scheduler`, `story-launcher`, `wave-observer`, `checkpointer`,
> `blocker-handler`, `notification-hook`, `column-sync`, and `bookend-chainer`.
> The wave loop reads state synchronously per wave — there is no background
> poller, no idle-watchdog, and no progress-log file. Story dispatch is
> in-session via the Agent tool; **no subprocess is spawned**.
>
> The CLI at [`.agents/scripts/epic-runner.js`](../scripts/epic-runner.js)
> exists for `--dry-run` preview only. End-to-end execution must be driven
> from this skill so the parent Claude session can issue Agent tool calls.
>
> 📎 See tech spec **#902** for the architectural rationale (Agent-tool
> dispatch replacing subprocess spawn, structured-comment progress collation,
> retired config keys), and tech spec **#323** for the underlying
> `epic-run-state` schema and submodule decomposition.

---

## Arguments

```text
/epic-execute <epicId>
```

- `epicId` — the GitHub Issue number of the Epic. Must carry `type::epic`. If
  the ticket is not an Epic, **STOP** and tell the operator to use
  `/story-execute <id>` (for `type::story`) or open the parent Epic (for
  `type::feature` / `type::task`).

The skill takes a single positional argument. There are no flags — every
runtime modifier is sourced either from the Epic ticket's labels (e.g.
`epic::auto-close`) or from `agentSettings.runners.epicRunner` in
`.agentrc.json`.

---

## Contract

- **Idempotent by checkpoint.** Re-running `/epic-execute <epicId>` resumes
  from the `epic-run-state` structured comment if present; otherwise it
  initializes a fresh run. Restarts are safe.
- **Single pause point.** Only `agent::blocked` halts execution. All other
  Epic labels are informational during the run.
- **Snapshot modifier.** `epic::auto-close` is read **once** at run start.
  Adding it mid-run is ignored; removing it mid-run is ignored. The captured
  value lives in the `epic-run-state` checkpoint and survives restarts.
- **No clarifying questions.** Like every skill in this workflow,
  `/epic-execute` runs without a human input channel between waves. If the
  skill cannot make progress without input, it transitions the Epic to
  `agent::blocked`, posts a friction comment, and parks until the operator
  flips it back to `agent::executing`.

---

## Step 1 — Snapshot the Epic and `epic::auto-close`

Read the Epic ticket once. Capture the `epic::auto-close` modifier as a
boolean **at this exact moment** — this is the authoritative `autoClose` value
for the entire run.

```js
const epic = await provider.getTicket(epicId);
const autoClose = (epic.labels ?? []).includes('epic::auto-close');
```

Validate the type label — if it isn't `type::epic`, exit with a clear error
rather than continuing.

---

## Step 2 — Build the wave DAG

Enumerate the Epic's descendants via `provider.getSubTickets(epicId)`, filter
to `type::story`, and compute waves via `Graph.computeWaves()`:

```js
import { computeWaves } from '.agents/scripts/lib/Graph.js';

const descendants = await provider.getSubTickets(epicId);
const stories = descendants.filter((t) => (t.labels ?? []).includes('type::story'));
if (!stories.length) throw new Error(`Epic #${epicId} has no child Stories.`);

const { adjacency, taskMap } = buildStoryDag(stories); // see build-wave-dag.js
const waves = computeWaves(adjacency, taskMap);
```

Dependency edges come from `blocked by #N` parsed from each Story's body
(via `parseBlockedBy`) plus any explicit `dependencies` field on the
provider-returned object. Foreign IDs (Stories not in the Epic) are dropped so
the DAG stays closed over the scheduled set.

The wave order from `computeWaves()` matches the wave order recorded in the
`dispatch-manifest` structured comment that `/epic-plan` upserted on the
Epic. `/wave-execute` reads that manifest at dispatch time, so as long as the
DAG-builder rules stay in lock-step, the runtime wave layout and the
manifest's `earliestWave` integers agree by construction.

---

## Step 3 — Initialize the `epic-run-state` checkpoint

Write the initial checkpoint via the marker-scoped upsert. Re-running mid-flow
re-reads this comment instead of starting over.

```js
import { Checkpointer } from '.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';

const cp = new Checkpointer({ provider, epicId });
const state = await cp.initialize({
  totalWaves: waves.length,
  concurrencyCap,
  autoClose,
});
```

The marker is `epic-run-state` (constant `EPIC_RUN_STATE_TYPE`). Schema
version is bumped via `CHECKPOINT_SCHEMA_VERSION` in `checkpointer.js`. The
canonical fields are documented in tech spec #323; do not invent new ones —
the BookendChainer and the checkpoint resume path both depend on the exact
shape.

After writing the checkpoint, flip the Epic to `agent::executing` (this is
idempotent — re-runs land on the same label).

---

## Step 4 — Iterate waves

For each wave `N` from `0` to `totalWaves - 1`:

1. **Dispatch.** Emit one assistant turn that invokes `/wave-execute <epicId>
   <N>` via a single `Agent` tool call (not parallel — `/wave-execute` itself
   handles parallel Story fan-out internally). Use `subagent_type:
   general-purpose`. The child prompt must:

   - State the Epic id and the wave index.
   - Tell the sub-agent to invoke `/wave-execute <epicId> <N>`.
   - State the **return contract** the wave skill owes the parent:

     ```json
     {
       "epicId": <number>,
       "wave": <number>,
       "status": "complete" | "blocked" | "failed",
       "stories": [ { "id": <n>, "status": "done|blocked|failed" }, ... ],
       "blockedStoryIds": [ ... ]
     }
     ```

   - Remind the sub-agent of the non-interactive contract: no clarifying
     questions, transition to `agent::blocked` and exit if truly stuck.

2. **Read the wave summary.** Parse the JSON returned by the Agent tool call.
   `/wave-execute` will already have upserted a `wave-run-progress` comment on
   the Epic — that is the source of truth for per-Story state in this wave.

3. **Roll up `epic-run-progress`** (see Step 5 below) so the operator's
   single-comment view on the Epic ticket reflects every wave so far.

4. **Advance the checkpoint.** Append the wave's outcome to `state.waves[]`
   and re-write `epic-run-state` via `Checkpointer.write(state)`. This is what
   makes restarts idempotent.

5. **Branch on status:**
   - `complete` → continue to the next wave.
   - `blocked`  → invoke the blocker handler (Step 6) and park.
   - `failed`   → post a friction comment, flip Epic to `agent::blocked`,
                  park.

When all waves return `complete`, the iteration phase is done.

---

## Step 5 — Roll up `epic-run-progress`

After each wave returns, build the operator-facing summary by reading every
`wave-run-progress` structured comment on the Epic and folding them into a
single `epic-run-progress` upsert.

```js
import {
  parseWaveRunProgressComment,
  upsertEpicRunProgress,
} from '.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';

const comments = await provider.getComments(epicId);
const waveSnapshots = comments
  .filter((c) => c.body?.includes('ap:structured-comment type="wave-run-progress"'))
  .map(parseWaveRunProgressComment)
  .filter(Boolean)
  .sort((a, b) => a.wave - b.wave);

await upsertEpicRunProgress({
  provider,
  epicId,
  waves: waveSnapshots,        // each entry holds its own stories[] roll-up
  currentWave: state.currentWave,
  totalWaves: waves.length,
  startedAt: state.startedAt,
});
```

The marker is `epic-run-progress` and the body wraps a fenced JSON block
matching the canonical payload defined in tech spec #902:

```json
{
  "kind": "epic-run-progress",
  "epicId": <number>,
  "currentWave": <number>,
  "totalWaves": <number>,
  "waves": [
    {
      "wave": 0,
      "concurrencyCap": 3,
      "stories": [
        { "id": 912, "title": "...", "state": "done",       "tasksDone": 3, "tasksTotal": 3 },
        { "id": 916, "title": "...", "state": "blocked",    "blockerCommentId": "..." }
      ]
    },
    { "wave": 1, "stories": [ ... ] }
  ],
  "updatedAt": "<iso8601>"
}
```

The collation reader **never re-derives Story state from labels** — it trusts
the wave snapshots, which were themselves computed from each Story's
`story-run-progress` comment. This keeps the rollup deterministic and decouples
it from transient label drift.

If a wave's `wave-run-progress` comment is missing or unparseable, fall back
to `{ wave: N, stories: [] }` for that entry rather than crashing the rollup.
A log warning is sufficient — the wave loop has already recorded the failure
in the checkpoint.

---

## Step 6 — Blocker handling

When a wave returns `blocked` (or the Epic label transitions to
`agent::blocked` mid-run via the `BlockerHandler`'s observer):

1. **Flip the Epic** to `agent::blocked` (the handler does this for you).
2. **Post a structured friction comment** describing the blocker and listing
   `blockedStoryIds` so the operator can drill straight into the offending
   Story tickets.
3. **Fire the notification hook** (Slack / Discord webhook, fire-and-forget
   via `notification-hook.js`).
4. **Halt dispatch of the next wave.** In-flight Stories from the current
   wave are already done returning by the time the parent reaches this step,
   because Step 4 reads the wave's Agent-tool result synchronously.
5. **Wait for resume.** The handler polls the Epic's labels via the injected
   `labelFetcher` and returns when the operator flips it back to
   `agent::executing`. The next-wave dispatch then resumes from the
   checkpointed `currentWave`.

The skill never decides on its own to give up on a blocker. Resume is always
operator-driven via the label flip.

---

## Step 7 — Finalize

When the wave loop completes without an unresumed halt:

1. **Flip the Epic** to `agent::review`.
2. **Run `column-sync`** so the project board column reflects the new state.
3. **Invoke the `BookendChainer`** with the snapshot value of `autoClose`:
   - `autoClose === true` → auto-invoke `/epic-close <epicId>` via the
     `runSkill` adapter passed in from this skill. `/epic-code-review` and
     `/epic-retro` remain operator-driven; the chainer always lists them in
     the hand-off comment so the operator sees exactly what is left.
   - `autoClose === false` → post the hand-off comment listing the operator's
     remaining bookends — the `helpers/epic-code-review.md` procedure, the
     `helpers/epic-retro.md` procedure, and `/epic-close <epicId>` — and exit
     cleanly.

The chainer never auto-runs review or retro on its own — autonomous closure
must be a single, explicit action.

---

## Live progress for operators

The `epic-run-progress` structured comment on the Epic ticket is the
authoritative live view. It is upserted in place after every wave, so an
operator watching the Epic on GitHub sees one in-place update rather than
N comments. There is no longer a local progress-log file — the previous
`temp/epic-runner-logs/epic-<epicId>-progress.log` channel was retired
together with the headless subprocess spawn pipeline.

When driving the run from an IDE chat, simply watch the assistant turns:
each wave dispatch is an Agent tool call whose result is visible in the
parent session, and the per-wave `wave-run-progress` upsert and the rolled-up
`epic-run-progress` upsert both surface in the Epic ticket.

---

## Idempotence and resume

`/epic-execute` is safe to re-run at any point:

- **Mid-wave restart.** The `epic-run-state` checkpoint is upserted before
  every wave dispatch and after every wave completion, so re-running picks
  up at the next undispatched wave. In-flight Stories from the previous run
  finish their own work via `/story-execute`'s checkpointing
  (`story-init` + `story-run-progress` comments).
- **Re-running a completed Epic.** The checkpoint records `currentWave ===
  totalWaves`. The skill notices, skips iteration, and proceeds straight to
  finalize / bookend.
- **Re-running a blocked Epic.** While the Epic carries `agent::blocked`, the
  blocker handler holds at the wait loop until the operator flips it back to
  `agent::executing`. Re-invoking the skill while still blocked re-enters the
  same wait — that's the expected behaviour, not a bug.

---

## Constraints

- **Never** honor a mid-run change to `epic::auto-close`. The snapshot at
  startup is authoritative.
- **Always** checkpoint via the `Checkpointer` (which calls
  `upsertStructuredComment(provider, epicId, EPIC_RUN_STATE_TYPE, body)`) —
  never write run state anywhere else.
- **Never** dispatch more than one wave at a time. Concurrency lives **inside**
  `/wave-execute`, not across waves.
- **Never** flip Story-level labels from inside this skill. Story-state
  ownership belongs to `/story-execute` and its child sub-agents.
- **Never** re-derive `epic-run-progress` from raw Story labels. The rollup
  must read the per-wave `wave-run-progress` comments so the source of truth
  stays consistent across the hierarchy.
- **Always** post a friction structured comment on the Epic before returning
  a non-`complete` outcome, so the failure is visible on the ticket rather
  than only in chat.
- **Never** spawn a subprocess to dispatch a Story or a wave. In-session
  Agent-tool fan-out is the only supported dispatch path; the legacy
  `claude -p '/story-execute <id>' --dangerously-skip-permissions` pipeline
  is gone.
