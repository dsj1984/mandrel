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

### Lease preflight

Before any git mutation, init takes an exclusive, time-bounded **lease** on
the Story ticket via the assignee-as-lease primitive
(`lib/orchestration/ticket-lease.js`). The single assignee _is_ the lease
owner (resolved from `github.operatorHandle`). The standalone path has no
Epic-scoped dispatch manifest to serialise two operators driving the same
Story, so this lease is the only guard against a concurrent
`single-story-init` clobbering an in-flight run.

**Fail-closed.** Unlike `/mandrel-deliver`, the standalone path
has **no Epic-scoped lifecycle ledger** to read a per-owner
`story.heartbeat` from, so there is no live-heartbeat source to decide
whether a foreign claim is stale. Rather than silently reclaim every
foreign assignee (which would leave the guard inert), the standalone lease
**fails closed**: a foreign assignee is treated as a _live_ claim. Outcomes:

- **Unclaimed / self-held** → init proceeds (a self-held claim is
  re-affirmed without re-writing assignees).
- **Any foreign assignee** → init **exits non-zero** with a message naming
  the current owner. Coordinate with that operator, or pass **`--steal`** to
  forcibly transfer the claim once you have confirmed the other run is dead.

`--dry-run` skips the lease (no assignee mutation). The matching release
runs in `single-story-close.js` (Step 3).

### Branch reuse

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

The sweep applies two hardening layers:

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
runs a **wrong-tree guard** that aborts close and posts a
`friction` comment if it finds uncommitted tracked-path edits in the main
checkout while the worktree is the active work tree — but that is a backstop,
not a substitute for prefixing paths correctly.

---

## Engine invariants and the lite route

**Prerequisites before Step 0.** A `type::story` issue, a clean
`gh auth status`, and `project.baseBranch` present both locally and on
`origin` — init seeds the Story branch from the base branch and probes the
remote, so a missing or unauthenticated remote surfaces as a
`remoteVerified: false` block rather than a useful error.

The v2 engine's trait table:

| Trait         | v2 `/deliver-story`                                                      |
| ------------- | ------------------------------------------------------------------------ |
| Ticket type   | `type::story` only                                                       |
| Branch        | `story-<id>` seeded from `project.baseBranch` (`main`)                   |
| Merge target  | `main` via PR (squash + required checks)                                 |
| Spec / slices | Folded `## Spec` + optional `## Slicing` checkpoints in-session          |
| Ceremony      | Per-Story, routed off the derived change level via `ceremony-routing.js` |

**Ceremony-lite Stories still land through this engine unchanged.** A
lite-routed Story collapses only the _advisory_ plan/mandrel-deliver
ceremony — the fresh-critic / Tech-Spec authoring a one-artifact scope does
not earn. It does **not** get a cheaper landing: the close-validation gates
(lint / test / format / coverage / CRAP / maintainability), the PR to `main`,
and the `rules/security-baseline.md` MUSTs all run exactly as for a
full-ceremony Story. The lite route's `preserves` field is the machine-readable
record of those non-negotiables; there is no lite-specific gate bypass.

**Ceremony comes from the landed diff; the dispatch mode comes from the
run.** Persist stamps no route label (Story #5312 retired the plan-side lite
claim with its `route::lite` hint). Ceremony is resolved from the **derived
change level** (`deriveChangeLevel` over the computed change set — digest § 3),
not from a body-shape read: a footprint intersecting a sensitive-path class
derives `high`, so the Story keeps its fresh acceptance critic. The light path
is the one caller that reads the authored body's shape, through
`deriveStoryShape` (`lib/orchestration/complexity-gate.js`).

That derived level sets ceremony. It does **not** set the dispatch mode,
because `inline` names one indivisible resource — the router's own session —
and only run topology can say whether it is free: a **single-Story run**
executes inline, and every Story of a multi-Story run dispatches as a
`story-worker` sub-agent whatever its shape — a lite shape makes the work
cheap, it does not conjure a second session for a sibling. Inline
execution changes the isolation only: the engine, every script gate, and the
terminal envelope are byte-identical either way.

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

