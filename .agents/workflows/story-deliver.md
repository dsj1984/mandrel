---
description: >-
  Deliver one or more standalone Stories end-to-end. Accepts 1+ Story IDs,
  computes a dependency-aware wave plan via `stories-wave-tick.js`, asks the
  operator to confirm the plan, then fans out parallel Agent calls per wave
  — each delegating to `helpers/single-story-deliver`. Stories without an
  `Epic: #N` reference only; Epic-attached Stories use `/epic-deliver`.
---

# /story-deliver [Story IDs...]

## Overview

`/story-deliver` is the **operator-facing multi-Story delivery command**. It
takes one or more Story IDs, builds a dependency-aware wave plan, optionally
confirms it with the operator, and fans out one Agent call per Story per wave
— parallel within each wave, serialised across waves.

```text
/story-deliver 101 102 103
  → Phase 0 — Validate input & build DAG
  → Phase 1 — stories-wave-tick.js → wave plan + operator confirmation
  → Phase 2 — for each wave:
        Agent tool × min(wave.stories.length, concurrencyCap) parallel calls
          helpers/single-story-deliver <storyId>
  → Phase 3 — Summary
```

**When to use `/story-deliver` vs. other commands:**

| Scenario | Command |
| --- | --- |
| 1+ standalone Stories (no `Epic: #N` in body) | `/story-deliver <id> [<id>...]` |
| Exactly one standalone Story (lighter path) | `/single-story-deliver <id>` |
| Epic-attached Stories (have `Epic: #N`) | `/epic-deliver <epicId>` |

`/story-deliver` **refuses** Stories that carry an `Epic: #N` reference in
their body. Those Stories belong to an Epic's dispatch manifest and must flow
through `/epic-deliver`. Use `/single-story-deliver` for a single Epic-free
Story when you want the leaner one-story path without wave machinery.

> **Concurrency cap.** The default is 3 parallel Agent calls per wave.
> Override via `delivery.deliverRunner.concurrencyCap` in `.agentrc.json`.

---

## Arguments

```text
/story-deliver <storyId> [<storyId> ...] [--dep <fromId>:<toId> ...] [--yes] [--concurrency <n>]
```

- `storyId` — One or more GitHub issue numbers carrying `type::story` and
  **no** `Epic: #N` reference. At least one is required.
- `--dep <fromId>:<toId>` — Declare an explicit dependency edge: `<fromId>`
  must complete before `<toId>` runs. Repeat for each edge. When omitted,
  all Stories are treated as independent (wave 0 catches everything) unless
  `blocked by #N` references between the supplied IDs are detected
  automatically.
- `--yes` — Skip the operator confirmation in Phase 1 and proceed
  immediately. Safe for scripted / sub-agent invocations.
- `--concurrency <n>` — Override the per-wave concurrency cap for this run
  only.

---

## Phase 0 — Validate input and build DAG

For each supplied Story ID:

1. Confirm the issue exists and carries the `type::story` label.
2. Confirm the issue body does **not** contain an `Epic: #N` reference. If
   it does, STOP and tell the operator to use `/epic-deliver <epicId>`
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

## Phase 1 — Wave planning and operator confirmation

### 1a. Compute the wave plan

```bash
node .agents/scripts/stories-wave-tick.js --dag '<dag-json>'
```

Stdout is one JSON envelope:

```json
{
  "kind": "stories-wave-plan",
  "waves": [
    { "waveIndex": 0, "stories": [101, 103] },
    { "waveIndex": 1, "stories": [102] }
  ],
  "totalStories": 3,
  "cycleError": null
}
```

- **`cycleError` non-null** → STOP. Report the cycle to the operator and
  exit. The Story set cannot be delivered until the circular dependency is
  resolved.
- **`waves` empty** → STOP. Zero Stories resolved — report and exit.

### 1b. Operator confirmation (skipped with `--yes` or for single-story plans)

