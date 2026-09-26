---
description: >-
  Reference companion to `helpers/deliver-story.md` — the lease and
  sweep detail, worktree-scope warnings, CI-recovery procedures, and
  Status-column reconciliation lifted out of the runtime core so the
  always-ingested standalone-delivery prose stays lean. Not a slash command;
  consulted on demand when the core file points here.
caller: helpers/deliver-story.md
---

# helpers/deliver-story — reference (lease, recovery, troubleshooting)

> **Not a slash command, not the runtime path.** The reference companion to
> [`deliver-story.md`](deliver-story.md): read a section here only when the
> matching pointer in the core sends you.

---

## Step 0 — Lease preflight and merged-sweep

### Lease preflight

Before any git mutation, init takes an exclusive, time-bounded **lease** on
the Story ticket via the assignee-as-lease primitive
(`lib/orchestration/ticket-lease.js`). The single assignee _is_ the lease
owner (resolved from `github.operatorHandle`), and it is the only guard
against a concurrent `single-story-init` clobbering an in-flight run.

**Fail-closed.** The standalone path has **no Epic-scoped lifecycle ledger**
to read a per-owner `story.heartbeat` from, so it cannot tell whether a
foreign claim is stale — a foreign assignee is treated as a _live_ claim:

- **Unclaimed / self-held** → init proceeds (a self-held claim is
  re-affirmed without re-writing assignees).
- **Any foreign assignee** → init **exits non-zero** with a message naming
  the current owner. Coordinate with that operator, or pass **`--steal`** to
  forcibly transfer the claim once you have confirmed the other run is dead.

`--dry-run` skips the lease (no assignee mutation). The matching release
runs in `single-story-close.js` (Step 3).

### Branch reuse

When a `story-<id>` branch already exists locally, init **reuses** it. The
seed decision (`reuse` / `fetch` / `create`) keys off local + remote ref
presence, so re-running init on a partially-initialized Story is idempotent.

### Merged-`story-*` sweep

Between the fetch and the branch seed, init runs the same primitive as
`<agentRoot>/scripts/clean-git.js` scoped to `story-*` in
`--execute --remote` mode, excluding this run's `story-<id>`, reaping merged
siblings' local refs, `origin/` refs and stale tracking refs in one pass.

- **Per-candidate protection.** A candidate is skipped — listed under
  `protected[]` and named in the `CLEANUP` log line — on `unpushed-work`
  (branch HEAD differs from the PR's `headRefOid`), `dirty-tree` (its
  worktree has uncommitted changes) or `ticket-not-done` (the Story is
  neither closed nor `agent::done`).
- **Cross-session lock.** The sweep takes `<tempRoot>/single-story-sweep.lock`
  before planning. On contention this run's sweep is **skipped** with a warn
  log; a lockfile older than the fixed 60-second timeout is treated as expired.

Sweep failure or skip never blocks init. `--dry-run` also skips the sweep.

### Worktree scope is not just the Bash cwd

`cd <workCwd>` steers the **Bash** tool's working directory, but it does
**not** scope the path-based **Edit/Write/Read** tools — those resolve
**absolute paths** and ignore the shell cwd, so an agent whose shell sits in
the worktree can still silently edit the **main checkout**. You MUST prefix
**every Edit/Write/Read path with the absolute worktree root** (the `workCwd`
value from Step 0). Never edit files under the bare main-checkout root.
`single-story-close.js` runs a **wrong-tree guard** that aborts close and posts
a `friction` comment on uncommitted tracked-path edits in the main checkout —
a backstop, not a substitute for prefixing paths correctly.

---

## Engine invariants and ceremony

**Prerequisites before Step 0.** A `type::story` issue, a clean
`gh auth status`, and `project.baseBranch` present both locally and on
`origin` — a missing or unauthenticated remote surfaces as a
`remoteVerified: false` block rather than a useful error. The engine's trait
table is digest § 2.

**A cheap shape never buys a cheaper landing.** A small Story collapses only
the _advisory_ ceremony — the fresh-critic / Tech-Spec authoring a
one-artifact scope does not earn. The close-validation gates (lint / test /
format / coverage / CRAP / maintainability), the PR to `main`, and the
`rules/security-baseline.md` MUSTs run exactly as for any other Story. There
is no gate bypass to opt into, and nothing in the ticket can declare one.

