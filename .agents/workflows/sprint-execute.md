---
description: >-
  Execute a sprint ticket. Routes by `type::` label — `type::epic` fans out
  wave-based orchestration via the epic runner; `type::story` runs a single
  Story end-to-end (init → implement → validate → close, per-story worktree when
  isolation is enabled).
---

# /sprint-execute #[Ticket ID]

## Overview

`/sprint-execute` is the **single entry point** for sprint execution. It routes
by the ticket's `type::` label:

| Label                          | Mode           | What runs                                                     |
| ------------------------------ | -------------- | ------------------------------------------------------------- |
| `type::epic`                   | **Epic Mode**  | Long-running orchestrator — fans out Stories wave-by-wave.    |
| `type::story`                  | **Story Mode** | Single-Story worker — init, implement Tasks, validate, close. |
| `type::feature` / `type::task` | Rejected       | Features are containers; Tasks are child items.               |

The skill front-door is the same for both modes — `/sprint-execute <id>` — but
each mode drives a distinct engine:

- **Epic Mode** runs [`epic-runner.js`](../scripts/epic-runner.js), which loads
  the coordinator at
  [`lib/orchestration/epic-runner.js`](../scripts/lib/orchestration/epic-runner.js).
- **Story Mode** runs the init → implement → validate → close chain documented
  below; it does not go through the dispatcher pipeline.

[`.agents/scripts/dispatcher.js`](../scripts/dispatcher.js) is the **manifest
builder** invoked by `/sprint-plan` and remote-trigger bootstrap to produce the
dispatch manifest consumed by Epic Mode. It is not the runtime engine for
`/sprint-execute`.

---

## Step 0 — Identify the ticket type

Delegate the routing decision to
[`sprint-execute-router.js`](../scripts/sprint-execute-router.js). It owns
the `type::` label mapping so this skill never drifts from the taxonomy.

```bash
node .agents/scripts/sprint-execute-router.js --ticket <ticketId>
```

The script prints a JSON verdict on stdout:

```json
{ "mode": "epic" | "story" | "reject", "ticketId": N, "title": "...", "reason": "..." }
```

Route by `mode`:

- `epic` → follow **Epic Mode** below.
- `story` → follow **Story Mode** below.
- `reject` → **STOP** and relay `reason` to the operator. Typical causes are
  a `type::feature` container or a `type::task` that should be executed
  through its parent Story.

### Step 0a — Story id is required

`/sprint-execute` requires a ticket id. The legacy "Pool Mode" path
(invocation without an id, claim via `in-progress-by:<sessionId>` label)
was retired in story #909 in favour of deterministic parent-driven story
assignment from the wave-execute skill. Operators always launch with an
explicit Story or Epic id; sibling sessions never race on the same Story.

---

## Epic Mode (`type::epic`)

### Epic Mode overview

Epic Mode is the **long-running orchestrator** that composes Story sub-agents
across every wave of an Epic. It is the entry point for the remote-agent
dispatch flow (fired from `.github/workflows/epic-orchestrator.yml`) and can
also be invoked locally for manual end-to-end runs.

> **Engine**: coordinator at `.agents/scripts/lib/orchestration/epic-runner.js`
> composes the submodules in
> `.agents/scripts/lib/orchestration/epic-runner/` that are active in the wave
> loop: `wave-scheduler`, `story-launcher`, `wave-observer`, `checkpointer`,
> `blocker-handler`, `notification-hook`, `column-sync`, and `bookend-chainer`.
> The wave loop reads state synchronously per wave rather than via a background
> poller. The CLI at `.agents/scripts/epic-runner.js` drives the engine with
> the `orchestration.epicRunner` block from `.agentrc.json`.

### Contract

- **Argument**: a single **Epic ID** (`type::epic`). Story IDs take the other
  branch of this workflow.
- **Idempotent by checkpoint**: resumes from the `epic-run-state` structured
  comment if present; otherwise initializes a fresh run.
- **Single pause point**: only `agent::blocked` halts execution. All other
  labels are informational during the run.
- **Snapshot modifier**: `epic::auto-close` is read once at run start. Adding it
  mid-run is ignored; removing it mid-run is ignored.

### Invocation

```bash
node .agents/scripts/epic-runner.js --epic <epicId> [--dry-run]
```

The skill drives that CLI. Inside the remote-agent environment, it is invoked
indirectly by `.agents/scripts/remote-bootstrap.js` after the workspace is
provisioned.

#### Live progress in IDE chat (interactive runs)

