---
description: >-
  Execute one Story end-to-end. Calls `story-init.js`, `cd`s into the worktree,
  iterates child Tasks reading `helpers/task-execute.md` inline per Task,
  writes a `story-run-progress` snapshot per transition, and finally calls
  `story-close.js` to merge into the Epic branch and reap the worktree.
---

# /story-execute #[Story ID]

## Overview

`/story-execute` is the **single-Story worker**. It sits below
[`/epic-execute`](epic-execute.md) (which fans out one Story sub-agent per
slot, per wave) and runs one Story from init to close in one invocation.

```text
/epic-execute <epicId>
  → for each wave N:
      Agent tool × concurrencyCap parallel calls (one assistant turn):
        /story-execute <storyId>
          → story-init.js
          → for each Task: read helpers/task-execute.md inline
          → story-close.js
```

The argument is always a **Story ID** (`type::story`). Epic IDs go through
[`/epic-execute`](epic-execute.md); Tasks are not directly executable —
they are implemented by their parent Story's loop.

> **Worktree isolation.** When `orchestration.worktreeIsolation.enabled` is
> `true`, Step 0 creates a worktree at `.worktrees/story-<id>/` and prints
> its absolute path as `workCwd`. You **must** `cd` into that path before
> Step 1. The main checkout's HEAD is never moved. See
> [`worktree-lifecycle.md`](worktree-lifecycle.md) for node_modules
> strategies, Windows notes, and escape hatches.

---

## Non-interactive execution contract

`/story-execute` runs as a sub-agent of `/epic-execute`'s per-wave fan-out
(common case) or interactively for a single Story. Sub-agent runs share
the parent's permissions but have **no input channel** mid-run.

- **Never** ask clarifying questions as a sub-agent. Pick the narrowest
  reasonable interpretation that satisfies the Task's AC. If you cannot
  proceed, transition to `agent::blocked`, post a `friction` comment with
  the decision needed and the default assumption, and exit non-zero.
- **Never** assume tool-permission prompts will be auto-approved. Treat a
  blocking prompt as a harness condition and transition to `agent::blocked`.
- **Always** write `story-run-progress` snapshots at every Task and phase
  transition so the parent aggregator never falls back to label
  re-derivation.

---

## Step 0 — Initialize (`story-init.js`)

Run from the **main checkout** (the worktree does not exist yet):

```bash
node .agents/scripts/story-init.js --story <storyId>
```

The script validates `type::story`, checks blockers, traces the
Feature → Epic → PRD/Tech-Spec hierarchy, enumerates child Tasks in
dependency order, seeds `story-<id>` from the Epic branch, and (when
worktree isolation is on) runs `git worktree add` at
`.worktrees/story-<id>/`. All child Tasks are batch-transitioned to
`agent::executing` and a `story-init` structured comment is upserted.

Capture `workCwd`, `dependenciesInstalled` (tri-state), `tasks[]`, and
`context.{prdId,techSpecId}`. Add `--dry-run` to check status without git
or ticket changes.

### Step 0.5 — `cd` into the workCwd

```bash
cd "<workCwd from Step 0 result>"
```

All subsequent commands run from this directory. The `dependenciesInstalled`
tri-state carries one of three values:

| Value     | Meaning                                                                            | Action                                              |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `true`    | Per-worktree install ran and succeeded.                                            | Proceed.                                            |
| `false`   | Install was attempted and failed.                                                  | The next CLI runs the install before proceeding.    |
| `skipped` | No per-worktree install (single-tree, reused worktree, `symlink`, `pnpm-store`).   | Trust the strategy.                                 |

### Step 0.6 — Initial `story-run-progress` snapshot

Re-read the `story-init` comment, apply the install tri-state, and upsert
the initial snapshot (every Task pinned to `pending`, `phase: "init"`):

```bash
node .agents/scripts/story-execute-prepare.js --story <storyId> --cwd .
```

The CLI runs the install command when `dependenciesInstalled === 'false'`
(default `npm ci`; override with `--install-cmd "<cmd>"`).

The CLI's stdout JSON envelope carries a `renderedBody` field — the markdown
body that was upserted onto the Story ticket. **Relay it verbatim to chat**
so operators see the initial task table before the first commit lands. Do
the same after every transition in Step 1 / Step 3 (the body is the
hierarchical Story-level rollup the parent `/epic-execute` aggregator
reads).

---

## Step 1 — Implementation (Sequential Task Loop)

For **each child Task** in the order returned by `story-init.js`:

1. Mark the Task `executing` and flip `phase` to `implementing`:

   ```bash
   node .agents/scripts/story-task-progress.js \
     --story <storyId> --task <taskId> --state executing --phase implementing
   ```