**The ceremony rule has one home: digest § 3**, and the dispatch rule is
digest § 1. The light path is the one caller that reads the authored body's
shape, through `deriveStoryShape` (`lib/orchestration/complexity-gate.js`).

---

## Declared dependency edges — what actually gates dispatch

`resolve-stories.js` builds each `dag[].dependsOn` from the **union of two
declared-edge channels**, and nothing else: the Story body's footer block and
the issue's native GitHub `blocked_by` relations. Both are read strictly — an
edge the resolver cannot read is never quietly reported as an edge that does
not exist.

**The body channel is footer-scoped.** Only a `blocked by #N` line standing
alone inside the `---` footer block declares an edge:

```markdown
## Goal

…

---

blocked by #42
```

Prose elsewhere in the body declares **nothing** — move a hand-written prose
edge into the footer block. The loose spellings `depends on #N`,
`Blocked by: #N`, and `blocked by #N once X lands` declare nothing either.

**The native channel fails loud.** The read paginates to exhaustion, and
**a 404 is not an empty result**: an issue with no dependencies answers
`200 []`, while a 404 is also how GitHub answers a token that cannot see the
dependencies API. Any non-OK read fails the resolution naming the Story —
check the token's scopes first. The one scoped degrade is a **cross-repo
edge**: it cannot be matched against this repo's same-numbered issue, so it is
dropped with a warning naming the Story, and its siblings resolve normally.

**Edges are monotone — retraction is not built.** Removing a footer line or a
native relation makes the edge absent from the **next** resolve, but nothing
reconciles an edge a previous run already acted on: treat a stale gate as a
body/issue edit plus a fresh `resolve-stories.js` run.

---

## Step 1 — Implementation detail

**Docs context — digest-first.** Read a full doc only when the Story's own
context points you at one; prefer a caller-provided `docsDigestPath` and pull
individual files on demand. See [`.agents/instructions.md` § 3](../../instructions.md).

**Write-time audit checklists.** When the caller provides a `checklistPath`
(footprint-matched **local**-lens authoring checklists), read it before you
write and self-check as you author. When absent, lens-aware coverage still
runs maker-blind at Story-scope review inside the close subprocess. The
dispatch step produces `checklistPath` from the Story's predicted footprint
before it spawns the worker — see [`/mandrel-deliver`](../mandrel-deliver.md).

**Full-suite discipline (spine Step 2.5).** Repo-invariant guards —
drift-guard and schema tests outside the Story's scoped greps — are the
failure class that bounces deliveries, and close-validation discovers them
only after the whole close pipeline has run. The run itself is stated once,
in [`deliver-digest.md`](deliver-digest.md) § 5.

**Conflict with `main` mid-implementation** → resolve as you would any branch
rebase; the rebase base is `main` directly.

### Step 1a — self-eval mechanics

**One verdict owner per Story** — `verdictOwner: 'fresh-critic' |
'inline-self-eval'` from `resolveCeremonyForRisk`, following the ceremony
profile alone (digest § 3). Exactly one pass authors the verdict — never both,
and never a preliminary self-assessment before dispatching a fresh critic.
`acceptance-eval.js` is the deterministic **scorer** of that one verdict —
schema validation, round cap, proceed / redraft / block — not an additional
pass over the criteria. The invocation and the one-verdict-one-call rule are
digest § 4; per-round mechanics are
[`acceptance-self-eval.md`](acceptance-self-eval.md).

**On `decision: "block"`** — post a `friction` comment naming the unmet
criteria, then transition the Story to `agent::blocked`:

```bash
node .agents/scripts/diagnose-friction.js --story <storyId> \
  --cmd node .agents/scripts/acceptance-eval.js --story <storyId> --verdict <verdict-path>
node .agents/scripts/update-ticket-state.js --ticket <storyId> --state agent::blocked
```

---

## Step 2 — Ceremony detail

`ceremony-derive.js` (digest § 3) is the change-set enumeration, the level
derivation ([`deriveChangeLevel`](../../scripts/lib/orchestration/review-depth.js))
and the ceremony resolution
([`resolveCeremonyForRisk`](../../scripts/lib/orchestration/ceremony-routing.js))
in one call. Hand the **same** `files` list to the verdict owner (Step 1a) —
an evaluator that re-ran its own `git diff` could score a different set than
the one that routed it.

