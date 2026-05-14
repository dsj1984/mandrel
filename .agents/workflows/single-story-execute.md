---
description:
  Execute a standalone Story (no parent Epic) end-to-end. Creates a branch
  from main, implements the changes in a worktree, runs gates, pushes, and
  opens a PR directly against main.
---

# /single-story-execute #[Story ID]

## Overview

`/single-story-execute` is the standalone counterpart to
[`/story-execute`](story-execute.md). Use it for a Story that is **not**
attached to an Epic — refactors carved out of closed Epics, framework
maintenance, or any work small enough that the Epic-Centric ceremony
(PRD + Tech Spec + decomposition + dispatch manifest + cascade) would be
overhead rather than help.

```text
/single-story-execute <storyId>
  → single-story-init.js          (branch from main, worktree, agent::executing)
  → agent implements + commits     (operator works in the worktree)
  → single-story-close.js          (gates, push, gh pr create → main, agent::done)
```

**When to use `/single-story-execute` vs. `/story-execute`:**

| Trait                         | `/single-story-execute`                              | `/story-execute`                                        |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Parent Epic                   | None (no `Epic: #N` in body)                         | Required (`Epic: #N` in body)                           |
| Branch base                   | `project.baseBranch` (default `main`)          | `epic/<epicId>`                                         |
| Merge target                  | `main` via PR                                        | `epic/<epicId>` via `--no-ff` merge                     |
| Cascade up to Feature/Epic    | No                                                   | Yes                                                     |
| Dispatch manifest interaction | None                                                 | Read at init, regenerated at close                      |
| Child Task ceremony           | None (standalone Story is atomic)                    | Required (per-Task `task-commit.js` loop)               |

If the Story has an `Epic: #N` reference, use `/story-execute`. If it
doesn't, use this workflow.

## Prerequisites

1. A GitHub Issue with the `type::story` label and **no** `Epic: #N`
   reference in its body.
2. `GITHUB_TOKEN` or `gh auth status` clean — `gh pr create` runs at close.
3. The base branch (`project.baseBranch`, default `main`) exists on
   both local and `origin`.

---

## Step 0 — Initialize (`single-story-init.js`)

Run from the **main checkout** (the worktree does not exist yet):

```bash
node .agents/scripts/single-story-init.js --story <storyId>
```

> **Execution mode.** Like `story-init.js`, this command can take 3–6
> minutes when the worktree's per-tree install runs. Invoke synchronously
> with `Bash(timeout: 600000)`. Do **not** use `run_in_background` +
> `Monitor` — a sub-agent that exits mid-install leaves the worktree
> half-bootstrapped.

The script validates `type::story`, fetches `origin`, seeds
`story-<id>` from `baseBranch`, materializes a worktree (when
`delivery.worktreeIsolation.enabled` is true), upserts a
`story-init` structured comment carrying `standalone: true`, and flips
the Story to `agent::executing`.

Between the fetch and the branch-seed step, the script also runs a
**merged-`story-*` sweep**: it invokes the same primitive as
`git-cleanup-branches.js` scoped to `story-*` only, in
`--execute --remote` mode, with the current run's `story-<id>` branch
excluded from the candidate list. Local refs, the matching `origin/`
ref, and stale tracking refs for any merged sibling stories are reaped
in one pass. The sweep never blocks init — failures are logged and the
new story is initialized regardless.

Capture `workCwd` from the result envelope. Add `--dry-run` to inspect
the planned actions without git or ticket mutations (dry-run also skips
the sweep).

### Step 0.5 — `cd` into the workCwd

```bash
cd "<workCwd from Step 0 result>"
```

All subsequent commands run from this directory.

---

## Step 1 — Implementation

A standalone Story is **atomic** — there are no child Tasks, no per-Task
`task-commit.js` ceremony, no wave dispatch. Work happens in one or more
commits on the `story-<id>` branch.

Operator/agent responsibilities while in the worktree:

1. Read the Story body. Treat its acceptance criteria as the contract.
2. Implement the changes.
3. Commit on the Story branch. Conventional-commit format is encouraged
   but not enforced — the PR title carries the canonical summary.
