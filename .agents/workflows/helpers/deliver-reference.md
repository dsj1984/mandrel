---
description:
  On-demand reference appendix for /mandrel-deliver — the sequencing edge cases,
  role-scoped dispatch mechanics, lite-route inline execution, checklist
  threading, and the per-run epilogue. Read it when the matching lever is in
  play; the lean spine in deliver.md links here.
---

# /mandrel-deliver — reference appendix (on-demand)

Reference-only detail split out of [`mandrel-deliver.md`](../mandrel-deliver.md).
Nothing here is a new MUST — it is the mechanics an operator consults when the
matching lever is engaged.

## Ranges (`4922 - 4926`) {#ranges}

A contiguous span is a first-class id shape — `/mandrel-deliver 4922 - 4926`
means exactly the five ids in it.

**Pass the span through; never expand it by hand.** Every id-list flag on the
delivery path takes range tokens — `resolve-stories.js --ids`,
`deliver-run.js --stories` and `--handoff`, and
`plan-run-epilogue.js --stories`. Normalize the operator's spacing away and hand
the scripts one unspaced token (`--ids 4922-4926`), mixed freely with singles
and commas (`--ids 4901,4922-4926`); overlaps dedupe. A hand-typed enumeration
is where an id gets dropped or invented, and the drop is silent.

The shared expander (`lib/util/parse-id-list.js`) refuses rather than guesses:

| Input | Outcome |
| --- | --- |
| `4922-4926`, `4922 - 4926` | Expands to the inclusive span. En and em dashes, and a `#` on either endpoint, are accepted too. |
| `4926-4922` | Refused — write it low-to-high. |
| `1-4926` | Refused — above the 50-id span cap (`MAX_RANGE_SPAN`). |
| `4922-`, `-4926`, `4922-4923-4924` | Refused as a malformed token. |

The cap is per range token, not per run: a 60-Story delivery is still two
ranges.

## Sequencing edge cases (`deliver-run.js` over `stories-wave-tick.js`)

**What "discovered, not declared" means concretely.** `resolve-stories.js` reads
the graph from live state as the union of the Story bodies' `depends_on` edges
and GitHub's native `blocked_by` edges, resolving each blocker against its real
issue state. That is why there is no batch label to pass and why a blocker that
landed in an unrelated run is simply seen as done.

**A Story with no `agent::*` label is refused.** The audit sweep files Stories
deliberately without one — their bodies are audit prose, not a scoped change
with verifiable acceptance criteria. Route it through `/mandrel-plan` first,
which applies `agent::ready` at the end of planning. `--allow-unlabelled` is
the deliberate escape hatch.

**Inspecting a beat without taking one.** `deliver-run.js` writes — the ledger,
the prompts. The tick underneath it is read-only and answers "what *would* the
next beat do?":

```bash
node .agents/scripts/stories-wave-tick.js --stories <id,id,...> --probe-live
```

Its envelope is the beat's scheduling half verbatim — `ready`, `inFlight`,
`inFlightReservation`, `footprintGuard`, `foreignHeld`, `wedged`. Read it when
a slot is unfilled and you want to know why before acting. Do **not** drive a
run from it: without the ledger the init window reopens, and the same Story is
handed out twice.

**The non-zero exit codes.** **2** — `cycleError`: the graph is
self-referential; fix `depends_on`, do not retry. **3** — `wedged`: nothing
dispatchable and nothing in flight, with the undone Stories and their unmet
blockers named; land a blocker or add it to `--ids`. **4** — `blocked`: a Story
carries `agent::blocked` with `blockedReason`, the protocol's HITL pause
([`instructions.md` § 1.J](../../instructions.md)). Blocked outranks a wedge,
but not a cycle.

