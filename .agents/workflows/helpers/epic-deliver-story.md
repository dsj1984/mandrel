---
description: >-
  Helper — not a slash command. Execute one Epic-attached Story end-to-end on
  behalf of `/epic-deliver`. Calls `story-init.js`, `cd`s into the worktree,
  runs the Story-implementation phase against the inline acceptance[] /
  verify[] arrays, writes a `story-run-progress` snapshot per transition, and
  finally calls `story-close.js` to merge into the Epic branch and reap the
  worktree.
caller: epic-deliver.md
---

# helpers/epic-deliver-story — Epic-attached Story worker

> **Not a slash command.** This file lives in `helpers/` and is not imported
> into `.claude/commands/`. It is invoked exclusively by the
> [`/epic-deliver`](../epic-deliver.md) per-wave fan-out via an `Agent` tool
> call (`subagent_type: general-purpose`). Run `/epic-deliver <epicId>` from
> the operator surface, not this helper directly.

## Overview

`epic-deliver-story` is the **single-Story worker** for Epic-attached Stories.
It sits below [`/epic-deliver`](../epic-deliver.md) (which fans out one Story
sub-agent per slot, per wave) and runs one Story from init to close in one
invocation.

```text
/epic-deliver <epicId>
  → for each wave N:
      Agent tool × concurrencyCap parallel calls (one assistant turn):
        helpers/epic-deliver-story <storyId>
          → story-init.js
          → single Story-implementation phase using inline
            acceptance[] / verify[] from the Story body
          → story-close.js
```

The argument is always a **Story ID** (`type::story`). Epic IDs go through
[`/epic-deliver`](../epic-deliver.md).

**Standalone Stories** (no `Epic: #N` in body) use
[`/story-deliver`](../story-deliver.md) instead — that workflow's helper
branches from `main`, opens its PR directly to `main`, and skips the
Epic-scoped machinery (cascade, dispatch manifest, dashboard regen). This
helper requires a parent Epic and will refuse to initialize a Story that lacks
the `Epic: #N` reference.

> **Worktree isolation.** When `delivery.worktreeIsolation.enabled` is
> `true`, Step 0 creates a worktree at `.worktrees/story-<id>/` and prints
> its absolute path as `workCwd`. You **must** `cd` into that path before
> Step 1. The main checkout's HEAD is never moved. See
> [`worktree-lifecycle.md`](worktree-lifecycle.md) for node_modules
> strategies, Windows notes, and escape hatches.

---

## Non-interactive execution contract

`epic-deliver-story` runs as a sub-agent of `/epic-deliver`'s per-wave fan-out
(common case) or interactively for a single Story. Sub-agent runs share
the parent's permissions but have **no input channel** mid-run.

- **Never** ask clarifying questions as a sub-agent. Pick the narrowest
  reasonable interpretation that satisfies the Story's AC. If you cannot
  proceed, transition to `agent::blocked`, post a `friction` comment with
  the decision needed and the default assumption, and exit non-zero.
- **Never** assume tool-permission prompts will be auto-approved. Treat a
  blocking prompt as a harness condition and transition to `agent::blocked`.
- **Always** write `story-run-progress` snapshots at every phase
  transition so the parent aggregator never falls back to label
  re-derivation.

---

## Step 0 — Initialize (`story-init.js`)

Run from the **main checkout** (the worktree does not exist yet):

```bash
node .agents/scripts/story-init.js --story <storyId>
```

> **Execution mode (sub-agents must read).** This command typically takes
> 3–6 minutes when the worktree's per-tree install runs. Invoke it
> **synchronously** with the Bash tool's maximum timeout
> (`Bash(timeout: 600000)`). Do **not** use `run_in_background` + `Monitor`
> here: `Monitor`'s return is not equivalent to script exit, and a sub-agent
> that exits during a `Monitor` wait kills `story-init.js` mid-batch — the
> worktree is left half-initialized (some child Tasks transitioned, no
> `story-init` comment, no Story-level `agent::*` label flip) and the parent
> wave aggregator records the Story as failed. The script is idempotent on
> partial state, so the recovery is to re-run it synchronously, but
> prevention is cheaper: just give Bash the 10-minute timeout and block.

The script validates `type::story`, checks blockers, traces the
Feature → Epic → PRD/Tech-Spec hierarchy, seeds `story-<id>` from the
Epic branch, and (when worktree isolation is on) runs `git worktree add`
at `.worktrees/story-<id>/`. The Story flips to `agent::executing`. A
`story-init` structured comment is upserted with the Story's inline
`acceptance[]` and `verify[]` arrays from the body.