Epic runs regularly exceed the Bash tool's 10-minute ceiling and its stdout is
only returned on exit — so a foreground invocation goes silent for the entire
run. When driving Epic Mode from an IDE chat, invoke the runner in the
background and tail its progress log so the per-wave `ProgressReporter`
snapshots stream into chat as they're emitted:

1. **Launch in background.** Run the CLI above with `run_in_background: true`.
   Note the returned shell ID — you'll reconcile the final JSON result against
   it once the run finishes.
2. **Tail the progress log with `Monitor`.** The runner tees every snapshot to
   `<orchestration.epicRunner.logsDir>/epic-<epicId>-progress.log` (default
   `temp/epic-runner-logs/epic-<epicId>-progress.log`). Open a `Monitor` on
   that file — each new block is a notification, so you surface the wave
   table + Notable section to the user without polling.
3. **On shell completion.** Read the background shell's final stdout to
   capture the runner's terminating JSON result and any trailing diagnostics.
   Stop the `Monitor` and report the outcome.

The `epic-run-progress` structured comment on the Epic issue continues to be
upserted in place for operators watching on GitHub — the local log file is an
additional channel, not a replacement.

### Flow

1. **Startup**: flip Epic to `agent::executing`, snapshot `autoClose`, write
   initial `epic-run-state` checkpoint comment.
2. **Per wave**: compute wave N via `Graph.computeWaves()`, launch up to
   `orchestration.epicRunner.concurrencyCap` parallel Story sub-agents (each
   invokes `/sprint-execute <storyId>` under the hood), poll every
   `pollIntervalSec`, write wave-end comment, advance.
3. **Blocker**: flip Epic to `agent::blocked`, post friction comment, fire
   webhook, park until the operator flips back to `agent::executing`.
4. **Final wave completes**: flip Epic to `agent::review`.
5. **If `autoClose` was set**: auto-invoke `/sprint-close` only. Review and
   retro remain operator-driven — the runner never generates review or retro
   artefacts on its own. The hand-off comment always lists the full set of
   operator-driven bookends (the `helpers/sprint-code-review.md` procedure,
   the `helpers/sprint-retro.md` procedure, and `/sprint-close`) so the
   operator sees exactly what remains. If
   `epic::auto-close` was not set, the runner exits cleanly after posting the
   hand-off.

> 📎 See tech spec **#323** for the full component diagram, failure model,
> `epic-run-state` schema, and `.agentrc.json` keys under
> `orchestration.epicRunner`.

---

## Story Mode (`type::story`)

### Story Mode overview

Story Mode is a **single-purpose worker**. One invocation runs one Story from
init to close. The argument is always a **Story ID**.

For the Epic-level view — waves, recommended models, parallel suggestions — see
the Story Dispatch Table emitted by `/sprint-plan` (Phase 4). Run one
`/sprint-execute <Story ID>` per Claude window; the operator owns launch order
by picking stories off the Dispatch Table.

> **Worktree isolation.** When `orchestration.worktreeIsolation.enabled` is
> `true`, Step 0 ensures a worktree at `.worktrees/story-<id>/` and prints its
> absolute path as `workCwd`. You **must** `cd` into that path before Step 1.
> The main checkout's HEAD is never moved. When isolation is `false`, `workCwd`
> equals the main checkout. See [`worktree-lifecycle.md`](worktree-lifecycle.md)
> for node_modules strategies, Windows notes, and escape hatches.

### Non-interactive execution contract

Story Mode is almost always launched headless by the Epic runner, which spawns
`claude -p '/sprint-execute <id>' --dangerously-skip-permissions` with **stdin
closed**. Any clarifying question you ask the operator will block forever —
the runner has no way to reply and will eventually be killed by the idle
watchdog (`orchestration.epicRunner.idleTimeoutSec`, default 900s).

**Rules when running as a sub-agent:**

- **Never ask the operator clarifying questions.** If information is missing
  or ambiguous, pick the most reasonable assumption, log it explicitly in the
  story execution log (so it appears in the ticket timeline), and proceed.
- **If you are truly blocked** and cannot make progress without human input,
  transition the Story to `agent::blocked` with a structured comment that
  states (a) what decision is needed and (b) what assumption you would make by
  default. Then exit non-zero. Do **not** wait for a reply.
- **Tool-permission prompts are already disabled** by
  `--dangerously-skip-permissions`; if you encounter one anyway, treat it as a
  harness bug and mark the Story `agent::blocked` rather than hanging.

When run interactively (operator typed `/sprint-execute <id>` directly),
normal conversational clarification is fine. The contract above only binds
when spawned headless.

### Step 0 — Initialize (`sprint-story-init.js`)

