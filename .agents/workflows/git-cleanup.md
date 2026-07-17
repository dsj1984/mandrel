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
   `origin/<branch>` ref when `--remote` is passed. Every default run
   also **enumerates** `refs/remotes/origin/*` and reports any
   **remote-only** merged branches — branches whose local ref is
   already gone (or never existed) but whose `origin/<branch>` still
   points at a merged PR — even without `--remote`; `--remote` is still
   required to *delete* them. A third branch, whose content already
   landed in `<base>` by another route (a squash-merged PR, a
   cherry-pick, a manual `merge --squash`), is caught by a
   **content-equivalence probe** (`git merge-tree --write-tree`,
   git ≥ 2.38) even when it has no merged PR of its own and is not a
   git ancestor of `<base>`.
4. **triage `git stash` entries** — list every stash and prompt for
   `drop / keep / quit` per entry (or pass `--drop-stashes <ref>` for
   non-interactive use).

The enumeration + reap logic lives in
[`git-cleanup.js`](../scripts/git-cleanup.js). When no phase flag is
passed, **all four phases run** sequentially. Pass any of
`--fast-forward-main`, `--prune-remotes`, `--branches`, `--stashes` to
narrow the run.

> **When to run**: After a session that landed several PRs, or before
> starting a new Story, to put the local checkout into a known
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
  "skipped": [
    { "branch": "story-4200", "reason": "not-merged", "lastCommitAt": "2026-05-01T00:00:00Z" }
  ],
  "ghDegraded": false,
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

The merged-branch sweep recognizes three detection signals, in order:

1. **`detectedBy: 'gh'`** — the branch has a merged PR
   (`gh pr list --head <branch> --state all`, classified by the
   **latest** PR's state).
2. **`detectedBy: 'git-merged'`** — the branch is a git ancestor of
   `<base>` (`git branch --merged <base>`), or of `origin/<base>` when
   that remote-tracking ref exists (unioned so a stale local `<base>` —
   fast-forward phase skipped, or `--branches` run alone — no longer
   hides a branch already merged on the remote).
3. **`detectedBy: 'content-merged'`** (Story #4395) — the branch has no
   reapable PR verdict and is not an ancestor of `<base>` under either
   anchor, but simulating the merge via
   `git merge-tree --write-tree <base> <branch>` (git ≥ 2.38) produces a
   tree identical to `<base>`'s own tree — i.e. applying the branch's
   changes on top of `<base>` is a content no-op. This catches
   `story-<id>` branches whose PR **squash-merged** to `main` (the story
   commits are not ancestors of `main`), and any other branch whose content
   landed via a different route (a renamed
   head, a cherry-pick, a manual `merge --squash`). When git rejects
   `--write-tree` (git < 2.38) or the simulated merge conflicts, the
   probe is inconclusive and the branch keeps its existing `not-merged`
   skip — the signal never guesses. `content-merged` candidates render
   with a "weaker signal — verify before deleting" annotation in the
   dry-run list and are called out separately in the confirmation
   prompt, since — unlike a merged PR or git ancestry — no CI or GitHub
   merge check ever validated this branch's exact diff.

Other candidate semantics:

- A branch is a candidate iff it is not `<base>`, not the current HEAD,
  not in `git config branch.protectedBranches`, and matches one of the
  three signals above.
- When a candidate has an attached worktree, the worktree is removed
  (force if dirty) **before** `git branch -D`, mirroring the pattern in
  [`worktree-lifecycle.md`](helpers/worktree-lifecycle.md).
- `--remote` is required on top of `--execute` to touch `origin/`.
- A throwing `gh` runner (auth failure, rate limit, missing binary) no
  longer aborts the run: the branches phase logs one warning and
  continues with the git-only signals (ancestry + content-equivalence).
  The JSON envelope's `ghDegraded: true` records that this happened for
  the run, and the dry-run text carries a matching warning line.

The skip taxonomy:

- `reason: 'protected'` — the base branch or a name in
  `git config branch.protectedBranches`. Not reapable; ignore.
- `reason: 'current-head'` — the current branch. Reapable after
  `git checkout <base>`. The dry-run output surfaces a remediation
  hint so the operator sees the recovery path without having to look
  in the JSON envelope.
- `reason: 'tip-diverged-from-merge'` — the latest PR merged, but the
  branch's tip has since moved past the merged commit (a post-merge
  force-push). The dry-run line names both SHAs and a remediation hint
  (delete manually via `git branch -D <branch>`, or push the follow-up
  commit).
- `reason: 'not-merged'` — none of the three detection signals matched.
  Previously silent; the dry-run output now lists every surviving
  `not-merged` branch as a one-line-per-branch summary with its
  last-commit age, so the operator can see why a leftover branch isn't
  reaped instead of hunting for it by hand.

Every default run also opts the planner into a **remote-only
enumeration pass**: in addition to walking `refs/heads/*`, the planner
also walks `refs/remotes/origin/*` and emits candidates for any branch
that exists on `origin` with a merged PR but has no local ref. These
candidates carry `detectedBy: 'remote-only'` and `localExists: false`
and are always shown in the dry-run list; **deleting** them (via the
`git push --delete origin/<branch>` path — no local `git branch -D` is
attempted, since there is no local branch) still requires `--remote` on
top of `--execute`, unchanged.

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
