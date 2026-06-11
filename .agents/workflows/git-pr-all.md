---
description: >-
  Stage all outstanding changes, commit, push to a feature branch, and open a
  pull request with native auto-merge enabled.
---

# /git-pr-all [Message] [--draft] [--no-auto-merge] [--branch <name>] [--base <branch>]

This workflow is the **ad-hoc PR ergonomics** counterpart to the heavyweight
`/deliver` pipeline. Use it when you have outstanding changes that do not
belong to a planned Epic (typo fixes, file deletions, doc tweaks, dependency
bumps, operator housekeeping) and you want a single command to take them from
the working tree to a PR queued for auto-merge.

It composes the three steps that used to live in
[`/git-commit-all`](git-commit-all.md), [`/git-push`](git-push.md), and a
manual `gh pr create` — no more dance, no more manually slugging branch
names. Quality gates remain enforced by the existing pre-push hook; this
workflow does not bypass them.

> **When to run**: After making changes on `main` (or any base branch) that
> are too small or too out-of-band for `/plan` + `/deliver` but
> still need to land via the PR-required flow.
>
> **Persona**: `devops-engineer` · **Skills**:
> `core/git-workflow-and-versioning`

---

## Arguments

```text
/git-pr-all [Message] [--draft] [--no-auto-merge] [--branch <name>] [--base <branch>]
```

- `Message` — the commit subject. First line becomes the PR title; if
  the message contains a blank line, everything after the blank line
  becomes the PR body. When omitted, an interactive prompt is suppressed
  and a timestamped fallback (`chore: ad-hoc changes <ISO>`) is used.
- `--draft` — open the PR in draft state and skip the auto-merge enable
  step. Useful when you want CI to run before flipping to ready-for-review.
- `--no-auto-merge` — open a normal (non-draft) PR but do not enable
  GitHub's native auto-merge queue. The operator merges through the UI
  when ready. Default behaviour is `gh pr merge --auto --squash --delete-branch`.
- `--branch <name>` — override the auto-generated feature branch name.
  When omitted, the branch is slugged from the commit subject (see
  Step 2).
- `--base <branch>` — override the merge target. When omitted, reads
  `project.baseBranch` from `.agentrc.json` (default `main`).

---

## Step 0 — Resolve Context

1. Resolve `[BASE_BRANCH]` from `--base` or `.agentrc.json` →
   `project.baseBranch` (default `main`).
2. Read the current branch with `git rev-parse --abbrev-ref HEAD`.
3. Determine the operating mode:
   - **`from-base` mode** — current branch equals `[BASE_BRANCH]`. The
     workflow must cut a feature branch in Step 2 before committing.
   - **`from-feature` mode** — current branch is anything else. The
     workflow commits + pushes to the existing branch in Step 3 and
     opens (or updates) a PR from it.
4. Verify the working tree has outstanding changes with
   `git status --porcelain`. If the output is empty: **STOP** and tell
   the operator there is nothing to PR.

---

## Step 1 — Compose Commit Message

If the operator passed `[Message]`, use it verbatim. Otherwise, fall back
to `chore: ad-hoc changes <ISO 8601 timestamp>` so the commit is never
unmessageable.

Split the message on the first blank line:

- **Subject** — the first line, used as the commit subject AND the PR
  title.
- **Body** — everything after the first blank line, used as the commit
  body AND the PR body. May be empty.

---

## Step 2 — Cut Feature Branch (from-base mode only)

Skip this step in `from-feature` mode — the branch already exists.

When `--branch <name>` is set, use it verbatim. Otherwise generate a
branch slug from the commit subject:

1. Detect the Conventional Commit type prefix (`<type>(<scope>): …`).
   If matched, use `<type>` as the branch namespace. Allowed types:
   `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`,
   `perf`, `style`. Anything else (or no prefix) → `chore`.
2. Strip the type prefix and any leading punctuation from the subject.
3. Lowercase, replace non-alphanumeric runs with `-`, collapse repeated
   hyphens, trim leading/trailing hyphens.
4. Truncate to 50 chars on a word boundary.
5. Combine: `<type>/<slug>`. Example: `"Delete unused files"` →
   `chore/delete-unused-files`. `"fix(observability): drop stale handler"`
   → `fix/observability-drop-stale-handler`.

Cut and check out the branch:

```powershell
git checkout -b <branch-name>
```

If a local branch with that name already exists: pick a fresh name by
appending `-2` (then `-3`, etc.) until `git rev-parse --verify` returns
non-zero, and check that out instead.

---

## Step 3 — Stage + Commit

Stage all outstanding changes:

```powershell
git add -A
```

> **Why `-A` and not explicit paths?** `/git-pr-all` is operator-driven
> (not parallel-agent-driven), so the single-tree assumption that
> blocks `git add .` inside `/deliver` does not apply here. See
> the parallel-execution warning at the bottom of this file.

Commit:

```powershell
git commit -m "<subject>" -m "<body>"
```

If the body is empty, omit the second `-m`. If the pre-commit hook
fails:

1. Read the failure output.
2. Fix the issue (run `npm run format`, fix lint errors, etc.).
3. `git add -A` again.
4. Re-run `git commit` (do **not** pass `--no-verify`).