**Resuming an exit-4 `blocked`.** Read the friction comment with
`gh issue view <id> --comments`, and resume only once the operator has
unblocked it:
`node .agents/scripts/update-ticket-state.js --ticket <id> --state agent::ready`.
Do not poll the label yourself while waiting — the HITL pause is the operator's
turn, not a slow beat. Before resuming, the operator raises session effort one
step, and raises effort before switching models
([effort escalation](../../docs/execution-reference.md#session-effort-and-model)).

Each beat re-probes live state: it re-resolves the graph, classifies **done**
(`agent::done` or a closed issue — including foreign blockers that landed in
another run), and derives **in-flight** from live `agent::executing` /
`agent::closing` labels. You never compute `done` or `in-flight`.

**The run ledger closes the init window, and you maintain nothing.** Until
`single-story-init.js` publishes `agent::executing`, a just-dispatched Story
still reads `agent::ready`, and an unaugmented beat would hand it out again.
`deliver-run.js` records every id it hands out in
`<tempRoot>/run-<id>/ledger.json` and seeds the next beat with it. The ledger
is additive, not authoritative — the probe unions it into the label-derived set
and filters it against live state, so an id that has gone `agent::done` drops
out. A missing or corrupt ledger costs one extra beat of the init window, never
the run. The run id is a stable digest of the Story id set, so every beat of
one run finds the same ledger; `--run-id` pins it explicitly.

**A spawn that never reached init is the ledger's one sharp edge.** If a spawn
dies before `single-story-init.js` runs, the id stays ledgered and is withheld
as in flight on every later beat — an empty `ready[]` with a non-zero
`inFlight` that reads like a healthy wait. The beat names it: every ledgered id
live state still reports as `agent::ready` appears in `stalledDispatch[]`, with
the recovery in `stalledDispatchReason` — its **own** reason, not a footprint
withhold and not a foreign lease.

It is a report, not a release: a slow init and a dead spawn look identical, and
auto-releasing would re-dispatch a live Story onto its own branch. So the
operator owns the call: confirm no worker is running, remove the id from
`dispatched` in `<tempRoot>/run-<id>/ledger.json` (deleting the file works too,
at the cost of reopening the init window for the rest), and beat again with
`--run-id <id>` so the same run directory is reused.

**Cross-run de-confliction is automatic.** A Story another
operator is delivering is withheld without any bookkeeping from you: the probe
reads the Story's assignee lease and, when it belongs to a different operator,
withholds the Story and reports it in the envelope's
`foreignHeld: [{ id, holder }]` (with `foreignHeldReason`). That is not a
failure or a wedge — this run picks the Story up once their lease clears. Init
is the backstop: it refuses a Story already labelled `agent::executing`, or one
whose lease a different operator holds, unless you pass `--steal`.
Assignee-based withholding needs `github.operatorHandle` set (in
`.agentrc.local.json`); without it the probe logs a warning and leans on init's
lease refusal alone.

**Overlapping footprints are reserved across beats, not just within one.** A
Story sharing a **concrete** path with a still-implementing Story is withheld
and named in `inFlightReservation: { available, withheld: [{ id, blockedBy,
reason, source, paths }], note }`, where `reason` is `in-flight-earlier-beat` or
`foreign-lease`. Like `foreignHeld` this is neither a failure nor a wedge — the
Story re-admits automatically once its blocker leaves the in-flight set. A
**glob** footprint (or the UNKNOWN sentinel for an unparseable body) reserves
nothing across beats; it still serializes its own beat. Reservation is a
`--probe-live` capability: under `--dag` the report is `available: false` and
selection de-conflicts within the beat only.

**Beat-local skips are reported too**, in `footprintGuard: { mode, withheld,
advisory, note }`. Every entry in **either** report carries the colliding
`paths` and one `source` tag, `declared-overlap`: both Stories' `changes[]`
named the path, or one declared a glob. A declared footprint is the whole
footprint — `changes[]` is the only evidence a collision is scored against.

**`delivery.deliverRunner.footprintGuard`** selects what a collision does:

| Mode | Effect |
| --- | --- |
| `enforce` (default) | A collision withholds the Story. Keep this unless you have a reason — the guard encodes delivery-time-only knowledge (open implementation windows, foreign leases, ground moved since planning) no `depends_on` edge can carry. |
| `advisory` | Collisions are still **detected** and listed in `footprintGuard.advisory`, but never withhold; dispatch follows the declared `depends_on` edges alone. A throughput trade for a run whose ordering is fully declared. |

## Dispatch mechanics (role-scoped by default)

**Read the mode; never infer it from shape.** Before spawning anything, read
the Story's `dispatchMode` from the resolver envelope (`stories[].dispatchMode`,
from `resolveStoryDispatchMode` in `lib/orchestration/complexity-gate.js`,
which decides on the resolved set size alone). The rule is digest § 1: a
one-Story run is `inline`, every Story of a multi-Story run is `subagent`
however lite its body. A Story with `dispatchMode: "inline"` executes
[`deliver-story.md`](deliver-story.md) **inline in this session** — no
`story-worker` boot — threading the same `docsDigestPath` / `checklistPath` /
change-set discipline as a spawned worker. It does not touch the acceptance
verdict owner ([`deliver-digest.md`](deliver-digest.md) § 3).

**Issue a beat's spawns in one turn.** A beat hands you a ready set, not a
queue: those Stories have no dependency edge between them and no shared write
paths. Dispatch them the way
[`parallel-tooling.md`](parallel-tooling.md) Rule 3 prescribes — **N `Agent`
calls issued together in a single assistant turn**, one per ready Story, not
`Agent` → wait → `Agent`. Serial dispatch costs the run a full Story's
implementation time per sibling for nothing. Respect
`delivery.deliverRunner.concurrencyCap`: when the ready set exceeds it, slice
into batches of `cap` and dispatch each batch in its own turn.

**Dispatch each `ready` Story (role-scoped by default).** When
`delivery.routing.roleScopedAgents` is enabled (the **default**) and the host
exposes agent dispatch, spawn each ready Story as its own
`subagent_type: story-worker` sub-agent — it boots on the role-scoped
[`story-worker`](../../agents/story-worker.md) context (its own system prompt, no
entry-doc @-closure) carrying the load-bearing delivery MUSTs standalone. The
sub-agent executes [`deliver-story.md`](deliver-story.md) Steps 0–2.5
(init → implement → acceptance self-eval → **push**) and stops there; **you**
own Step 3, serialized — see `/mandrel-deliver` § Closing what the workers hand back.

**The beat writes the prompt; you pass the file.** Each `ready[]` entry carries
a `promptPath` under `<tempRoot>/run-<id>/`, and that file is the whole spawn
payload: the Story id, the `workCwd` conventions, the `docsDigestPath` (null
when `project.docsContextFiles` is unset), the `checklistPath` — the
footprint-matched write-time audit checklist built from the Story's declared
`changes[]` / `references[]`, empty when nothing matched — and the
**change-set discipline** (derive the change set once with `ceremony-derive.js`
and hand that one list to the verdict owner; never let a critic re-derive the
diff). An unmatched checklist costs nothing: the maker-blind close-scope pass
still covers the Story.

**Inline fallback (`roleScopedAgents: false` / no-nesting harness).** When the
kill-switch is off, or the host cannot spawn a sub-agent at this nesting depth,
do **not** stall: read [`deliver-story.md`](deliver-story.md) **in full** and
execute it directly, in this turn, following that same dispatch prompt. Under
`--yes` / injected helper content, execute directly without a re-read turn. The
engine, gates, and terminal envelope are identical either way — only the
isolation differs.

## Intent phrases (what replaced the flag table)

`/mandrel-deliver` has no operator-facing flags. The scripts still take every flag they
always did — the workflow fills them in from what the operator said, the same
derive-then-announce contract `/git-deliver` uses for its terminal level.

| The operator says | You pass | Effect |
| --- | --- | --- |
| "I'll merge it myself", "don't wait", "just open the PR" | `--no-wait-merge` | Rest at `agent::closing` for a human land |
| "wait for the merge", "land it" | `--wait-merge` | Close-and-land — already the default (`delivery.routing.closeAndLand`) |
| "take the lease", "steal it", "it's mine, override" | `--steal` | Forwarded to `single-story-init.js` |
| "one at a time", "sequentially", "no parallelism" | `--concurrency 1` | Serialize a multi-Story run |
| "run <n> at once" | `--concurrency <n>` | One-run cap only |

Two rules keep this honest:

1. **Announce before acting.** Name the intent you read and the flag it fills
   in. A misread phrase is then visible in one line rather than discovered at
   the terminal envelope.
2. **Silence means config, not a literal.** With no intent phrase, omit the
   flag entirely so `delivery.deliverRunner.concurrencyCap` (and any
   `.agentrc.local.json` override) wins. Filling in the config default as a
   literal silently defeats that override — the failure this table most easily
   causes.

`--yes` is deliberately **absent** from the table. It is not an intent an
operator expresses; it is a runner asserting *nobody is at the keyboard*, and
it changes fail-closed behavior (it is what turns the unplanned path's
over-scope stop into an `escalated` terminal envelope, and what auto-proceeds
`/mandrel-plan`'s gates). Cron, `/loop`, and headless dispatch set it. An attended run
never does, however the operator phrases their impatience.

## Operator-merge implies no-wait

`--no-auto-merge` and `delivery.ci.autoMerge: "strict"` leave the PR
deliberately un-armed: there is nothing for close to land, so the Story rests
at `agent::closing` for the human merge and is **not** flipped to
`agent::blocked` — `--wait-merge` does not override this, because the operator
owning the merge is a decision to respect, not a fault to report. A genuine
*arm failure* is the opposite case: nobody chose it, so close still waits and
still blocks.

## Per-run epilogue (N>1)

Once the sequence reports `epilogueDue: true` (every Story done), keyed on the
delivered id set:

```bash
node .agents/scripts/plan-run-epilogue.js --stories 101,102
```

This executes, in order:

- `follow-up-rollup` — friction follow-ups across every Story in the run
  (files issues when auto-file is on; posts `follow-ups`).
- `epic-close` — **reports** which of the run's container Epics its land tails
  left closed and which are still open. **Read-only** — the last Story's own
  land tail already derived the container from a complete child set.

**The audit roster is opt-in** (Story #5343). Add `--audit-roster` and the run
also selects cross-Story audit lenses over the combined landed tip and posts
`plan-run-audit-roster` on the primary Story — and the host MUST then walk
every listed lens against the combined diff, one `auditor` sub-agent per lens.
That walk is expensive, so **the operator asks for it** — exactly as for the
pre-mortem plan critic. Without the flag no roster comment is posted and no
auditor is spawned.

A single-Story run skips the epilogue — follow-ups are captured on merge
confirm instead (`captureStoryFollowUps`).

## Container-Epic rollup (every N)

`epic-rollup.js` derives a container Epic's state from its children at
**every edge that changes a child's state** — the `agent::executing` flip in
`single-story-init.js`, the post-land tail (the tail's `epicRollup` step), and
`plan-persist`'s supersede close (`supersede.epicRollup`) — so it holds at
**N=1**, where no epilogue runs.

- **Status** follows the children's composition (`deriveParentState` mapped
  onto the board's three options): any **open** child executing or blocked →
  `In Progress`, every child `agent::done` or closed → `Done`. A **closed**
  child contributes no `agent::*` state at all. It is written **directly**,
  never via a label: the container carries no `agent::*` label by
  construction, which keeps it out of the bare `/mandrel-deliver` ready list.
- **Owner** — `github.operatorHandle` is added to the Epic while any child is
  in flight, through the additive assignees endpoint, and is never removed.
- **Closure** is one-way: a container whose children are all finished closes,
  as `completed` when at least one child landed and as `not_planned` when none
  did. A reopened child moves Status back to `In Progress` and does **not**
  reopen the issue.
- The parent lookup resolves the native parent edge in **one** call
  (`getParentIssue`), falling back to a `type::epic` scan for a child linked by
  checklist alone. An authoritative "no parent" narrows that scan to Epics
  whose body checklist names the Story (no per-Epic native read); only a
  degraded lookup reads every scanned Epic's native children. Children are the body checklist **union** the native
  sub-issue edges — the same reader `/mandrel-deliver`'s expansion uses.
- A checklist row citing an id that resolves to nothing is **dropped with a
  warning** when the native read succeeded; an unresolvable *native* edge
  still fails the read. An Epic-typed child is refused by name
  (`epic-typed-child`) and neither blocks nor advances the parent.
- Every step is best-effort and never throws: a stale container costs
  tidiness, not a landed Story's envelope.

## Ceremony (profiles + two scopes)

The ceremony rule is digest § 3: `delivery.routing.ceremonyProfile` alone names
the acceptance verdict owner; the change level derived from the Story's own
diff selects **review depth**.

| Profile | Acceptance verdict owner | When to use |
| --- | --- | --- |
| `minimal` | Inline self-eval | Tiny trusted N=1 Stories |
| `standard` | Inline self-eval | Default |
| `strict` | Fresh-context critic | High-assurance / regulated surfaces |

| Scope | What runs | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Gates, branch discipline, close-and-land | `deliver-story` / `single-story-close` |
| **Per-Story (profile)** | Acceptance verdict owner (the rule: digest § 3) | `ceremony-routing.js` |
| **Per-Story (derived level)** | Review depth | `review-depth.js` + `code-review.js` |
| **Per-run (N>1)** | Follow-up roll-up · container-Epic report (· audit roster on `--audit-roster`) | `plan-run-epilogue.js` once at run end |
| **Per-Story land tail** | Follow-up capture · status resync · Epic rollup · ref cleanup · base fast-forward | `single-story-close/phases/post-land.js` (in-process, per-step reported) |

## Async merge-confirm mode (`delivery.mergeWatch.mode: "async"`)

In async mode the close arms auto-merge and probes the PR **once**. A
definitive probe settles as in sync mode — merged lands, closed or a red
required check (the head-anchored predicate) blocks, a red advisory gate
blocks. A probe whose checks have not started or are still running returns
`pending` with a `nextCommand` at once, no sleep: CI never reddens inside the
first minute, so a second probe could only hold the serialized slot. Two
shapes poll on inside the ~60s window: checks already **green** (the merge is
imminent — observed at the green cadence, it saves a whole confirm
invocation) and a red rollup still awaiting its confirming probe. When a close returns that `pending` envelope, launch its
`nextCommand` (`single-story-confirm-merge.js … --wait`) as a **background**
invocation (host background Bash — its completion re-invokes the agent) and
move on to the next Story; `single-story-confirm-merge.js` is idempotent and
owns the whole tail, and `deliver-recover.js` recovers an orphaned confirm. Do
not foreground-poll the merge. The cumulative `maxBudgetSeconds` give-up is
unchanged.

**On a multi-Story run the beat adds `--merge-watch-mode async` for you.** Close
sees one Story and cannot see run topology — `deliver-run.js` can: every
`close[]` command it renders carries the flag when the run holds more than one
Story and omits it for a run of one. Run the command it printed verbatim rather
than composing your own. Under `sync` each serialized close would hold the
foreground for its full merge wait before the next may start — the run's
dominant serialized cost, paid per sibling. Expect a `pending` envelope from
each async close — that is the designed ending here, not a failure.

The flag overrides `delivery.mergeWatch.mode` for that invocation only; the
config default stays `"sync"`. A slow-CI solo consumer may opt into `"async"`
for the same reason — a foreground wait longer than the host tool ceiling
expires `pending` anyway. Otherwise a one-Story run keeps `sync`: there is no
sibling to unblock, and the foreground wait is the cheapest path to `landed`.

## Preflight (before close) {#preflight}

Digest § 5 states the rule: before the credited suite run, the worker runs
the configured `project.commands.lint` (falling back to `npm run lint`) and
`quality-preview.js --changed-since origin/<baseBranch>` in the worktree, and
fixes and commits every finding. It runs **before** the credited run because a
fix commit afterwards would void that run's credit.

- **Why.** Close runs lint and the maintainability half of the preview
  (`quality-preview-mi`) in its parallel phase, but a regression found there
  still costs a close round-trip. Seconds of preflight in the worktree is
  cheaper than any close.
- **The CRAP half never captures.** It scores whatever coverage artifact is
  on disk — the worker's credited capture when one exists — and triggers no
  capture of its own. With no artifact its methods report unscorable; a stale
  one can invent a violation. `--only mi` runs the maintainability half alone.
- **Close stays authoritative.** Its `quality-preview-crap` gate scores a
  fresh capture after `coverage-capture`; a preflight pass never skips it.

## Credited run (situational) {#credited-run}

Digest § 5 states the rule and both invocations; this is what surrounds them.

- **Why the capture.** On a capture-active project close registers
  `coverage-capture` instead of the plain `test` gate, so an evidence-gate
  `test` deposit buys nothing there: close logs `no credited capture stamp
  covers this change set` and pays the whole suite on the serialized tail. The
  worker's capture writes the content-digest stamp in the worktree, and
  close's capture then exits on its freshness probe without spawning
  `test:coverage`. A base-sync that merges a path under `crap.targetDirs`
  spends the stamp, and close re-captures.
- **Runner shapes.** A bare `npm test` earns the `test` credit **only** where
  the project's test script routes through mandrel's own runner, which prints
  the outcome. On any other runner it deposits nothing and prints nothing, so
  silence is never evidence of credit.
- **Background dispatch.** If the run outruns the host's sync Bash ceiling,
  dispatch it in the **background** — its completion re-invokes you; never
  spawn a task to poll or `sleep`-loop against it
  ([`parallel-tooling.md`](parallel-tooling.md) Rule 2).
- **Redraft rounds.** Run the scoped projects for the roots you changed plus
  `verify[]`, not the whole suite; only the one run needs credit.
- **Seating new methods (`--seat-missing`).** Close fails a Story whose own
  new methods have no baseline row, so after the credited run and before the
  push the worker runs, in `<workCwd>`, for each enabled gate:
  `node .agents/scripts/update-crap-baseline.js --seat-missing` (CRAP) and
  `node .agents/scripts/update-maintainability-baseline.js --seat-missing`
  (MI). Each scores the files changed since the `origin/<baseBranch>`
  merge-base and writes **only** rows whose (path, method) key is absent —
  every existing row stays byte-identical, including rows whose scores moved
  (re-scoring stays close's auto-refresh). It prints `seated: N`; `seated: 0`
  writes nothing. Commit a change as `chore(baselines): baseline-refresh: …`.
- **Seat refusals.** The CRAP seat exits non-zero and writes nothing unless
  the coverage-capture stamp is fresh for the tree **and** method resolution
  over the in-scope files is exactly 100% — a lower rate means the artifact's
  coordinates predate the tree. The refusal names the rate, the unresolved
  files and the fix: re-run the digest § 5 capture, then seat.
- **Seat order vs credit.** The capture stamp digests scorable sources only,
  so a baseline-JSON-only seat commit leaves it fresh and the capture credit
  stands. The evidence-gate `test` credit is keyed on the tree, so on that
  path seat first — MI is static and needs no coverage — then run the suite.

## Held review at hand-off {#held-review}

The one home of this rule; the digest and the worker contract point here.
After the credited run **and** the push, the worker computes the Story-scope
code review itself, before handing off:

```bash
node <main-repo>/.agents/scripts/story-review-compute.js --story <storyId> --cwd <workCwd>
```

- **What it does.** It runs close's own review computation (the configured
  provider chain) against `origin/<baseBranch>...story-<id>`, posts nothing,
  takes no full-suite lock, and writes
  `temp/orchestration/story-review-<id>.json` beside the terminal envelope,
  keyed on the **diff digest** (sha256 of the exact three-dot diff text). It
  exits 0 whatever the findings; non-zero means the provider threw — report
  it in the hand-off; close computes the review itself.
- **A CRITICAL is the worker's to fix.** Fix, commit, re-run the credited
  run (the fix commit voided its credit), push, and re-run the compute — the
  acceptance loop's redraft discipline, bounded by
  `delivery.acceptanceEval.maxRounds`. Still CRITICAL at the cap → take the
  blocked path. Anything else goes in the hand-off as the severity tally.
- **Close adopts, else computes.** When the deposit's digest equals the
  digest of the diff at close's held-review start, close starts no review and
  posts the deposit after PR-open. A clean base-sync merge moves HEAD without
  changing the diff, so it keeps the deposit; a commit that changes the diff
  does not, and close reviews as it would without one. The CRITICAL halt and
  `--override-review-block` apply to an adopted result unchanged.

## Gate output {#gate-output}

Close writes gate lines to `temp/orchestration/close-gates-<storyId>.log` and
reports a one-line digest on success; a failed gate replays its tail inline.
`AGENT_LOG_LEVEL=verbose` restores live streaming. A gate exiting `75` (its
full-suite lock wait expired) logs a deferred line and the close settles
`pending`; one exiting `124` (the suite outran its timeout) logs a timeout
line naming host contention — neither is reported as failing tests.
