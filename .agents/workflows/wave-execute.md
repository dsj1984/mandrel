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

`/wave-execute` is the **wave-level worker** in the Epic-centric workflow. It
sits between [`/epic-execute`](epic-execute.md) (long-running orchestrator) and
[`/story-execute`](story-execute.md) (single-Story worker):

```text
/epic-execute <epicId>
  → for each wave N:
      /wave-execute <epicId> <N>
        → Agent tool × concurrencyCap parallel calls (one assistant turn):
            /story-execute <storyId>
```

The skill is a **single-pass operation**: one invocation handles one wave end
to end. It does not loop, does not poll, and does not spawn subprocesses. The
fan-out is in-session — every child Story runs as a sub-agent that shares the
parent's tool permissions and Claude session.

**Engine.** This skill drives the planning and aggregation logic in
[`lib/orchestration/epic-runner/story-launcher.js`](../scripts/lib/orchestration/epic-runner/story-launcher.js)
and
[`lib/orchestration/epic-runner/wave-run-progress-writer.js`](../scripts/lib/orchestration/epic-runner/wave-run-progress-writer.js).
There is no top-level `wave-execute.js` CLI — the skill itself emits the
Agent-tool dispatch turn.

> 📎 See tech spec **#902** for the architectural rationale (why Agent-tool
> dispatch replaced subprocess spawn, the progress-collation contract, and the
> structured-comment payload shape).

## Arguments

```text
/wave-execute <epicId> <waveN>
```

- `epicId` — the GitHub Issue number of the Epic. Must carry `type::epic`.
- `waveN` — zero-indexed wave number (matches `waves[].waveIndex` in the
  dispatch manifest). Wave `0` is the first wave.

Both arguments are **required**. The skill does not infer the active wave
from Epic state; the caller (`/epic-execute` or an operator running waves by
hand) is responsible for picking the right index.

---

## Step 1 — Read the dispatch manifest

Fetch the `dispatch-manifest` structured comment from the Epic issue. The
comment was upserted by `/epic-plan` after Phase 4 and is the **single source
of truth** for which Stories belong to each wave.

```bash
gh issue view <epicId> --json comments \
  | jq -r '.comments[] | select(.body | contains("ap:structured-comment type=\"dispatch-manifest\"")) | .body' \
  | head -1
```

The comment body wraps a fenced `json` block matching
[`dispatch-manifest.json`](../schemas/dispatch-manifest.json). The relevant
fields are `storyManifest[]` (Story-centric grouping) and each entry's
`earliestWave` integer.

**Selection rule.** A Story belongs to wave `N` when
`storyManifest[i].earliestWave === waveN`. Stories with a later
`earliestWave` are skipped (they belong to a future wave); stories with an
earlier `earliestWave` are skipped (they belong to a prior wave that has
already run, or were recut into a follow-on).

If the manifest is missing, malformed, or has no Stories for the requested
wave: **STOP** and post a `friction` structured comment on the Epic
explaining the failure. Do not attempt to dispatch Stories you cannot
discover deterministically.

---

## Step 2 — Plan the wave

Hand the selected Stories to `StoryLauncher.planWave(stories)`:

```js
import { StoryLauncher } from '.agents/scripts/lib/orchestration/epic-runner/story-launcher.js';

const launcher = new StoryLauncher({
  concurrencyCap: cfg.orchestration.runners.epicRunner.concurrencyCap,
});
const plan = launcher.planWave(stories); // [{ storyId, modelTier, worktree? }]
```

`planWave` is pure — it produces a stable ordered list of
`{ storyId, modelTier, worktree? }` entries. It does **not** dispatch; the
skill keeps that responsibility because Agent-tool fan-out is a Claude-session
primitive, not a script-level one.

---

## Step 3 — Fan out via Agent tool calls

Emit **one assistant turn** containing **N parallel `Agent` tool calls**, one
per Story in the plan, where `N === min(plan.length, concurrencyCap)`. Use
`subagent_type: general-purpose` for every call.

