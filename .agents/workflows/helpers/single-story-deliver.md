---
description:
  Execute a standalone Story (no parent Epic) end-to-end. Creates a branch
  from main, implements the changes in a worktree, runs gates, pushes, and
  opens a PR directly against main.
---

# /single-story-deliver #[Story ID]

> **Runtime core.** This file is the always-ingested standalone-Story path:
> step flow, commands, gate contracts, and the return contract. The lease /
> sweep mechanics, the worktree-scope safety warning, the CI-recovery
> procedures, and the Status-column reconciliation live in the sibling
> [`single-story-deliver-reference.md`](single-story-deliver-reference.md);
> each moved procedure keeps a one-line pointer at its trigger point below.
> The reference is not projected to `.claude/commands/` — it is consulted on
> demand.

## Overview

`/single-story-deliver` is the standalone counterpart to
[`/deliver`](deliver-stories.md). Use it for a Story that is **not**
attached to an Epic — refactors carved out of closed Epics, framework
maintenance, or any work small enough that the Epic-Centric ceremony
(sectioned Epic body + decomposition + dispatch manifest + cascade) would be
overhead rather than help.

```text
/single-story-deliver <storyId>
  → single-story-init.js          (branch from main, worktree, agent::executing)
  → agent implements + commits     (operator works in the worktree)
  → single-story-close.js          (gates, push, gh pr create → main, agent::closing)
  → CI watch + fix loop            (until all required checks pass + PR is merged)
  → single-story-confirm-merge.js  (PR merged → agent::done, issue closes)
```

**When to use `/single-story-deliver` vs. `/deliver`:**

| Trait                         | `/single-story-deliver`                              | `/deliver`                                         |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Parent Epic                   | None (no `Epic: #N` in body)                         | Required (`Epic: #N` in body)                           |
| Branch base                   | `project.baseBranch` (default `main`)          | `epic/<epicId>`                                         |
| Merge target                  | `main` via PR                                        | `epic/<epicId>` via `--no-ff` merge                     |
| Epic-branch integration       | No                                                   | Yes — merged into `epic/<epicId>` at close              |
| Dispatch manifest interaction | None                                                 | Read at init, regenerated at close                      |
| Story scope                   | Inline `acceptance[]` / `verify[]` on the Story body | Inline `acceptance[]` / `verify[]` on the Story body    |

If the Story has an `Epic: #N` reference, use `/deliver`. If it
doesn't, use this workflow (or `/deliver` for several standalone
Stories at once).

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

Flags: `--dry-run` (no git/ticket mutation), `--steal` (forcibly transfer a
foreign Story lease to this operator — see the lease note below).

> **Execution mode.** Like `story-init.js`, this command can take 3–6
> minutes when the worktree's per-tree install runs. Invoke synchronously
> with `Bash(timeout: 600000)`. Do **not** use `run_in_background` +
> `Monitor` — a sub-agent that exits mid-install leaves the worktree
> half-bootstrapped.

The script validates `type::story`, **acquires the Story lease**, fetches
`origin`, seeds `story-<id>` from `baseBranch`, materializes a worktree
(when `delivery.worktreeIsolation.enabled` is true), upserts a
`story-init` structured comment carrying `standalone: true`, and flips
the Story to `agent::executing`. It also reuses an existing `story-<id>`
branch (idempotent re-init) and runs a **merged-`story-*` sweep** between
fetch and branch-seed.