**Auto-skip rule (Story #3302):** When `waves.length === 1` and
`waves[0].stories.length === 1`, skip the confirmation prompt
automatically and proceed. A single-Story plan has no ordering ambiguity
and no meaningful operator decision to make — the plan *is* "deliver this
one Story". Prompting for confirmation would just be friction.

Otherwise, present the wave plan to the operator in a readable table:

```text
Wave plan — 3 Stories across 2 waves
  Wave 0 (parallel): #101 "<title>", #103 "<title>"
  Wave 1 (after wave 0): #102 "<title>"

Proceed? [Y/n]
```

Wait for the operator to confirm before dispatching. When the operator
types `n` or `N`, abort cleanly with a summary of the plan that was
declined. When `--yes` was passed, skip this step and proceed regardless
of wave count.

---

## Phase 2 — Wave dispatch loop

For each wave in `waves` (in `waveIndex` order):

### 2a. Fan out per-Story Agent calls

Emit **one `Agent` tool call per Story** in the wave. When the wave
contains more Stories than `concurrencyCap`, dispatch the first
`concurrencyCap` in one turn with `run_in_background: true` and refill
as each child returns — never exceed the cap, never wait for the whole
batch before refilling.

Each Agent call:

1. Names the Story ID and instructs the child to invoke
   [`helpers/single-story-deliver`](helpers/single-story-deliver.md)
   for that Story.
2. States the **return contract** (see § 2c).
3. Reminds the child of the **non-interactive contract**: no clarifying
   questions — if stuck, transition to `agent::blocked`, post a
   `friction` comment, and exit non-zero.
4. Requests the child suppress per-phase chat relay and include its
   **terminal** `renderedBody` in the JSON return.

Use `subagent_type: general-purpose`.

### 2b. Collect results

Wait for all dispatched Stories in the current wave to return before
advancing to the next wave. A wave is complete when every dispatched
Agent call has returned a result (success, blocked, or failed).

### 2c. Per-Story return contract

Each child returns:

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

### 2d. Wave outcome handling

After every Story in a wave returns:

- **All `status === 'done'`** → Advance to the next wave (or Phase 3 if
  this was the last wave). Print a one-line wave-complete summary.
- **Any `status === 'blocked'`** → STOP the wave loop. Post a summary
  of blocked Stories and their `blockerCommentId` references. Do not
  dispatch the next wave. Wait for the operator to resolve each blocker
  and re-run `/story-deliver` with the same set (already-done Stories
  will short-circuit because `single-story-close.js` is idempotent).
- **Any `status === 'failed'`** → STOP the wave loop. Report the
  failures. The operator must fix the failing Stories before re-running.

---

## Phase 3 — Summary

Print a final run summary:

```text
/story-deliver — 3 Stories delivered in 2 waves

  Wave 0: #101 ✅ done, #103 ✅ done
  Wave 1: #102 ✅ done

All Stories delivered. PRs opened, auto-merge armed. CI will merge each
PR when checks pass; each child then confirms the merge and flips its
Story to `agent::done` (Story #3385 — until the merge confirms, a Story
rests at `agent::closing` with its issue OPEN). Run
`git-cleanup --fast-forward-main` after the last merge to bring local
main up to date.
```

When some Stories are blocked or failed, list them explicitly with the
`blockerCommentId` or failure detail so the operator knows where to look.

---

## Idempotence

`/single-story-deliver` is idempotent at every phase:
`single-story-init.js` reuses an existing worktree and
`single-story-close.js` short-circuits when the Story is already closed.
Re-running `/story-deliver` with the same Story set after a partial
failure is safe — already-done Stories produce no-op outcomes; only the
blocked or unstarted Stories execute.

---

## Constraints

- **Never** pass Epic-attached Stories to this command. Detect `Epic: #N`
  in Phase 0 and STOP.
- **Never** advance to the next wave while any Story in the current wave
  is `blocked` or `failed`.
- **Never** exceed `concurrencyCap` parallel Agent calls at any moment.
- **Always** confirm the wave plan with the operator before dispatching,
  unless `--yes` was passed.
- **MCP fallback**: if `mandrel` MCP tools fail, fall back to
  `node .agents/scripts/update-ticket-state.js --ticket <id> --state <state>`
  for label transitions.

---

## See also

- [`helpers/single-story-deliver`](helpers/single-story-deliver.md) — the
  per-Story worker this command delegates to.
- [`/epic-deliver`](epic-deliver.md) — full Epic wave loop for
  Epic-attached Stories.
- [`helpers/epic-deliver-story`](helpers/epic-deliver-story.md) — the
  per-Story worker `/epic-deliver` uses internally.
