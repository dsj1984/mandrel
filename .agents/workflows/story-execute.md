---
description: >-
  Execute one Story end-to-end. Calls `story-init.js`, `cd`s into the worktree,
  iterates child Tasks reading `helpers/task-execute.md` inline per Task,
  writes a `story-run-progress` snapshot per transition, and finally calls
  `story-close.js` to merge into the Epic branch and reap the worktree.
---

# /story-execute #[Story ID]

## Overview

`/story-execute` is the **single-Story worker** in the Epic-centric workflow.
It sits below [`/wave-execute`](wave-execute.md) (which fans out one Story
sub-agent per slot) and runs one Story from init to close in one invocation.

```text
/wave-execute <epicId> <waveN>
  → Agent tool × concurrencyCap parallel calls (one assistant turn):
      /story-execute <storyId>
        → story-init.js
        → for each Task: read helpers/task-execute.md inline
        → story-close.js
```

The argument is always a **Story ID** (`type::story`). Epic IDs go through
[`/epic-execute`](epic-execute.md); Tasks are not directly executable —
they are implemented by their parent Story's loop.

> **Worktree isolation.** When `orchestration.worktreeIsolation.enabled` is
> `true`, Step 0 creates a worktree at `.worktrees/story-<id>/` and prints its
> absolute path as `workCwd`. You **must** `cd` into that path before Step 1.
> The main checkout's HEAD is never moved. When isolation is `false`, `workCwd`
> equals the main checkout. See [`worktree-lifecycle.md`](worktree-lifecycle.md)
> for node_modules strategies, Windows notes, and escape hatches.

---

## Non-interactive execution contract

`/story-execute` runs in two contexts:

- **Sub-agent (the common case)**: launched as one slot of a `/wave-execute`
  fan-out via the `Agent` tool. The sub-agent shares the parent session's
  permissions and tool allowlist but has **no input channel** mid-run — the
  parent cannot answer a clarifying question.
- **Operator (interactive)**: typed directly at the chat prompt for a single
  Story. Conversational clarification is fine here.

**Rules that bind regardless of context:**

- **Never** ask clarifying questions when running as a sub-agent. Pick the
  narrowest reasonable interpretation that satisfies the Task's acceptance
  criteria and proceed. If you cannot proceed at all, transition the Story to
  `agent::blocked`, post a `friction` structured comment with (a) the decision
  needed and (b) the assumption you would default to, and exit non-zero.
- **Never** assume tool-permission prompts will be auto-approved. The Agent
  tool inherits the parent's permission mode; if a prompt would block, treat
  it as a harness condition and transition to `agent::blocked` rather than
  hanging the parent.
- **Always** write `story-run-progress` snapshots at the points listed below
  so the parent (`/wave-execute`) can read Story state without re-fetching
  ticket labels.

---

## Step 0 — Initialize (`story-init.js`)

Run the initialization script from the **main checkout** (not the worktree —
the worktree does not exist yet).

```powershell
node .agents/scripts/story-init.js --story <storyId>
```

The script:

- Fetches the Story ticket and validates it's a `type::story`.
- Checks blockers — exits non-zero if any `blocked by` are open.
- Traces the hierarchy (Feature → Epic → PRD / Tech Spec).
- Enumerates child Tasks in dependency order.
- Bootstraps the Epic branch if missing (in main checkout).
- **Worktree-enabled path**: seeds the `story-<id>` branch ref from the Epic
  branch without moving main's HEAD, then `git worktree add` at
  `.worktrees/story-<id>/`.
- **Single-tree fallback**: checks out the story branch in the main checkout.
- Batch-transitions all child Tasks to `agent::executing`.

**Output**: structured JSON. Key fields the skill consumes:

- `workCwd` — absolute path where every subsequent command runs.
- `worktreeEnabled` — whether worktree isolation is active.
- `dependenciesInstalled` — `'true' | 'false' | 'skipped'` (see Step 0.5).
- `installStatus` — structured `{ status, reason }` behind the tri-state.
- `tasks[]` — dependency-ordered child Task list (`{ id, title, labels,
  dependencies }`).
- `context.prdId`, `context.techSpecId` — fetch these before coding when the
  Task instructions refer to spec-level rationale.

The same fields are upserted as a `story-init` structured comment on the
Story ticket so re-entrant runs can read state via `gh issue view <storyId>
--json comments`.

