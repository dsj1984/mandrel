---
description: >-
  Helper — not a slash command. Execute one Epic-attached Story end-to-end on
  behalf of `/deliver`. Calls `story-init.js`, `cd`s into the worktree,
  runs the Story-implementation phase against the inline acceptance[] /
  verify[] arrays, writes a `story-run-progress` snapshot per transition, and
  finally calls `story-close.js` to merge into the Epic branch and reap the
  worktree.
caller: epic-deliver.md
---

# helpers/epic-deliver-story — Epic-attached Story worker

> **Not a slash command.** This file lives in `helpers/` and is not projected
> into the mandrel plugin command tree. It is invoked exclusively by the
> [`/deliver`](deliver-epic.md) per-wave fan-out via an `Agent` tool
> call (`subagent_type: general-purpose`). Run `/deliver <epicId>` from
> the operator surface, not this helper directly.

## Overview

`epic-deliver-story` is the **single-Story worker** for Epic-attached Stories.
It sits below [`/deliver`](deliver-epic.md) (which fans out one Story
sub-agent per slot, per wave) and runs one Story from init to close in one
invocation.

```text
/deliver <epicId>
  → for each wave N:
      Agent tool × concurrencyCap parallel calls (one assistant turn):
        helpers/epic-deliver-story <storyId>
          → story-init.js
          → single Story-implementation phase using inline
            acceptance[] / verify[] from the Story body
          → story-close.js
```

The argument is always a **Story ID** (`type::story`). Epic IDs go through
[`/deliver`](deliver-epic.md).

**Standalone Stories** (no `Epic: #N` in body) use
[`/deliver`](deliver-stories.md) instead — that workflow's helper
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

`epic-deliver-story` runs as a sub-agent of `/deliver`'s per-wave fan-out
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