---

## Step 3 — Merge wait, async mode, and flags

**Step 3 is the orchestrator's, and it is serialized.** A dispatched
`story-worker` ends its turn at a pushed branch (spine § Step 2.5); the session
that dispatched it runs close. Two reasons:

1. **A sub-agent cannot resume itself.** It gets no notification when a
   backgrounded close finishes, so a worker that backgrounds close and ends its
   turn strands the envelope in a turn nobody reads. The parent, by contrast,
   is still live and _does_ observe and retry its own close.
2. **Closes contend; implementation does not.** Close syncs from
   `origin/<baseBranch>`, pushes, opens a PR and arms auto-merge — two of those
   in flight race on the base branch, the merge queue and the shared checkout.
   So implementation may fan out across the wave, but the tail runs **one Story
   at a time**: a worker that hands back while another close is running waits in
   the orchestrator's queue.

A worker therefore returns a hand-off report, not a terminal envelope, and that
is the expected shape — only close mints an envelope. Never answer a missing
envelope with a re-dispatch: `single-story-init.js` re-run under a live branch
is how one Story ends up with two closes. Close the pushed branch, or probe with
`deliver-recover.js` and run the one command it prints.

**The merge wait is bounded and resumable.** Two budgets, deliberately
separate (`delivery.mergeWatch.*`):

- **`maxWaitSeconds`** (default 300) bounds **one invocation**, sized to fit
  inside a single host tool invocation (~10 min ceiling) alongside the gates
  that precede it. Expiry → `pending`. Pass `--max-wait-seconds <n>` to raise
  it when your host has no such ceiling and you want to land in one block.
- **`maxBudgetSeconds`** (default 3600) bounds the **cumulative** wait across
  resumes, anchored at the PR's `createdAt` so resuming does not restart the
  clock. Exhausting _this_ is the genuine give-up → `blocked`.

The wait probes the checks every poll: a red required check fails fast as
`checks-failed` instead of burning the budget, and a PR that falls behind its
base is brought up to date within 3 tries.

**On a multi-Story run, async is the posture — pass `--merge-watch-mode async`
on every close.** The close tail is serialized, and under `sync` each close
holds the foreground for its full merge wait before the next may start. Close
cannot see run topology, so the orchestrator makes the call per invocation
(`deliver-run.js` renders it into every multi-Story `close[]` command) while
the config default stays `"sync"` — right for a solo delivery. What async does
and how to resume its `pending` is
[`deliver-reference.md`](deliver-reference.md) § Async merge-confirm mode.

**`delivery.ci.autoMerge` policy.** Under the default `"trust-ci"`, GitHub
native auto-merge is armed and the PR squash-merges once its **required**
checks pass. Under `"strict"`, the close **does not arm auto-merge** — the
PR opens and waits for an **operator merge**, exactly as `--no-auto-merge`
does per-run.

**When to reach for a close flag.** What each one _does_ is in
`node .agents/scripts/single-story-close.js --help`; below is only the
judgment that help text cannot carry.

- `--skip-validation` — only when re-running close after a fixed gate
  failure that's already known to pass.
- `--skip-sync` — only after a hand-resolved sync, or in tests.
- `--no-auto-merge` — when the PR materially changes behaviour and warrants a
  pre-merge eyeball; the operator then merges via the GitHub UI.
- `--wait-merge` — **close-and-land**. When neither land flag
  is passed, close defaults from `delivery.routing.closeAndLand` (**true**):
  attended and headless delivers share the land-in-one-close happy path.
- `--no-wait-merge` — the explicit opt-out always wins. Use when the operator
  wants the PR left at `agent::closing` for a human land (or a wrapper that
  will invoke `single-story-confirm-merge.js` itself). Reports `pending` —
  the work is not done, nothing is broken, and one named command finishes it.
- `--override-review-block "<reason>"` — when the Story-scope review's
  **critical** blocker is one you have read and judged wrong (a false positive,
  or a finding the ratchet correctly exempts). It is the only sanctioned way
  past that halt: reach for it instead of merging the PR by hand, because a
  hand-merge bypasses the gate and records nothing. The reason is mandatory and
  is written to three places (Story comment, PR comment, a
  `review-block-overridden` friction signal), and the terminal envelope reports
  `gates.codeReview: "overridden"` rather than `"passed"`. If you find yourself
  reaching for it twice for the same shape of finding, the gate is
  miscalibrated — fix the gate, not the run.
