---
description: >-
  Reference companion to `helpers/single-story-deliver.md` — the lease and
  sweep detail, worktree-scope warnings, CI-recovery procedures, and
  Status-column reconciliation lifted out of the runtime core so the
  always-ingested standalone-delivery prose stays lean. Not a slash command;
  consulted on demand when the core file points here.
caller: helpers/single-story-deliver.md
---

# helpers/single-story-deliver — reference (lease, recovery, troubleshooting)

> **Not a slash command, not the runtime path.** This file is the
> reference companion to
> [`single-story-deliver.md`](single-story-deliver.md). The core file
> carries the step flow, commands, gate contracts, and the return contract a
> standalone-Story run needs; this file holds the lease/sweep mechanics, the
> worktree-scope safety warning, the CI-recovery procedures, and the
> Status-column reconciliation the core points at with one-line pointers.
> Read a section here only when the matching pointer in the core sends you.

---

## Step 0 — Lease preflight and merged-sweep

### Lease preflight (Story #3483)

Before any git mutation, init takes an exclusive, time-bounded **lease** on
the Story ticket via the assignee-as-lease primitive
(`lib/orchestration/ticket-lease.js`). The single assignee *is* the lease
owner (resolved from `github.operatorHandle`). The standalone path has no
Epic-scoped dispatch manifest to serialise two operators driving the same
Story, so this lease is the only guard against a concurrent
`single-story-init` clobbering an in-flight run.