When `plan.length > concurrencyCap`, dispatch the first `concurrencyCap`
Stories in the assistant turn, wait for the batch to return, then emit a
follow-up turn with the next batch. **Never** dispatch more than
`concurrencyCap` Stories in flight at once — that is the only rate-limit the
framework enforces against the parent session's context budget.

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
     "detail": <string|undefined>
   }
   ```

4. Reminds the sub-agent of the **non-interactive contract** (no clarifying
   questions, transition to `agent::blocked` and exit if truly stuck — the
   parent session has no input channel into a sub-agent prompt mid-run).

Sub-agents inherit the parent's tool permissions and worktree context; they do
**not** require `--dangerously-skip-permissions` (no subprocess is spawned).

### Aggregating returns

Collect every Agent tool result. For each Story, produce a row of:

```js
{
  id: storyId,
  title: storyTitle,        // from manifest
  state: status,            // 'done' | 'blocked' | 'failed' | 'in-flight'
  tasksDone, tasksTotal,
  blockerCommentId,         // when state === 'blocked'
}
```

A Story counts as **successful** only when `status === 'done'`. Any other
return value blocks wave completion.

---

## Step 4 — Upsert `wave-run-progress`

Hand the aggregated rows to the writer:

```js
import { upsertWaveRunProgress } from '.agents/scripts/lib/orchestration/epic-runner/wave-run-progress-writer.js';

await upsertWaveRunProgress({
  provider,
  epicId,
  wave: waveN,
  concurrencyCap,
  stories: rows,
});
```

The writer renders a markdown body that wraps the canonical fenced-JSON
payload defined in tech spec #902:

```json
{
  "kind": "wave-run-progress",
  "epicId": <number>,
  "wave": <number>,
  "concurrencyCap": <number>,
  "stories": [
    { "id": <n>, "title": "...", "state": "done",       "tasksDone": 3, "tasksTotal": 3 },
    { "id": <n>, "title": "...", "state": "blocked",    "blockerCommentId": "..." }
  ],
  "updatedAt": "<iso8601>"
}
```

The comment is upserted on the **Epic ticket** (not the Story tickets) so
operators see one row per Story per wave in a single in-place update.
`/epic-execute` reads these comments to assemble its own
`epic-run-progress` rollup.

---

## Step 5 — Return the wave summary

Return one JSON object to the caller (the `/epic-execute` parent or the
operator):

```json
{
  "epicId": <number>,
  "wave": <number>,
  "status": "complete" | "blocked" | "failed",
  "stories": [ { "id": <n>, "status": "done|blocked|failed" }, ... ],
  "blockedStoryIds": [ ... ]
}
```

- `status === 'complete'` ⇔ every Story returned `done`.
- `status === 'blocked'` ⇔ at least one Story returned `blocked` and none
  returned `failed`. The caller (`/epic-execute`) flips the Epic to
  `agent::blocked` and parks.
- `status === 'failed'` ⇔ at least one Story returned `failed`. The caller
  posts a friction comment on the Epic and parks; the operator triages.

The skill never transitions Epic-level state on its own — that is
`/epic-execute`'s responsibility. `/wave-execute`'s only ticket-level
side effects are (a) the `wave-run-progress` upsert on the Epic and (b) the
side effects each Story sub-agent performs on its own ticket.

---

## Idempotence

`/wave-execute` is **idempotent at the comment level**: re-running it for
the same `<epicId> <waveN>` re-reads the manifest, re-plans, re-dispatches,
and re-upserts the `wave-run-progress` comment in place (the marker survives,
the body is overwritten). It does **not** dedupe at the dispatch level — re-
running a wave whose Stories have already merged will re-launch sub-agents
that re-run `/story-execute`, which itself short-circuits when the Story
branch is already closed.

For partial-wave reruns (some Stories done, some blocked), the operator
should drive each blocked Story through `/story-execute <id>` directly
rather than re-firing `/wave-execute` — that avoids re-doing already-merged
work.

---

## Constraints

- **Never** dispatch more than `concurrencyCap` Stories in flight.
  `concurrencyCap` is sourced from
  `agentSettings.runners.epicRunner.concurrencyCap` (resolved by
  `lib/config-resolver.js`).
- **Never** rename, retype, or skip the `wave-run-progress` structured
  comment. The marker string is the only handle `/epic-execute` and the
  progress reporter use to read wave state.
- **Never** flip Epic-level labels (`agent::executing`, `agent::blocked`,
  `agent::review`) from inside this skill. Epic-state ownership belongs to
  `/epic-execute`.
- **Always** include the non-interactive contract in every child prompt.
  Sub-agents that ask clarifying questions stall the parent's tool call
  until manual intervention.
- **Always** post a `friction` structured comment on the Epic before
  returning a non-`complete` status, so the operator sees the failure on
  the ticket rather than only in chat output.