4. Iterate (read tests, run targeted gates, edit, commit) until the
   acceptance criteria are met.

Recommended quick gates while iterating (each is fast enough to run on
save):

```bash
npm run typecheck
npm run lint
npm test -- --grep "<scope>"
```

The full close-validation chain runs in Step 3; the gates above are
advisory pre-flight.

> Conflict with `main` mid-implementation → resolve as you would any
> branch rebase. There is no `epic/<id>` intermediate, so the rebase
> base is `main` directly.

---

## Step 2 — Validate (deferred to close)

`single-story-close.js` runs the canonical close-validation chain
(typecheck, lint, test, format, maintainability, coverage, crap) before
it pushes. Do **not** pre-run those gates here unless interactively
iterating on a fix.

---

## Step 3 — Close (`single-story-close.js`)

Invoke from the main checkout (or pass `--cwd <main-repo>` from inside
the worktree):

```bash
node <main-repo>/.agents/scripts/single-story-close.js --story <storyId> --cwd <main-repo>
```

The script:

1. Runs the close-validation gates against `baseBranch` as the baseline.
   On any gate failure it throws — the operator fixes and re-runs close.
2. Pushes `story-<id>` to `origin`.
3. Probes for an existing open PR with `head = story-<id>`. If none
   exists, opens one via `gh pr create --base <baseBranch>`. The PR
   body carries `Closes #<storyId>` so the GitHub merge auto-closes the
   issue.
3a. **Enables GitHub native auto-merge by default** via
   `gh pr merge <prNumber> --auto --squash --delete-branch`. Once CI's
   required checks turn green, GitHub squash-merges the PR and deletes
   the source branch — the operator does not need to babysit the merge
   button. Mirrors the `/epic-deliver` finalize path. Failure is
   non-fatal: the operator retains the manual merge surface in the
   GitHub UI. Pass `--no-auto-merge` to opt out when the PR needs a
   pre-merge eyeball.
4. Flips the Story to `agent::done`. The GitHub issue stays open until
   the auto-merge fires (or until the operator merges manually); the
   `Closes #<id>` PR footer auto-closes the issue on merge.
5. Reaps the worktree when `delivery.worktreeIsolation.reapOnSuccess`
   is enabled.

`--skip-validation` bypasses Step 1 (gates). Use only when re-running
close after a fixed gate failure that's already known to pass.

`--no-auto-merge` disables Step 3a. Use when the PR materially changes
behaviour and warrants pre-merge review.

---

## Step 4 — Merge

With auto-merge enabled (default), no operator action is needed —
GitHub squash-merges the PR when required checks pass and the
`Closes #<id>` footer auto-closes the issue.

With `--no-auto-merge`, the PR is the merge gate. The operator reviews
and merges via the GitHub UI; the same `Closes #<id>` auto-close fires
when the merge lands on `main`.

Optional: watch CI progress from the terminal with

```bash
gh pr checks <prNumber> --watch
```

The `prNumber` field is included in the close-script result envelope
so a wrapper can pipe it straight in.

---

## Idempotence

- `single-story-init.js` re-prints the same `workCwd` without recreating
  the worktree when one already exists for `story-<id>`.
- `single-story-close.js` short-circuits when the Story is already
  closed (returns `{ action: 'noop', reason: 'already-closed' }`).
- The PR probe (`gh pr list --head <branch> --state open`) reuses an
  existing open PR rather than opening a duplicate.

Re-running `/single-story-execute` against an already-closed Story is
safe.

---

## Constraints

- **Never** push the Story branch directly to `main`. The PR is the only
  merge surface.
- **Always** `cd` into the `workCwd` returned by Step 0 before editing.
- **Always** pass `--cwd <main-repo>` to `single-story-close.js` when
  invoking from inside a worktree (worktree-local branch deletion fails
  when run from inside the worktree).
- **MCP fallback**: if `mandrel` MCP tools fail, fall back to
  `node .agents/scripts/update-ticket-state.js --task <id> --state <state>`
  for label transitions.

---

## See also

- [`/story-execute`](story-execute.md) — Epic-attached Story execution.
- [`/epic-deliver`](epic-deliver.md) — full Epic wave loop.