- `--max-wait-seconds <n>` — from a headless caller with no host
  tool-invocation ceiling, to keep single-block semantics
  without editing the consumer's config.
- `--merge-watch-mode <sync|async>` — the per-invocation override of
  `delivery.mergeWatch.mode`. **Pass `async` on every close of a multi-Story
  run** (above); leave it off for a solo delivery. It composes with
  `--max-wait-seconds` — the explicit bound still wins over the async probe
  cap. An unrecognized value is refused before any phase runs, reporting a
  `failed` terminal envelope at `phase: init` and mutating nothing.

---

## Step 3 — Close pipeline detail

The `single-story-close.js` script, in order:

1. **Syncs the Story branch from `origin/<baseBranch>`** — before the gates,
   so the tree the gates validate is the tree the push sends, and a conflict
   costs no gate run. It runs `git fetch origin <baseBranch>` then
   `git merge --no-edit origin/<baseBranch>` in the worktree, defending against
   parallel Stories leaving a lagging PR "behind base". Outcomes:
   - **No-op / fast-forward / clean merge-commit** → close proceeds to
     push.
   - **Merge conflict** → the merge is aborted, a `friction` structured
     comment is posted on the Story (conflicting file list + recovery
     command set), the Story flips to `agent::blocked`, and close
     throws. Resolve in the worktree (`git merge origin/<base>` + fix
     conflicts + `git commit --no-edit`) and re-run
     `/deliver-story`.
   - **Fetch failed** → close throws with the git stderr; no label
     transition.

   Without a merge queue a residual race remains between PR open and
   auto-merge fire; the merge queue re-tests against the queue tip.

2. Runs the close-validation gates against `baseBranch`; any failure throws —
   fix and re-run close. The chain fails cheapest-first: `typecheck`, `lint`,
   `format` and `check-baselines-independent` run in parallel, and only once
   they are green does the serial walk pay for `coverage-capture` and
   `check-baselines-coverage`. Gate output is captured (digest § 6).
3. Pushes `story-<id>` to `origin`.
4. Opens (or reuses) a PR with `head = story-<id>` against `<baseBranch>`,
   carrying `Closes #<storyId>`, and arms native auto-merge
   (`gh pr merge <prNumber> --auto --squash --delete-branch`) unless
   `--no-auto-merge` or `autoMerge: "strict"`. An arm failure is non-fatal.
5. Flips the Story to **`agent::closing`** (NOT `agent::done`) and leaves
   the issue **OPEN**: auto-merge completes after the arm, so closing here
   would strand a CLOSED issue with no merged work if the PR failed CI, went
   `BEHIND` base, or closed unmerged. A Story only reaches `agent::done` once
   its PR to `main` is confirmed merged (Step 5).
6. Reaps the worktree when `delivery.worktreeIsolation.reapOnSuccess`
   is enabled.
7. **Releases the Story lease** — a no-op when the operator no longer holds
   the claim, so a late close never yanks a live claim. Best-effort: a
   release failure is logged, not fatal, and reported as
   `leaseReleased: <boolean>`. The fail-closed lease never expires on its
   own, so a claim stranded by a failed release is cleared only by `--steal`
   or by de-assigning the ticket.

---

## Step 4 — CI watch + fix recovery

Enter this step **only** when Step 3 returned `blocked` with
`blockClass: "checks-failed"` (a required check went red), or when a
`--no-wait-merge` run left the PR for you to shepherd. When a required check is
red, the agent owns the green-CI outcome, not just the push: CI runs on a
different OS and concurrency, and coverage rounding, platform-conditional
branches, and timing-sensitive tests routinely drift from the dev host.

Fix the failure and push a new commit on `story-<storyId>` — the watcher
**disarmed native auto-merge on the first red** and re-arms it
only when the checks go green on a **new head SHA**, so the fix must be a real
commit — then resume the land with the envelope's `nextCommand`.