> **Lease preflight, branch reuse, and merged-sweep.** The standalone lease
> **fails closed** on a foreign assignee (there is no Epic-scoped
> heartbeat ledger to judge staleness) — coordinate or pass `--steal`. The
> sweep is guarded (per-candidate protection + cross-session lock) and
> never blocks init. See
> [`single-story-deliver-reference.md` § Step 0 — Lease preflight and merged-sweep](single-story-deliver-reference.md#step-0--lease-preflight-and-merged-sweep)
> for the fail-closed outcomes, the `--steal` contract, and the sweep
> hardening layers.

Capture `workCwd` from the result envelope. Add `--dry-run` to inspect
the planned actions without git or ticket mutations (dry-run also skips
the lease and the sweep).

### Step 0.5 — `cd` into the workCwd

```bash
cd "<workCwd from Step 0 result>"
```

All subsequent commands run from this directory.

> **Worktree scope is not just the Bash cwd.** `cd <workCwd>` steers the
> Bash tool's cwd but does **not** scope the path-based Edit/Write/Read
> tools — you MUST prefix every such path with the absolute `workCwd` root or
> risk silently editing the main checkout. Close's wrong-tree guard (Story
> #3364) is a backstop, not a substitute. See
> [`single-story-deliver-reference.md` § Worktree scope is not just the Bash cwd](single-story-deliver-reference.md#worktree-scope-is-not-just-the-bash-cwd).

---

## Step 1 — Implementation

A standalone Story is **atomic** — no wave dispatch and no Epic-scoped
cascade. Work happens in one or more commits on the `story-<id>`
branch, against the inline `acceptance[]` / `verify[]` arrays on the
Story body.

Operator/agent responsibilities while in the worktree:

1. Read the Story body. Treat its acceptance criteria as the contract.

   **Docs context — digest-first.** A standalone Story has no parent Epic,
   so there is usually no per-Epic docs digest to read. If the caller
   provides a `docsDigestPath` (the per-Epic docs digest at
   `temp/epic-<epicId>/docs-digest.md`), read that compact outline instead
   of re-reading the full `project.docsContextFiles` set, and pull
   individual docs files on demand (jump to the section at the line number
   the digest names). When no digest path is provided, read a full doc
   only when the Story's own context points you at one — do not ingest the
   whole docs set up front. See
   [`.agents/instructions.md` § 3](../../instructions.md).
2. Implement the changes.
3. Commit on the Story branch. Conventional-commit format is encouraged
   but not enforced — the PR title carries the canonical summary.
4. Iterate (read tests, run targeted gates, edit, commit) until the
   acceptance criteria are met.
5. Run the **bounded acceptance self-eval loop** (Step 1a below) before
   proceeding to close.

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

### Step 1a — Bounded acceptance self-eval loop (**required, not optional**)

After the implementation commits land and **before** you proceed to close, run
the bounded acceptance self-eval loop. The per-round critic mechanic (fresh-
context critic, `verify[]`-as-evidence, the verdict schema, and the
proceed / redraft / block decision) is the single-homed include
[`acceptance-self-eval.md`](acceptance-self-eval.md) — read it and follow it.

Standalone specifics for this path:

- **Critic evidence-share** (Story #4250). When the critic runs a `verify[]`
  command that is byte-identical to a close gate (`lint` / `typecheck`), it
  records the pass into the standalone evidence keyspace via `--standalone`
  (no parent Epic to key on) so Step 3's close short-circuits the gate at
  unchanged HEAD. Run it in the **Story worktree** (`workCwd` from Step 0):

  ```bash
  node <main-repo>/.agents/scripts/evidence-gate.js \
    --standalone --scope-id <storyId> --gate lint \
    --worktree <workCwd> -- npm run lint
  ```

- **Gate invocation** (omit `--epic` — there is no parent Epic):

  ```bash
  node <main-repo>/.agents/scripts/acceptance-eval.js \
    --story <storyId> --verdict <verdict-path>
  ```

- **On `decision: "proceed"`** → proceed to Step 3 (close).
- **On `decision: "block"`** → **do not proceed to close.** Post a `friction`
  comment naming the unmet criteria, then transition the Story to
  `agent::blocked`:

  ```bash
  node .agents/scripts/diagnose-friction.js --story <storyId> \
    --cmd node .agents/scripts/acceptance-eval.js --story <storyId> --verdict <verdict-path>
  node .agents/scripts/update-ticket-state.js --ticket <storyId> --state agent::blocked
  ```

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

The script runs the close-validation gates against `baseBranch`, syncs the
Story branch from `origin/<baseBranch>` (Story #2580 — the parallel-race
defence), pushes `story-<id>`, opens (or reuses) a PR against `baseBranch`
with a `Closes #<storyId>` footer, enables GitHub native auto-merge
(`--auto --squash --delete-branch`) **when `delivery.ci.autoMerge` is
`"trust-ci"` (the default)**, flips the Story to **`agent::closing`**
(NOT `agent::done` — the issue stays OPEN until Step 5 confirms the merge,
Story #3385), reaps the worktree, and releases the Story lease.

> **`delivery.ci.autoMerge` policy (shared with the Epic path).** The
> standalone close honours the same config knob the Epic Phase 8.5 gate
> reads. Under the default `"trust-ci"`, GitHub native auto-merge is armed
> and the PR squash-merges once its **required** checks pass (GitHub's
> `--auto` is the required-check gate — no client-side predicate is needed
> here, unlike the Epic path, because a standalone Story runs no
> audit/review/retro phase to gate on). Under `"strict"`, the close **does
> not arm auto-merge** — the PR opens and waits for an **operator merge**,
> exactly as `--no-auto-merge` does per-run. This lets a consumer who tightens
> Epic merges with `"strict"` get the same operator-in-the-loop behaviour for
> standalone Stories.

Flags:

- `--skip-validation` — bypass the gates (Step 1). Use only when re-running
  close after a fixed gate failure that's already known to pass.
- `--skip-sync` — bypass the base-sync (Story #2580). Use only after a
  hand-resolved sync, or in tests.
- `--no-auto-merge` — disable auto-merge. Use when the PR materially changes
  behaviour and warrants a pre-merge eyeball; the operator then merges via
  the GitHub UI.

> **Full close pipeline (base-sync outcomes, `agent::closing` rationale,
> lease release).** For the numbered close pipeline, the base-sync outcome
> table (no-op / conflict → `agent::blocked` / fetch-failed), and why the
> issue stays OPEN at `agent::closing`, see
> [`single-story-deliver-reference.md` § Step 3 — Close pipeline detail](single-story-deliver-reference.md#step-3--close-pipeline-detail).

---

## Step 4 — CI watch + fix loop (**required, not optional**)

The Story is **not done** when `single-story-close.js` returns. Auto-merge
only fires when every required CI check turns green. Local close-validation
gates pass on the dev host's environment; CI runs on a different OS and
concurrency, and coverage rounding, platform-conditional branches, and
timing-sensitive tests routinely drift between the two. The agent owns the
green-CI outcome, not just the push.

> **The auto-merge wait is an internally-blocking step, not a reason to end
> your turn.** `pr-watch-with-update.js` blocks the current turn until CI
> resolves — that IS how you wait. Keep the turn alive: watch → (fix +
> push + re-watch on red) → confirm the merge (Step 5) → flip
> `agent::done` → post-merge steps → return the terminal JSON contract.
> Ending the turn with prose and an unconfirmed merge is a contract
> violation (the Story #1553 / PR #1554 failure mode). See
> [`single-story-deliver-reference.md` § The auto-merge wait is an internally-blocking step](single-story-deliver-reference.md#the-auto-merge-wait-is-an-internally-blocking-step).

After `single-story-close.js` succeeds, enter the watch + fix loop. Drive
`pr-watch-with-update.js` — the **single CI-watch mechanism** shared with
the Epic Phase 8 path (Story #4358). It polls the required checks to a
terminal state and auto-recovers from `mergeStateStatus: BEHIND`; do
**not** fall back to a bare `gh pr checks` watch invocation:

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>
```

Poll cadence and caps come from `delivery.ci.watch.*`
(`pollIntervalMs`, `maxPolls`, `maxResumes`); pass `--poll-interval-ms`,
`--max-polls`, or `--max-resumes` to override for one run.

When the watch exits, branch on the exit code:

- **Exit 0 (all checks ✓)** — auto-merge will fire (or has already). The
  Story is still at `agent::closing` with its issue OPEN. **Proceed to
  Step 5 within the same turn** — green CI is the *start* of the
  merge-confirm sequence, not a terminal state.
- **Exit 1 (a check genuinely failed)** — diagnose, fix, and push a new
  commit on `story-<storyId>`, then re-watch. Auto-merge stays enabled
  across retries; no need to re-arm it. The Story stays at
  `agent::closing` throughout, so a failed/abandoned PR never strands a
  CLOSED issue. If the same failure class recurs, hand convergence off to
  the host loop: `/loop /loops:fix-failing-tests`.
- **Exit 2 (still-running — slow CI, not red)** — the poll cap fired with
  checks still pending and the watcher exhausted its resume budget with
  nothing red. This is **never** a failure. Hand the wait off to the
  host's interval loop rather than ending your turn:
  `/loop 5m /loops:watch-ci`.

> **Triage authority.** How to classify and remediate a red (or repeatedly
> slow) check — the root-cause-only decision tree for infra/transient and
> flaky failures (reproduce → check `main` → bisect env vs code → fix in-scope
> or file a `meta::framework-gap` issue), the never-rerun / never-quarantine
> prohibitions, and the escalation criteria (three-strikes, the 30-minute
> wall-clock timebox, and the clearly-environmental fast path) — is defined
> once in [`.agents/rules/ci-remediation.md`](../../rules/ci-remediation.md).
> Read it before remediating a red check above.
>
> **CI recovery procedures.** For resurrecting the worktree after
> `reapOnSuccess`, pulling the failing job log, fixing coverage/CRAP
> baselines without re-running close-validation, and the when-to-stop
> Anti-Thrashing rules, see
> [`single-story-deliver-reference.md` § Step 4 — CI watch + fix recovery](single-story-deliver-reference.md#step-4--ci-watch--fix-recovery).

---

## Step 5 — Merge confirmation + `agent::done` flip (**required, not optional**)

With auto-merge enabled (default), GitHub squash-merges the PR when
every required check turns green and the `Closes #<id>` footer
auto-closes the Story issue.

Confirm the merge landed:

```bash
gh pr view <prNumber> --json state,mergedAt,mergeCommit
```

Expect `state: "MERGED"`. With `--no-auto-merge`, the PR is the merge
gate — the operator reviews and merges via the GitHub UI; the same
`Closes #<id>` auto-close fires when the merge lands on `main`.

**Then flip the Story to `agent::done`.** Step 3 deferred this flip
(Story #3385); now that the merge is confirmed, drive the
`agent::closing → agent::done` transition (which closes the issue) via:

```bash
node .agents/scripts/single-story-confirm-merge.js --story <storyId> --cwd <main-repo>
```

> **Confirmation outcomes.** `single-story-confirm-merge.js` re-reads the
> live PR state and flips to `agent::done` only on a confirmed `MERGED` PR;
> it is idempotent and safe to re-run while the PR is still open (returns
> `pending`). See
> [`single-story-deliver-reference.md` § Step 5 — Merge confirmation detail](single-story-deliver-reference.md#step-5--merge-confirmation-detail).

---

## Step 5.5 — Re-assert Status column (**required, not optional**)

GitHub Projects v2 built-in workflows fire minutes *after* auto-merge lands
and clobber the `Done` Status the confirm step set, stranding closed
Stories at `In Progress` on the board (reproduced on Story #2813).
Re-assert authority once the merge confirms:

```bash
node .agents/scripts/resync-status-column.js --story <storyId>
```

The helper re-fires the `ColumnSync` mutation and **polls for ~15 s** to win
the race against the bot's late write (Story #2876). It is idempotent and
no-op-safe (`no-project` / `not-on-project` exit 0). Skip Step 5.5 only when
the operator opted out of auto-merge AND has not yet merged the PR — run it
after the manual merge instead.

> **Status-column detail + tuning flags + operator fix.** For the poll-loop
> flags (`--poll-attempts`, `--poll-delay-ms`), the `attempts` / `drifted`
> envelope semantics, and the canonical
> `--reap-conflicting-workflows` operator fix, see
> [`single-story-deliver-reference.md` § Step 5.5 — Re-assert Status column detail](single-story-deliver-reference.md#step-55--re-assert-status-column-detail).

---

## Step 6 — Local branch cleanup (**required, not optional**)

GitHub deletes the **remote** branch on auto-merge, but the **local**
`story-<storyId>` ref lingers in the main checkout until something prunes
it. After Step 5 confirms `state: "MERGED"`, prune the story ref **and**
fast-forward local `main` (or `project.baseBranch`):

```bash
node .agents/scripts/git-cleanup.js \
  --execute \
  --remote \
  --yes \
  --fast-forward-main \
  --branches \
  --include "story-<storyId>"
```

`--fast-forward-main` brings local `main` current (the next init seeds from
it), `--branches` + `--include` reap only this Story's ref, and
`--execute --remote --yes` run the deletes non-interactively. The sweep is
idempotent and safe to run before `MERGED` confirms. Skip Step 6 only when
the operator opted out via `--no-auto-merge` AND has not yet merged the PR —
run the cleanup after the manual merge lands.

> **Why local `main` goes stale + per-flag behaviour.** For the stale-`main`
> mechanism and the full `--fast-forward-main` / `--branches` / `--include`
> flag semantics, see
> [`single-story-deliver-reference.md` § Step 6 — Local branch cleanup detail](single-story-deliver-reference.md#step-6--local-branch-cleanup-detail).

---

## Step 7 — Return contract (**required when dispatched as a sub-agent**) {#return-contract}

When this workflow runs as a per-Story sub-agent (dispatched by `/deliver`
via [`deliver-stories.md` § 2a/2c](deliver-stories.md)), the **only**
acceptable way to end your turn is to **return a single terminal JSON status
object** — never free-form prose:

```json
{
  "storyId": <number>,
  "status": "done" | "blocked" | "failed",
  "phase": "init|implementing|closing|blocked|done",
  "branchDeleted": <boolean>,
  "blockerCommentId": <string|null>,
  "detail": "<one-liner: what changed + what was verified, e.g. PR #N merged>",
  "renderedBody": "<terminal Story body>"
}
```

This is the same envelope [`deliver-stories.md` § 2c](deliver-stories.md)
mandates; this section is its single-homed restatement for the standalone
worker so the contract is self-contained when this workflow is the entry
point.

There is **no fourth "pending" status** — the CI/auto-merge wait is handled
internally by blocking on `pr-watch-with-update.js` (Step 4) and confirming
the merge (Step 5). Return **only** on a confirmed `MERGED` PR (`status: "done"`),
an `agent::blocked` transition (`status: "blocked"`), or an unrecoverable
failure (`status: "failed"`).

> **No-park rule + per-status contract + handoff discipline.** For the full
> terminal-status contract (what each status requires), why a prose hand-off
> with an unconfirmed merge is the very bug this workflow prevents, and the
> report-state-not-process handoff discipline, see
> [`single-story-deliver-reference.md` § Step 7 — Return-contract detail](single-story-deliver-reference.md#step-7--return-contract-detail).

---

## Idempotence

- `single-story-init.js` re-prints the same `workCwd` without recreating
  the worktree when one already exists for `story-<id>`.
- `single-story-close.js` short-circuits when the Story is already
  closed (returns `{ action: 'noop', reason: 'already-closed' }`).
- `single-story-confirm-merge.js` short-circuits when the Story already
  carries `agent::done` or the issue is already closed (returns
  `{ action: 'noop', reason: 'already-done' }`), and is safe to re-run
  while the PR is still open (returns `{ action: 'pending', ... }` without
  mutating the Story).
- The PR probe (`gh pr list --head <branch> --state open`) reuses an
  existing open PR rather than opening a duplicate.

Re-running `/single-story-deliver` against an already-closed Story is
safe.

---

## Constraints

- **Never** push the Story branch directly to `main`. The PR is the only
  merge surface.
- **Always** `cd` into the `workCwd` returned by Step 0 before editing,
  **and** prefix every path-based Edit/Write/Read with that absolute
  `workCwd` root — the `cd` alone does not scope the path-based tools (see
  Step 0.5). Editing a bare main-checkout path lands the change in the wrong
  tree; close's wrong-tree guard (Story #3364) aborts when it detects this.
- **Handoff discipline — report state, not process.** When you hand back to
  your caller (the `/deliver` aggregator or the interactive operator),
  report essential terminal state only: the Story branch, the closing commit
  SHA, what changed, and what was verified. Mirror the fields the close
  pipeline already emits (`single-story-close.js` / `story-phase.js`
  envelopes, the `story-run-progress` snapshot) rather than inventing a new
  contract. Do not narrate the steps you took, and do not prescribe how the
  next stage should do its work. Prose process commentary only bloats the
  hydrated prompt (`delivery.maxTokenBudget` elision).
- **Label transitions**: drive every `agent::*` state change through
  `node .agents/scripts/update-ticket-state.js --ticket <id> --state <state>`.
  This CLI is the authoritative mechanism — there is no separate
  state-mutation MCP server to degrade from (see
  [`.agents/instructions.md` § 1.D](../../instructions.md)).

---

## See also

- [`/deliver`](deliver-stories.md) — several standalone Stories at
  once (dependency-aware waves).
- [`/deliver`](deliver-epic.md) — full Epic wave loop.
- [`single-story-deliver-reference.md`](single-story-deliver-reference.md) —
  lease, sweep, CI-recovery, and Status-column reference detail.