**No spec-ticket threading (Story #4324).** The Tech Spec lives as managed
sections of the Epic body — there is no separate Tech-Spec issue, no
`--tech-spec` flag, and no per-Story hierarchy trace to a spec ticket.
Your hydrated prompt already embeds the Epic body (with the
`## Acceptance Table` section stripped), which carries the folded Tech
Spec sections; do not fetch a Tech Spec issue.

> **Execution mode (sub-agents must read).** This command typically takes
> 3–6 minutes when the worktree's per-tree install runs. Invoke it
> **synchronously** with the Bash tool's maximum timeout
> (`Bash(timeout: 600000)`). Do **not** use `run_in_background` + `Monitor`
> here: `Monitor`'s return is not equivalent to script exit, and a sub-agent
> that exits during a `Monitor` wait kills `story-init.js` mid-batch — the
> worktree is left half-initialized (no `story-init` comment, no Story-level
> `agent::*` label flip) and the parent
> wave aggregator records the Story as failed. The script is idempotent on
> partial state, so the recovery is to re-run it synchronously, but
> prevention is cheaper: just give Bash the 10-minute timeout and block.

The script validates `type::story`, checks blockers, resolves the parent
Epic id, seeds `story-<id>` from the
Epic branch, and (when worktree isolation is on) runs `git worktree add`
at `.worktrees/story-<id>/`. The Story flips to `agent::executing`. A
`story-init` structured comment is upserted with the Story's inline
`acceptance[]` and `verify[]` arrays from the body.

Capture `workCwd`, `dependenciesInstalled` (tri-state), and
`context.parentId`. Add `--dry-run` to check
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

Story #4017 inlined the former standalone prepare CLI into
`story-init.js`: Step 0's init run already applied the install tri-state
in-process (retrying the install command when
`dependenciesInstalled === 'false'`, default `npm ci`) and rendered the
initial snapshot (`phase: "init"`). There is no separate command to run.

Step 0's init run already upserted the initial `story-run-progress`
snapshot (`phase: "init"`) as a structured comment on the Story — that
comment, refreshed by `story-phase.js` at each transition, is the
authoritative Story-level rollup the parent `/deliver` aggregator reads.
You do **not** relay `prepare.renderedBody` verbatim to chat. Instead,
relay **one line per phase transition** (e.g. `Story #<id>: init →
implementing`), and do the same after every transition in Step 1 / Step 3.
The snapshot CLI carries the full body; the chat line is a terse progress
delta, not a body dump.

---

## Step 1 — Story implementation

Run a single Story-implementation phase against the inline `acceptance[]`
/ `verify[]` arrays on the Story body.

1. Flip the snapshot to the `implementing` phase. Pass `--epic <epicId>`
   and `--branch story-<storyId>` from the Step 0 envelope so the render
   skips the `readEpicIdFromStory` / `resolveStoryBranch` GitHub reads
   (pass these same flags to **every** `story-phase.js` call below):

   ```bash
   node .agents/scripts/story-phase.js \
     --story <storyId> --epic <epicId> --branch story-<storyId> \
     --phase implementing
   ```

2. Read the Story body's inline `acceptance[]` and `verify[]` arrays
   from the `story-init` structured comment (`context.acceptance`,
   `context.verify`). Treat the acceptance items as the contract and
   the verify items as the canonical at-keyboard checks.

   **Docs context — read the digest, not the full set.** Do **not**
   re-read every file in `project.docsContextFiles`. The parent prompt
   passes a `docsDigestPath` (the per-Epic docs digest at
   `temp/epic-<epicId>/docs-digest.md`, written by
   `epic-deliver-prepare.js`). Read that digest — a compact per-file
   outline (path, size, heading outline with line numbers, first
   paragraph under each `##`) — to decide which docs bear on this Story,
   then **pull the full file on demand** (jump to the section at the line
   number the digest names) only when relevant. When `docsDigestPath` is
   null (the project configured no `docsContextFiles`), there is no
   digest and no per-Story docs mandate — read a full doc only if the
   Story's own context points you at one. See
   [`.agents/instructions.md` § 3](../../instructions.md).

   **Write-time audit checklists — read the threaded `checklistPath`.**
   When the parent prompt passes a `checklistPath` (Story #4410 — the
   repo-relative path to this Story's footprint-matched **local**-lens
   authoring checklists at
   `temp/epic-<epicId>/checklists/story-<storyId>.md`), read it before you
   write and self-check your change against each listed concern as you
   author it. These are the local audit lenses whose `filePatterns` matched
   the Story's predicted footprint, distilled to a short checklist and
   capped at a hard token budget by `epic-deliver-prepare.js` (matched via
   `resolveLensTier(lens) === 'local'` + `matchesAnyFilePattern`, never
   `selectAudits` — no provider or git diff runs on that path). When
   `checklistPath` is null or absent, the Story's footprint matched no local
   lens and there is nothing extra to read.

3. Implement the work as one or more commits on `story-<storyId>`.
   Author commits directly with the project's editor / `git commit`,
   following
   [`.agents/rules/git-conventions.md`](../../rules/git-conventions.md):
   - Conventional Commit subject (`feat:`, `fix:`, …).
   - Reference the parent Story via `(refs #<storyId>)` in the subject
     or body.
   - The `commit-msg` Husky hook enforces commitlint locally.

4. After the final commit lands, run the **bounded acceptance self-eval
   loop** (Step 1a below) **before** flipping to `closing`. The
   `verify[]` commands are consumed inside that loop as **required
   evidence** — they are no longer optional advisory pre-flight.

5. Once the eval loop returns `proceed`, flip the snapshot to `closing`
   and proceed to Step 3 (Step 3 invokes close directly — it no longer
   re-renders the `closing` snapshot, so this is the single `closing`
   render):

   ```bash
   node .agents/scripts/story-phase.js \
     --story <storyId> --epic <epicId> --branch story-<storyId> \
     --phase closing
   ```

6. If blocked (including by the eval loop reaching its round cap with
   criteria still unmet — Step 1a), flip the snapshot to `blocked`,
   transition the Story to `agent::blocked`, post a `friction` comment,
   and exit non-zero:

   ```bash
   node .agents/scripts/story-phase.js \
     --story <storyId> --epic <epicId> --branch story-<storyId> \
     --phase blocked
   ```

### Step 1a — Bounded acceptance self-eval loop (**required, not optional**)

After the implementation commits land and **before** the snapshot flips to
`closing`, run the bounded acceptance self-eval loop. The per-round critic
mechanic (fresh-context critic, `verify[]`-as-evidence, the verdict schema, and
the proceed / redraft / block decision) is the single-homed include
[`acceptance-self-eval.md`](acceptance-self-eval.md) — read it and follow it.
The critic reads the Story's inline `acceptance[]` / `verify[]` arrays from the
`story-init` comment (`context.acceptance` / `context.verify`).

Epic-attached specifics for this path:

- **Critic evidence-share** (Story #4250). When the critic runs a `verify[]`
  command that is byte-identical to a close gate (`lint` / `typecheck`), it
  records the pass into the Epic-keyed evidence keyspace via `--epic-id
  <epicId>` so `story-close.js` short-circuits the gate at unchanged HEAD.
  Run it in the **Story worktree** (`.worktrees/story-<storyId>`):

  ```bash
  node .agents/scripts/evidence-gate.js \
    --epic-id <epicId> --scope-id <storyId> --gate lint \
    --worktree .worktrees/story-<storyId> -- npm run lint
  ```

- **Gate invocation** (pass `--epic <epicId>` so the per-criterion signal lands
  on the Epic-scoped stream):

  ```bash
  node .agents/scripts/acceptance-eval.js \
    --story <storyId> --epic <epicId> --verdict <verdict-path>
  ```

- **On `decision: "proceed"`** → flip the snapshot to `closing` (item 5 above).
- **On `decision: "block"`** → take the blocked path (item 6 above): post a
  `friction` comment naming the unmet criteria and their evidence, flip the
  snapshot to `blocked`, and exit non-zero. Never silently proceed to close.

The resume guard is expressed at the Story level: re-entering a
partially-implemented Story picks up from whatever commits are already
on `story-<storyId>`; the agent inspects `git log` to decide what work
remains.

After each `story-phase.js` call, relay **one line naming the phase
transition** (e.g. `Story #<id>: implementing → closing`) as the Story's
progress update — not the envelope's `renderedBody` verbatim. The
`story-phase.js` CLI has already upserted the full body into the
`story-run-progress` snapshot; that comment is the authoritative rollup
the parent `/deliver` aggregator reads. Skip chat relay entirely when
running in a non-interactive sub-agent context where the parent will
aggregate.

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

Step 1 item 5 already flipped the snapshot to the `closing` phase, so this
step does **not** re-render it (the duplicate render was removed). Invoke
close directly. Pass the parent Epic id via `--epic <epicId>` from the
Step 0 envelope so close skips re-parsing the Epic hierarchy off the
Story body (which also closes the malformed-`Epic:`-line failure mode).
Pass the main-checkout path via `--cwd` so the merge and branch deletion
run against the main repo (branches checked out in a worktree cannot be
deleted from themselves):

```bash
node <main-repo>/.agents/scripts/story-close.js \
  --story <storyId> --epic <epicId> --cwd <main-repo>
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
  --story <storyId> --epic <epicId> --branch story-<storyId> \
  --phase done
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

> **Handoff discipline — report state, not process.** Populate the return
> object with essential terminal state only: the Story branch, the closing
> commit SHA, what changed, and what was verified (this maps onto the
> existing `storyId` / `branchDeleted` / `phase` / `detail` /
> `renderedBody` fields — do **not** add new envelope fields). Do not
> narrate the steps you took to get there, and do not prescribe how
> `/deliver`'s aggregator should do its job downstream. The parent
> reads structured state from this envelope and the `story-run-progress`
> snapshot; prose process commentary only bloats the hydrated prompt
> (`delivery.maxTokenBudget` elision).

`branchDeleted` is sourced from the `branchDeleted` field of the
`story-close.js` result envelope. It is **independent** of
`worktreeReap.status` — every reap outcome the close reports (including
the Windows-only `stale-registry-entry`, which queues a pending-cleanup
entry for the next drain) is operationally complete. `status: 'done'` is
appropriate when the Story is closed and `branchDeleted: true`,
regardless of the reap status.

`renderedBody` is the **most recent** `renderedBody` returned by
`story-phase.js` (typically the `phase: 'done'` snapshot at close,
or the `phase: 'blocked'` snapshot on a blocker). The parent
`/deliver` may inline a digest of this in its wave-level Notable
section. When run interactively (no parent), omit it — the authoritative
body lives in the `story-run-progress` snapshot the phase CLI upserted,
and the chat already carries the per-transition progress lines from
Step 1 / Step 3.

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
  `/deliver` on the same Story, and **do NOT** open a PR by
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
- **Always** `cd` into the `workCwd` returned by Step 0 before editing, and
  prefix every path-based Edit/Write/Read with that absolute `workCwd` root —
  the Edit tools ignore the shell cwd. The worktree pins the branch to
  `story-<storyId>`, so there is no need to re-check `git branch` before each
  commit.
- **Always** upsert a `story-run-progress` snapshot at every phase
  transition. The wave aggregator depends on this comment, not labels.
- **Always** pass `--cwd <main-repo>` to `story-close.js` when invoking
  from inside a worktree.
- **Label transitions**: drive every `agent::*` state change through
  `node .agents/scripts/update-ticket-state.js --ticket <id> --state <state>`.
  This CLI is the authoritative mechanism — there is no separate
  state-mutation MCP server to degrade from (see
  [`.agents/instructions.md` § 1.D](../../instructions.md)).
