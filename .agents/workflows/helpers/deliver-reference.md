---
description:
  On-demand reference appendix for /mandrel-deliver — the sequencing edge cases,
  role-scoped dispatch mechanics, lite-route inline execution, checklist
  threading, and the per-run epilogue. Read it when the matching lever is in
  play; the lean spine in deliver.md links here.
---

# /mandrel-deliver — reference appendix (on-demand)

Reference-only detail split out of [`mandrel-deliver.md`](../mandrel-deliver.md) so the
always-resident spine stays lean. Nothing here is a new MUST —
it is the mechanics an operator consults when the matching lever is engaged.

## Ranges (`4922 - 4926`) {#ranges}

A contiguous span is how an operator reads a plan run, so the dash range is a
first-class id shape rather than prose to interpret — `/mandrel-deliver 4922 - 4926`
means exactly the five ids in it.

**Pass the span through; never expand it by hand.** Every id-list flag on the
delivery path takes range tokens — `resolve-stories.js --ids`,
`stories-wave-tick.js --stories` and `--dispatched`, and
`plan-run-epilogue.js --stories`. Normalize the operator's spacing away and hand
the scripts one unspaced token (`--ids 4922-4926`), mixed freely with singles
and commas (`--ids 4901,4922-4926`); overlaps dedupe. A hand-typed enumeration
is where an id gets dropped or invented, and the drop is silent.

The shared expander (`lib/util/parse-id-list.js`) refuses rather than guesses,
so a typo fails where it was typed instead of resolving the wrong set:

| Input | Outcome |
| --- | --- |
| `4922-4926`, `4922 - 4926` | Expands to the inclusive span. En and em dashes, and a `#` on either endpoint, are accepted too. |
| `4926-4922` | Refused — write it low-to-high. |
| `1-4926` | Refused — above the 50-id span cap (`MAX_RANGE_SPAN`). |
| `4922-`, `-4926`, `4922-4923-4924` | Refused as a malformed token. |

The cap is per range token, not per run: a genuine 60-Story delivery is still
expressible as two ranges, but a slipped digit cannot fan out into a live
resolution sweep of thousands of issues.

## Sequencing edge cases (`stories-wave-tick.js`)

**What "discovered, not declared" means concretely.** `resolve-stories.js` reads
the graph from live state as the union of the Story bodies' `depends_on` edges
and GitHub's native `blocked_by` edges, resolving each blocker against its real
issue state rather than against anything you hand it. That is why there is no
batch label to pass and why a blocker that landed in an unrelated run is simply
seen as done.

**A Story with no `agent::*` label is refused.** The audit sweep files Stories
deliberately without one — their bodies are audit prose, not a scoped change
with verifiable acceptance criteria — so resolving one means dispatching a
worker at an unenriched body, after taking its lease. Route it through
`/mandrel-plan` first, which applies `agent::ready` at the end of planning.
`--allow-unlabelled` is the deliberate escape hatch.

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
turn, not a slow beat.

Each beat re-probes live state: it re-resolves the graph, classifies **done**
(`agent::done` or a closed issue — including foreign blockers that landed in
another run), and derives **in-flight** from live `agent::executing` /
`agent::closing` labels. You never compute `done` or `in-flight` — that
accounting is read from reality every beat.

**`--dispatched` is the one thing you must tell it.** List every
Story id you have spawned this run. Live state cannot instantly report a Story
you dispatched moments ago: `single-story-init.js` publishes `agent::executing`
before the worktree install (ahead of the multi-minute install, so the
window is short rather than minutes-long), but it is not
zero — until the label lands the Story still reads `agent::ready` and, without
`--dispatched`, the next beat would hand it back and a second sub-agent would
join the first on the same branch and worktree, interleaving commits.
`--dispatched` closes that residual same-run window. The rule is
**append-only: add each id as you dispatch it and never remove one.** The flag
is additive, not authoritative — the probe unions it into the label-derived set
and then filters it against live state, so an id that has since gone
`agent::done` is dropped for you. Re-listing an id costs nothing and cannot
double-count a slot; *omitting* one is the only way to get this wrong. This is
why `--dispatched` is not the retired `--done` bookkeeping, and why
`--in-flight` remains rejected under `--probe-live`.