Run the initialization script from the **main checkout**. It sets up the Epic
branch, seeds the Story branch, creates the worktree (if enabled), and
transitions child Tasks to `agent::executing`.

```powershell
node .agents/scripts/sprint-story-init.js --story <storyId>
```

The script:

- Fetches the Story ticket and validates it's a `type::story`.
- Checks blockers — **exits non-zero** if any `blocked by` are open.
- Traces the hierarchy (Feature → Epic → PRD / Tech Spec).
- Enumerates child Tasks in dependency order.
- Bootstraps the Epic branch if missing (in main checkout).
- **Worktree-enabled path**: seeds the `story-<id>` branch ref from the Epic
  branch without moving main's HEAD, then `git worktree add` at
  `.worktrees/story-<id>/`.
- **Single-tree fallback**: checks out the story branch in the main checkout.
- Batch-transitions all child Tasks to `agent::executing`.

**Output**: structured JSON. Key fields for the agent:

- `workCwd` — absolute path where you run all subsequent commands.
- `worktreeEnabled` — whether worktree isolation is active.
- `dependenciesInstalled` — `'true' | 'false' | 'skipped'` (see Step 0.5).
- `installStatus` — structured `{ status, reason }` behind the tri-state.
- `tasks[]` — dependency-ordered list of child Tasks to implement.
- `context.prdId`, `context.techSpecId` — fetch these before coding.

The same fields are upserted as a `story-init` structured comment on the
Story ticket so downstream workflow steps can read them via
`gh issue view <storyId> --json comments` without re-running init.

> **Dry-run**: Add `--dry-run` to check status without git or ticket changes. No
> worktree is created.

#### Step 0.5 — `cd` into the workCwd and verify dependencies

```powershell
cd "<workCwd from Step 0 result>"
```

All subsequent git commands, test runs, and Step 3 closure run from this
directory. In worktree-enabled mode this is `.worktrees/story-<id>/`; in
single-tree mode it is the main checkout.

**Dependency install:** Read `dependenciesInstalled` from the Step 0 stdout
JSON (or, when resuming a previously-initialized Story, from the `story-init`
structured comment on the Story ticket — `gh issue view <storyId> --json
comments | jq -r '.comments[] | select(.body | contains("ap:structured-comment
type=\"story-init\""))'`). Do **not** infer install state from the presence
or absence of `node_modules/`.

| `dependenciesInstalled` | Meaning                                                                                              | Agent action                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `true`                  | Per-worktree install ran and succeeded.                                                              | Proceed.                                                           |
| `false`                 | Install was attempted and failed.                                                                    | Run the appropriate install command before implementing tasks.    |
| `skipped`               | No per-worktree install was performed (single-tree mode, reused worktree, `symlink`, `pnpm-store`). | Trust the strategy; only install if a downstream tool errors out.  |

If `dependenciesInstalled === 'false'`, run the install:

```powershell
npm ci    # or: pnpm install --frozen-lockfile / yarn install --frozen-lockfile
```

> **Model Selection**: check the **Story Dispatch Table** from `/sprint-plan`
> for this Story's **Model Tier** (`high` or `low`). Pick any model whose
> reasoning strength matches the tier — the concrete choice is left to the
> operator/router.

### Step 1 — Implementation (Sequential Task Loop)

For **each child Task** in the order returned by `sprint-story-init.js`:

1. Read the full `## Instructions` section of the Task ticket.
2. Implement all described changes strictly within the scope of the Story
   branch.
3. Commit after each Task. Even inside an isolated worktree, keep the
   assert-branch guard — it's cheap defense-in-depth against the agent drifting
   off the story branch (e.g. from a `git checkout` buried in a tool script).

   ```powershell
   # 1. Guard: halt if HEAD drifted off story-<id>.
   node .agents/scripts/assert-branch.js --expected story-<storyId> --cwd .

   # 2. Stage: prefer explicit paths for the files you edited in this Task.
   git add <path/one> <path/two>
   # Or, for tracked edits only:
   # git add -u

   git commit -m "feat(<scope>): <task title> (resolves #<taskId>)"
   ```

4. Proceed to the next Task in the Story.

> If a commit runs into a merge conflict during a rebase, follow the canonical
> procedure in
> [`helpers/_merge-conflict-template.md`](helpers/_merge-conflict-template.md).

### Step 2 — Validate (deferred to close)

`sprint-story-close.js` runs the canonical close-validation chain (typecheck,
lint, test, format, maintainability, coverage, crap) before it merges — **do
not** pre-run `npm run typecheck`, `npm run lint`, and `npm test` here unless
you are interactively iterating on a fix. The close script's gate is
authoritative; pre-running them in headless sub-agent runs just doubles the
wall-clock cost of every Story. The typecheck gate sources its command from
`agentSettings.commands.typecheck` when set (e.g. `pnpm exec turbo run
typecheck`) and falls back to `npm run typecheck` otherwise.