2. Read [`helpers/task-execute.md`](helpers/task-execute.md) — it covers the
   `## Instructions` read, scope discipline, and the single
   `task-commit.js` invocation (stage, assert-branch, conventional-commit,
   post-commit verify).

3. After the commit lands, capture the SHA from `task-commit.js` stdout and
   record the Task `done`:

   ```bash
   node .agents/scripts/story-task-progress.js \
     --story <storyId> --task <taskId> --state done --commit-sha <sha>
   ```

4. If blocked, mark the Task `blocked`, transition the Story to
   `agent::blocked`, post a `friction` comment, and exit non-zero:

   ```bash
   node .agents/scripts/story-task-progress.js \
     --story <storyId> --task <taskId> --state blocked --phase blocked \
     --blocker-comment-id <id>
   ```

After each `story-task-progress.js` call, **relay the envelope's
`renderedBody` to chat** as the Story's progress update. The body carries
the canonical task-progress table (ID · State · Title · Commit) plus the
phase header — operators read the same table on the Story ticket. Skip
chat relay only when running in a non-interactive sub-agent context where
the parent will aggregate.

> Rebase pauses on conflicts → follow
> [`helpers/_merge-conflict-template.md`](helpers/_merge-conflict-template.md).

The marker is upserted in place — comment count never grows past one.

---

## Step 2 — Validate (deferred to close)

`story-close.js` runs the canonical close-validation chain (typecheck,
lint, test, format, maintainability, coverage, crap) before it merges —
**do not** pre-run those gates here unless interactively iterating on a
fix. (Interactively, `npm run typecheck && npm run lint && npm test` is
fine as advisory pre-flight.)

---

## Step 3 — Close (`story-close.js`)

Flip the snapshot to the closing phase, then invoke close. Pass the
main-checkout path via `--cwd` so the merge and branch deletion run
against the main repo (branches checked out in a worktree cannot be
deleted from themselves):

```bash
node .agents/scripts/story-task-progress.js \
  --story <storyId> --task <lastTaskId> --state done --phase closing

node <main-repo>/.agents/scripts/story-close.js --story <storyId> --cwd <main-repo>
```

In single-tree mode, `--cwd` defaults to `PROJECT_ROOT`. The script merges
into `epic/<epicId>` (`--no-ff`), pushes the Epic branch, deletes the
Story branch, reaps the worktree via `WorktreeManager.reap`, batch-closes
all child Tasks and the Story to `agent::done`, runs
`cascadeCompletion()`, and regenerates the Epic
dispatch manifest (`--skip-dashboard` to suppress). Output is JSON with
`ticketsClosed[]`, `cascadedTo[]`, and reap status.

> **Why not GitHub auto-close?** `Closes #N` only fires on default-branch
> merges; close fires the state writer explicitly.

After close, upsert a terminal snapshot:

```bash
node .agents/scripts/story-task-progress.js \
  --story <storyId> --task <lastTaskId> --state done --phase done
```

---

## Step 4 — Return contract (sub-agent path)

When run as a sub-agent, return one JSON object:

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

`status === 'done'` requires every Task closed and
`branchDeleted: true`.

`renderedBody` is the **most recent** `renderedBody` returned by
`story-task-progress.js` (typically the `phase: 'done'` snapshot at close,
or the `phase: 'blocked'` snapshot on a blocker). The parent
`/epic-execute` may inline a digest of this in its wave-level Notable
section. When run interactively (no parent), omit it — the chat already
has the latest body relayed during Step 1 / Step 3.

---

## Idempotence

`story-init.js` re-prints the same `workCwd` without recreating the
worktree. `story-run-progress` is upserted in place. `story-close.js`
short-circuits when the Story branch is already merged and deleted. Re-
running `/story-execute` against an already-closed Story is safe.

---

## Constraints

- **Never** push the Story branch directly to `main`. `story-close.js` is
  the only writer that integrates upstream, and only into `epic/<epicId>`.
- **Never** merge across Story branches; cross-Story dependencies are
  resolved by wave ordering via `blocked by`.
- **Always** `cd` into the `workCwd` returned by Step 0 before editing.
- **Always** verify branch identity before each commit (`task-commit.js`
  enforces this — keep its invocation in the loop).
- **Always** upsert a `story-run-progress` snapshot at every Task and phase
  transition. The wave aggregator depends on this comment, not labels.
- **Always** pass `--cwd <main-repo>` to `story-close.js` when invoking
  from inside a worktree.
- **MCP fallback**: if `agent-protocols` MCP tools fail, fall back to
  `node .agents/scripts/update-ticket-state.js --task <id> --state <state>`.
