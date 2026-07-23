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

> **Not a slash command, not the runtime path.** This file is the
> reference companion to
> [`deliver-story.md`](deliver-story.md). The core file
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
  contention (another `/deliver-story` already in the sweep
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

## Engine invariants and the lite route

The v2 engine's trait table:

| Trait | v2 `/deliver-story` |
| --- | --- |
| Ticket type | `type::story` only |
| Branch | `story-<id>` seeded from `project.baseBranch` (`main`) |
| Merge target | `main` via PR (squash + required checks) |
| Epic integration branch | **None** — no `epic/<id>`, no `--no-ff` wave merge |
| Spec / slices | Folded `## Spec` + optional `## Slicing` checkpoints in-session |
| Ceremony | Per-Story, routed off the derived change level via `ceremony-routing.js` |

**Ceremony-lite Stories still land through this engine unchanged (Story #4683).** A lite-routed Story collapses only the *advisory* plan/deliver
ceremony — the fresh-critic / Tech-Spec authoring a one-artifact scope does
not earn. It does **not** get a cheaper landing: the close-validation gates
(lint / test / format / coverage / CRAP / maintainability), the PR to `main`,
and the `rules/security-baseline.md` MUSTs all run exactly as for a
full-ceremony Story. The lite route's `preserves` field is the machine-readable
record of those non-negotiables; there is no lite-specific gate bypass.

**Deliver derives the route from the Story body's shape (Story #4722).**
Persist stamps a lite cohort's Stories with the `route::lite` label as a
*human-visible hint only* (and ledgers the authored verdict — recorded
reason plus per-Story shape evidence — on the `story-plan-state`
checkpoint); the label is never the control signal. `/deliver` computes the
route from the fetched Story body via `resolveStoryDispatchMode`
(`lib/orchestration/complexity-gate.js`) — the same shape taxonomy
`deriveChangeLevel` applies to the landed diff at close: `changes[]` count,
acceptance count, creates-vs-refactors mix, sensitive-path classes. A
lite-shaped Story executes **inline in the deliver session** — even when the
label is absent or its write failed — with no `story-worker` sub-agent boot,
and the Step 1a acceptance self-eval runs its critics **inline** (no
fresh-context acceptance-critic sub-agent dispatch; sub-agent boots are the
dominant deliver-phase token cost at trivial scope). A footprint
intersecting a sensitive-path class derives `full` — sensitivity wins, and
the Story keeps its fresh acceptance critic. Inline execution
changes the isolation only: the engine, every script gate, and the
terminal envelope are byte-identical either way.

---

## Step 1 — Implementation detail

**Docs context — digest-first.** Read a full doc only when the Story's own
context points you at one — do not ingest the whole
`project.docsContextFiles` set up front. If the caller provides a
`docsDigestPath`, prefer that compact outline and pull individual files on
demand. See [`.agents/instructions.md` § 3](../../instructions.md).

**Write-time audit checklists.** When the caller provides a `checklistPath`
(footprint-matched **local**-lens authoring checklists), read it before you
write and self-check as you author. When absent, lens-aware coverage still
runs maker-blind at Story-scope review inside the close subprocess. The
dispatch step produces `checklistPath` from the Story's predicted footprint
before it spawns the worker (Story #4627) — see [`/deliver`](../deliver.md).

**Pre-eval full-suite discipline (spine step 5).** Repo-invariant guards —
drift-guard and schema tests living outside the Story's scoped greps — are
the failure class that actually bounces deliveries: close-validation
discovers them only after the whole close pipeline has run, at several times
the cost of one pre-eval full-suite run.

**Conflict with `main` mid-implementation** → resolve as you would any branch
rebase. There is no `epic/<id>` intermediate, so the rebase base is `main`
directly.

### Step 1a — self-eval mechanics

**One verdict-owner per cluster (Story #4723).** The ceremony routing's
resolved decision names each cluster's single verdict owner
(`verdictOwner: 'fresh-critic' | 'inline-self-eval'` from
`resolveCeremonyForRisk`): the fresh maker-blind critic when sensitivity
routes the cluster `fresh`, the contract-identical inline self-eval when it
routes `inline`. Exactly one pass authors the verdict — never both, and
never a preliminary self-assessment pass before dispatching the fresh
critic (the redundant pre-pass buys no measurable quality and roughly
triples the acceptance-block cost). `acceptance-eval.js` is the
deterministic **scorer** of that one authored verdict — schema validation,
round cap, proceed / redraft / block — not an independent additional pass
over the criteria. The M4-B floor holds: one verdict per cluster, the
cluster count owned by `acceptance-clusters.js` alone.

**Critic evidence-share (Story #4250).** When the critic runs a `verify[]`
command that is byte-identical to a close gate (`lint` / `typecheck`), it
records the pass into the Story evidence keyspace via `--standalone` so
close short-circuits the gate at unchanged HEAD. Run it in the **Story
worktree** (`workCwd` from Step 0):

```bash
node <main-repo>/.agents/scripts/evidence-gate.js \
  --standalone --scope-id <storyId> --gate lint \
  --worktree <workCwd> -- npm run lint
```

**On `decision: "block"`** — post a `friction` comment naming the unmet
criteria, then transition the Story to `agent::blocked`:

```bash
node .agents/scripts/diagnose-friction.js --story <storyId> \
  --cmd node .agents/scripts/acceptance-eval.js --story <storyId> --verdict <verdict-path>
node .agents/scripts/update-ticket-state.js --ticket <storyId> --state agent::blocked
```

---

## Step 2 — Ceremony detail

**Compute the change set once** (Story #4593) with the shared enumerator —
the same module close uses — and reuse that one list downstream:

```bash
node --input-type=module -e '
  import { computeChangeSet } from "<main-repo>/.agents/scripts/lib/orchestration/change-set.js";
  const { files } = computeChangeSet({ baseRef: "main", headRef: "story-<storyId>" });
  console.log(JSON.stringify(files));
'
```

Derive the level with
[`deriveChangeLevel`](../../scripts/lib/orchestration/review-depth.js) over
the one computed change-set list: a diff touching a sensitive path registered
in `.agents/schemas/audit-rules.json` derives `high`, one touching none
derives `low`, and an unenumerable diff (`files === null`) derives `null`.
Hand the **same** list to every acceptance critic you spawn (Step 1a) — a
critic that re-ran its own `git diff` could score against a different set
than the one that routed it.

Resolve fresh-vs-inline acceptance critics per AC-cluster with
[`resolveCeremonyForRisk`](../../scripts/lib/orchestration/ceremony-routing.js)
(`minimal` → always inline; `strict` → always fresh; `standard` →
`high`/`null` → `fresh`, `low` → `inline` unless the `freshCriticSampleRate`
floor forces `fresh`). Review depth reads the same derived level via
`review-depth.js` inside close, so the two decisions cannot disagree.

**Lite-route override (Story #4722).** When the Story's body derives the
lite shape (`resolveStoryDispatchMode` → `inline`), run every
acceptance critic **inline** — do not spawn fresh-context critic sub-agents
regardless of what the profile would otherwise resolve. The self-eval rigor
(scoring each `acceptance[]` item against the one computed change set, with
`verify[]` output as evidence) is unchanged; only the sub-agent boot is
removed. Hard gates are untouched.

---

## Step 3 — Merge wait, async mode, and flags

**What close does internally.** The script runs the close-validation gates
against `baseBranch`, syncs the Story branch from `origin/<baseBranch>`
(Story #2580 — the parallel-race defence), pushes `story-<id>`, opens (or
reuses) a PR against `baseBranch` with a `Closes #<storyId>` footer, enables
GitHub native auto-merge (`--auto --squash --delete-branch`) **when
`delivery.ci.autoMerge` is `"trust-ci"` (the default)**, flips the Story to
`agent::closing`, reaps the worktree, releases the lease, then **waits for
the merge** and — on a confirmed merge — flips `agent::done` and runs the
post-land tail.

**The merge wait is bounded and resumable.** Two budgets, deliberately
separate (`delivery.mergeWatch.*`):

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

**Async merge-confirm mode (`delivery.mergeWatch.mode: "async"`, Story #4698).** Under the default `"sync"` the merge wait runs in the foreground as
described above. When a consumer's CI routinely takes longer than the host
tool ceiling (~10 min) can hold a single close invocation, the foreground
wait almost always expires `pending` after burning ~5 minutes of the slot —
so `"async"` makes that async confirm a designed mode instead of an expiry
accident. In async mode the close arms auto-merge, runs one short **~60s
probe window** (long enough to catch an instant merge and, via the
head-anchored required-check predicate, an instantly-red required check),
then returns the standard `pending` terminal with a `nextCommand`. When you
receive that `pending` envelope, launch its `nextCommand`
(`single-story-confirm-merge.js … --wait`) as a **background** invocation —
host **background Bash** (`run_in_background`), whose completion re-invokes
the agent — and continue; do **not** sit in a foreground poll the tool
ceiling will kill. `single-story-confirm-merge.js` is already idempotent and
owns the whole tail, so no new state holder is needed, and
`deliver-recover.js` remains the recovery path for an orphaned confirm. The
cumulative `maxBudgetSeconds` give-up is unchanged; `"sync"` behaviour is
byte-compatible.

**`delivery.ci.autoMerge` policy.** Under the default `"trust-ci"`, GitHub
native auto-merge is armed and the PR squash-merges once its **required**
checks pass. Under `"strict"`, the close **does not arm auto-merge** — the
PR opens and waits for an **operator merge**, exactly as `--no-auto-merge`
does per-run.

**Close flags:**

- `--skip-validation` — bypass the gates. Use only when re-running close
  after a fixed gate failure that's already known to pass.
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

---

## Step 3 — Close pipeline detail

The `single-story-close.js` script, in order:

1. Runs the close-validation gates against `baseBranch` as the baseline.
   On any gate failure it throws — the operator fixes and re-runs close.
1a. **Syncs the Story branch from `origin/<baseBranch>`** before push
   (Story #2580). Runs `git fetch origin <baseBranch>` followed by
   `git merge --no-edit origin/<baseBranch>` inside the worktree. This
   defends against the parallel-`/deliver-story` race: when
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
     `/deliver-story`.
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
   `agent::done` flip (which closes the issue) is deferred to Step 5's
   merge confirmation — `single-story-confirm-merge.js` on a
   `--no-wait-merge` run, or the in-close confirm phase on the
   close-and-land default. (Step 5.5 is the Status-column resync.) A Story
   only reaches `agent::done` once its PR to `main` is confirmed merged.
5. Reaps the worktree when `delivery.worktreeIsolation.reapOnSuccess`
   is enabled.
6. **Releases the Story lease** (Story #3483). Clears the Story assignment
   that init claimed so the next `/deliver-story` run sees an
   unclaimed ticket. The release is a no-op when the operator no longer
   holds the claim (a later run took over via reclaim/steal), so a late
   close never yanks a live claim away from its current owner. Best-effort:
   a release failure is logged but does not fail an otherwise-clean close.
   Note the lease does **not** expire on its own: the standalone lease is
   fail-closed by design (it anchors its heartbeat to now, so a foreign
   claim always reads as live regardless of the configured TTL), so a
   claim stranded by a failed release is cleared only by `--steal` or by
   de-assigning the ticket. The close result carries
   `leaseReleased: <boolean>`.

`--skip-validation` bypasses Step 1 (gates). Use only when re-running
close after a fixed gate failure that's already known to pass.

`--skip-sync` bypasses Step 1a (base-sync). Use only when re-running
close after a hand-resolved sync, or in tests.

`--no-auto-merge` disables Step 3a. Use when the PR materially changes
behaviour and warrants pre-merge review.

---

## Step 4 — CI watch + fix recovery

Enter this step **only** when Step 3 returned `blocked` with
`blockClass: "checks-failed"` (a required check went red), or when a
`--no-wait-merge` run left the PR for you to shepherd. When a required check is
red, the agent owns the green-CI outcome, not just the push: local
close-validation gates pass on the dev host's environment; CI runs on a
different OS and concurrency, and coverage rounding, platform-conditional
branches, and timing-sensitive tests routinely drift between the two.

Fix the failure and push a new commit on `story-<storyId>` — auto-merge stays
armed across retries, so you do not re-arm — then resume the land with the
envelope's `nextCommand`.

To watch the checks on the red path, drive `pr-watch-with-update.js` — the
**single CI-watch mechanism** (Story #4358). It polls the required checks to a
terminal state and auto-recovers from `mergeStateStatus: BEHIND`; do **not**
fall back to a bare `gh pr checks` watch invocation:

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber> --story <storyId>
```

`--story` is what keys the red-path CI digest
(`temp/story-<id>-ci-digest.{json,md}` — failing check name, run id, and a
`gh run view --log-failed` tail). Omit it and a red check writes no digest.
Poll cadence and caps come from `delivery.ci.watch.*` (`pollIntervalMs`,
`maxPolls`, `maxResumes`); pass `--poll-interval-ms`, `--max-polls`, or
`--max-resumes` to override for one run.

When the watch exits, branch on the exit code:

- **Exit 0 (all checks ✓)** — auto-merge will fire (or has already). The Story
  is still at `agent::closing` with its issue OPEN. **Proceed to merge
  confirmation (§ Step 5) within the same turn** — green CI is the *start* of
  the merge-confirm sequence, not a terminal state.
- **Exit 1 (a check genuinely failed)** — diagnose, fix, and push a new commit
  on `story-<storyId>`, then re-watch. Auto-merge stays enabled across retries;
  no need to re-arm it. The Story stays at `agent::closing` throughout, so a
  failed/abandoned PR never strands a CLOSED issue. If the same failure class
  recurs, hand convergence off to a self-paced host loop (`/loop`) that re-runs
  the failing check and applies the smallest fix until it exits green.
- **Exit 2 (still-running — slow CI, not red)** — the poll cap fired with checks
  still pending and the watcher exhausted its resume budget with nothing red.
  This is **never** a failure. Hand the wait off to the host's interval loop
  rather than ending your turn: `/loop 5m` polling `gh pr checks` until the
  checks settle.

**Triage authority.** How to classify and remediate a red (or repeatedly slow)
check — the root-cause-only decision tree for infra/transient and flaky failures
(reproduce → check `main` → bisect env vs code → fix in-scope or file a
`meta::framework-gap` issue), the never-rerun / never-quarantine prohibitions,
and the escalation criteria (three-strikes, the 30-minute wall-clock timebox,
and the clearly-environmental fast path) — is defined once in
[`.agents/rules/ci-remediation.md`](../../rules/ci-remediation.md). Read it
before remediating a red check.

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

> On the default path Step 3 already did this. Run it only to resume a
> `pending` envelope, to finish a `--no-wait-merge` run, or to rescue a
> merged-but-mislabelled Story.

```bash
node .agents/scripts/single-story-confirm-merge.js --story <storyId> --cwd <main-repo>
```

This is the **same** shared land path Step 3 reaches: it flips
`agent::closing → agent::done` on a confirmed merge (closing the issue) and runs
the **same** post-land tail — so the two surfaces cannot diverge. It is
idempotent, emits the same terminal envelope, and is safe to re-run while the PR
is still open (returns `pending`).

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

The issue closes exactly when the work has merged, never at PR-open
(#2155).

---

## Step 5.5 — Re-assert Status column detail

> **The land tail already ran this** (Story #4543) — it is `tail.statusResync`
> in the terminal envelope. Run it by hand only when that step reported
> `false`, or after a manual merge on a `--no-wait-merge` run.

```bash
node .agents/scripts/resync-status-column.js --story <storyId>
```

The helper re-fires the `ColumnSync` mutation and **polls for ~15 s** to win the
race against the bot's late write (Story #2876). It is idempotent and
no-op-safe (`no-project` / `not-on-project` exit 0).

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

> **The land tail already ran this** (Story #4543) — it is `tail.refCleanup` and
> `tail.baseFastForward` in the terminal envelope, done in-process against the
> same planners this command drives. Run it by hand only when either step
> reported `false` (a dirty shared checkout is the common, benign cause), or
> after a manual merge on a `--no-wait-merge` run. To prune the story ref **and**
> fast-forward local `main` (or `project.baseBranch`):

```bash
node .agents/scripts/git-cleanup.js \
  --execute \
  --remote \
  --yes \
  --fast-forward-main \
  --branches \
  --include "story-<storyId>"
```

`--fast-forward-main` brings local `main` current (the next init seeds from it),
`--branches` + `--include` reap only this Story's ref, and
`--execute --remote --yes` run the deletes non-interactively. The sweep is
idempotent and safe to run before `MERGED` confirms. Skip it only when the
operator opted out via `--no-auto-merge` AND has not yet merged the PR — run the
cleanup after the manual merge lands.

GitHub deletes the **remote** branch on auto-merge (via the
`--delete-branch` flag `single-story-close.js` passes to `gh pr merge`).
The **local** `story-<storyId>` ref, however, lingers in the main
checkout until something prunes it — `single-story-init.js` runs a
merged-sweep at the start of every *subsequent* `/deliver-story`
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

The field-level contract is the shipped schema
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
(Story #4543) — not this file, and not
[`agents/story-worker.md`](../../agents/story-worker.md). All three used to
carry their own prose version; the schema is now the only definition. What
follows is the *judgement* around it, which a schema cannot express.

### `pending` is a real status — and it is not a park

`pending` is a real terminal status with its own exit code (3) — the honest
name for a close-and-land whose CI outlived the host's ~10-minute
tool-invocation ceiling, which would otherwise park the Story at
`agent::closing` with no event and no label:

- It is **resumable**: no label was mutated, no `merge.unlanded` was emitted,
  and `nextCommand` names the one command that continues it. The cumulative
  budget is anchored at the PR's `createdAt`, so resuming does not restart the
  clock and the give-up bound still means something.
- It is **not** a park. Returning `pending` because you would rather not wait
  is the Story #1553 / PR #1554 failure mode wearing a schema. Return it only
  when the bound genuinely expired, or a human owns the merge.

The no-park rule holds: a turn that ends with prose ("I'll wait for the watch
task…", "the next event will be its completion notification…") and an
unconfirmed merge is a **contract violation** — the parent cannot distinguish
"still working" from "done but silent". `pending` is the honest,
machine-readable alternative: "not finished, here is exactly how to continue."

### Exit-code compatibility note (`--no-wait-merge`)

Every close flag keeps its meaning, but the **exit code** of a
`--no-wait-merge` (or `--no-auto-merge` / `autoMerge: "strict"`) run changed:
it now exits **3** (`pending`) rather than 0, because the PR is open and a
human still owns the merge. Reporting `landed` would be a lie, and `landed` is
what exit 0 means. A wrapper that shells out and tests `exit == 0` to mean
"close finished" must be updated to treat 3 as the operator-merge success
path; `!= 0` no longer implies failure.

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
> `single-story-close.js` already emits). Do not narrate the
> steps you took, and do not prescribe how the next stage should work. Prose
> process commentary only bloats the hydrated prompt. When run **interactively** (no parent
> aggregator), this JSON envelope is optional — relay terminal state to the
> operator in prose instead — but the **no-park rule still holds**: never end
> an interactive turn with an unconfirmed merge either; block on the watch,
> confirm, and report the merged outcome.