> **Dry-run**: Add `--dry-run` to check status without git or ticket changes.
> No worktree is created.

### Step 0.5 — `cd` into the workCwd and verify dependencies

```powershell
cd "<workCwd from Step 0 result>"
```

All subsequent git commands, edits, structured-comment writes, and Step 3
closure run from this directory. In worktree-enabled mode this is
`.worktrees/story-<id>/`; in single-tree mode it is the main checkout.

**Dependency install.** Read `dependenciesInstalled` from the Step 0 stdout
JSON (or, when resuming a previously-initialized Story, from the `story-init`
structured comment on the Story ticket). Do **not** infer install state from
the presence or absence of `node_modules/`.

| `dependenciesInstalled` | Meaning                                                                                            | Skill action                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `true`                  | Per-worktree install ran and succeeded.                                                            | Proceed.                                                          |
| `false`                 | Install was attempted and failed.                                                                  | Run the appropriate install command before implementing tasks.    |
| `skipped`               | No per-worktree install was performed (single-tree, reused worktree, `symlink`, `pnpm-store`).     | Trust the strategy; only install if a downstream tool errors out. |

If `dependenciesInstalled === 'false'`, run the install:

```powershell
npm ci    # or: pnpm install --frozen-lockfile / yarn install --frozen-lockfile
```

### Step 0.6 — Initial `story-run-progress` snapshot

Immediately after `cd`, upsert a `story-run-progress` comment on the Story
with every child Task pinned to `pending` and `phase = "init"`:

```js
import { upsertStoryRunProgress } from '.agents/scripts/lib/orchestration/epic-runner/story-run-progress-writer.js';

await upsertStoryRunProgress({
  provider,
  storyId,
  branch: `story-${storyId}`,
  phase: 'init',
  tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: 'pending' })),
});
```

This anchors the comment so `/wave-execute`'s aggregator can find a
deterministic snapshot for this Story even before any Task starts.

---

## Step 1 — Implementation (Sequential Task Loop)

For **each child Task** in the order returned by `story-init.js`:

1. Mark the Task `executing` in the in-memory snapshot and upsert
   `story-run-progress` with `phase = "implementing"` so the parent sees the
   transition immediately.
2. Read [`helpers/task-execute.md`](helpers/task-execute.md) and follow it for
   this Task. The helper covers reading `## Instructions`, scope discipline,
   the `assert-branch` guard, and the conventional-commit format.
3. After the commit lands, capture the new commit SHA, mark the Task `done`
   in the snapshot, and upsert `story-run-progress` again. The writer carries
   `commitSha` on `done` rows so the wave aggregator can cross-check that the
   merge replay below is replaying the expected commits.
4. If implementation cannot proceed (missing dependency, contradictory
   instructions, blocked-by ticket reopened): mark the Task `blocked`,
   upsert `story-run-progress` with `phase = "blocked"`, transition the
   Story to `agent::blocked`, post a `friction` comment, and exit non-zero.
5. Proceed to the next Task.

> If a commit runs into a merge conflict during a rebase, follow the canonical
> procedure in
> [`helpers/_merge-conflict-template.md`](helpers/_merge-conflict-template.md).

### Per-Task transition cadence

Each Task triggers up to two `story-run-progress` upserts: `pending →
executing` at the start of its slot, and `executing → done|blocked` at the
end. The marker is upserted in place, so the comment count never grows past
one per Story regardless of Task count.

---

## Step 2 — Validate (deferred to close)

`story-close.js` runs the canonical close-validation chain (typecheck,
lint, test, format, maintainability, coverage, crap) before it merges — **do
not** pre-run `npm run typecheck`, `npm run lint`, and `npm test` here unless
you are interactively iterating on a fix. The close script's gate is
authoritative; pre-running them in headless sub-agent runs just doubles the
wall-clock cost of every Story. The typecheck gate sources its command from
`agentSettings.commands.typecheck` when set (e.g. `pnpm exec turbo run
typecheck`) and falls back to `npm run typecheck` otherwise.

**Interactive `--fast` advisory mode.** When iterating in your own terminal
and you want a fast pre-flight before invoking close, run:

```powershell
npm run typecheck
npm run lint
npm test
```

Treat the output as advisory — failures here will be re-surfaced by
`story-close.js` regardless. If you spot a regression, fix it on the Story
branch and commit before proceeding to Step 3.