To watch the checks on the red path, drive `pr-watch-with-update.js` — the
**single CI-watch mechanism**. It polls the required checks to a
terminal state and auto-recovers from `mergeStateStatus: BEHIND`; do **not**
fall back to a bare `gh pr checks` watch invocation:

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber> --story <storyId>
```

`--story` is what keys the red-path CI digest
(`temp/story-<id>-ci-digest.{json,md}` — failing check name, the PR head SHA,
run id + run link, and a `gh run view --log-failed` tail). Omit it and a red
check writes no digest — and with no digest the no-rerun guard has nothing to
adjudicate the next green against, so always pass it. Cadence, caps and the
attach window (how long an **empty** required-check set is re-resolved before
the watch stops waiting, default 20 min) are in `--help`. Add
`--repo owner/repo` only when the cwd is not the target repository; there is no
`<owner/repo>#<number>` ref form — `gh` parses that as a branch name.

When the watch exits, branch on the exit code:

- **Exit 0 (all checks ✓)** — auto-merge will fire (or has already). The Story
  is still at `agent::closing` with its issue OPEN. **Proceed to merge
  confirmation (§ Step 5) within the same turn** — green CI is the _start_ of
  the merge-confirm sequence, not a terminal state.
- **Exit 1 (a check genuinely failed, the green was a forbidden re-run, or the
  PR itself could not be read)** —
  diagnose, fix at source, and push a new commit on `story-<storyId>`, then
  re-watch: the watcher disarmed auto-merge on the red and re-arms it only for
  a green on a **new head SHA**. The Story stays at `agent::closing`
  throughout, so a failed/abandoned PR never strands a CLOSED issue. If the
  same failure class recurs, hand convergence off to a self-paced host loop
  (`/loop`) that applies the smallest fix and pushes a new commit each pass —
  **never** a bare re-run of the failed job. A green the guard rejects as a
  re-run of the same commit flips the Story to `agent::blocked` with a
  `friction` comment; clear it per
  [`ci-remediation.md`](../../rules/ci-remediation.md) § Verifier.
- **Exit 2 (slow, not red)** — one of three slow conditions, **never** a
  failure and never a green. Hand the wait off to the host's interval loop
  rather than ending your turn: `/loop 5m` polling `gh pr checks` until the
  checks settle. The envelope names which:
  - **still-running** — the poll cap fired with checks still pending and the
    watcher exhausted its resume budget with nothing red.
  - **not-yet-started** (`notYetStarted: true`) — the attach window was spent
    and **no** required context ever attached, while the PR kept reading back
    fine. CI has not started; there is no failing check and no CI digest to
    read. Do **not** treat it as red — nothing needs fixing, and re-watching
    (or raising `--attach-window-ms`) is the whole remediation.
  - **unresolved** (`reconciliation.reconciled: false`) — every observed
    required check is green but the repository still refuses the merge, so the
    green verdict is withheld.

**Triage authority.** How to classify and remediate a red (or repeatedly slow)
check — the root-cause-only decision tree, the never-rerun / never-quarantine
prohibitions, and the escalation criteria — is defined once in
[`.agents/rules/ci-remediation.md`](../../rules/ci-remediation.md). Read it
before remediating a red check.

**Filing an out-of-scope root cause is one command, never a hand-run `gh issue
create`:**

```bash
node <agentRoot>/scripts/file-ci-gap.js --story <storyId> \
  --verdict <pre-existing|capacity|unreproducible-tier> \
  --owner <consumer|framework|platform> --evidence "<proof reading>" [--block]
```

It reads the digest, routes the filing to the repo that owns the fault, updates
the existing ticket when the signature is a repeat, posts the `friction`
comment, and with `--block` flips the Story. What it files is an **intake**
issue, not a Story — `/mandrel-plan <issue number>` graduates it on the next
planning pass, so the delivery never waits on planning.

### The auto-merge wait is an internally-blocking step

A session that owns close must not arm auto-merge and then end its turn with
**free-form prose** ("I'll wait for the background watch task…"), leaving the
merge unconfirmed and the Story stranded at `agent::closing`.
`pr-watch-with-update.js --pr <prNumber>` _blocks the current turn_ until CI
resolves — that is the mechanism by which you wait. Keep your turn alive:
watch → (fix + push + re-watch on red) → confirm the merge (Step 5) → and only
then return the terminal status. **Only** a confirmed-`MERGED` PR
(→ `status: "landed"`), an `agent::blocked` transition (→ `status: "blocked"`),
or an unrecoverable failure (→ `status: "failed"`) ends the turn — or a
genuine `pending` (§ Step 7). The statuses are the shipped
[terminal schema](../../schemas/story-deliver-terminal.schema.json)'s.

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

