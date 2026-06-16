---
description: >-
  Single ad-hoc delivery command for working-tree changes. Detects the git
  setup and escalates to the right terminal step — commit only, commit + push,
  or commit + push + open a PR with native auto-merge — picking the default
  from observable state and letting flags pin any level explicitly. Replaces
  the retired git-commit-all, git-push, and git-pr-all trio.
---

# /git-deliver [Message] [--no-push] [--pr] [--draft] [--no-auto-merge] [--branch <name>] [--base <branch>]

This workflow is the **single source of truth** for getting outstanding
working-tree changes out the door when they do not belong to a planned Epic
(typo fixes, file deletions, doc tweaks, dependency bumps, operator
housekeeping). It is the ad-hoc counterpart to the heavyweight `/deliver`
pipeline.

It replaces the retired `/git-commit-all`, `/git-push`, and `/git-pr-all`
commands: instead of choosing a command by how far you want to go, you run
one command and it **detects the git setup** and escalates to the correct
terminal step. Flags pin any level explicitly; the interactive choice prompt
fires **only** when the detected state is genuinely ambiguous, so the common
path stays non-interactive and scriptable.

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

- `Message` — the commit subject. First line becomes the commit subject (and,
  at the **pr** level, the PR title); if the message contains a blank line,
  everything after it becomes the commit/PR body. When omitted, a timestamped
  fallback (`chore: ad-hoc changes <ISO 8601>`) is used so the commit is never
  unmessageable.
- `--no-push` — force the **commit** level: stage and commit only, no push.
  Useful when chaining several commits or deferring the push.
- `--pr` — force the **pr** level even from a feature branch where a plain
  push would otherwise be the default.
- `--draft` — (pr level) open the PR in draft state and skip arming
  auto-merge. Useful when you want CI to run before flipping to
  ready-for-review.
- `--no-auto-merge` — (pr level) open a normal (non-draft) PR but do not enable
  GitHub's native auto-merge queue. The operator merges through the UI.
  Default at the pr level is `gh pr merge --auto --squash --delete-branch`.
- `--branch <name>` — (pr level) override the auto-generated feature branch
  name. When omitted, the branch is slugged from the commit subject (Step 3).
- `--base <branch>` — override the base branch used for detection and as the PR
  merge target. When omitted, reads `project.baseBranch` from `.agentrc.json`
  (default `main`).

---

## Step 0 — Detect Git Setup & Resolve Level

1. Resolve `[BASE_BRANCH]` from `--base` or `.agentrc.json` →
   `project.baseBranch` (default `main`).
2. Read the current branch: `git rev-parse --abbrev-ref HEAD`.
3. Verify the working tree has outstanding changes with
   `git status --porcelain`. If the output is empty: **STOP** and tell the
   operator there is nothing to deliver.
4. Detect whether a remote is configured: `git remote`.
5. Resolve the **terminal level** from flags + state:
   - `--no-push` set → **commit**.
   - No remote configured → **commit** (warn there is nowhere to push).
   - `--pr` set → **pr**.
   - Current branch equals `[BASE_BRANCH]` → **pr** (a direct push to the
     protected base would be rejected, so the PR flow is the only safe path).
   - Otherwise (a feature branch with a remote) → **push**.