**Cross-run de-confliction is automatic.** A Story another
operator is delivering is withheld without any bookkeeping from you: the probe
reads the Story's assignee lease and, when it belongs to a different operator,
withholds the Story and reports it in the envelope's
`foreignHeld: [{ id, holder }]` (with `foreignHeldReason`). That is not a
failure or a wedge — the holder's run owns the branch, and this run picks the
Story up automatically once their lease clears. Init is the backstop: it
refuses a Story already labelled `agent::executing`, or one whose lease a
different operator holds, unless you pass `--steal`. Assignee-based withholding
needs `github.operatorHandle` set (in `.agentrc.local.json`); without it the
probe logs a warning and leans on init's lease refusal alone.

**Overlapping footprints are reserved across beats, not just within one.** A
Story sharing a **concrete** path with a still-implementing Story is withheld
and named in `inFlightReservation: { available, withheld: [{ id, blockedBy,
reason, source, paths }], note }`, where `reason` is `in-flight-earlier-beat` or
`foreign-lease`. Like `foreignHeld` this is neither a failure nor a wedge — the
Story re-admits automatically once its blocker leaves the in-flight set — and
it exists so an unfilled slot is explained rather than mysterious. A **glob**
footprint (or the UNKNOWN sentinel for an unparseable body) reserves nothing
across beats; it still serializes its own beat. Reservation needs the in-flight
Stories' footprints, so it is a `--probe-live` capability: under `--dag` the
report is `available: false` and selection de-conflicts within the beat only.

**Beat-local skips are reported too**, in `footprintGuard: { mode, withheld,
advisory, note }`. They used to be an unreported skip, so a Story simply
vanished from `ready[]` and an unfilled slot read exactly like a cap that was
never reached. Every entry in **either** report carries the colliding `paths`
and a `source` tag:

- `declared-overlap` — both Stories' `changes[]` named the path (or a declared
  glob). Intended serialization; two Stories rewriting the same generated
  baseline must not co-dispatch.
- `scraped-overlap` — only the text evidence produced it. Real signal — a
  declaration is only a lower bound — but the class where a false positive is
  possible.

**The evidence scrape excludes exactly three token sources**, each structurally
incapable of naming an edit target: `audit-fingerprints` /
`audit-semantic-keys` provenance footers, paths under `project.paths.tempRoot`,
and markdown-link URL interiors. Nothing else is stripped — a
`<!-- DECOMPOSITION -->` block's paths are genuine intent
([`instructions.md` § 7](../../instructions.md)) and still count.

**`delivery.deliverRunner.footprintGuard`** selects what a collision does:

| Mode | Effect |
| --- | --- |
| `enforce` (default) | A collision withholds the Story. Keep this unless you have a reason — the guard encodes delivery-time-only knowledge (open implementation windows, foreign leases, ground moved since planning) no `depends_on` edge can carry. |
| `advisory` | Collisions are still **detected** and listed in `footprintGuard.advisory`, but never withhold; dispatch follows the declared `depends_on` edges alone. A throughput trade for a run whose ordering is fully declared. |

## Dispatch mechanics (role-scoped by default)

**A single-Story run executes inline.** Sub-agent isolation is
load-bearing only for **concurrent** dispatch — two workers sharing a checkout
would race on worktrees and branch refs — so a run resolving exactly one Story
has no sibling to isolate from and pays the spawn premium for nothing (a boot is
a cache write at full rate; an inline continuation is a cache read at ~10%).
`resolve-stories.js` already reports it: a one-id run comes back with
`dispatchMode: "inline"` whatever the Story's shape. Role-scoped spawning is
retained in full for multi-Story waves, and the rule changes **where** the
engine runs, never what runs — gates, PR, and terminal envelope are identical.

**Read the mode; never infer it from shape.** Before spawning
anything, read the Story's `dispatchMode` from the resolver envelope
(`stories[].dispatchMode`, produced by `resolveStoryDispatchMode` in
`lib/orchestration/complexity-gate.js`, which decides on the resolved set size
alone — it does not read the Story body). A Story with `dispatchMode: "inline"`
executes [`deliver-story.md`](deliver-story.md) **inline in this session** — no
`story-worker` sub-agent boot and no fresh acceptance-critic sub-agents
(sub-agent boots are the dominant deliver-phase token cost at trivial scope) —
threading the same `docsDigestPath` / `checklistPath` / change-set discipline
as a spawned worker. Inline removes model-side fan-out only: every
`single-story-close.js` gate, the PR to `main`, and the terminal envelope are
identical.