Prose elsewhere in the body declares **nothing**, and this is a deliberate,
user-visible change from the whole-body scan that preceded it. A sentence
merely mentioning a blocker — an example, a changelog note, an acceptance
criterion quoting the phrase — used to mint a real dispatch gate that withheld
the Story until an unrelated issue closed. `plan-persist` has always
serialized the canonical footer form, so no machine-authored body is affected;
only a **hand-written prose edge** stops gating, and the fix is to move it into
the footer block. The loose spellings never reached the footer grammar either:
`depends on #N`, `Blocked by: #N`, and `blocked by #N once X lands` all declare
nothing. One grammar serves both readers — the body parser and the
dispatch-edge parser share it — so what a Story body round-trips and what gates
dispatch cannot drift apart.

**The native channel fails loud.** The read paginates to exhaustion (a
first-page read silently truncated a Story's gates at GitHub's 30-item
default), and **a 404 is not an empty result**. An issue with no dependencies
answers `200 []`; a 404 is how GitHub also answers a token that cannot see the
dependencies API, so treating it as "no edges" erased every native edge in the
run under a mis-scoped token, silently, with a clean exit code. Any non-OK
read now fails the resolution naming the Story — check the token's scopes
first. The one degrade that is scoped rather than fatal is a **cross-repo
edge**: another repository's issue number cannot be matched against this
repo's same-numbered issue without risking a false match, so that edge is
dropped with a warning naming the Story, and its siblings resolve normally.

**Edges are monotone — retraction is not built.** Both channels only ever
_add_ a gate for the current resolution. Removing a `blocked by` footer line
or deleting a native relation makes the edge absent from the **next** resolve,
but nothing reconciles an edge that a previous run already acted on, and the
write path never deletes a native relation it did not need. In practice that
means: re-resolve after editing edges, and treat a stale gate as a body/issue
edit plus a fresh `resolve-stories.js` run, never as something delivery
un-declares on your behalf. This is a known limitation, not an oversight.

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
before it spawns the worker — see [`/mandrel-deliver`](../mandrel-deliver.md).

**Full-suite discipline (spine Step 2.5).** Repo-invariant guards —
drift-guard and schema tests living outside the Story's scoped greps — are
the failure class that actually bounces deliveries: close-validation
discovers them only after the whole close pipeline has run, at several times
the cost of one full-suite run in the worktree.

**Run it once, last, so close can credit it.** The run belongs **after** the
self-eval loop's last fix commit and **after** the hand-off push — the credit
is keyed on the tree, not on push state, so pushing first keeps the stamp and
buys the ordering Step 2.5 needs (the capture is backgrounded, and its
completion ends the turn); redraft rounds run scoped tests. Close skips a gate that already passed at the current HEAD, but a bare
`npm test` deposits no such record — the suite then runs twice per delivery,
once here and once in the close gate chain. Pick the invocation by the same
predicate `close-validation/gates.js` uses to choose its test gate:

```bash
# CRAP gate enabled (default) + a `test:coverage` script — writes the stamp
# the close `coverage-capture` gate reads:
node <main-repo>/.agents/scripts/coverage-capture.js --cwd <workCwd>
# otherwise — the evidence record the close `test` gate reads. <workCwd> must
# be ABSOLUTE and the runner exactly `npm test`: both sides hash
# {cmd, args, cwd}, so a relative path or a wrapper misses the credit.
node <main-repo>/.agents/scripts/evidence-gate.js --standalone \
  --scope-id <storyId> --gate test --worktree <workCwd> -- npm test
```

The credit expires the moment it stops describing the tree: evidence is keyed
on HEAD, the capture stamp on a content digest of `crap.targetDirs`. A
self-eval fix — or any commit — invalidates it and close re-runs the suite for
real, so this never trades away the gate. That keying is exactly why the run
comes last, and why the push before it is free. Close's own base-sync can
spend the stamp too when it lands base commits; it now says so out loud rather
than silently re-running the suite.

