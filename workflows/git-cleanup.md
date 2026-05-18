---
description: >-
  Tidy the local checkout in four phases: fast-forward `main`, prune stale
  remote-tracking refs, sweep merged branches (squash-aware), and triage
  `git stash` entries — each step gated by operator confirmation.
---

# Git Cleanup Workflow

`/git-cleanup` folds the four cleanup steps that operators routinely
run by hand after a busy session into a single pipeline with per-step
confirmation:

1. **fast-forward `main`** — `git fetch origin <base>` then
   `git merge --ff-only origin/<base>` on a clean working tree.
2. **prune stale remote-tracking refs** — `git fetch --prune origin`
   to drop `refs/remotes/origin/*` entries that GitHub already deleted.
3. **reap merged local branches** — the existing squash-aware
   `gh pr list --state merged` + `git branch --merged <base>` sweep,
   with attached worktrees removed first. Optionally also deletes the
   `origin/<branch>` ref when `--remote` is passed. With `--remote`,
   the planner additionally enumerates `refs/remotes/origin/*` and
   reaps any **remote-only** merged branches — branches whose local
   ref is already gone (or never existed) but whose `origin/<branch>`
   still points at a merged PR.
4. **triage `git stash` entries** — list every stash and prompt for
   `drop / keep / quit` per entry (or pass `--drop-stashes <ref>` for
   non-interactive use).

The enumeration + reap logic lives in
[`git-cleanup.js`](../scripts/git-cleanup.js). When no phase flag is
passed, **all four phases run** sequentially. Pass any of
`--fast-forward-main`, `--prune-remotes`, `--branches`, `--stashes` to
narrow the run.

> **When to run**: After a session that landed several PRs, or before
> starting a new Epic / Story, to put the local checkout into a known
> tidy state.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

<!-- markdownlint-disable-next-line MD028 -->

> [!WARNING] The `--execute` flag mutates state: it can fast-forward
> `main`, delete local branches, delete remote refs (with `--remote`),
> and drop stashes. Without `--execute` the script is a dry-run preview.

## Step 1 — Dry-run preview

```powershell
node .agents/scripts/git-cleanup.js
```

Walks all four phases without mutating anything. The fast-forward phase
reports whether the tree is clean and how far behind `origin/<base>` the
local ref is. The branches phase prints the merged-branch candidate
list. The stashes phase lists every stash with its created-at and
message.

Add `--json` for a structured `{ fastForward, prune, stashes,
candidates, … }` envelope.

## Step 2 — Run a single phase

Each phase is independently selectable. Useful when you want to scope
the cleanup tightly:

```powershell
# Only fast-forward main (skip everything else)
node .agents/scripts/git-cleanup.js --fast-forward-main --execute

# Only sweep merged branches + their origin refs
node .agents/scripts/git-cleanup.js --branches --execute --remote

# Only prune stale tracking refs
node .agents/scripts/git-cleanup.js --prune-remotes --execute
```

## Step 3 — Run all four phases

The default. Confirms each destructive step independently:

```powershell
node .agents/scripts/git-cleanup.js --execute
```

The script prompts before each mutation:

- **fast-forward-main**: skipped silently when the tree is dirty or the
  FF would not be a fast-forward; otherwise prompts
  `Fast-forward main by N commit(s)? [y/N]`.
- **prune-remotes**: prompts before running
  `git fetch --prune origin`.
- **branches**: prints the dry-run candidate list, then prompts
  `Reap N merged branch(es)? [y/N]`.
- **stashes**: prompts per-stash with `drop / keep / quit`. A `quit`
  reply stops the per-stash loop without dropping anything further.

Add `--remote` to also reap `origin/<branch>` during the branches phase.

## Step 4 — Non-interactive / CI

Pass `--yes` to bypass every per-step prompt:

```powershell
node .agents/scripts/git-cleanup.js --execute --remote --yes
```

For the stash phase under `--yes` or `--json`, drops require an explicit
allowlist via `--drop-stashes <ref>` (repeatable). Without that flag,
stashes are listed but never dropped:

```powershell
node .agents/scripts/git-cleanup.js --stashes --execute --yes \
  --drop-stashes 'stash@{0}' --drop-stashes 'stash@{2}'
```

This keeps the JSON / CI invocation contract explicit — the operator
names exactly which stashes to drop, by ref.

## Step 5 — JSON envelope

