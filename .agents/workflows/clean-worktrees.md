---
description: >-
  Reclaim disk from dead worktrees: list every worktree of this project as a
  removal candidate (closed Story, merged branch, orphaned directory, detached
  HEAD) or as kept with a reason, then remove candidates only on `--execute`.
---

# /clean-worktrees [--execute] [--yes] [--json]

Every Story worktree carries its own `node_modules`, so a worktree left behind
costs gigabytes. Workflow boot already removes `.worktrees/story-<id>` trees
whose Story is closed or `agent::done` (the boot sweep in
[`boot-sweep.js`](../scripts/boot-sweep.js)); `/clean-worktrees` is the
**recovery tool** for everything that sweep does not own — the backlog, trees
on non-Story branches, directories git no longer registers, and detached
trees such as the Claude Code app's `.claude/worktrees/*`.

The enumeration, classification and removal live in
[`clean-worktrees.js`](../scripts/clean-worktrees.js), which documents its own
flags: `node .agents/scripts/clean-worktrees.js --help`.

## Steps

1. **Preview.** Run `node .agents/scripts/clean-worktrees.js` (dry-run, the
   default). It prints one row per worktree — class, path, size, branch/HEAD,
   action — and removes nothing. Show the operator the table.
2. **Confirm.** Ask the operator which candidates to remove. Do not proceed
   on your own judgment.
3. **Remove.** Re-run with `--execute`. In a terminal it asks per entry;
   `--execute --yes` removes every non-`detached` candidate without asking.
   `--json` emits the envelope, including `bytesReclaimed`.

## Classes

| Class | Candidate when |
| --- | --- |
| `closed-story` | `.worktrees/story-<id>` on `story-<id>` whose Story is closed or `agent::done`. |
| `merged-branch` | Any other branch whose PR is MERGED and whose HEAD is the merged head. |
| `orphan-dir` | A directory under `.worktrees/` that `git worktree list` does not register. |
| `detached` | A registered worktree with a detached HEAD. |

Everything else is **kept** with its reason: the main checkout, an open Story,
an unmerged branch, a dirty tree, unpushed commits, a tree in use.

## Safety contract

> [!WARNING] `--execute` deletes worktree directories. Without it the script
> only previews.

- **Project-scoped.** Only worktrees inside the invoking checkout's project
  root are candidates; one registered elsewhere is reported, never removed.
- **Unique work survives.** A dirty tree, or a HEAD no remote-tracking ref
  contains, is never removed.
- **Live trees survive.** The tree this process runs from is never removed;
  on macOS and Linux a tree any live process uses is refused outright.
- **`detached` needs a person.** A detached tree carries no Story label and a
  live session may own it (a blanket prune once destroyed a live delivery's
  worktree), so it is removed only on a per-entry interactive yes — never
  under `--yes`.
- **Removal goes through the worktree removal seam** (Windows lock retry and
  the pending-cleanup hand-off), never raw deletion.
- **Branches are untouched.** Deleting local or remote branches is
  [`/git-cleanup`](git-cleanup.md)'s job.