If genuinely blocked (e.g. upstream dependency missing): mark the Task
`blocked`, upsert `story-run-progress`, post a `friction` comment, and apply
`agent::blocked`.

---

## Step 3 — Close (`story-close.js`)

Before invoking close, upsert one final `story-run-progress` snapshot with
`phase = "closing"` so the parent sees the Story enter the merge phase.

Run closure. Pass the main-checkout path via `--cwd` so the merge and branch
deletion run against the main repo, not inside the worktree (branches checked
out in a worktree cannot be deleted from themselves). The close script reaps
the worktree after the merge succeeds.

```powershell
# From the worktree, invoke close against the main checkout.
node <main-repo>/.agents/scripts/story-close.js --story <storyId> --cwd <main-repo>
```

In single-tree mode, `--cwd` can be omitted (defaults to `PROJECT_ROOT`).

The script:

- Merges the Story branch into `epic/<epicId>` with `--no-ff`.
- Pushes the Epic branch.
- Deletes the Story branch (local + remote).
- **Reaps the worktree** (`.worktrees/story-<id>/`) via `WorktreeManager.reap` —
  refuses if uncommitted or unmerged.
- Batch-transitions all child Tasks and the Story to `agent::done`.
- Runs `cascadeCompletion()` to propagate closure up the hierarchy.
- Runs `health-monitor.js` to update sprint metrics.
- Regenerates the Epic dispatch manifest. Pass `--skip-dashboard` to suppress.

**Output**: structured JSON with `ticketsClosed[]`, `cascadedTo[]`, and
worktree reap status.

> **Why not use GitHub auto-close?** GitHub's `Closes #N` only fires when
> merging into the repo's default branch. Story branches merge into
> `epic/<epicId>`, so we close tickets explicitly via the state writer.

After `story-close.js` returns successfully, upsert one last
`story-run-progress` snapshot with `phase = "done"` and every Task in
`done` state. The wave aggregator reads this terminal snapshot to confirm
Story closure without re-fetching ticket labels.

---

## Step 4 — Return contract (sub-agent path)

When `/story-execute` runs as a sub-agent of `/wave-execute`, return one JSON
object to the parent:

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

`status === 'done'` is reserved for runs where every Task closed and
`story-close.js` reported `branchDeleted: true`. Any other terminal state is
`blocked` (recoverable by the operator) or `failed` (unrecoverable; needs
triage).

When run interactively by an operator, the final `story-run-progress` and
`story-close` JSON output already convey the same information; an explicit
JSON return is optional.

---

## Idempotence

- `story-init.js` is idempotent — re-running it on a Story whose worktree
  already exists prints the same `workCwd` without re-creating the worktree.
- `story-run-progress` is upserted in place — re-running the loop replaces
  the body without growing comment count.
- `story-close.js` short-circuits when the Story branch is already merged
  and deleted: it returns success with `branchDeleted: false` and skips the
  merge replay. A re-run of `/story-execute` against an already-closed Story
  is therefore safe.

---

## Constraints

- **Never** push the Story branch directly to `main`. `story-close.js` is the
  only writer that integrates Story work upstream — and only into
  `epic/<epicId>`.
- **Never** merge across Story branches. Each Story is self-contained; cross-
  Story dependencies are encoded as `blocked by` ticket relationships and
  resolved by wave ordering, not by inter-Story merges.
- **Always** `cd` into the `workCwd` returned by Step 0 before editing.
- **Always** verify `git branch --show-current` outputs the expected Story
  branch name before any commit. If it does not, **STOP**.
- **Always** upsert a `story-run-progress` snapshot at every Task transition
  (`pending → executing`, `executing → done|blocked`) and at every phase
  transition (`init → implementing → closing → done|blocked`). The wave
  aggregator's correctness depends on reading this comment, not labels.
- **Always** pass `--cwd <main-repo>` to `story-close.js` when invoking from
  inside a worktree, so the merge runs in the main repo.
- **Always** run `cascadeCompletion` after merging — GitHub cannot auto-close
  tickets on non-default-branch merges. `story-close.js` does this for you.
- **Always** delete the Story branch (local + remote) after merging into the
  Epic branch. `story-close.js` does this for you.
- **MCP fallback**: if `agent-protocols` MCP tools fail due to connection
  errors, fall back immediately to
  `node .agents/scripts/update-ticket-state.js --task <id> --state <state>`
  (which auto-cascades on `--state agent::done`). Do not leave tickets in
  stale states.
