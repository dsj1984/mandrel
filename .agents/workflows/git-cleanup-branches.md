---
description: >-
  Sweep merged branches (squash-aware) from the local checkout — and
  optionally from `origin/` — with worktree-safe reap order.
---

# Git Cleanup Branches Workflow

General-purpose cleanup for the dozens of `story/…`, `fix/…`, `feat/…`,
`chore/…` branches that accumulate after a long session. The script
detects squash-merged PRs via `gh pr list --state merged` (covering
branches that `git branch --merged main` would miss) and reaps them
locally, optionally on `origin/` too.

The enumeration + reap logic lives in
[`git-cleanup-branches.js`](../scripts/git-cleanup-branches.js) — this
workflow is a thin operator-confirmation wrapper. A branch is a
candidate iff:

- it is not `main`, the current HEAD, or listed in
  `git config branch.protectedBranches`, **and**
- `gh pr list --head <branch> --state merged` returns ≥1 PR, **or**
  `git branch --merged <baseBranch>` includes it.

When a candidate has an attached worktree, the worktree is removed
(force if dirty) **before** `git branch -D`, mirroring the pattern in
[`worktree-lifecycle.md`](helpers/worktree-lifecycle.md).

> **When to run**: After a session that landed several PRs, to clear
> the stale branches the squash-merge workflow leaves behind.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

## Step 1 — Confirmation

Confirm with the operator that they want to sweep merged branches.

> [!WARNING] This will permanently delete merged branches and their
> attached worktrees. Anything not merged to `main` is left alone.

## Step 2 — Checkout Stable Branch

Switch to `main` (or whatever `agentSettings.baseBranch` resolves to)
so the swept branches are never the current HEAD when
`git branch -D` runs.

```powershell
git checkout main
```

## Step 3 — Dry-run Audit

Preview the exact branches that would be reaped (this is the default
mode — the script never deletes anything without `--execute`):

```powershell
node .agents/scripts/git-cleanup-branches.js --dry-run
```

The script prints one line per candidate with its PR number (or
`git-merged` for non-squash merges) and attached-worktree path, if any.
Add `--json` to get a structured `{ candidates, skipped, … }` payload.

Narrow the scope with repeated `--include` / `--exclude` glob flags:

```powershell
node .agents/scripts/git-cleanup-branches.js --dry-run --include "fix/*" --exclude "fix/keep-me"
```

## Step 4 — Final Operator Approval

Review the candidate list. Ask: "Reap all of these locally?" If the
operator also wants to delete the `origin/` refs, confirm separately —
remote deletion is the destructive bit and requires `--remote` on top
of `--execute`.

## Step 5 — Execute

Local-only reap (safe default for most operators):

```powershell
node .agents/scripts/git-cleanup-branches.js --execute
```

Local + `origin/` reap (when the operator explicitly approves it):

```powershell
node .agents/scripts/git-cleanup-branches.js --execute --remote
```

The script removes any attached worktree first, then deletes the
local branch (`git branch -D`), then optionally the remote ref
(`git push origin --delete`). Remote refs that are already gone are
treated as idempotent success.

Add `--json` for a structured result suitable for programmatic
consumption:

```json
{
  "dryRun": false,
  "baseBranch": "main",
  "candidates": [
    {
      "branch": "fix/foo",
      "prNumber": 1471,
      "mergedAt": "2026-05-09T12:00:00Z",
      "hasWorktree": true,
      "worktreePath": "C:/repo/.worktrees/fix-foo",
      "detectedBy": "gh"
    }
  ],
  "skipped": [{ "branch": "feat/wip", "reason": "not-merged" }],
  "worktrees": [{ "path": "C:/repo/.worktrees/fix-foo", "ok": true, "dirty": false }],
  "local":  [{ "branch": "fix/foo", "ok": true, "alreadyGone": false }],
  "remote": [{ "branch": "fix/foo", "ok": true, "alreadyGone": false }],
  "failures": [],
  "ok": true
}
```

## Exit codes

- `0` — clean (dry-run preview, or all reaps succeeded).
- `1` — at least one reap failed (worktree, local, or remote).
- `2` — no candidates matched (informational; nothing to do).

## Constraint

Do **not** run this workflow if there is unmerged work that needs
saving. Always perform Step 3 (Dry-run Audit) and Step 4 (Approval)
before passing `--execute`. The remote reap (`--remote`) crosses
`origin/` and cannot be undone without re-pushing.