**A trivial shape does not buy that session.** Only the
one-Story rule above yields `inline`; every Story of a multi-Story run comes
back `subagent` however lite its body, because the ready set below may offer
several Stories on one beat and a session cannot be split between them. The
Story's derived shape is still reported (it sets ceremony, and a sensitive
footprint keeps the fresh acceptance critic), and the `route::lite` label
remains a human-visible hint only, never the control signal — a lost or
never-written label cannot misroute delivery.

**Issue a beat's spawns in one turn.** A wave tick hands you a ready set, not a
queue: those Stories have no dependency edge between them (the resolver already
withheld any that do) and no shared write paths (each owns its own worktree and
branch). Dispatch them the way
[`parallel-tooling.md`](parallel-tooling.md) Rule 3 prescribes — **N `Agent`
calls issued together in a single assistant turn**, one per ready Story, not
`Agent` → wait → `Agent`. Serial dispatch is compliant with every other rule on
this page and costs the run a full Story's implementation time per sibling for
nothing; the wave aggregator is built for the parallel shape. Respect
`delivery.deliverRunner.concurrencyCap`: when the ready set exceeds it, slice
into batches of `cap` and dispatch each batch in its own turn.

**Dispatch each `ready` Story (role-scoped by default).** When
`delivery.routing.roleScopedAgents` is enabled (the **default**) and the host
exposes agent dispatch, spawn each ready Story as its own
`subagent_type: story-worker` sub-agent — it boots on the role-scoped
[`story-worker`](../../agents/story-worker.md) context (its own system prompt, no
`CLAUDE.md` @-closure) carrying the load-bearing delivery MUSTs standalone. The
sub-agent executes [`deliver-story.md`](deliver-story.md) Steps 0–2.5
(init → implement → acceptance self-eval → **push**) and stops there; **you**
own Step 3, serialized — see `/mandrel-deliver` § Closing what the workers hand back.
Thread into its prompt: `storyId`; `docsDigestPath` (the per-run docs digest, null when
`project.docsContextFiles` is unset); `checklistPath` (the footprint-matched
write-time audit checklist, produced at dispatch, below); and the
**change-set discipline** — the worker computes the change set once with
`computeChangeSet` and hands that one list to every acceptance critic; it
never lets a critic re-derive the diff.

**Produce `checklistPath` before the spawn.** Compute the payload
from the Story's predicted footprint (its `changes[]` / `references[]` path
entries) with `buildDispatchChecklist` and write it to the run temp dir, then
thread the resulting path (empty when nothing matched):

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

`buildDispatchChecklist` (`lib/audit-suite/dispatch-checklist.js`) is a pure
function of the footprint and the on-disk checklists; an empty match prints
nothing and the worker runs with no write-time checklist — the maker-blind
close-scope pass still covers it.

**Inline fallback (`roleScopedAgents: false` / no-nesting harness).** When the
kill-switch is off, or the host cannot spawn a sub-agent at this nesting depth,
do **not** stall: read [`deliver-story.md`](deliver-story.md) **in full** and
execute it directly, in this turn, threading the same `docsDigestPath` /
`checklistPath` / change-set discipline. Under `--yes` / injected helper
content, execute directly without a re-read turn. The engine, gates, and
terminal envelope are identical either way — only the isolation differs.

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
still blocks. That asymmetry is what keeps the must-land contract intact
without misfiling deliberate human merges as blocks.

## Per-run epilogue (N>1)

Once the sequence reports `epilogueDue: true` (every Story done), keyed on the
delivered id set:

```bash
node .agents/scripts/plan-run-epilogue.js --stories 101,102
```

This executes, in order:

- `audit-roster` — selects cross-Story audit lenses over the combined landed
  tip and posts `plan-run-audit-roster` on the primary Story; the host MUST
  walk each listed lens against the combined diff.
- `follow-up-rollup` — friction follow-ups across every Story in the run
  (files issues when auto-file is on; posts `follow-ups`).
- `sibling-coherence` — Spec/Acceptance coherence check across sibling bodies
  (`plan-run-sibling-coherence`).
- `epic-close` — **reports** which container Epics this run closed and which
  are still pending. It derives nothing itself: every step here and the
  per-Story land tail alike delegate to `epic-rollup.js`, so one rule decides
  a container's state.

A single-Story run skips the epilogue — follow-ups are captured on merge
confirm instead (`captureStoryFollowUps`).

## Container-Epic rollup (every N)