**`verify[]` reuses the same stamp.** A `verify[]` entry that is itself a
full-suite command is reported **credited** against that stamp rather than
respawned (`resolveVerifyCredit` in
[`verify-credit.js`](../../scripts/lib/orchestration/verify-credit.js)), and the
self-eval gate warns when it sees one: the intended shape is scoped `verify[]`
entries **plus** the single credited run.

**Conflict with `main` mid-implementation** → resolve as you would any branch
rebase. There is no `epic/<id>` intermediate, so the rebase base is `main`
directly.

### Step 1a — self-eval mechanics

**One verdict-owner per cluster.** The ceremony routing's
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
over the criteria. The M4-B floor holds: one verdict per cluster, with the
cluster count owned by the dispatching caller and never by routing.

**One round = N cluster critics → ONE merged verdict → ONE gate call.** The
clusters are how a round is _authored_; they are not how it is _scored_.
Concatenate every cluster's records into a single `criteria[]` ordered by
`index` — exactly one per `acceptance[]` item, under one `storyId`,
`schemaVersion`, `round` and `commitSha` — and hand that merged file to the
gate once, with `--expected-criteria` set to the Story's `acceptance[]` count:

```bash
node <main-repo>/.agents/scripts/acceptance-eval.js \
  --story <storyId> --verdict <merged-verdict-path> \
  --expected-criteria <acceptance[] count>
```

The flag is what makes the merge enforceable: `assertCriteriaCoverage` returns
early on the `null` default, so **omitting it leaves the guard inert** and a
single cluster's verdict handed over unmerged scores a fraction of the criteria
and still reports `proceed`. A length mismatch is rejected before scoring and
consumes no round. Calling the gate once per cluster instead spends a round
_per cluster_ — a Story past the cluster ceiling would burn its whole redraft
budget on cluster arithmetic — and N concurrent calls race the Story-scoped
round ledger. Full per-round mechanics, including the parallel dispatch and the
merge shape: [`acceptance-self-eval.md`](acceptance-self-eval.md).

**Critic evidence-share.** When the critic runs a `verify[]`
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

**Compute the change set once** with the shared enumerator —
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

**Inline-dispatch override.** When the Story dispatches
`inline` (`resolveStoryDispatchMode` → `inline`, which is exactly a
single-Story run — the function reads the resolved set size and nothing
else), run
every acceptance critic **inline** — do not spawn fresh-context critic
sub-agents regardless of what the profile would otherwise resolve. The self-eval rigor
(scoring each `acceptance[]` item against the one computed change set, with
`verify[]` output as evidence) is unchanged; only the sub-agent boot is
removed. Hard gates are untouched.

---

## Step 3 — Merge wait, async mode, and flags

**Step 3 is the orchestrator's, and it is serialized.** A dispatched
`story-worker` ends its turn at a pushed branch (spine § Step 2.5); the session
that dispatched it runs close. Two reasons, both measured rather than
theoretical:

1. **A sub-agent cannot resume itself.** It gets no notification when a
   backgrounded close finishes, so a worker that backgrounds close and ends its
   turn strands the envelope in a turn nobody reads — three of five workers in
   one measured wave did exactly that despite an explicit foreground-close
   instruction. Moving the seam removes the failure instead of re-wording the
   prohibition. The parent, by contrast, is still live and _does_ observe and
   retry its own close.
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

