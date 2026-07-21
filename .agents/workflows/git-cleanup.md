---
description: >-
  Tidy the local checkout in four phases: fast-forward `main`, prune stale
  remote-tracking refs, sweep merged branches (squash-aware), and triage
  `git stash` entries — each step gated by operator confirmation.
---

# /git-cleanup [--fast-forward-main] [--prune-remotes] [--branches] [--stashes] [--execute] [--remote] [--yes] [--drop-stashes <ref>] [--exclude <pattern>] [--json]

`/git-cleanup` folds the four cleanup steps operators routinely run by hand
after a busy session into a single pipeline with per-step confirmation. It is a
**recovery tool**, not a routine chore: the delivering flows already reap their
own merged refs and fast-forward the base branch (see
[`rules/git-conventions.md` § Local checkout hygiene](../rules/git-conventions.md)).
Reach for it when the automated hygiene left an unusual state behind.

> **When to run**: after a session that landed several PRs, or before starting a
> new Story, to put the local checkout into a known tidy state.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

The enumeration + reap logic lives in
[`git-cleanup.js`](../scripts/git-cleanup.js) — it computes the candidate list,
the skip taxonomy, the detection signals, and the JSON envelope (add `--json`),
and prints them itself. Without `--execute` the script is a **dry-run preview**; nothing is
mutated. When no phase flag is passed, **all four phases run** sequentially; pass
any of `--fast-forward-main`, `--prune-remotes`, `--branches`, `--stashes` to
narrow the run. A failure in one phase does not short-circuit the others — each
runs and reports independently.

## Phases

| Phase | What it does | Safety contract |
| --- | --- | --- |
| **fast-forward-main** | `git fetch origin <base>` then `git merge --ff-only origin/<base>`. | Skipped silently on a dirty tree or a non-fast-forward; otherwise prompts `Fast-forward main by N commit(s)?`. Checks out `<base>` first when HEAD is elsewhere and does **not** restore the prior branch. |
| **prune-remotes** | `git fetch --prune origin` to drop `refs/remotes/origin/*` GitHub already deleted. | Prompts before pruning. Runs as its own phase regardless of `--remote`. |
| **branches** | Reaps merged local branches (squash-aware: merged-PR, git-ancestry, and content-equivalence signals), removing an attached worktree first. Also enumerates **remote-only** merged branches. | Prints the candidate list, then prompts `Reap N merged branch(es)?`. `--remote` is required **on top of** `--execute` to delete any `origin/<branch>`. `content-merged` candidates carry a weaker-signal warning. |
| **stashes** | Lists every stash and triages it. | Interactive: `drop / keep / quit` per entry (default `keep`). Under `--yes` / `--json`, drops require an explicit `--drop-stashes <ref>` allowlist (repeatable) — there is no "drop all". |

## Constraint

> [!WARNING] `--execute` mutates state: it can fast-forward `main`, delete local
> branches, delete remote refs (with `--remote`), and drop stashes. Without
> `--execute` the script only previews.

- **`--execute`** — the master gate. Omit it for a preview of all four phases.
- **`--remote`** — extends the branches phase to delete the matching
  `origin/<branch>` ref (and to delete remote-only merged branches). Cannot be
  undone without re-pushing.
- **`--yes`** — bypass every per-step prompt (CI / non-interactive). Under it,
  stash drops still require `--drop-stashes <ref>`.
- **`--exclude '<pattern>'`** — carve a branch out of the reap. This is the only
  way to protect an in-scope merged-PR branch you want to keep.

Do **not** run with `--execute` if there is unmerged work that needs saving. The
fast-forward phase skips on a dirty tree (safe), but the branches phase reaps any
merged-PR branch in scope unless `--exclude`d.

## Examples

```bash
# Preview all four phases (no mutation).
node .agents/scripts/git-cleanup.js

# Run everything non-interactively, including origin refs.
node .agents/scripts/git-cleanup.js --execute --remote --yes

# Only fast-forward main.
node .agents/scripts/git-cleanup.js --fast-forward-main --execute

# Only sweep merged branches + their origin refs.
node .agents/scripts/git-cleanup.js --branches --execute --remote

# Drop specific stashes under --yes.
node .agents/scripts/git-cleanup.js --stashes --execute --yes \
  --drop-stashes 'stash@{0}' --drop-stashes 'stash@{2}'
```
