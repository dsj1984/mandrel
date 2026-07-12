---
description: >-
  Single ad-hoc delivery command for working-tree changes. Detects the git
  setup and escalates to the right terminal step — commit only, commit + push,
  or commit + push + open a PR with native auto-merge — picking the default
  from observable state and letting flags pin any level explicitly. Replaces
  the retired git-commit-all, git-push, and git-pr-all trio.
---

# /git-deliver [Message] [--no-push] [--pr] [--draft] [--no-auto-merge] [--branch <name>] [--base <branch>]

The **single source of truth** for getting outstanding working-tree changes
out the door when they do not belong to a planned Epic (typo fixes, doc
tweaks, dependency bumps, operator housekeeping, benchmark result commits
from mandrel-bench's `/benchmark` Step 4). It is the ad-hoc counterpart to
the heavyweight `/deliver` pipeline: one command that **detects the git
setup** and escalates to the correct terminal step. Flags pin any level
explicitly; the interactive choice prompt fires **only** when the detected
state is genuinely ambiguous, so the common path stays non-interactive and
scriptable.

> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

---

## Terminal levels

| Level | Terminal action | Default trigger |
| ----- | --------------- | --------------- |
| **commit** | stage + commit on the current branch | `--no-push`, **or** no git remote is configured |
| **push** | + push the current branch to its upstream | on a feature branch (current ≠ base branch) with a remote |
| **pr** | + cut/push a feature branch, open a PR, arm auto-merge | on the base branch (a direct push would bounce off branch protection), **or** `--pr` is set |

The detection only sets the **default**. Every level is reachable by an
explicit flag, and the command **announces what it detected and which level
it is about to run** before it acts.

---

## Arguments

```text
/git-deliver [Message] [--no-push] [--pr] [--draft] [--no-auto-merge] [--branch <name>] [--base <branch>]
```

- `Message` — commit subject (and, at the **pr** level, the PR title); text
  after the first blank line becomes the commit/PR body. When omitted, fall
  back to `chore: ad-hoc changes <ISO 8601>` so the commit is never
  unmessageable.
- `--no-push` — force the **commit** level.
- `--pr` — force the **pr** level even from a feature branch.
- `--draft` — (pr level) open the PR in draft state and skip arming
  auto-merge.
- `--no-auto-merge` — (pr level) open a normal PR but do not enable native
  auto-merge; the operator merges through the UI.
- `--branch <name>` — (pr level) override the auto-generated feature branch
  name.
- `--base <branch>` — override the base branch used for detection and as the
  PR merge target. Default: `project.baseBranch` from `.agentrc.json`
  (fallback `main`).

---

## Boot sweep

Before detecting the git setup, run the **protected boot sweep** so the run
starts from a tidy local checkout — a feature branch this command opened on a
prior run, once its PR has merged, is reaped here rather than left to
accumulate:

```bash
node .agents/scripts/boot-sweep.js \
  --include 'feat/*' --include 'fix/*' --include 'chore/*' \
  --include 'docs/*' --include 'refactor/*' \
  --current "$(git rev-parse --abbrev-ref HEAD)"
```

The safe subset of the `/git-cleanup` phases: fast-forwards the base branch,
prunes stale remote-tracking refs, and reaps merged branches. It never
touches the stash, never reaps a candidate with unpushed work / dirty
worktree / open parent ticket, and always exits `0` — a failed sweep is
reported in its summary line, never allowed to fail the delivery run.

---

## Step 0 — Detect Git Setup & Resolve Level

1. Resolve `[BASE_BRANCH]` (`--base` → `.agentrc.json` → `main`).
2. Read the current branch; verify `git status --porcelain` shows outstanding
   changes — if empty, **STOP**: nothing to deliver.
3. Resolve the **terminal level** from flags + state:
   - `--no-push` set → **commit**.
   - No remote configured → **commit** (warn there is nowhere to push).
   - `--pr` set → **pr**.
   - Current branch equals `[BASE_BRANCH]` → **pr** (a direct push to the
     protected base would be rejected).
   - Otherwise (feature branch with a remote) → **push**.
4. **Ambiguity gate.** Prompt the operator **only** when state is genuinely
   under-determined — e.g. a detached HEAD, or a feature branch with a remote
   but no upstream tracking ref (push `-u` vs. open a PR). In every
   non-ambiguous case, do **not** prompt.
5. Echo a one-line plan before acting, e.g.
   `detected: on feature branch 'fix/foo' with upstream → level: push`.

---

## Steps 1–6 — Deliver at the resolved level

Commit, push, and PR mechanics are host-native git/`gh` competency; run them
directly, honoring these contracts:

- **Branch cut (pr level, from-base only).** Cut the feature branch **before
  committing** so the commit never lands on the base branch. Branch name:
  `--branch` verbatim, else `<type>/<slug>` — Conventional Commit type from
  the subject (unrecognized/absent → `chore`), subject slugged to lowercase
  hyphenated ≤50 chars. Name collision → append `-2`/`-3`/….
- **Stage + commit.** `git add -A`, then commit with the composed
  subject/body.
- **Push.** `git push` (existing upstream) or `git push -u origin <branch>`.
  Rejected because the remote is ahead → `git pull --rebase`, resolve, push
  again.
- **Hook failures (commit or push).** Read the output, fix the underlying
  issue, re-stage, and (for an already-pushed commit) add a **new follow-up
  commit** rather than amending. **Never** `--no-verify`.
- **PR + auto-merge (pr level).** `gh pr create --base [BASE_BRANCH]`
  with the subject/body (empty body → `Opened via /git-deliver`; pass
  `--draft` through). Then, unless `--draft`/`--no-auto-merge`:
  `gh pr merge --auto --squash --delete-branch`. If arming fails (repo
  feature missing, token scope), log and surface it — the PR stays open and
  mergeable through the UI.

Stop at the resolved level and print a one-block summary naming the branch,
subject, and (pr level) PR URL + auto-merge state.

Do **not** poll CI — that is the `/deliver` Phase 7 job and is overkill for
ad-hoc changes. The local feature branch left behind at the pr level is
reaped by the next run's Boot sweep — see
[`.agents/rules/git-conventions.md` § Local checkout hygiene](../rules/git-conventions.md).

---

## Constraint

- **Never** push directly to `[BASE_BRANCH]`. The from-base branch cut is
  mandatory; remove it and the workflow becomes a silent bypass of the
  PR-required policy.
- **Never** pass `--no-verify` to `git commit` or `git push`. Fix the failure
  at the source.
- **Never** force-push from `/git-deliver`. This workflow opens new PRs, it
  does not rewrite history.
- **Always** prefer `--auto --squash --delete-branch` at the pr level unless
  the operator opts out, so `main`'s history stays uniform across the
  `/git-deliver` and `/deliver` surfaces.

---

## ⚠️ Parallel Story Execution

Do **not** use this workflow from inside a parallel story-execution context
(`/deliver #<storyId>`, `/deliver` wave dispatch). `git add -A` sweeps any
untracked files in the working tree, which in a shared working directory may
belong to another agent. In those contexts stage explicit paths only and
confirm `git branch --show-current` reports the expected `story-<id>` branch
before committing — see
[`helpers/worktree-lifecycle.md`](helpers/worktree-lifecycle.md) for the
shared-tree hazard and the worktree-isolation model that contains it.
