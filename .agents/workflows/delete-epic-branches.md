---
description: >-
  Delete all local and remote Git branches (and any associated worktrees)
  for an Epic and its child Stories/Tasks/Features. Worktree-only scope —
  this workflow never touches GitHub issues, labels, or ticket state.
---

# Delete Epic Branches Workflow

This workflow provides a manual cleanup mechanism specifically for **Git
branches and worktrees** when an Epic needs to be reset. It deletes both
local and `origin/` branches for the Epic and its full hierarchy.

> **Worktree-only scope.** This workflow does **not** close, label, or
> otherwise mutate GitHub tickets. It also does not invoke any
> `ITicketingProvider`. Issue lifecycle (closure, cascade, agent::done
> labels) is owned by `story-close.js` / `epic-deliver-finalize.js` —
> there is no separate ticket-reset workflow.

The enumeration + deletion logic lives in
[`delete-epic-branches.js`](../scripts/delete-epic-branches.js) — this
workflow is a thin operator-confirmation wrapper. The script matches:

- `epic/<id>`
- `task/epic-<id>/*`
- `feature/epic-<id>/*`
- `story/epic-<id>/*`

against both local and `origin/` remote refs.

> **When to run**: When an Epic needs to be scrapped or reset, but you want to
> handle branch deletion independently of issue deletion.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

## Step 1 — Confirmation

Confirm with the operator that they want to delete branches.

> [!WARNING] This will permanently delete branches. Ensure all valuable code is
> backed up or committed elsewhere.

## Step 2 — Checkout Stable Branch

Always switch to a stable branch (e.g., `main`) before deletion so the Epic
branch isn't the current HEAD when `git branch -D` runs.

```powershell
git checkout main
```

## Step 3 — Dry-run Audit

Preview the exact refs that will be deleted:

```powershell
node .agents/scripts/delete-epic-branches.js --epic [EPIC_ID] --dry-run
```

The script prints the matched local + remote branches. Add `--json` if you
want the plan as a structured `{ epicId, local, remote, dryRun }` payload.

## Step 4 — Final Operator Approval

Verify the dry-run output. Ask: "Are you sure you want to delete these
branches?"

## Step 5 — Execute

```powershell
node .agents/scripts/delete-epic-branches.js --epic [EPIC_ID]
```

The script deletes every matched local branch (`git branch -D`) and remote
branch (`git push origin --delete`). Remote refs that are already gone are
treated as idempotent success; any other failure surfaces via exit code 1.

Add `--json` to receive a structured result suitable for programmatic
consumption:

```json
{
  "epicId": 441,
  "local":  [{ "branch": "epic/441", "ok": true }, ...],
  "remote": [{ "branch": "story/epic-441/453", "ok": true, "alreadyGone": false }, ...],
  "failures": [],
  "ok": true
}
```

## Constraint

Do **not** run this workflow if there is unmerged work that needs saving.
Always perform Step 3 (Dry-run Audit) and Step 4 (Approval) before deletion.
