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
  → CI watch + fix loop            (until all required checks pass + PR is merged)
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
`git-cleanup.js` scoped to `story-*` only, in
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

`--no-full-scope-crap` disables the close-time full-scope CRAP scan
(Story #1945) and falls back to the diff-scoped check the framework used
historically. The full-scope scan adds ~3s to close on a ~1400-method
repo; the opt-out exists for cases where that cost becomes prohibitive.
The post-merge CI run still enforces full-scope CRAP either way, so the
opt-out trades close-time detection for the slower watch-loop round-trip
described in Step 4.

---

## Step 4 — CI watch + fix loop (safety net, post Story #1945)

The Story is **not done** when `single-story-close.js` returns. Auto-merge
only fires when every required CI check turns green. Local close-validation
gates pass on the dev host's environment (Windows, particular Node patch,
particular concurrency), but CI runs on a different OS and concurrency —
coverage rounding, platform-conditional branches, and timing-sensitive
tests routinely drift between the two. The agent owns the green-CI
outcome, not just the push.

Story #1945 narrowed the gap by running **full-scope** CRAP and coverage
gates at close time, mirroring CI's post-merge `push` event on main. The
common drift mode that motivated this workflow's watch+fix loop — an
unrelated method's CRAP score regressing on CI Linux after a PR that
didn't touch the file — is now caught **before** push in the close-
validation chain rather than after auto-merge in the CI run. Genuine
host-vs-CI drift (platform-conditional code paths, true flakes) still
escapes close, so the loop below remains the canonical safety net; it is
no longer the primary detection point for environmental CRAP drift.

After `single-story-close.js` succeeds, enter the watch + fix loop via
the shared watch-and-recover helper. The helper wraps `gh pr checks
--watch` and additionally auto-recovers from `mergeStateStatus: BEHIND`
by calling `gh pr update-branch` once every required check is green
(branch-protection rules requiring "up to date before merging" otherwise
park the PR until the operator clicks **Update branch** manually):

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>
```

`<agentRoot>` resolves from `project.paths.agentRoot` (default
`.agents`). Pass `--max-updates N` (default 3) to cap how many times
the helper will recover from BEHIND in one session, and
`--poll-interval-ms MS` (default 10000) to override the polling cadence.

When the helper exits:

- **0 (merged or green+clean)** — auto-merge will fire (or has
  already). The `Closes #<id>` footer closes the Story issue on merge.
  Done.
- **Non-zero (throw)** — the helper throws on terminal check failure,
  PR closure without merging, or when the update-branch cap is
  exhausted. Diagnose, fix, and push a new commit on `story-<storyId>`,
  then re-run the helper. Auto-merge stays enabled across retries; no
  need to re-arm it.

### Resurrecting the worktree after `reapOnSuccess`

`single-story-close.js` reaps the worktree on success when
`delivery.worktreeIsolation.reapOnSuccess` is enabled (the default). To
fix CI you must re-attach a worktree to the existing remote branch:

```bash
cd <main-repo>
git fetch origin story-<storyId>
git worktree add .worktrees/story-<storyId> story-<storyId>
cd .worktrees/story-<storyId>
```

Do **not** re-run `single-story-init.js` — it would reset the branch
state and lose the close commit's structured comment.

### Diagnosing the failure

Pull the failing job log via:

```bash
gh run view <runId> --repo <owner>/<repo> --log-failed
```

The `<runId>` is the run number that `gh pr checks` shows in the
failing row's URL. Read the bottom of the log — the gate that exited
non-zero is named there (e.g. `[Coverage] ❌ REGRESSION in …`).

### Fixing without re-running close-validation

For coverage / maintainability / CRAP regressions detected only on CI:

1. Update the relevant baseline file (`baselines/coverage.json`,
   `baselines/maintainability.json`, `baselines/crap.json`) to absorb
   CI's actual numbers. Edit by hand when CI's numbers are within the
   tolerance you'd otherwise accept — don't re-run `npm run … :update`
   locally, because Windows numbers will overwrite CI's Linux numbers
   and the cycle repeats.
2. Commit the baseline delta with a `chore(baselines):` message that
   names the CI run that produced the values.
3. `git push` to `origin/story-<storyId>` and re-watch.

For genuine test failures (a flaky test, a platform-conditional bug):
fix the code or test, commit, push, re-watch. Keep iterating until
the watch exits clean.

### When to stop iterating

- **Three consecutive failures with the same fix shape** — stop and
  Re-Plan per Anti-Thrashing Protocol. The diagnosis is likely wrong.
- **Operator-blocking failure** (security scanner, branch-protection
  rule the agent can't change) — transition the Story to
  `agent::blocked`, summarize the blocker on the PR, and yield to the
  operator.

### Idempotence of the loop

- The PR stays open across retries; `gh pr create` is a one-shot at
  close, the loop only pushes new commits.
- Auto-merge stays armed across retries — pushing a new commit does
  not disarm `gh pr merge --auto`.
- If the operator manually merges or disables auto-merge mid-loop,
  exit the loop and report.

---

## Step 5 — Merge confirmation

With auto-merge enabled (default), GitHub squash-merges the PR when
every required check turns green and the `Closes #<id>` footer
auto-closes the Story issue.

Confirm the merge landed:

```bash
gh pr view <prNumber> --json state,mergedAt,mergeCommit
```

Expect `state: "MERGED"`. The Story is now complete.

With `--no-auto-merge`, the PR is the merge gate. The operator reviews
and merges via the GitHub UI; the same `Closes #<id>` auto-close fires
when the merge lands on `main`.

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