**Fail-closed (audit #3513).** Unlike `/deliver`, the standalone path
has **no Epic-scoped lifecycle ledger** to read a per-owner
`story.heartbeat` from, so there is no live-heartbeat source to decide
whether a foreign claim is stale. Rather than silently reclaim every
foreign assignee (which would leave the guard inert), the standalone lease
**fails closed**: a foreign assignee is treated as a *live* claim. Outcomes:

- **Unclaimed / self-held** → init proceeds (a self-held claim is
  re-affirmed without re-writing assignees).
- **Any foreign assignee** → init **exits non-zero** with a message naming
  the current owner. Coordinate with that operator, or pass **`--steal`** to
  forcibly transfer the claim once you have confirmed the other run is dead.

`--dry-run` skips the lease (no assignee mutation). The matching release
runs in `single-story-close.js` (Step 3).

### Branch reuse (Story #3483)

When a `story-<id>` branch already exists locally, init **reuses** it rather
than re-creating it (re-running `git branch` on an existing ref throws
`branch already exists`). The seed decision (`reuse` / `fetch` / `create`)
keys off local + remote ref presence, so re-running init on a
partially-initialized Story is idempotent.

### Merged-`story-*` sweep

Between the fetch and the branch-seed step, the script runs a
**merged-`story-*` sweep**: it invokes the same primitive as
`<agentRoot>/scripts/git-cleanup.js` (`<agentRoot>` resolves
from `project.paths.agentRoot`, default `.agents`) scoped to `story-*`
only, in `--execute --remote` mode, with the current run's
`story-<id>` branch excluded from the candidate list. Local refs, the
matching `origin/` ref, and stale tracking refs for any merged sibling
stories are reaped in one pass. The sweep never blocks init — failures
are logged and the new story is initialized regardless.

The sweep applies two hardening layers (Story #2011):

- **Per-candidate protection.** Each merged-PR candidate is filtered
  through three guards before reaching `executeCleanup`:
  - `unpushed-work` — branch HEAD SHA differs from the PR's
    `headRefOid`, meaning the operator has commits the merge didn't
    capture.
  - `dirty-tree` — the attached worktree (if any) has uncommitted
    changes.
  - `ticket-not-done` — the parent Story ticket isn't closed and
    doesn't carry `agent::done`.
  Protected candidates are skipped, listed in the sweep result envelope
  under `protected[]`, and named in the `CLEANUP` log line so the
  operator can see what was preserved.
- **Cross-session lock.** The sweep acquires a process-scoped lockfile
  at `<tempRoot>/single-story-sweep.lock` before planning. On
  contention (another `/single-story-deliver` already in the sweep
  step), this run's sweep is **skipped** with a warn log; init
  continues normally. Stale lockfiles (mtime older than the timeout)
  are treated as expired. The timeout defaults to 60 seconds and is
  overridable via `delivery.worktreeIsolation.sweepLockMs` in
  `.agentrc.json`.

Both layers are non-fatal — sweep failure / skip never blocks init, and
the new story is always created. `--dry-run` also skips the sweep.

### Worktree scope is not just the Bash cwd

`cd <workCwd>` steers the **Bash** tool's working directory, but it does
**not** scope the path-based **Edit/Write/Read** tools — those resolve
**absolute paths** and ignore the shell cwd. On Windows especially, an agent
whose shell sits in the worktree can still silently edit the **main
checkout** if it resolves a main-checkout absolute path. To stay in the
worktree you MUST prefix **every Edit/Write/Read path with the absolute
worktree root** (the `workCwd` value from Step 0), not merely `cd` into it.
Never edit files under the bare main-checkout root. `single-story-close.js`
runs a **wrong-tree guard** (Story #3364) that aborts close and posts a
`friction` comment if it finds uncommitted tracked-path edits in the main
checkout while the worktree is the active work tree — but that is a backstop,
not a substitute for prefixing paths correctly.

---

## Step 3 — Close pipeline detail

The `single-story-close.js` script, in order:

1. Runs the close-validation gates against `baseBranch` as the baseline.
   On any gate failure it throws — the operator fixes and re-runs close.
1a. **Syncs the Story branch from `origin/<baseBranch>`** before push
   (Story #2580). Runs `git fetch origin <baseBranch>` followed by
   `git merge --no-edit origin/<baseBranch>` inside the worktree. This
   defends against the parallel-`/single-story-deliver` race: when
   multiple sessions run in parallel, the Story that auto-merges first
   bumps `baseBranch`, and without this sync the lagging Stories open
   PRs that are "behind base" and stall against branch-protection's
   `up-to-date branch` rule. Outcomes:
   - **No-op / fast-forward / clean merge-commit** → close proceeds to
     push.
   - **Merge conflict** → the merge is aborted, a `friction` structured
     comment is posted on the Story (conflicting file list + recovery
     command set), the Story flips to `agent::blocked`, and close
     throws. Resolve in the worktree (`git merge origin/<base>` + fix
     conflicts + `git commit --no-edit`) and re-run
     `/single-story-deliver`.
   - **Fetch failed** → close throws with the git stderr; no label
     transition.

   Note: the merge queue (when enabled) re-tests each PR against the
   queue tip before merging, so this sync + merge queue is the complete
   defence against the parallel race. Without merge queue, the sync
   closes the PR-open-time race but a residual race remains between PR
   open and auto-merge fire.
2. Pushes `story-<id>` to `origin`.
3. Probes for an existing open PR with `head = story-<id>`. If none
   exists, opens one via `gh pr create --base <baseBranch>`. The PR
   body carries `Closes #<storyId>` so the GitHub merge auto-closes the
   issue.
3a. **Enables GitHub native auto-merge by default** via
   `gh pr merge <prNumber> --auto --squash --delete-branch`. Once CI's
   required checks turn green, GitHub squash-merges the PR and deletes
   the source branch — the operator does not need to babysit the merge
   button. Mirrors the `/deliver` finalize path. Failure is
   non-fatal: the operator retains the manual merge surface in the
   GitHub UI. Pass `--no-auto-merge` to opt out when the PR needs a
   pre-merge eyeball.
4. Flips the Story to **`agent::closing`** (NOT `agent::done`) and leaves
   the GitHub issue **OPEN** (Story #3385). Auto-merge completes
   asynchronously *after* this script exits, so closing the issue here
   would strand a CLOSED issue with no merged work if the PR later failed
   CI, went `BEHIND` base, or was closed without merging. The Story rests
   at `agent::closing` while the PR is open with auto-merge armed; the
   `agent::done` flip (which closes the issue) is deferred to Step 5.5's
   `single-story-confirm-merge.js`. This brings the standalone path to
   parity with the epic path (#2155), where a Story only reaches
   `agent::done` once its merge into `epic/<id>` is confirmed.
5. Reaps the worktree when `delivery.worktreeIsolation.reapOnSuccess`
   is enabled.
6. **Releases the Story lease** (Story #3483). Clears the Story assignment
   that init claimed so the next `/single-story-deliver` run sees an
   unclaimed ticket. The release is a no-op when the operator no longer
   holds the claim (a later run took over via reclaim/steal), so a late
   close never yanks a live claim away from its current owner. Best-effort:
   a release failure is logged but does not fail an otherwise-clean close —
   the lease goes stale via TTL regardless. The close result carries
   `leaseReleased: <boolean>`.

`--skip-validation` bypasses Step 1 (gates). Use only when re-running
close after a fixed gate failure that's already known to pass.

`--skip-sync` bypasses Step 1a (base-sync). Use only when re-running
close after a hand-resolved sync, or in tests.

`--no-auto-merge` disables Step 3a. Use when the PR materially changes
behaviour and warrants pre-merge review.

---

## Step 4 — CI watch + fix recovery

### The auto-merge wait is an internally-blocking step

This is the single most important contract of this workflow, and the seam
where a worker most often misbehaves: it delivers up to arming auto-merge,
then ends its turn with **free-form prose** — e.g. "I'll wait for the
background watch task to complete" or "the next event will be its completion
notification" — leaving the merge unconfirmed and the Story stranded at
`agent::closing` (observed on Story #1553 / PR #1554). **Do not do this.**
`pr-watch-with-update.js --pr <prNumber>` *blocks the current turn* until CI
resolves — that is the mechanism by which you wait. You MUST keep your turn alive
across the wait: watch → (fix + push + re-watch on red) → confirm the merge
(Step 5) → flip `agent::done` → run the post-merge steps → and only then
return the terminal JSON status contract. The CI wait NEVER terminates your
turn; **only** a confirmed-`MERGED` PR (→ `status: "done"`), an
`agent::blocked` transition (→ `status: "blocked"`), or an unrecoverable
failure (→ `status: "failed"`) does. Ending your turn with prose and an
unconfirmed merge is a contract violation — it is the very bug this workflow
exists to prevent.

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

## Step 5 — Merge confirmation detail

`single-story-confirm-merge.js` re-reads the live PR state (`gh pr view
--json state,mergedAt`, probing `gh pr list --head story-<id> --state all`
when `--pr` is omitted) and:

- **PR `MERGED`** → flips `agent::closing → agent::done`, closing the
  issue, and fires the `story-merged` notify. Prints
  `{ action: 'done', merged: true, ... }`.
- **PR still open / closed-without-merge** → leaves the Story at
  `agent::closing` (issue stays OPEN) and prints
  `{ action: 'pending', reason: 'pr-open' | 'pr-not-merged' | 'no-pr' }`.
  Re-run after the merge lands.
- **Story already `agent::done` / issue already closed** → idempotent
  `{ action: 'noop', reason: 'already-done' }`.

This is the standalone counterpart to the epic path's post-merge
`agent::done` flip in `post-merge-close.js` (#2155): the issue closes
exactly when the work has merged, never at PR-open.

---

## Step 5.5 — Re-assert Status column detail

The GitHub Projects v2 built-in workflows `Pull request merged` and
`Pull request linked to issue` are enabled by default on most boards
and fire ~minutes *after* auto-merge lands. They overwrite the Status
field as a side-effect, clobbering the `Done` value
`single-story-confirm-merge.js` set at the `agent::done` flip in Step 5
and leaving closed Stories stuck at `In Progress` on the board
(reproduced on Story #2813). The confirmation step has already exited by
then, so the bot gets the last write.

`resync-status-column.js`:

- Reads the ticket's current `agent::*` label set (now `agent::done`).
- Re-fires the same `ColumnSync` mutation `transitionTicketState` used
  at close, overwriting the bot's late write.
- **Polls the live Status for ~15 s after the initial write** and
  re-fires on drift (Story #2876). Without this loop, a one-shot
  mutation routinely lost the race against the bot's asynchronous
  fire (reproduced on Story #2871 / PR #2872).
- Prints a single-line JSON envelope:
  `{ ticketId, status, column?, reason?, attempts? }`. `attempts > 1`
  means the helper had to fight a bot overwrite; `status: 'drifted'`
  means the bot won every attempt in the poll budget (rare; usually
  signals operator should reap the conflicting workflows).

Tuning flags (rarely needed):

- `--poll-attempts <n>` — total mutation attempts including the
  initial sync. Default `4`. Pass `1` to disable the poll loop
  (fastest, matches pre-#2876 behaviour).
- `--poll-delay-ms <ms>` — delay between drift checks. Default `5000`.

Idempotent: re-running on a ticket whose Status already matches the
target returns the same envelope. No-op skips (`no-project`,
`no-meta`, `not-on-project`) exit 0 with the reason in the envelope
so the workflow can continue.

**Canonical operator fix:** run
`node .agents/scripts/agents-bootstrap-github.js --reap-conflicting-workflows`
once per project to delete the conflicting bot workflows entirely.
This eliminates the race source; the poll loop becomes pure
defense-in-depth against re-enabled or future workflows.

---

## Step 6 — Local branch cleanup detail

GitHub deletes the **remote** branch on auto-merge (via the
`--delete-branch` flag `single-story-close.js` passes to `gh pr merge`).
The **local** `story-<storyId>` ref, however, lingers in the main
checkout until something prunes it — `single-story-init.js` runs a
merged-sweep at the start of every *subsequent* `/single-story-deliver`
invocation, but that's next-run cleanup, not end-of-run cleanup. Stale
local refs accumulate between sessions, clutter `git branch`, and shadow
the lessons the sweep is meant to surface.

**Why local `main` goes stale:** `single-story-init.js` seeds new
`story-<id>` branches from the **local** `baseBranch` ref (default
`main`). Auto-merge updates **`origin/main`** on GitHub; nothing in
close or the old Step 6 command updated **local `main`**. The next init
then forked from a tip six merges behind until you manually pulled.
`single-story-init` also attempts the same fast-forward after `git fetch`
when the main checkout is clean (defense in depth if Step 6 was skipped).
Step 6 must still run `--fast-forward-main` so local `main` is current
before the next session — init may skip when the tree is dirty or the
operator is mid-checkout on another branch.

What the Step 6 cleanup command does:

- **`--fast-forward-main`** fetches `origin/<baseBranch>` and
  `git merge --ff-only` on the main checkout when the tree is clean and
  the local base is strictly behind remote. Skipped when already current,
  dirty, or diverged (see `/git-cleanup`).
- **`--branches`** reaps the merged `story-<storyId>` ref (worktree,
  local branch, stale `origin/` tracking ref). Does not run
  `--prune-remotes` or `--stashes` unless you add those flags.
- **`--include "story-<storyId>"`** scopes the branch reap to this
  Story's ref only — sibling stories in flight are untouched.
- **`--execute --remote --yes`** actually deletes the local ref, prunes
  the matching `origin/` tracking ref, and runs non-interactively.

The sweep is idempotent. It is safe to run before `state: "MERGED"`
confirms (it will skip a not-yet-merged branch), and safe to re-run
after a successful cleanup (it reports "no merged branches to clean
up").

---

## Step 7 — Return-contract detail

**The auto-merge wait does not produce a fourth status.** There is no
"pending" or "waiting" terminal — the CI/auto-merge wait is handled
*internally* by blocking on `pr-watch-with-update.js` (Step 4) and confirming
the merge (Step 5). You return **only** when you have reached a genuinely
terminal state:

- **`status: "done"`** — the PR is confirmed `state: "MERGED"` (Step 5),
  the Story carries `agent::done`, and Steps 5.5 / 6 have run. `phase: "done"`,
  `branchDeleted: true`.
- **`status: "blocked"`** — you transitioned the Story to `agent::blocked`
  and posted a `friction` comment (acceptance self-eval block in Step 1a, a
  base-sync conflict, or an operator-blocking CI failure / Anti-Thrashing
  stop in Step 4). `phase: "blocked"`, `blockerCommentId` set.
- **`status: "failed"`** — an unrecoverable failure outside the blocked
  protocol. `phase` reflects where it died.

A turn that ends with prose ("I'll wait for the watch task…", "the next event
will be its completion notification…") and an **unconfirmed merge** is a
**contract violation** (the Story #1553 / PR #1554 failure mode): the parent
wave loop cannot distinguish "still working" from "done but silent", and the
Story strands at `agent::closing`. If you genuinely cannot confirm the merge,
that is a `blocked` or `failed` outcome with the JSON contract — not a
prose hand-off.

> **Handoff discipline — report state, not process.** Populate the envelope
> with essential terminal state only (mirroring the fields
> `single-story-close.js` / `story-phase.js` already emit). Do not narrate the
> steps you took, and do not prescribe how the next stage should work. Prose
> process commentary only bloats the hydrated prompt
> (`delivery.maxTokenBudget` elision). When run **interactively** (no parent
> aggregator), this JSON envelope is optional — relay terminal state to the
> operator in prose instead — but the **no-park rule still holds**: never end
> an interactive turn with an unconfirmed merge either; block on the watch,
> confirm, and report the merged outcome.