---

## Step 4 — Push with Upstream

Push the branch and set its upstream so subsequent pushes do not need
the explicit ref:

```powershell
git push -u origin <branch-name>
```

If the pre-push hook fails:

1. Read the failure output.
2. Fix the offending baseline / test / lint issue in the working tree.
3. `git add -A`, `git commit --amend --no-edit` (the original commit
   has not been pushed yet, so amend is safe).
4. Re-run the push.

If the pre-push hook is correctly blocking a real regression, fix the
regression — never bypass the hook with `--no-verify`.

---

## Step 5 — Open PR

```powershell
gh pr create --base <BASE_BRANCH> --head <branch-name> \
  --title "<subject>" --body "<body-or-default>"
```

When `--body` would otherwise be empty, fall back to a single line:
`Opened via /git-pr-all`. Pass `--draft` to `gh pr create` when the
operator set the `--draft` flag.

Capture the resulting PR URL from `gh pr create`'s stdout for the
final summary.

---

## Step 6 — Enable Auto-Merge (default)

Skip this step when `--draft` or `--no-auto-merge` is set.

```powershell
gh pr merge <PR_NUMBER> --auto --squash --delete-branch
```

This queues the PR for merge as soon as required checks turn green and
schedules deletion of the head branch on merge. Auto-merge requires
`allow_auto_merge: true` on the repo (set by `/agents-bootstrap-github`,
Story #1239).

If `gh pr merge --auto` fails (missing repo feature, insufficient
token scope), log the failure and surface it to the operator — the PR
itself remains open and mergeable through the GitHub UI.

---

## Step 7 — Summary

Print a single block to the operator:

```text
✅ Opened PR #<PR_NUMBER>: <subject>
   <PR_URL>
   branch: <branch-name> → <BASE_BRANCH>
   auto-merge: <enabled | draft | disabled>
```

Do **not** poll CI. That is the `/deliver` Phase 7 job and is
overkill for ad-hoc changes. The operator (or GitHub's email
notification) is the next watcher.

---

## Troubleshooting

- **Hook failures**: Treat the same way `/git-push` does — read the
  output, fix the underlying issue, never `--no-verify`. The pre-push
  hook (lint + format + maintainability + audit + coverage + CRAP) is
  the same gate every PR has to pass eventually; failing here lets you
  fix it before opening the PR rather than after CI fails.
- **Branch already exists locally**: appended `-2`/`-3` per Step 2; this
  is the same behaviour `gh repo` uses. If you want a specific name,
  pass `--branch <name>` explicitly.
- **`gh pr create` fails with "no commits between branches"**: the push
  in Step 4 did not actually move the branch (e.g., it was already at
  the same SHA as `[BASE_BRANCH]`). Verify `git log <BASE_BRANCH>..HEAD`
  shows commits before re-running.
- **PR template wins over `--body`**: if `.github/pull_request_template.md`
  exists, `gh pr create --body` overrides it. To opt into the template
  flow, drop the `--body` flag in Step 5 and pass `--editor` instead —
  but that requires an interactive session. For ad-hoc PRs the explicit
  body is the right default.
- **Auto-merge does not fire after CI green**: confirm the PR's required
  checks match the auto-merge requirements. The framework's quality gate
  (`Validate and Test`) is the canonical required check; other checks
  may be informational. Use the GitHub UI's "Merge when ready" surface
  to inspect the queue state.

---

## Constraint

- **Never** push directly to `[BASE_BRANCH]`. Step 2's branch cut is
  mandatory in `from-base` mode; remove it and the workflow becomes a
  silent bypass of the PR-required policy.
- **Never** pass `--no-verify` to `git commit` or `git push` to bypass
  the quality gate. Fix the failure at the source.
- **Never** force-push from `/git-pr-all`. This workflow is for opening
  new PRs, not for rewriting history. Force-pushes belong to
  `/git-merge-pr` (with `--force-with-lease` after a rebase) and
  `/deliver` Phase 7 (with the operator's explicit context).
- **Always** delete the head branch on merge (Step 6's
  `--delete-branch` flag handles this for `--auto` mode; for
  `--no-auto-merge` PRs the operator is responsible for the cleanup).
- **Always** prefer `--auto --squash --delete-branch` unless the
  operator explicitly opts out. The squash + auto-merge default gives
  the same merge ergonomics `/deliver` produces, so main's commit
  history stays uniform across both surfaces.

---

## ⚠️ Parallel Story Execution

Do **not** use this workflow from inside a parallel story-execution
context (`/deliver #<storyId>`, `/deliver` wave dispatch).
`git add -A` sweeps any untracked files in the working tree, which in
a shared working directory may belong to another agent. In those
contexts stage explicit paths only and confirm
`git branch --show-current` reports the expected `story-<id>` branch
before committing — see
[`helpers/worktree-lifecycle.md`](helpers/worktree-lifecycle.md) for the
shared-tree hazard and the worktree-isolation model that contains it.

The same warning applies to any workflow that calls `git add .` or
`git add -A`; this is not unique to `/git-pr-all` (see
[`git-push.md`](git-push.md) for the canonical version).