```bash
gh run view <runId> --repo <owner>/<repo> --log-failed
```

The `<runId>` is in the failing row's URL from `gh pr checks`. The gate that
exited non-zero is named at the bottom of the log (e.g.
`[Coverage] ❌ REGRESSION in …`).

### Fixing without re-running close-validation

For coverage / maintainability / CRAP regressions detected only on CI, update
the relevant `baselines/*.json` to CI's actual numbers by hand when they are
within the tolerance you would otherwise accept — a local `npm run … :update`
on another OS overwrites CI's numbers and the cycle repeats. Commit it as
`chore(baselines):` naming the CI run, push, and re-watch. For genuine test
failures: fix the code or test, commit, push, re-watch.

### When to stop iterating

- **Three consecutive failures with the same fix shape** — stop and
  Re-Plan per Anti-Thrashing Protocol. The diagnosis is likely wrong.
- **Operator-blocking failure** (security scanner, branch-protection
  rule the agent can't change) — transition the Story to
  `agent::blocked`, summarize the blocker on the PR, and yield to the
  operator.

### Idempotence of the loop {#idempotence}

- The PR stays open across retries; `gh pr create` is a one-shot at
  close, the loop only pushes new commits.
- Auto-merge is disarmed by the watcher on the first red and re-armed
  when the checks go green on a new head SHA; pushing a new commit is
  what re-opens the merge path.
- If the operator manually merges or disables auto-merge mid-loop,
  exit the loop and report.

---

## Step 5 — Merge confirmation detail

> On the default path Step 3 already did this. Run it only to resume a
> `pending` envelope, to finish a `--no-wait-merge` run, or to rescue a
> merged-but-mislabelled Story.

```bash
node .agents/scripts/single-story-confirm-merge.js --story <storyId> --cwd <main-repo>
```

This is the **same** shared land path Step 3 reaches: it re-reads the live PR
state, flips `agent::closing → agent::done` on a confirmed merge (closing the
issue) and runs the **same** post-land tail — so the two surfaces cannot
diverge. It is idempotent, emits the same terminal envelope, and is safe to
re-run while the PR is still open (returns `pending`). The issue closes exactly
when the work has merged, never at PR-open.

---

## Step 5.5 — Re-assert Status column detail

> **The land tail already ran this** — it is `tail.statusResync`
> in the terminal envelope. Run it by hand only when that step reported
> `false`, or after a manual merge on a `--no-wait-merge` run.

```bash
node .agents/scripts/resync-status-column.js --story <storyId>
```

It re-fires the `ColumnSync` mutation and polls to win the race against the
Projects v2 built-in `Pull request merged` / `Pull request linked to issue`
workflows, which overwrite Status minutes after the merge. Idempotent and
no-op-safe; its envelope and flags are in `--help`. `status: 'drifted'` means
the bot won every attempt. **Canonical operator fix:** run
`node .agents/scripts/agents-bootstrap-github.js --reap-conflicting-workflows`
once per project to delete the conflicting bot workflows entirely.

---

## Step 6 — Local branch cleanup detail

> **The land tail already ran this** — it is `tail.refCleanup` and
> `tail.baseFastForward` in the terminal envelope. Run it by hand only when
> either step reported `false` (a dirty shared checkout is the common, benign
> cause), or after a manual merge on a `--no-wait-merge` run:

```bash
node .agents/scripts/clean-git.js \
  --execute \
  --remote \
  --yes \
  --fast-forward-main \
  --branches \
  --include "story-<storyId>"
```

It fast-forwards local `main` (the next init seeds from it) and reaps only
this Story's ref. Idempotent and safe before `MERGED` confirms (a
not-yet-merged branch is skipped); after an `--no-auto-merge` opt-out, run it
once the manual merge lands.

---

## Idempotence and the standing constraints

**Why a no-envelope hand-off must never be re-dispatched.** Only Step 3 mints a
terminal envelope, so a sub-agent returning without one is the normal shape. The
branch already exists, and re-running Step 0 underneath live work is how one
Story ends up with two closes — resume per the spine's § Recovery instead.