6. **Ambiguity gate.** Surface an interactive choice **only** when the state is
   genuinely under-determined — for example a **detached HEAD**, or a feature
   branch with a remote but no upstream tracking ref where pushing would need
   `-u`. Present the operator the candidate levels (e.g. "push to a new
   upstream" vs. "open a PR") and proceed with their pick. In every
   non-ambiguous case, do **not** prompt — announce the detected level and
   continue.
7. Echo a one-line plan to the operator before acting, e.g.
   `detected: on feature branch 'fix/foo' with upstream → level: push`.

---

## Step 1 — Compose Commit Message

If the operator passed `[Message]`, use it verbatim. Otherwise fall back to
`chore: ad-hoc changes <ISO 8601 timestamp>`.

Split the message on the first blank line:

- **Subject** — the first line; commit subject and (pr level) PR title.
- **Body** — everything after the first blank line; commit body and (pr level)
  PR body. May be empty.

---

## Step 2 — Stage + Commit (all levels)

Stage all outstanding changes:

```powershell
git add -A
```

Commit:

```powershell
git commit -m "<subject>" -m "<body>"
```

If the body is empty, omit the second `-m`. If the pre-commit hook fails:

1. Read the failure output.
2. Fix the issue (run `npm run format`, fix lint errors, etc.).
3. `git add -A` again.
4. Re-run `git commit` — do **not** pass `--no-verify`.

**If the level is `commit`, stop here** and print the commit summary.

---

## Step 3 — Cut Feature Branch (pr level, from-base only)

Only when the level is **pr** *and* the current branch equals `[BASE_BRANCH]`.
Skip when already on a feature branch.

When `--branch <name>` is set, use it verbatim. Otherwise generate a branch
slug from the commit subject:

1. Detect the Conventional Commit type prefix (`<type>(<scope>): …`). If
   matched, use `<type>` as the branch namespace. Allowed types: `feat`,
   `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`,
   `style`. Anything else (or no prefix) → `chore`.
2. Strip the type prefix and any leading punctuation from the subject.
3. Lowercase, replace non-alphanumeric runs with `-`, collapse repeated
   hyphens, trim leading/trailing hyphens.
4. Truncate to 50 chars on a word boundary.
5. Combine: `<type>/<slug>`. Example: `"Delete unused files"` →
   `chore/delete-unused-files`.

Cut and check out the branch **before committing** — that is, when this step
applies, run it ahead of Step 2's commit so the commit lands on the feature
branch, never on the base branch:

```powershell
git checkout -b <branch-name>
```

If a local branch with that name already exists, append `-2` (then `-3`, …)
until `git rev-parse --verify` returns non-zero, and check that out instead.

---

## Step 4 — Push (push and pr levels)

Push the current branch. At the **push** level, push to the existing upstream:

```powershell
git push
```

At the **pr** level (or any branch lacking an upstream), set the upstream:

```powershell
git push -u origin <branch-name>
```

If the pre-push hook fails:

1. Read the failure output.
2. Fix the offending baseline / test / lint issue in the working tree.
3. `git add -A`, then create a **new follow-up commit** (do not amend a commit
   that has already been pushed; amending an unpushed commit is fine).
4. Re-run the push. Never bypass the hook with `--no-verify`.

If the push is rejected because the remote has work you do not have locally,
`git pull --rebase`, resolve conflicts, and push again.

**If the level is `push`, stop here** and print the push summary.

---

## Step 5 — Open PR (pr level)

```powershell
gh pr create --base <BASE_BRANCH> --head <branch-name> \
  --title "<subject>" --body "<body-or-default>"
```

When the body would otherwise be empty, fall back to a single line:
`Opened via /git-deliver`. Pass `--draft` to `gh pr create` when the operator
set `--draft`. Capture the PR URL from stdout for the summary.

---

## Step 6 — Arm Auto-Merge (pr level, default)

Skip when `--draft` or `--no-auto-merge` is set.

```powershell
gh pr merge <PR_NUMBER> --auto --squash --delete-branch
```

This queues the PR to merge as soon as required checks turn green and schedules
head-branch deletion on merge. Auto-merge requires `allow_auto_merge: true` on
the repo. If `gh pr merge --auto` fails (missing repo feature, insufficient
token scope), log the failure and surface it — the PR stays open and mergeable
through the GitHub UI.

---

## Step 7 — Summary

Print a single block matched to the level that ran:

```text
# commit level
✅ Committed on <branch>: <subject>

# push level
✅ Committed + pushed <branch> → origin: <subject>

# pr level
✅ Opened PR #<PR_NUMBER>: <subject>
   <PR_URL>
   branch: <branch-name> → <BASE_BRANCH>
   auto-merge: <enabled | draft | disabled>
```

Do **not** poll CI. That is the `/deliver` Phase 7 job and is overkill for
ad-hoc changes. The operator (or GitHub's email notification) is the next
watcher.

---

## Troubleshooting

- **Hook failures**: Read the output, fix the underlying issue, never
  `--no-verify`. The pre-push hook (lint + format + maintainability + audit +
  coverage + CRAP) is the same gate every PR has to pass eventually; failing
  here lets you fix it before opening the PR rather than after CI fails.
- **Branch already exists locally**: appended `-2`/`-3` per Step 3; pass
  `--branch <name>` for a specific name.
- **`gh pr create` fails with "no commits between branches"**: the push did not
  move the branch (e.g. it was already at the same SHA as `[BASE_BRANCH]`).
  Verify `git log <BASE_BRANCH>..HEAD` shows commits before re-running.
- **PR template wins over `--body`**: if `.github/pull_request_template.md`
  exists, `gh pr create --body` overrides it. For ad-hoc PRs the explicit body
  is the right default.
- **Auto-merge does not fire after CI green**: confirm the PR's required checks
  match the auto-merge requirements. The framework's quality gate
  (`Validate and Test`) is the canonical required check.

---

## Constraint

- **Never** push directly to `[BASE_BRANCH]`. At the pr level Step 3's branch
  cut is mandatory in from-base mode; remove it and the workflow becomes a
  silent bypass of the PR-required policy.
- **Never** pass `--no-verify` to `git commit` or `git push` to bypass the
  quality gate. Fix the failure at the source.
- **Never** force-push from `/git-deliver`. This workflow opens new PRs, it
  does not rewrite history. Force-pushes belong to `/git-merge-pr` (with
  `--force-with-lease` after a rebase) and `/deliver` Phase 7.
- **Always** prefer `--auto --squash --delete-branch` at the pr level unless
  the operator opts out, so `main`'s commit history stays uniform across the
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