**Interactive `--fast` advisory mode.** When iterating in your own terminal and
you want a fast pre-flight before invoking close, run:

```powershell
npm run typecheck
npm run lint
npm test
```

Treat the output as advisory: failures here will be re-surfaced by
`sprint-story-close.js` regardless. If you spot a regression, fix it on the
Story branch and commit before proceeding to Step 3.

If genuinely blocked (e.g. upstream dependency missing): post a friction comment
and apply `agent::blocked`.

### Step 3 — Close (`sprint-story-close.js`)

Run closure. Pass the main-checkout path via `--cwd` so the merge and branch
deletion run against the main repo, not inside the worktree (branches checked
out in a worktree cannot be deleted from themselves). The close script will reap
the worktree after the merge succeeds.

```powershell
# From the worktree, invoke close against the main checkout.
node <main-repo>/.agents/scripts/sprint-story-close.js --story <storyId> --cwd <main-repo>
```

In single-tree mode, `--cwd` can be omitted (defaults to `PROJECT_ROOT`).

The script:

> **Runtime pause model.** `risk::high` is no longer a runtime gate — it is
> informational/planning metadata only. The sole runtime pause point is
> `agent::blocked`: if a Task, Story, or Epic encounters a blocker, the agent
> flips the corresponding ticket to `agent::blocked`, posts a friction comment,
> and stops. The operator resumes by flipping the label back to
> `agent::executing`. See `docs/decisions.md` for the retirement rationale.

- Merges the Story branch into `epic/<epicId>` with `--no-ff`.
- Pushes the Epic branch.
- Deletes the Story branch (local + remote).
- **Reaps the worktree** (`.worktrees/story-<id>/`) via `WorktreeManager.reap` —
  refuses if uncommitted or unmerged.
- Batch-transitions all child Tasks and the Story to `agent::done`.
- Runs `cascadeCompletion()` to propagate closure up the hierarchy.
- Runs `health-monitor.js` to update sprint metrics.
- Regenerates the Epic dispatch manifest (`temp/dispatch-manifest-<epicId>.md` /
  `.json`). Pass `--skip-dashboard` to suppress.

**Output**: structured JSON with `ticketsClosed[]`, `cascadedTo[]`, worktree
reap status.

> **Why not use GitHub auto-close?** GitHub's `Closes #N` only fires when
> merging into the repo's default branch. Story branches merge into
> `epic/<epicId>`, so we close tickets explicitly via the state writer.

### Parallel execution

Run two Stories at once by opening two Claude windows and invoking
`/sprint-execute <id>` in each. With `worktreeIsolation.enabled: true` each
window gets its own `.worktrees/story-<id>/`; the main checkout stays quiet.
Pick the story IDs from the Dispatch Table produced by `/sprint-plan`.

Focus-area / file-overlap conflicts are the **operator's** responsibility — read
the Dispatch Table before launching. The framework no longer serializes waves
automatically.

---

## Constraint

### Epic Mode

- **Never** honor a mid-run change to `epic::auto-close`. The snapshot at
  startup is authoritative.
- **Always** checkpoint via `node .agents/scripts/post-structured-comment.js
  --ticket <epicId> --marker epic-run-state --body-file <path>` — never write
  run state anywhere else.
- **Never** launch more than `concurrencyCap` parallel Story executors per wave.

### Story Mode

- **Never** push Story branch work directly to `main`.
- **Never** merge across Story branches — each Story is self-contained.
- **Always** `cd` into the `workCwd` returned by Step 0 before editing.
- **Always** verify `git branch --show-current` outputs the expected Story
  branch name before making any commits. If it does not, **STOP**.
- **Always** validate (lint + test) before running Step 3.
- **Always** pass `--cwd <main-repo>` to `sprint-story-close.js` when invoking
  from inside a worktree, so the merge runs in the main repo.
- **Always** run cascadeCompletion after merging — GitHub cannot auto-close
  tickets on non-default branch merges.
- **Always** delete the Story branch (local + remote) after merging into the
  Epic branch. `sprint-story-close.js` does this for you.
- **MCP Fallback**: If `agent-protocols` MCP tools fail due to connection
  errors, **fall back immediately** to
  `node .agents/scripts/update-ticket-state.js --task <id> --state <state>`
  (which also auto-cascades completion when `--state agent::done`). Do not leave
  tickets in stale states.