Every script in the chain no-ops safely on re-run: `single-story-init.js`
re-prints `workCwd` for an already-initialized Story; `single-story-close.js`
and `single-story-confirm-merge.js` short-circuit on a closed or `agent::done`
Story; the PR probe reuses an open PR rather than opening a second one. That is
what makes the recovery router safe to walk more than once.

The four constraints the spine states without arguing for them:

- **Never push the Story branch directly to `main`.** The PR is the only merge
  surface — a direct push bypasses required checks and the squash title
  release-please parses.
- **Always prefix path-based tools with the absolute `workCwd` root** —
  § Worktree scope.
- **Report state, not process.** Mirror the close envelope's fields; step
  narration reads as progress while telling the caller nothing it can branch on.
- **Drive every `agent::*` transition through `update-ticket-state.js`** so the
  label, the Projects Status column and the lifecycle event stay in one motion.

## Step 7 — Return-contract detail

The field-level contract is the shipped schema
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
— not this file, and not
[`agents/story-worker.md`](../../agents/story-worker.md). What follows is the
_judgement_ around it, which a schema cannot express.

### `pending` is a real status — and it is not a park

`pending` is a real terminal status with its own exit code (3) — the honest
name for a close-and-land whose CI outlived the host's ~10-minute
tool-invocation ceiling:

- It is **resumable**: no label was mutated, no `merge.unlanded` was emitted,
  and `nextCommand` names the one command that continues it. The cumulative
  budget is anchored at the PR's `createdAt`, so resuming does not restart the
  clock.
- It is **not** a park. Returning `pending` because you would rather not wait
  is the no-park failure mode wearing a schema. Return it only
  when the bound genuinely expired, or a human owns the merge.

The no-park rule holds: a turn that ends with prose and an unconfirmed merge
is a **contract violation** — the parent cannot distinguish "still working"
from "done but silent". `pending` is the honest, machine-readable alternative.

### The envelope also lands on disk

`emitTerminalEnvelope` — the one writer behind every emit site — also
persists the validated envelope to
`<tempRoot>/orchestration/story-deliver-terminal-<storyId>.json`, because
stdout's one reader is not always still listening:

- **It is the same object**, not a summary. Read it and branch exactly as you
  would on stdout; the copy is written before the markers are, so a caller
  that saw them can rely on the file.
- **It is best-effort.** A failed write returns null and changes nothing about
  the emitted envelope or the exit code.
- **It is a fallback, not a licence.** The orchestrator running close still
  holds its turn until the envelope arrives; see § Step 3 above and
  [`agents/story-worker.md`](../../agents/story-worker.md).

`deliver-recover.js` reads the same artifact, plus the freshness of
`close-gates-<storyId>.log`, to split `agent::executing` with no PR: it answers
`close-in-flight` (a gate log touched inside the window: wait, then re-probe)
or `close-envelope-on-disk` (the close already reached a verdict: relay it),
and falls back to "Implementation never finished" only when neither artifact
exists — never re-init under a live close.

### Exit-code compatibility note (`--no-wait-merge`)

A `--no-wait-merge` (or `--no-auto-merge` / `autoMerge: "strict"`) run exits
**3** (`pending`), not 0: the PR is open and a human still owns the merge, and
`landed` is what exit 0 means. A wrapper testing `exit == 0` for "close
finished" must treat 3 as the operator-merge success path; `!= 0` does not
imply failure.

### Per-status judgement

- **`landed`** — the only status that means done. A `false` in `tail.*`
  degrades the report, never the land: the merge is on the base branch, and
  failing it because a Projects v2 mutation flaked would report a false
  negative about work that demonstrably shipped.
- **`pending`** — see above.
- **`blocked`** — you (or the close pipeline) transitioned the Story to
  `agent::blocked` and posted a `friction` comment. `blocked.blockClass` comes
  from the shared classifier, never an ad hoc string, and
  `blocked.frictionCommentId` points at the remediation.
- **`failed`** — an unrecoverable failure outside the blocked protocol.
  `phase` reflects where it died.

> **Handoff discipline — report state, not process.** Populate the envelope
> with essential terminal state only (mirroring the fields
> `single-story-close.js` already emits); do not narrate the steps you took.
> When run **interactively** (no parent aggregator), the JSON envelope is
> optional — relay terminal state in prose — but the **no-park rule still
> holds**: never end an interactive turn with an unconfirmed merge either.
