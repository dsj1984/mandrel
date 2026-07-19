---
description:
  Execute one Story end-to-end. Creates story-<id> from main, implements in a
  worktree (optional ## Slicing checkpoints), runs derived-level ceremony,
  opens a PR against main, and lands.
---

# /deliver-story #[Story ID]

> **Runtime core.** Always-ingested per-Story delivery path. Lease / sweep /
> CI-recovery detail lives in
> [`deliver-story-reference.md`](deliver-story-reference.md); consult on demand.
> Invoked by [`/deliver`](../deliver.md) for every Story (N=1 and N>1).

## Overview

`/deliver-story` is the **one** delivery engine in v2. Every Story — trivial or
large — uses the same machinery:

```text
/deliver <storyId> [<storyId> ...]   (each Story runs through this engine)
  → single-story-init.js          (branch from main, worktree, agent::executing)
  → agent implements + commits     (optional ## Slicing intra-session checkpoints)
  → derived-level ceremony         (acceptance critics · review depth)
  → single-story-close.js          (gates, push, gh pr create → main, agent::closing)
  → CI watch + fix loop            (until required checks pass + PR merged)
  → single-story-confirm-merge.js  (PR merged → agent::done + follow-ups)
```

| Trait | v2 `/deliver-story` |
| --- | --- |
| Ticket type | `type::story` only |
| Branch | `story-<id>` seeded from `project.baseBranch` (`main`) |
| Merge target | `main` via PR (squash + required checks) |
| Epic integration branch | **None** — no `epic/<id>`, no `--no-ff` wave merge |
| Spec / slices | Folded `## Spec` + optional `## Slicing` checkpoints in-session |
| Ceremony | Per-Story, routed off the derived change level via `ceremony-routing.js` |

If the Story still carries an `Epic: #N` reference, **stop** — that is a v1
Epic-attached ticket; re-plan as a v2 Story or finish it on a pre-v2 checkout.

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

> **Execution mode.** `single-story-init.js` can take 3–6 minutes when the
> worktree's per-tree install runs. Invoke synchronously with
> `Bash(timeout: 600000)`. Do **not** use `run_in_background` + `Monitor` —
> a sub-agent that exits mid-install leaves the worktree half-bootstrapped.

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
> [`deliver-story-reference.md` § Step 0 — Lease preflight and merged-sweep](deliver-story-reference.md#step-0--lease-preflight-and-merged-sweep)
> for the fail-closed outcomes, the `--steal` contract, and the sweep
> hardening layers.

Capture `workCwd` from the result envelope. Add `--dry-run` to inspect
the planned actions without git or ticket mutations (dry-run also skips
the lease and the sweep).

**Remote evidence — land or block (issue #4483).** The envelope also
carries `remoteVerified` + `remoteProbe` (`git remote get-url origin` +
bounded `git ls-remote origin HEAD`). When `remoteVerified` is `false`,
transition the Story to `agent::blocked` quoting `remoteProbe.detail` and
stop. Implementing the Story inline outside the worktree/branch/PR path
and/or committing it to local `main` is expressly forbidden — the close
pipeline's push is the only sanctioned landing.

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
> [`deliver-story-reference.md` § Worktree scope is not just the Bash cwd](deliver-story-reference.md#worktree-scope-is-not-just-the-bash-cwd).

---

## Step 1 — Implementation

A Story is **atomic** — one `story-<id>` branch, one PR to `main`. Work
happens in one or more commits against the inline `acceptance[]` /
`verify[]` arrays (and the folded `## Spec` when present).

Operator/agent responsibilities while in the worktree:

1. Read the Story body. Treat its acceptance criteria as the contract.

   **Docs context — digest-first.** Read a full doc only when the Story's
   own context points you at one — do not ingest the whole
   `project.docsContextFiles` set up front. If the caller provides a
   `docsDigestPath`, prefer that compact outline and pull individual files
   on demand. See [`.agents/instructions.md` § 3](../../instructions.md).

   **Write-time audit checklists.** When the caller provides a
   `checklistPath` (footprint-matched **local**-lens authoring checklists),
   read it before you write and self-check as you author. When absent,
   lens-aware coverage still runs maker-blind at Story-scope review inside
   the close subprocess.

   **Producing `checklistPath` at dispatch (Story #4627).** The dispatch that
   spawns this worker threads `checklistPath` the same way it threads
   `docsDigestPath`. Before the spawn, compute the payload from the Story's
   predicted footprint (its `changes[]` / `references[]` path entries) with
   `buildDispatchChecklist` and write it to the run temp dir:

   ```bash
   node --input-type=module -e '
     import { buildDispatchChecklist } from "<main-repo>/.agents/scripts/lib/audit-suite/index.js";
     import { parse } from "<main-repo>/.agents/scripts/lib/story-body/story-body.js";
     // storyBody is the fetched Story issue body.
     const { changes, references } = parse(process.env.STORY_BODY);
     const { checklistPath } = buildDispatchChecklist({
       storyId: <storyId>, changes, references, runTempDir: "temp/run-<id>",
     });
     console.log(checklistPath ?? "");
   '
   ```

   A non-empty `checklistPath` is threaded into this worker's prompt; an empty
   footprint match prints nothing and the worker runs with no write-time
   checklist (the maker-blind close-scope pass still covers it). The builder is
   a pure function of the footprint and the on-disk checklists —
   `buildDispatchChecklist` (`lib/audit-suite/dispatch-checklist.js`).
2. Implement the changes. When the body has a `## Slicing` / Delivery
   Slicing table, walk rows as **intra-session checkpoints** (commit +
   flip each row when done) — never as sibling tickets.
3. Commit on the Story branch. Conventional-commit format is encouraged
   but not enforced — the PR title carries the canonical summary.
4. Iterate (read tests, run targeted gates, edit, commit) until the
   acceptance criteria are met.
5. Run the **bounded acceptance self-eval loop** (Step 1a below) before
   ceremony / close.

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

Story-path specifics:

- **Critic evidence-share** (Story #4250). When the critic runs a `verify[]`
  command that is byte-identical to a close gate (`lint` / `typecheck`), it
  records the pass into the Story evidence keyspace via `--standalone` so
  Step 3's close short-circuits the gate at unchanged HEAD. Run it in the
  **Story worktree** (`workCwd` from Step 0):

  ```bash
  node <main-repo>/.agents/scripts/evidence-gate.js \
    --standalone --scope-id <storyId> --gate lint \
    --worktree <workCwd> -- npm run lint
  ```

- **Gate invocation** (omit `--epic`):

  ```bash
  node <main-repo>/.agents/scripts/acceptance-eval.js \
    --story <storyId> --verdict <verdict-path>
  ```

- **On `decision: "proceed"`** → proceed to Step 2 (ceremony) then Step 3.
- **On `decision: "block"`** → **do not proceed to close.** Post a `friction`
  comment naming the unmet criteria, then transition the Story to
  `agent::blocked`:

  ```bash
  node .agents/scripts/diagnose-friction.js --story <storyId> \
    --cmd node .agents/scripts/acceptance-eval.js --story <storyId> --verdict <verdict-path>
  node .agents/scripts/update-ticket-state.js --ticket <storyId> --state agent::blocked
  ```

---

## Step 2 — Ceremony (profile + derived level)

Per-Story ceremony is selected by `delivery.routing.ceremonyProfile`
(`minimal` | `standard` | `strict`, default `standard`) and the Story's
**derived change level** — not a planner-authored verdict (Story #4542 retired
that).

**Compute the change set once** (Story #4593) with the shared enumerator
[`computeChangeSet`](../../scripts/lib/orchestration/change-set.js) — the same
module close uses — and reuse that one list for everything downstream:

```bash
node --input-type=module -e '
  import { computeChangeSet } from "<main-repo>/.agents/scripts/lib/orchestration/change-set.js";
  const { files } = computeChangeSet({ baseRef: "main", headRef: "story-<storyId>" });
  console.log(JSON.stringify(files));
'
```

Then derive the level with
[`deriveChangeLevel`](../../scripts/lib/orchestration/review-depth.js) over that
list: a diff touching a sensitive path registered in
`.agents/schemas/audit-rules.json` derives `high`, one touching none derives
`low`, and an unenumerable diff (`files === null`) derives `null`. Hand the
**same** list to every acceptance critic you spawn (Step 1a) — a critic that
re-ran its own `git diff` could score against a different set than the one that
routed it.

Resolve fresh-vs-inline acceptance critics per AC-cluster with
[`resolveCeremonyForRisk`](../../scripts/lib/orchestration/ceremony-routing.js)
(`minimal` → always inline; `strict` → always fresh; `standard` →
`high`/`null` → `fresh`, `low` → `inline` unless the `freshCriticSampleRate`
floor forces `fresh`). Review depth reads the same derived level via
`review-depth.js` inside close, so the two decisions cannot disagree.

Hard gates (lint / test / format / coverage / CRAP / maintainability) always
run in Step 3 — the derived level never disables them. Do **not** pre-run the
full close-validation chain here unless interactively iterating on a fix.

---

## Step 3 — Close and land (`single-story-close.js`)

Invoke from the main checkout (or pass `--cwd <main-repo>` from inside
the worktree):

```bash
node <main-repo>/.agents/scripts/single-story-close.js --story <storyId> --cwd <main-repo>
```

**This step is the whole delivery tail.** Close owns the gates, the PR, the
merge wait, the `agent::done` flip, and the post-land tail (follow-up
capture, status-column resync, local ref cleanup, base fast-forward) in one
process. Your job is to run it and **branch on the terminal envelope's
`status`** — nothing more (Story #4543).

### Branch on the terminal envelope

Every invocation emits exactly one schema-validated envelope
([`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json))
between `--- STORY DELIVER TERMINAL ---` markers, and the exit code mirrors
its `status`:

| `status` | Exit | What it means | What you do |
| --- | --- | --- | --- |
| `landed` | 0 | PR merged, Story `agent::done`, tail ran. `tail.*` booleans expose any partial degradation — a `false` there does **not** demote the land. | Go to Step 7 and relay the envelope. Nothing else. |
| `pending` | 3 | **Resumable, not a failure.** The per-invocation merge wait expired with the PR healthy and in flight, or the operator owns the merge. No label was mutated; no `merge.unlanded` was emitted. | Run the envelope's `nextCommand`. Repeat until it resolves. Relay `pending` only once you have exhausted your own budget. |
| `blocked` | 1 | A classified hard block. Story carries `agent::blocked`; `blocked.blockClass` names the class and `blocked.frictionCommentId` points at the remediation. | `checks-failed` → fix the red check and push (Step 4). Otherwise go to Step 7 and relay the envelope. |
| `failed` | 1 | A phase crashed; `phase` names which. | Diagnose, fix, re-run close. |

Do **not** re-sequence the post-close steps by hand. Steps 4–6 below are
**recovery-only** — reached from a `blocked`/`pending` envelope, never as
routine choreography.

### What close does internally

The script runs the close-validation gates against `baseBranch`, syncs the
Story branch from `origin/<baseBranch>` (Story #2580 — the parallel-race
defence), pushes `story-<id>`, opens (or reuses) a PR against `baseBranch`
with a `Closes #<storyId>` footer, enables GitHub native auto-merge
(`--auto --squash --delete-branch`) **when `delivery.ci.autoMerge` is
`"trust-ci"` (the default)**, flips the Story to `agent::closing`, reaps the
worktree, releases the lease, then **waits for the merge** and — on a
confirmed merge — flips `agent::done` and runs the post-land tail.

### The merge wait is bounded and resumable

Two budgets, deliberately separate (`delivery.mergeWatch.*`):

- **`maxWaitSeconds`** (default 300) bounds **one invocation**, sized to fit
  inside a single host tool invocation (~10 min ceiling) alongside the gates
  that precede it. Expiry → `pending`. Pass `--max-wait-seconds <n>` to raise
  it when your host has no such ceiling and you want to land in one block.
- **`maxBudgetSeconds`** (default 3600) bounds the **cumulative** wait across
  resumes, anchored at the PR's `createdAt` so resuming does not restart the
  clock. Exhausting *this* is the genuine give-up → `blocked`.

The wait probes the checks every poll: a red required check fails fast as
`checks-failed` instead of burning the budget, and a PR that falls behind its
base is brought up to date within `updateAttempts` tries.

> **`delivery.ci.autoMerge` policy.** Under the default `"trust-ci"`, GitHub
> native auto-merge is armed and the PR squash-merges once its **required**
> checks pass. Under `"strict"`, the close **does not arm auto-merge** — the
> PR opens and waits for an **operator merge**, exactly as `--no-auto-merge`
> does per-run.

Flags:

- `--skip-validation` — bypass the gates (Step 1). Use only when re-running
  close after a fixed gate failure that's already known to pass.
- `--skip-sync` — bypass the base-sync (Story #2580). Use only after a
  hand-resolved sync, or in tests.
- `--no-auto-merge` — disable auto-merge. Use when the PR materially changes
  behaviour and warrants a pre-merge eyeball; the operator then merges via
  the GitHub UI.
- `--wait-merge` — **close-and-land** (Story #4428). Forces close to poll
  the armed PR to merge confirmation and flip `agent::done` itself. When
  neither land flag is passed, close defaults from
  `delivery.routing.closeAndLand` (**true**): attended and headless delivers
  share the land-in-one-close happy path.
- `--no-wait-merge` — explicit opt-out that always wins. Use when the
  operator wants the PR left at `agent::closing` for a human land (or a
  wrapper that will invoke `single-story-confirm-merge.js` itself). Reports
  `pending` — the work is not done, nothing is broken, and one named command
  finishes it.
- `--max-wait-seconds <n>` — raise the merge wait's per-invocation bound for
  this run (Story #4543). Use from a headless caller with no host
  tool-invocation ceiling to keep single-block semantics without editing the
  consumer's config.

> **Full close pipeline (base-sync outcomes, `agent::closing` rationale,
> lease release).** For the numbered close pipeline, the base-sync outcome
> table (no-op / conflict → `agent::blocked` / fetch-failed), and why the
> issue stays OPEN at `agent::closing`, see
> [`deliver-story-reference.md` § Step 3 — Close pipeline detail](deliver-story-reference.md#step-3--close-pipeline-detail).

---

## Step 4 — CI fix loop (**recovery-only**)

> **Steps 4, 5, 5.5, and 6 are recovery paths, not routine choreography
> (Story #4543).** On the default path Step 3 already polled the PR to a
> confirmed merge, flipped `agent::done`, and ran the whole post-land tail —
> follow-up capture, status resync, ref cleanup, base fast-forward — in one
> process. A `landed` envelope means all of it ran; go straight to Step 7.
>
> Enter this step **only** when Step 3 returned `blocked` with
> `blockClass: "checks-failed"` (a required check went red), or when a
> `--no-wait-merge` run left the PR for you to shepherd.

When a required check is red, the agent owns the green-CI outcome, not just
the push. Local close-validation gates pass on the dev host's environment;
CI runs on a different OS and concurrency, and coverage rounding,
platform-conditional branches, and timing-sensitive tests routinely drift
between the two.

Fix the failure and push a new commit on `story-<storyId>` — auto-merge stays
armed across retries, so you do not re-arm — then resume the land with the
envelope's `nextCommand`.

> **A watch is an internally-blocking step, not a reason to end your turn.**
> `pr-watch-with-update.js` blocks the current turn until CI resolves — that
> IS how you wait. Ending the turn with prose and an unconfirmed merge is a
> contract violation (the Story #1553 / PR #1554 failure mode). See
> [`deliver-story-reference.md` § The auto-merge wait is an internally-blocking step](deliver-story-reference.md#the-auto-merge-wait-is-an-internally-blocking-step).

To watch the checks on the red path, drive
`pr-watch-with-update.js` — the **single CI-watch mechanism**
(Story #4358). It polls the required checks to a
terminal state and auto-recovers from `mergeStateStatus: BEHIND`; do
**not** fall back to a bare `gh pr checks` watch invocation:

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber> --story <storyId>
```

`--story` is what keys the red-path CI digest
(`temp/story-<id>-ci-digest.{json,md}` — failing check name, run id, and a
`gh run view --log-failed` tail). Omit it and a red check writes no digest.

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
  CLOSED issue. If the same failure class recurs, hand convergence off to a
  self-paced host loop (`/loop`) that re-runs the failing check and applies
  the smallest fix until it exits green.
- **Exit 2 (still-running — slow CI, not red)** — the poll cap fired with
  checks still pending and the watcher exhausted its resume budget with
  nothing red. This is **never** a failure. Hand the wait off to the
  host's interval loop rather than ending your turn: `/loop 5m` polling
  `gh pr checks` until the checks settle.

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
> [`deliver-story-reference.md` § Step 4 — CI watch + fix recovery](deliver-story-reference.md#step-4--ci-watch--fix-recovery).

---

## Step 5 — Merge confirmation + land tail (**recovery-only**)

> On the default path Step 3 already did this. Run it only to resume a
> `pending` envelope, to finish a `--no-wait-merge` run, or to rescue a
> merged-but-mislabelled Story.

```bash
node .agents/scripts/single-story-confirm-merge.js --story <storyId> --cwd <main-repo>
```

This is the **same** shared land path Step 3 reaches: it flips
`agent::closing → agent::done` on a confirmed merge (closing the issue) and
runs the **same** post-land tail — so the two surfaces cannot diverge. It is
idempotent, emits the same terminal envelope, and is safe to re-run while
the PR is still open (returns `pending`).

> **Confirmation outcomes.** `single-story-confirm-merge.js` re-reads the
> live PR state and flips to `agent::done` only on a confirmed `MERGED` PR;
> it is idempotent and safe to re-run while the PR is still open (returns
> `pending`). See
> [`deliver-story-reference.md` § Step 5 — Merge confirmation detail](deliver-story-reference.md#step-5--merge-confirmation-detail).

---

## Step 5.5 — Re-assert Status column (**recovery-only**)

> **The land tail already ran this** (Story #4543) — it is `tail.statusResync`
> in the terminal envelope. Run it by hand only when that step reported
> `false`, or after a manual merge on a `--no-wait-merge` run.

GitHub Projects v2 built-in workflows fire minutes *after* auto-merge lands
and clobber the `Done` Status the confirm step set, stranding closed
Stories at `In Progress` on the board (reproduced on Story #2813).
Re-assert authority:

```bash
node .agents/scripts/resync-status-column.js --story <storyId>
```

The helper re-fires the `ColumnSync` mutation and **polls for ~15 s** to win
the race against the bot's late write (Story #2876). It is idempotent and
no-op-safe (`no-project` / `not-on-project` exit 0).

> **Status-column detail + tuning flags + operator fix.** For the poll-loop
> flags (`--poll-attempts`, `--poll-delay-ms`), the `attempts` / `drifted`
> envelope semantics, and the canonical
> `--reap-conflicting-workflows` operator fix, see
> [`deliver-story-reference.md` § Step 5.5 — Re-assert Status column detail](deliver-story-reference.md#step-55--re-assert-status-column-detail).

---

## Step 6 — Local branch cleanup (**recovery-only**)

> **The land tail already ran this** (Story #4543) — it is `tail.refCleanup`
> and `tail.baseFastForward` in the terminal envelope, done in-process
> against the same planners this command drives. Run it by hand only when
> either step reported `false` (a dirty shared checkout is the common,
> benign cause), or after a manual merge on a `--no-wait-merge` run.

GitHub deletes the **remote** branch on auto-merge, but the **local**
`story-<storyId>` ref lingers in the main checkout until something prunes
it. To prune the story ref **and** fast-forward local `main` (or
`project.baseBranch`):

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
> [`deliver-story-reference.md` § Step 6 — Local branch cleanup detail](deliver-story-reference.md#step-6--local-branch-cleanup-detail).

---

## Step 7 — Return contract (**required when dispatched as a sub-agent**) {#return-contract}

The return contract is the shipped schema
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
— **the single source of truth for every field, and the only place they are
defined** (Story #4543). Do not restate its fields here or anywhere else:
this section and
[`agents/story-worker.md`](../../agents/story-worker.md) each used to define
their own divergent shape, neither validated by anything, which is exactly
how they drifted apart.

When this workflow runs as a per-Story sub-agent (dispatched by
[`/deliver`](../deliver.md)), the **only** acceptable way to end your turn is
to return a single terminal JSON object conforming to that schema — never
free-form prose. `single-story-close.js` already emits a validated one
between its `--- STORY DELIVER TERMINAL ---` markers; **relay that envelope**
rather than composing a new object by hand.

Its `status` is one of exactly four values, and the no-park rule follows
directly from them:

- `landed` — the PR merged, the Story is `agent::done`, and the tail was
  attempted. Terminal; you are done.
- `pending` — **resumable**, and the only sanctioned way to end a turn
  without a merge. It carries the `nextCommand` that resumes it. Return this
  only when you have exhausted your own budget, not as a way to avoid
  waiting: the wait is internally blocking (Step 4).
- `blocked` — the Story carries `agent::blocked` and `blocked.blockClass`
  names the class.
- `failed` — a phase crashed; `phase` names it.

Ending the turn with prose and an unconfirmed merge is a contract violation
(the Story #1553 / PR #1554 failure mode).

> **No-park rule + handoff discipline.** For why a prose hand-off with an
> unconfirmed merge is the very bug this workflow prevents, and the
> report-state-not-process handoff discipline, see
> [`deliver-story-reference.md` § Step 7 — Return-contract detail](deliver-story-reference.md#step-7--return-contract-detail).

---

## Recovering a stranded Story {#recover}

When a Story is in an unclear state — a killed run, a `pending` envelope you
no longer have, a Story a `/deliver` re-run refuses — do not guess and do not
re-run the pipeline hoping it converges. Probe it:

```bash
node .agents/scripts/deliver-recover.js --story <storyId>
```

It is **read-only**: it probes the labels, lease, branch, worktree, and PR
(state + checks), then prints the **one** next command with the evidence it
was derived from — never a menu.

It is the only automated way out of the **merged-but-label-stale** strand: a
`/deliver` re-run refuses that Story outright, because `single-story-init.js`
hard-errors on an already-closed one.

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

Re-running `/deliver-story` against an already-closed Story is
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
  pipeline already emits (the `single-story-close.js` terminal envelope)
  rather than inventing a new contract. Do not narrate the steps you took, and do not prescribe how the
  next stage should do its work. Prose process commentary only bloats the
  hydrated prompt.
- **Label transitions**: drive every `agent::*` state change through
  `node .agents/scripts/update-ticket-state.js --ticket <id> --state <state>`.
  This CLI is the authoritative mechanism — there is no separate
  state-mutation MCP server to degrade from (see
  [`.agents/instructions.md` § 1.D](../../instructions.md)).

---

## See also

- [`/deliver`](../deliver.md) — unified entry point (`<storyId...>`;
  sequences via `depends_on`, resolved from live state).
- [`deliver-story-reference.md`](deliver-story-reference.md) —
  lease, sweep, CI-recovery, and Status-column reference detail.