`--json` emits a single line of structured output suitable for
programmatic consumption:

```json
{
  "dryRun": false,
  "baseBranch": "main",
  "fastForward": {
    "ok": true,
    "applied": true,
    "skipped": false,
    "behind": 2
  },
  "prune": {
    "ok": true,
    "attempted": true,
    "remote": "origin",
    "pruned": ["fix/old"]
  },
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
  "worktrees": [{ "path": "C:/repo/.worktrees/fix-foo", "ok": true, "dirty": false }],
  "local":  [{ "branch": "fix/foo", "ok": true, "alreadyGone": false }],
  "remote": [{ "branch": "fix/foo", "ok": true, "alreadyGone": true }],
  "stashes": {
    "ok": true,
    "actions": [
      { "ref": "stash@{0}", "action": "drop", "dropped": true }
    ],
    "failures": []
  },
  "failures": [],
  "ok": true
}
```

## Exit codes

- `0` — clean: dry-run preview, or at least one phase produced work and
  no phase failed.
- `1` — at least one phase reported a failure (fast-forward, prune,
  branch reap, or stash drop). A failure in one phase **does not**
  short-circuit later phases — each runs and reports independently.
- `2` — every active phase produced nothing to do (informational; the
  repo is already tidy).

## Phase-specific behaviour

### fast-forward-main

- Skip reasons surfaced in `fastForward.reason`:
  - `dirty-tree` — `git status --porcelain` returned non-empty.
  - `not-fast-forward` — local `<base>` has commits the remote does
    not (`git rev-list --left-right --count` shows local-ahead > 0).
  - `already-up-to-date` — local and remote `<base>` point at the same
    commit.
  - `fetch-failed` / `merge-failed` — surface git's stderr verbatim.
- When the current HEAD is not `<base>`, the script runs
  `git checkout <base>` before merging. The original branch is **not**
  restored at the end — operators on a feature branch should run
  `git checkout -` after.

### prune-remotes

Runs as its own phase regardless of whether `--remote` was passed
during the branches phase. The branches phase still runs its own
follow-up prune when `--remote` is set, so passing both is idempotent
(the second prune just reports `pruned: []`).

### branches

The merged-branch sweep semantics:

- A branch is a candidate iff it is not `<base>`, not the current
  HEAD, not in `git config branch.protectedBranches`, and either has a
  merged PR (`gh pr list --head <branch> --state merged`) or appears in
  `git branch --merged <base>`.
- When a candidate has an attached worktree, the worktree is removed
  (force if dirty) **before** `git branch -D`, mirroring the pattern in
  [`worktree-lifecycle.md`](helpers/worktree-lifecycle.md).
- `--remote` is required on top of `--execute` to touch `origin/`.

The skip taxonomy distinguishes two unreapable cases:

- `reason: 'protected'` — the base branch or a name in
  `git config branch.protectedBranches`. Not reapable; ignore.
- `reason: 'current-head'` — the current branch. Reapable after
  `git checkout <base>`. The dry-run output surfaces a remediation
  hint so the operator sees the recovery path without having to look
  in the JSON envelope.

The `--remote` flag also opts the planner into a **remote-only
enumeration pass**: in addition to walking `refs/heads/*`, the planner
also walks `refs/remotes/origin/*` and emits candidates for any branch
that exists on `origin` with a merged PR but has no local ref. These
candidates carry `detectedBy: 'remote-only'` and `localExists: false`,
and the executor runs only the `git push --delete origin/<branch>`
path for them (no local `git branch -D` is attempted — there is no
local branch to delete).

### stashes

- Stashes are dropped high-index-first so the indices of remaining
  stashes stay stable across consecutive drops (git renumbers from the
  top of the stack).
- In interactive mode (no `--yes`, no `--json`), each stash gets a
  prompt: `drop / keep / quit`. The default on bare ENTER is `keep`.
- In `--yes` or `--json` mode, only refs explicitly named via
  `--drop-stashes <ref>` are dropped. Everything else is kept. There is
  intentionally no "drop all" shorthand.

## Constraint

Do **not** run with `--execute` if there is unmerged work that needs
saving. The fast-forward phase skips on a dirty tree (safe), but the
branches phase will reap any merged-PR branch in scope — passing
`--exclude '<pattern>'` is the only way to carve out exceptions. The
remote reap (`--remote`) crosses `origin/` and cannot be undone without
re-pushing.