A container Epic is never delivered, so nothing used to write to it during
the run it was the subject of. `epic-rollup.js` derives its state from its
children at both per-Story lifecycle edges — the `agent::executing` flip in
`single-story-init.js` and the post-land tail (reported as the tail's
`epicRollup` step) — which is why it holds at **N=1**, where no epilogue runs.

- **Status** follows the children's composition (`deriveParentState` mapped
  onto the board's three options): any **open** child executing or blocked →
  `In Progress`, every child `agent::done` or closed → `Done`. A **closed**
  child contributes no `agent::*` state at all — its label records where it
  stopped, and a superseded Story closed still wearing `agent::blocked` used
  to pin its container open forever. It is written
  **directly**, never via a label: the container carries no `agent::*` label
  by construction, which is what keeps it out of the bare `/mandrel-deliver`
  ready list.
- **Owner** — `github.operatorHandle` is added to the Epic while any child is
  in flight, through the additive assignees endpoint, and is never removed.
- **Closure** is one-way: every child landed closes the container as
  `completed`; a reopened child moves Status back to `In Progress` and does
  **not** reopen it.
- The parent lookup scans open `type::epic` issues, because linkage is
  parent→child only, and reads children as the body checklist **union** the
  native sub-issue edges — the same reader `/mandrel-deliver`'s expansion
  uses, so an Epic can never be expandable but unclosable.
- Every step is best-effort and never throws: a stale container costs
  tidiness, not a landed Story's envelope.

## Ceremony (profiles + two scopes)

Ceremony depth is selected by `delivery.routing.ceremonyProfile`
(`minimal` | `standard` | `strict`, default `standard`) and the **change level
derived from the Story's own diff** — the changed files' intersection with the
sensitive-path classes in `audit-rules.json`
(`review-depth.js#deriveChangeLevel`), not a planner-authored verdict:

| Profile | Acceptance critic | When to use |
| --- | --- | --- |
| `minimal` | Always inline | Tiny trusted N=1 Stories |
| `standard` | Derived-level routed (+ sampling floor) | Default |
| `strict` | Always fresh-context | High-assurance / regulated surfaces |

| Scope | What runs | Mechanism |
| --- | --- | --- |
| **Per-Story (always)** | Gates, branch discipline, close-and-land | `deliver-story` / `single-story-close` |
| **Per-Story (profile + derived level)** | Acceptance critic mode; review depth | `ceremony-routing.js` + `review-depth.js` + `code-review.js` |
| **Per-run (N>1)** | Audit roster · follow-up roll-up · sibling coherence | `plan-run-epilogue.js` once at run end |
| **Per-Story land tail** | Follow-up capture · status resync · Epic rollup · ref cleanup · base fast-forward | `single-story-close/phases/post-land.js` (in-process, per-step reported) |

## Async merge-confirm mode (`delivery.mergeWatch.mode: "async"`)

A slow-CI consumer can opt the close into `"async"` mode so the merge wait
probes once for ~60s (catching an instant merge or an instantly-red required
check) and then returns `pending` instead of burning ~5 minutes of the host
tool slot polling a merge that lands after the wait would have expired anyway.
When a close returns that `pending` envelope, launch its `nextCommand` as a
**background** invocation (host background Bash — its completion re-invokes the
agent) and move on to the next Story; `single-story-confirm-merge.js` is
idempotent and owns the whole tail. Do not foreground-poll the merge. The
default `"sync"` behaviour is unchanged.

**On a multi-Story run, pass `--merge-watch-mode async` on every close.** Close
sees one Story and cannot see run topology, so it cannot make this call for
itself — you can. Implementation runs in parallel but the close tail is
serialized one at a time, and under `sync` each of those closes holds the
foreground for its full merge wait before the next Story's close may start.
That is the run's dominant serialized cost, and it is paid per sibling:

```bash
node <main-repo>/.agents/scripts/single-story-close.js \
  --story <storyId> --cwd <main-repo> --merge-watch-mode async
```

The flag overrides `delivery.mergeWatch.mode` for that invocation only — the
config default stays `"sync"`, which is right for the solo delivery that has no
sibling waiting behind it. It composes with `--max-wait-seconds`: pass both and
the explicit bound still wins over the async probe cap. An unrecognized value
exits non-zero before any phase runs, so a typo cannot silently drop the run
back onto synchronous waiting. Expect a `pending` envelope from each async
close — that is the designed ending here, not a failure; background its
`nextCommand` and move to the next Story's close immediately.

A one-Story run should keep the `sync` default: there is no sibling to unblock,
and the foreground wait is the cheapest path to `landed`.