Capture `workCwd`, `dependenciesInstalled` (tri-state), and
`context.{prdId,techSpecId,acceptance,verify}`. Add `--dry-run` to check
status without git or ticket changes.

### Step 0.5 — `cd` into the workCwd

```bash
cd "<workCwd from Step 0 result>"
```

All subsequent commands run from this directory. The `dependenciesInstalled`
tri-state carries one of three values:

| Value     | Meaning                                                                            | Action                                              |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `true`    | Per-worktree install ran and succeeded.                                            | Proceed.                                            |
| `false`   | Install was attempted and failed.                                                  | The next CLI runs the install before proceeding.    |
| `skipped` | No per-worktree install (single-tree, reused worktree, `symlink`, `pnpm-store`).   | Trust the strategy.                                 |

### Step 0.6 — Initial `story-run-progress` snapshot

Re-read the `story-init` comment, apply the install tri-state, and upsert
the initial snapshot (`phase: "init"`):

```bash
node .agents/scripts/story-deliver-prepare.js --story <storyId> --cwd .
```

The CLI runs the install command when `dependenciesInstalled === 'false'`
(default `npm ci`; override with `--install-cmd "<cmd>"`).

The CLI's stdout JSON envelope carries a `renderedBody` field — the markdown
body that was upserted onto the Story ticket. **Relay it verbatim to chat**
so operators see the initial progress block before the first commit lands.
Do the same after every transition in Step 1 / Step 3 (the body is the
Story-level rollup the parent `/epic-deliver` aggregator reads).

---

## Step 1 — Story implementation

Run a single Story-implementation phase against the inline `acceptance[]`
/ `verify[]` arrays on the Story body:

1. Flip the snapshot to the `implementing` phase:

   ```bash
   node .agents/scripts/story-phase.js \
     --story <storyId> --phase implementing
   ```

2. Read the Story body's inline `acceptance[]` and `verify[]` arrays
   from the `story-init` structured comment (`context.acceptance`,
   `context.verify`). Treat the acceptance items as the contract and
   the verify items as the canonical at-keyboard checks.

3. Implement the work as one or more commits on `story-<storyId>`.
   Author commits directly with the project's editor / `git commit`,
   following
   [`.agents/rules/git-conventions.md`](../../rules/git-conventions.md):
   - Conventional Commit subject (`feat:`, `fix:`, …).
   - Reference the parent Story via `(refs #<storyId>)` in the subject
     or body.
   - The `commit-msg` Husky hook enforces commitlint locally.

4. Run the inline `verify[]` commands as advisory pre-flight. The
   canonical validation chain still fires inside `story-close.js`
   (Step 2 / Step 3); pre-running here is optional and only useful
   while iterating on a fix.

5. After the final commit lands, flip the snapshot to `closing` and
   proceed to Step 3:

   ```bash
   node .agents/scripts/story-phase.js \
     --story <storyId> --phase closing
   ```

6. If blocked, flip the snapshot to `blocked`, transition the Story to
   `agent::blocked`, post a `friction` comment, and exit non-zero:

   ```bash
   node .agents/scripts/story-phase.js \
     --story <storyId> --phase blocked \
     --blocker-comment-id <id>
   ```

The resume guard is expressed at the Story level: re-entering a
partially-implemented Story picks up from whatever commits are already
on `story-<storyId>`; the agent inspects `git log` to decide what work
remains.

After each `story-phase.js` call, **relay the envelope's
`renderedBody` to chat** as the Story's progress update. Skip chat
relay only when running in a non-interactive sub-agent context where
the parent will aggregate.

> Rebase pauses on conflicts → follow
> [`_merge-conflict-template.md`](_merge-conflict-template.md).

---

## Step 2 — Validate (deferred to close)

`story-close.js` runs the canonical close-validation chain (typecheck,
lint, test, format, maintainability, coverage, crap) before it merges —
**do not** pre-run those gates here unless interactively iterating on a
fix. (Interactively, `npm run typecheck && npm run lint && npm test` is
fine as advisory pre-flight.)

---

## Step 3 — Close (`story-close.js`)

Flip the snapshot to the closing phase, then invoke close. Pass the
main-checkout path via `--cwd` so the merge and branch deletion run
against the main repo (branches checked out in a worktree cannot be
deleted from themselves):

```bash
node .agents/scripts/story-phase.js \
  --story <storyId> --phase closing

node <main-repo>/.agents/scripts/story-close.js --story <storyId> --cwd <main-repo>
```