**What close does internally.** The script runs the close-validation gates
against `baseBranch`, syncs the Story branch from `origin/<baseBranch>`
(the parallel-race defence), pushes `story-<id>`, opens (or
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
  clock. Exhausting _this_ is the genuine give-up → `blocked`.

The wait probes the checks every poll: a red required check fails fast as
`checks-failed` instead of burning the budget, and a PR that falls behind its
base is brought up to date within `updateAttempts` tries.

**Async merge-confirm mode (`delivery.mergeWatch.mode: "async"`).** Under
the default `"sync"` the merge wait runs in the foreground as described above.

**On a multi-Story run, async is the posture — pass `--merge-watch-mode async`
on every close.** This is not a slow-CI opt-in. Implementation fans out, but
the close tail is serialized one Story at a time, and under `sync` each close
holds the foreground for its full merge wait before the next may start; that
is the run's dominant serialized cost, paid once per sibling. Close sees one
Story and cannot see run topology, so the orchestrator — which can — makes the
call per invocation while the config default stays `"sync"`, which is right for
a solo delivery with no sibling waiting behind it
([`deliver-reference.md`](deliver-reference.md) § Async merge-confirm mode).
A slow-CI consumer reaches for the same mode for the separate reason that a
foreground wait longer than the host tool ceiling (~10 min) almost always
expires `pending` after burning ~5 minutes of the slot — `"async"` makes that
confirm a designed ending instead of an expiry accident.

In async mode the close arms auto-merge, runs one short **~60s
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
  `--max-wait-seconds` — pass both and the explicit bound still wins over the
  async probe cap. An unrecognized value is refused before any phase runs, so a
  typo cannot silently drop the run back onto synchronous waiting; the refusal
  reports a `failed` terminal envelope at `phase: init`, mutating nothing.

---

## Step 3 — Close pipeline detail

The `single-story-close.js` script, in order:

1. **Syncs the Story branch from `origin/<baseBranch>`** — before the gates,
   not after them. Runs `git fetch origin <baseBranch>` followed
   by `git merge --no-edit origin/<baseBranch>` inside the worktree. This
   defends against the parallel-`/deliver-story` race: when
   multiple sessions run in parallel, the Story that auto-merges first
   bumps `baseBranch`, and without this sync the lagging Stories open
   PRs that are "behind base" and stall against branch-protection's
   `up-to-date branch` rule. Running it first also means a conflict costs
   no gate run at all, and — the load-bearing half — the tree the gates
   validate is the tree the push sends. Outcomes:
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

2. Runs the close-validation gates against `baseBranch` as the baseline.
   On any gate failure it throws — the operator fixes and re-runs close.
   The chain fails cheapest-first: `typecheck`, `lint`, `format` and the
   coverage-independent half of the baselines gate
   (`check-baselines-independent`) run in parallel, and only once they are
   green does the serial walk pay for `coverage-capture` and the
   coverage-consuming half (`check-baselines-coverage`).
   **Gate output is captured, not streamed.** Every gate line
   goes to `temp/orchestration/close-gates-<storyId>.log`; a clean run reports
   one digest line naming that artifact, and a **failed** gate replays its
   captured tail inline so the evidence is in front of you without opening a
   file. Read the artifact when you need the full text — or re-run under
   `AGENT_LOG_LEVEL=verbose` for live streaming.

3. Pushes `story-<id>` to `origin`.
4. Probes for an existing open PR with `head = story-<id>`. If none
   exists, opens one via `gh pr create --base <baseBranch>`. The PR
   body carries `Closes #<storyId>` so the GitHub merge auto-closes the
   issue.
   4a. **Enables GitHub native auto-merge by default** via
   `gh pr merge <prNumber> --auto --squash --delete-branch`. Once CI's
   required checks turn green, GitHub squash-merges the PR and deletes
   the source branch — the operator does not need to babysit the merge
   button. Mirrors the `/mandrel-deliver` finalize path. Failure is
   non-fatal: the operator retains the manual merge surface in the
   GitHub UI. Pass `--no-auto-merge` to opt out when the PR needs a
   pre-merge eyeball.
5. Flips the Story to **`agent::closing`** (NOT `agent::done`) and leaves
   the GitHub issue **OPEN**. Auto-merge completes
   asynchronously _after_ this script exits, so closing the issue here
   would strand a CLOSED issue with no merged work if the PR later failed
   CI, went `BEHIND` base, or was closed without merging. The Story rests
   at `agent::closing` while the PR is open with auto-merge armed; the
   `agent::done` flip (which closes the issue) is deferred to Step 5's
   merge confirmation — `single-story-confirm-merge.js` on a
   `--no-wait-merge` run, or the in-close confirm phase on the
   close-and-land default. (Step 5.5 is the Status-column resync.) A Story
   only reaches `agent::done` once its PR to `main` is confirmed merged.
6. Reaps the worktree when `delivery.worktreeIsolation.reapOnSuccess`
   is enabled.
7. **Releases the Story lease.** Clears the Story assignment
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

`--skip-validation` bypasses the gate step. Use only when re-running
close after a fixed gate failure that's already known to pass.

`--skip-sync` bypasses the base-sync step. Use only when re-running
close after a hand-resolved sync, or in tests. The two flags are
independent: either, both or neither may be set, and each elides exactly
its own phase.

`--no-auto-merge` disables the auto-merge arm (step 4a). Use when the PR materially changes
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
adjudicate the next green against, so always pass it.
Poll cadence and caps come from `delivery.ci.watch.*` (`pollIntervalMs`,
`maxPolls`, `maxResumes`, `attachWindowMs`); pass `--poll-interval-ms`,
`--max-polls`, `--max-resumes`, or `--attach-window-ms` to override for one run.
`attachWindowMs` (default 20 min) is how long the watch keeps re-resolving an
**empty** required-check set before it stops waiting for a context to attach —
a required context that is an aggregator job gated on every other tier is the
last check to appear, measured at 16m52s on this repository.

Add `--repo owner/repo` only when the cwd is not the target repository; it
reaches `gh` as a real flag. There is no `<owner/repo>#<number>` ref form —
`gh` parses that as a branch name.

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
    (or raising `attachWindowMs`) is the whole remediation.
  - **unresolved** (`reconciliation.reconciled: false`) — every observed
    required check is green but the repository still refuses the merge, so the
    green verdict is withheld.

**Triage authority.** How to classify and remediate a red (or repeatedly slow)
check — the root-cause-only decision tree for infra/transient and flaky failures
(reproduce → check `main` → bisect env vs code → fix in-scope, or reach an
Option-2 verdict and file the intake issue), the never-rerun / never-quarantine
prohibitions, and the escalation criteria (three-strikes, the 30-minute
wall-clock timebox, and the clearly-environmental fast path) — is defined once in
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

This is the single most important contract of this workflow, and the seam
where a worker most often misbehaves: it delivers up to arming auto-merge,
then ends its turn with **free-form prose** — e.g. "I'll wait for the
background watch task to complete" or "the next event will be its completion
notification" — leaving the merge unconfirmed and the Story stranded at
`agent::closing`. **Do not do this.**
`pr-watch-with-update.js --pr <prNumber>` _blocks the current turn_ until CI
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

The issue closes exactly when the work has merged, never at PR-open.

---

## Step 5.5 — Re-assert Status column detail

> **The land tail already ran this** — it is `tail.statusResync`
> in the terminal envelope. Run it by hand only when that step reported
> `false`, or after a manual merge on a `--no-wait-merge` run.

```bash
node .agents/scripts/resync-status-column.js --story <storyId>
```

The helper re-fires the `ColumnSync` mutation and **polls for ~15 s** to win the
race against the bot's late write. It is idempotent and
no-op-safe (`no-project` / `not-on-project` exit 0).

The GitHub Projects v2 built-in workflows `Pull request merged` and
`Pull request linked to issue` are enabled by default on most boards
and fire ~minutes _after_ auto-merge lands. They overwrite the Status
field as a side-effect, clobbering the `Done` value
`single-story-confirm-merge.js` set at the `agent::done` flip in Step 5
and leaving closed Stories stuck at `In Progress` on the board. The
confirmation step has already exited by then, so the bot gets the last
write.

`resync-status-column.js`:

- Reads the ticket's current `agent::*` label set (now `agent::done`).
- Re-fires the same `ColumnSync` mutation `transitionTicketState` used
  at close, overwriting the bot's late write.
- **Polls the live Status for ~15 s after the initial write** and
  re-fires on drift. Without this loop, a one-shot
  mutation routinely lost the race against the bot's asynchronous
  fire.
- Prints a single-line JSON envelope:
  `{ ticketId, status, column?, reason?, attempts? }`. `attempts > 1`
  means the helper had to fight a bot overwrite; `status: 'drifted'`
  means the bot won every attempt in the poll budget (rare; usually
  signals operator should reap the conflicting workflows).

Tuning flags are rarely needed; the script enumerates them itself
(`node .agents/scripts/resync-status-column.js --help`).

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

> **The land tail already ran this** — it is `tail.refCleanup` and
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
merged-sweep at the start of every _subsequent_ `/deliver-story`
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
- **Always prefix path-based tools with the absolute `workCwd` root.** `cd`
  scopes Bash, not Edit/Write/Read; close's wrong-tree guard is a backstop for
  the mistake, not a licence to make it.
- **Report state, not process.** Mirror the close envelope's fields; step
  narration reads as progress while telling the caller nothing it can branch on.
- **Drive every `agent::*` transition through `update-ticket-state.js`** so the
  label, the Projects Status column and the lifecycle event stay in one motion.

## Step 7 — Return-contract detail

The field-level contract is the shipped schema
[`story-deliver-terminal.schema.json`](../../schemas/story-deliver-terminal.schema.json)
— not this file, and not
[`agents/story-worker.md`](../../agents/story-worker.md). All three used to
carry their own prose version; the schema is now the only definition. What
follows is the _judgement_ around it, which a schema cannot express.

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
  is the no-park failure mode wearing a schema. Return it only
  when the bound genuinely expired, or a human owns the merge.

The no-park rule holds: a turn that ends with prose ("I'll wait for the watch
task…", "the next event will be its completion notification…") and an
unconfirmed merge is a **contract violation** — the parent cannot distinguish
"still working" from "done but silent". `pending` is the honest,
machine-readable alternative: "not finished, here is exactly how to continue."

### The envelope also lands on disk

Stdout has exactly one reader — the turn that launched the close — and that
reader is not always still listening. A child that reports progress and ends
its turn while its close is mid-gate-chain is behaving reasonably, but the
envelope it never relayed is gone, and reconstructing the Story's state from
labels costs a recovery round trip plus a full resume of the child. Observed
four times across three workers in a single consumer run, on unrelated
footprints, and not new to that run.

So `emitTerminalEnvelope` — the one writer behind every emit site — also
persists the validated envelope to
`<tempRoot>/orchestration/story-deliver-terminal-<storyId>.json`:

- **It is the same object**, not a summary. Read it and branch exactly as you
  would on stdout; the copy is written before the markers are, so a caller
  that saw them can rely on the file.
- **It is best-effort.** A failed write returns null and changes nothing about
  the emitted envelope or the exit code — a landed PR must never become a
  crash because a temp directory was unwritable.
- **It is a fallback, not a licence.** The orchestrator running close still
  holds its turn until the envelope arrives; see § Step 3 above and
  [`agents/story-worker.md`](../../agents/story-worker.md).

`deliver-recover.js` reads the same artifact, plus the freshness of
`close-gates-<storyId>.log`, to split the one genuinely ambiguous row of its
table. `agent::executing` with no PR used to answer "Implementation never
finished" — false for the whole duration of a close, whose gates and push
happen before any PR exists, and actively hazardous, because acting on its
re-init suggestion can put a second close on one PR. It now answers
`close-in-flight` (a gate log touched inside the window: wait, then re-probe)
or `close-envelope-on-disk` (the close already reached a verdict: relay it),
and falls back to the original verdict only when neither artifact exists.

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