In single-tree mode, `--cwd` defaults to `PROJECT_ROOT`. The script merges
into `epic/<epicId>` (`--no-ff`), pushes the Epic branch, deletes the
Story branch, reaps the worktree via `WorktreeManager.reap`, closes the
Story to `agent::done`, runs `cascadeCompletion()`, and regenerates the
Epic dispatch manifest (`--skip-dashboard` to suppress). Output is JSON
with `ticketsClosed[]`, `cascadedTo[]`, and reap status.

> **Why not GitHub auto-close?** `Closes #N` only fires on default-branch
> merges; close fires the state writer explicitly.

After close, upsert a terminal snapshot:

```bash
node .agents/scripts/story-phase.js \
  --story <storyId> --phase done
```

---

## Step 4 — Return contract (sub-agent path)

When run as a sub-agent, return one JSON object:

```json
{
  "storyId": <number>,
  "status": "done" | "blocked" | "failed",
  "phase": "init|implementing|closing|blocked|done",
  "branchDeleted": <boolean>,
  "blockerCommentId": <string|null>,
  "detail": <string|undefined>,
  "renderedBody": <string|undefined>
}
```

`status === 'done'` requires the Story closed and
`branchDeleted: true`.

`branchDeleted` is sourced from the `branchDeleted` field of the
`story-close.js` result envelope, which is `branchCleanup.localDeleted &&
branchCleanup.remoteDeleted`. It is **independent** of `worktreeReap.status`.
Specifically, when `worktreeReap.status === 'stale-registry-entry'` — a
Windows-only outcome where the worktree directory was removed and the local
branch was deleted but `git worktree list` still shows the entry — the
close still reports `branchDeleted: true` because the branch was honestly
deleted; a pending-cleanup entry is recorded so the next post-close drain
(or the next plan-time sweep) clears the stale `.git/worktrees/<name>/`
registry entry. Treat `stale-registry-entry` as operationally complete
when computing your return contract: `status: 'done'` is appropriate when
all Tasks are closed and `branchDeleted: true`, regardless of whether
`worktreeReap.status` is `'removed'`, `'removed-after-drain'`, or
`'stale-registry-entry'`.

`renderedBody` is the **most recent** `renderedBody` returned by
`story-phase.js` (typically the `phase: 'done'` snapshot at close,
or the `phase: 'blocked'` snapshot on a blocker). The parent
`/epic-deliver` may inline a digest of this in its wave-level Notable
section. When run interactively (no parent), omit it — the chat already
has the latest body relayed during Step 1 / Step 3.

---

## Idempotence

`story-init.js` re-prints the same `workCwd` without recreating the
worktree. `story-run-progress` is upserted in place. `story-close.js`
short-circuits when the Story branch is already merged and deleted. Re-
running this helper against an already-closed Story is safe.

---

## Constraints

- **MUST merge into `epic/<epicId>`, never `main`.** The Story branch's
  only integration target is the parent Epic's integration branch. If
  `story-close.js` short-circuits, no-ops, or otherwise fails to merge,
  **do NOT** fall back to `gh pr create --base main`, **do NOT** invoke
  `/story-deliver` on the same Story, and **do NOT** open a PR by
  hand against `main`. Such a PR orphans the change on `main` and forces
  a manual `git merge origin/main` back into `epic/<id>` to recover (the
  Epic #2880 wave-5 / Story #2960 friction note). The framework refuses
  these PRs via the `pr-base-guard` helper wired into every
  `createPullRequest` surface; a raw shell `gh pr create` is the only
  way to bypass it, and you must not. Diagnose the no-op (was the
  branch already merged? is the ticket already closed? is the worktree
  on the wrong HEAD?) and re-run close, or transition the Story to
  `agent::blocked` with a `friction` comment so the operator can
  resolve it.
- **Never** push the Story branch directly to `main`. `story-close.js` is
  the only writer that integrates upstream, and only into `epic/<epicId>`.
- **Never** merge across Story branches; cross-Story dependencies are
  resolved by wave ordering via `blocked by`.
- **Always** `cd` into the `workCwd` returned by Step 0 before editing.
- **Always** verify branch identity before each commit (run
  `git branch --show-current` and confirm `story-<storyId>`).
- **Always** upsert a `story-run-progress` snapshot at every phase
  transition. The wave aggregator depends on this comment, not labels.
- **Always** pass `--cwd <main-repo>` to `story-close.js` when invoking
  from inside a worktree.
- **MCP fallback**: if `mandrel` MCP tools fail, fall back to
  `node .agents/scripts/update-ticket-state.js --ticket <id> --state <state>`.
