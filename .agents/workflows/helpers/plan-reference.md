# /mandrel-plan — on-demand reference appendix

> **Applies when:** you are executing [`/mandrel-plan`](../mandrel-plan.md) and hit one of the
> situations below — input-mode derivation, the Gate #1 light handoff,
> shape-derived complexity routing, tickets-mode supersede authoring, critic
> dispatch detail, a failed persist, or source-id resolution. The spine stays
> resident; this file is read on demand.

## Deriving the input mode

`/mandrel-plan` has no operator-facing flags; the CLIs below still take every flag they
always did. Read the invocation, **announce what you derived**, then fill in
the flag — the same derive-then-announce contract `/git-deliver` uses for its
terminal level.

| What was typed | Mode | You pass |
| --- | --- | --- |
| nothing | ask | — (ask what to plan) |
| prose | seed | `--seed "<text>"` |
| an argument resolving to an existing file | seed-file | `--seed-file <path>` |
| ids, none of them a delivered Story | tickets | `--tickets <ids>` |
| one id that is an `agent::done` Story | amends | `--amends '#<id>'` |
| "…but let me review before you file" | (any) | `--force-review` |

**Order matters.** Test *file exists* before *looks like prose*, or a bare
`notes.md` becomes a one-word seed. Test *all args are `^#?\d+$`* before
either, or a ticket list becomes prose.

**The one genuinely ambiguous case** is a bare id, between `amends` and
`tickets`. Resolve it from live state — `agent::done` can only be amended, an
open unplanned issue can only be planned — and ask only when the id is an open
Story already at `agent::ready`, where both readings are live. Do not ask in
the cases state already answers; an unnecessary question is the friction this
whole surface exists to remove.

Mixed ids and prose in one invocation is a **hard error**: refuse and ask which
was meant, rather than guessing a mode and doing the wrong work.

## Default-single split policy — what the seam means

The spine's two escape hatches from N=1 are narrow on purpose:

- **Near-zero overlap** — the pieces touch disjoint files and neither's
  acceptance criteria can be scored without the other having landed.
- **Architectural seam** — different deployables, or a migration and its
  consumer: work that cannot share one branch and one PR without one half
  sitting unverifiable behind the other.

Everything else is one Story with `## Slicing` checkpoints. When N>1 does
apply, **every acceptance criterion belongs to exactly one Story** —
`assertAcceptancePartition` refuses a split whose criteria repeat across
siblings, because a verbatim-shared criterion is the signature of coupled work
cut in half rather than genuinely separable work.

## Unknown triage — AFK vs HITL

Every open question interrogation surfaces is triaged by **who can resolve
it**, not parked in one bucket (a shape borrowed from the Wayfinder skill's
HITL/AFK ticket typing):

- **AFK** (away from keyboard — the agent resolves it alone): the answer is a
  fact something already records — third-party docs, a dependency's API
  surface, observable behavior of this repo. Research it during interrogation
  (per `.agents/instructions.md` § 1.C) and fold the answer into the plan as a
  verified claim. An AFK unknown never becomes a Key Assumption — an
  assumption standing in for a checkable fact is just an unchecked fact.
- **HITL** (human in the loop — only the operator can resolve it): a genuine
  product or architecture call — what to support, what to drop, which
  trade-off to prefer. Nothing the agent reads can answer it; presenting a
  researched recommendation is fine, deciding is not.

Boundary examples: *"does library X support streaming?"* is AFK (read its
docs); *"should we drop Node 18 support?"* is HITL (a support-policy call);
*"does our CLI already validate this flag?"* is AFK (read the code);
*"which of two valid schema shapes should the new field use?"* is HITL when
both fit — but first verify it is not settled by an existing convention,
which would make it AFK.

**Attended runs** present the HITL list at Gate #1 as "needs your decision",
one line each, alongside the sharpened intent. **Under `--yes`** nobody is at
the keyboard: AFK unknowns are researched exactly as in an attended run, and
each HITL unknown degrades to a declarative Key Assumption that names the
default chosen and marks it a decision-made-by-default, e.g.:

> **Key Assumption (decision-made-by-default):** new-style envelopes only;
> re-emitting legacy envelopes was ruled out by default, not by the operator.

(Keep the assumption itself declarative — "flag if wrong" phrasing trips the
open-question hygiene lint, and the deliverer cannot answer it anyway.)

The marker keeps the operator's undelegated decisions findable after the
fact: reviewing a `--yes` plan means scanning its decisions-made-by-default,
not re-deriving which assumptions were really the agent's to make.

## Gate #1 → the memory-pool advisory (`memoryPoolAdvisory`)

On a truthy `memoryPoolAdvisory.recommend`, name
[`/memory-consolidate`](memory-consolidate.md) at Gate #1, quoting its
`reasons[]`. Purely advisory: a stale pool degrades recall, it does not make
the plan wrong, so it never blocks and never reroutes.

## Gate #1 → the light path (in-session handoff)

On a confirmed `deliverLightSuggestion`, `/mandrel-plan` routes into
[`deliver-light.md`](deliver-light.md) **without ending the session**. Two
things make that safe, and both are worth understanding before changing it:

1. **The handoff carries the envelope, not the seed.** Gate #1 already holds
   the interrogated `complexitySignals`; fill the light gate's `--creates`
   / `--refactors` / `--acceptance` / `--reason` from those. Re-deriving from
   raw seed text throws away the better signal and can disagree with the
   suggestion that routed you.
2. **The gate still runs.** The suggestion is read against seed-time ceilings
   (`DELIVER_LIGHT_SUGGESTION_CEILINGS` — artifacts, risk hits, sensitive-path
   classes); the light gate is read against the predicted work's effort and risk
   (`STORY_SHAPE_CEILINGS` — change kinds, magnitude, uncertainty, deployable
   span). Two different checks on purpose, so a confirm is not a bypass.

**When the light gate answers `ask-operator`**, the two ceiling sets disagreed.
Resume `/mandrel-plan` at step 2 (Author) **in this same session** — the interrogation
is still valid and re-paying for it buys nothing. This bounce-back is not an
escalation.

**Under `--yes` the offer is recorded and planning proceeds** — it is *never*
auto-downgraded to light. An unattended run has nobody to confirm the reroute,
and a suggestion is not a confirmation. The same rule governs unknown triage
unattended: AFK unknowns are still researched, but no free-form operator
question is asked — each HITL unknown lands in Key Assumptions marked a
decision-made-by-default, so the record shows what was decided for the operator
rather than pretending it was decided with them.

Escalation in the *other* direction — an over-scope prompt on the light path —
is terminal and requires a fresh session. The rule that separates the two, and
why it must not be flattened into symmetry:
[`deliver-light.md` § Why the two directions differ](deliver-light.md).

## Gate #1 → the `/prototype` offer (`uiSurface`)

`complexitySignals.uiSurface` is the second advisory Gate #1 offer, and the
weaker of the two on purpose: it carries **no routing authority and adds no
gate**. Both halves are derived from observables already in the checkout — the
`hasWebSurface` applicability predicate the `target: "web"` audit lenses gate
on, and whether any predicted path matches a web lens `filePattern` registered
in `audit-rules.json`. There is no configuration key to set: a project with no
rendered frontend resolves falsey and the offer never fires.

When it does fire, **name [`/prototype`](../prototype.md) and stop there.**
`/mandrel-plan` must never invoke it — operator invocation is the entire design, because
the value is a human looking at a layout before its UI acceptance criteria are
frozen.

**Under `--yes` the offer is recorded and planning proceeds** — no reroute, no
prototype written, no gate raised. This is exactly how `deliverLightSuggestion`
behaves unattended, and for the same reason: an unattended run has nobody to
review an artifact, so recording the offer is the whole of the right behaviour.

## Shape-derived complexity routing (`complexitySignals`)

Complexity routes on the **objective shape of the authored work**, never on
seed word count — a detailed prompt can describe trivial work, a terse one
complex work. The pipeline stages the
decision:

- **Signals, not routing.** The envelope's `complexitySignals` field is
  advisory only (`routingAuthority: false`): enumerated-artifact count (with
  the configured `maxArtifacts` threshold beside it as one input),
  `planning.riskHeuristics` phrases present in the seed, the repo state of
  predicted paths (existing paths predict refactors; missing predict
  creates), and the `audit-rules.json` sensitive-path classes the predicted
  footprint intersects.
- **You author the verdict.** Judge the signals: a genuinely trivial scope
  (small additive footprint, no risk hits, no sensitive class) earns a `lite`
  claim via `plan-persist.js --route-downgrade-reason "<why>"`. The reason is
  recorded on every created Story's `story-plan-state` checkpoint, making the
  judgment auditable; without a recorded reason the conservative default
  (`full`) stands.
- **Persist backstops the claim deterministically.** After authoring, the
  work has measurable shape, so persist validates the `lite` claim against
  each Story's own shape — distinct change kinds, declared magnitude,
  uncertainty, deployable/migration span, glob-free footprint, and
  sensitive-path classes, against the framework `STORY_SHAPE_CEILINGS` (effort
  and risk, never artifact counts) — and **fails closed to
  `full`** when any Story exceeds them (the refusal is ledgered on the
  checkpoint too). The lite route is **not** licence to drop a
  non-negotiable — every decision's `preserves` field enumerates what still
  holds: the Story ticket, the PR-to-`main` landing, every repo quality gate,
  and the security baseline. Those gates run in `single-story-close.js`
  regardless of route.

**The label is a hint; deliver re-derives.** Persist labels a
lite cohort's Stories with **`route::lite`** as a *human-visible hint only* —
`/mandrel-deliver` computes the route from each fetched Story body via the same shape
function at dispatch, so neither a lost label nor an unread marker can
misroute delivery: a lite-shaped Story derives `lite` even with the label
absent, and a sensitive-footprint Story routes `full` and keeps its fresh
critic even with the label present. The derived route sets ceremony, not
where the engine runs — sub-agent boots are collapsed by a **single-Story
run**, never by a trivial shape. The `route::*` axis stays runtime-derived: hand-authored
`route::*` entries in `labels[]` are dropped by persist.

The knobs (`planning.complexityGate.{enabled, maxArtifacts}`) are documented
in [`.agents/docs/configuration.md`](../../docs/configuration.md) under
`### planning`; the defaults live on `DEFAULT_COMPLEXITY_GATE` and the shape
ceilings on `STORY_SHAPE_CEILINGS` in
[`lib/orchestration/complexity-gate.js`](../../scripts/lib/orchestration/complexity-gate.js).

## Correct-by-construction authoring template

`plan-context.js --out` writes `stories.template.json` as a
**correct-by-construction** skeleton, built from the same repo probe the
`complexitySignals` ran:

- **`verify[]` placeholders already end with a valid `(tier)` tag.** Keep
  every filled entry's trailing tag one of `(unit)` / `(contract)` /
  `(e2e)` / `(validate)` (or use the `manual:<reason>` escape) — a tierless
  entry is exactly the mechanical persist round-trip the template exists to
  prevent.
- **`changes[]` arrive pre-resolved to creates-vs-refactors.** Every path
  the seed predicted is probed against the repo: an existing path is
  emitted with `assumption: "refactors-existing"`, a missing one with
  `assumption: "creates"`. Trust the pre-resolved assumption — verify
  against the repo before overriding one (authoring `creates` for a file
  that exists at base is a validator rejection). The persist gates stay
  authoritative: they probe the base branch ref, not the working tree.
- **Keep `## Spec` near contract-level prose.** **Aim for ~250 words; an
  advisory warning fires past 350** (`SPEC_SOFT_WORD_BUDGET`). Two numbers,
  two jobs: ~250 is the authoring target — the nudge toward a contract-level
  Spec (interfaces, invariants, load-bearing constraints; no per-file
  behavior narration) — while 350 is the slacker threshold at which persist
  actually warns, so the warning marks a real outlier instead of ordinary
  variance. Neither fails the persist. The hard fail-closed ceiling
  (~1500 tokens, `spec-spill.js`) is unchanged.

A faithfully-filled skeleton — placeholders replaced, pre-resolved entries
kept, tags valid — passes the persist ticket validators with no
round-trip.

### Authored entry shape

Each `stories.json` entry: `slug` (`^[a-z0-9][a-z0-9-]*$`), `type: "story"`,
`title`, `body` (`goal`, optional `spec`, `changes[{path, assumption}]` —
`creates|refactors-existing|deletes`, `non_goals`, `reason_to_exist`),
top-level `acceptance[]`, `verify[]` (`… (unit|contract|e2e|validate)`), and
`depends_on[]` (a sibling slug, or `#<id>` for an existing open Story).

Nothing in that shape inventories the repo for the author. `changes[]` arrives
pre-resolved against the working tree, and Phase 8's
`validateStoryFileAssumptions` re-probes every `{path, assumption}` at persist
as a hard error — so the grounding contract is the author's own targeted reads
plus that gate. There is no pre-computed codebase snapshot to fall back on,
and no manifest-derived replacement to build.

### Per-Story audit provenance (`provenance`)

An audit-seeded plan carries dedup identities forward so the next sweep
recognises what it already planned. The optional top-level `provenance` field
says **which of them this Story owns**:

```jsonc
{
  "slug": "own-the-seam",
  "provenance": {
    "fingerprints": ["<40-char sha1, one per finding this Story tracks>"],
    "semanticKeys": ["architecture␟lib/owned.js"]
  }
}
```

Both arrays are optional; a malformed entry is a validator rejection, never a
silent drop — a dropped identity is invisible until the next sweep re-files
work this plan already tracked.

| `provenance` | What persist stamps |
| --- | --- |
| Present | **Exactly** the identities listed — siblings' groups never leak in. |
| Present but empty (`{}`) | Nothing. "Owns no findings" is a real answer. |
| **Absent** | The **whole seed's** footers (the union) — the recall-safe default. |

**The union fallback is load-bearing, not legacy.** Leaving the authoring agent
to hand-carry provenance out of the seed's HTML comments was measured to fail —
a remembered step is no step at all — and the mechanical union carry is what
closed it. Attribution is additive: it sharpens a plan that opts in and changes
nothing for one that does not. Never remove the fallback to "finish the
migration".

Attribution is what makes the next sweep's dedup answerable rather than
arbitrary. Under the union every sibling carried every key, so a finding
confirming against several open Stories could only pick one at random, and a
key whose owning Story had since **closed** was masked by any open neighbour —
a genuine regression filed as a routine update. With ownership stamped, the
issue carrying a finding's own fingerprint decides both the match and its
state (`lib/findings/route-finding.js`).

The audit path authors this mechanically from the per-group footers the seed
already carries — see [`audit-to-stories`](../audit-to-stories.md). A `--seed`
or `--tickets` plan has nothing to attribute and omits the field.

## Cross-Story conflict analysis at persist

The conflict passes run **twice**: once over the raw `stories.json` payload
(alongside the freshness, file-assumption and sizing gates), and again over the
**assembled, footer-stamped bodies** — the artifact persist actually posts.
The second pass is not belt-and-braces. The canonical authoring shape carries
`acceptance[]` / `verify[]` at the ticket's top level and assembly folds them
into the body, so the passes that scan `body.acceptance` / `body.verify`
(`implicit-cross-story-dep`, `missing-bdd-scaffold`) saw two empty arrays on
the real payload and emitted nothing. Both passes complete before the first
`createIssue`, so a refusal still costs no writes.

`shared-editor` findings are rendered into the posted `plan-summary` comment,
directly beneath the wave table: the table promises which Stories can run
together, and a path two same-wave Stories both write is exactly where that
promise breaks. Promise and caveat belong on one durable surface — previously
the caveat was a stderr warning nobody kept.

Two `planning.*` knobs upgrade a conflict class from advisory to a hard
refusal. **Both default to `false` and are documented, not recommended:**

| Knob | Upgrades | Why it is off |
| --- | --- | --- |
| `planning.failOnSharedEditors` | `shared-editor` → `hard` | Co-editing one file is routine and often correct; the delivery scheduler already serializes file-overlapping Stories. |
| `planning.requireExplicitCrossStoryDeps` | `implicit-cross-story-dep` → `hard` | Path references are matched by substring, so a legitimate mention in prose can read as a dependency. |

Turn one on for a repo where the class is genuinely fatal; expect a refusal to
name the Stories and the fix (a `depends_on` edge, or folding the shared edit
into one Story). The sibling knobs `failOnRegistryConflicts`,
`failOnMissingBddScaffold` and `failOnLargeFanOut` behave the same way.

## Tickets mode — authoring `supersedes[]`

In `--tickets` mode each Story carries a top-level `supersedes` array claiming
the source issues it replaces. It is bookkeeping, not part of the Story body,
so it is never serialized into the markdown:

```jsonc
{
  "slug": "close-superseded",
  "supersedes": [
    4525,
    { "id": 4529, "note": "The filed `--changed-only` fix is provably inert; the correction is recorded here." }
  ]
}
```

Entries are bare issue numbers, or `{ id, note }` when the plan has
something to say about *that* source issue — a correction to its analysis,
or why it was folded in with others. The optional `note` is rendered into
that issue's supersede comment, so planning that materially corrects a
source issue records the correction on the ticket rather than emitting
template-only prose.

### Supersede-map partition

`plan-persist` refuses a partial supersede map **before** it creates any
Story (mirroring `assertAcceptancePartition`): every id passed to
`--tickets` must be claimed by **exactly one** Story, and no Story may
claim an id that was not a source ticket. With N>1 the mapping is not
total by default — an authored map is the only thing that can say
`#11-#14 → #20` while `#15 → #21`, which a blanket "superseded by
this plan-run" reference could not.

## Critic dispatch detail

The **pre-mortem** critic fires on any of three deterministic triggers: the
draft ticket count reaching half the reviewability budget, a
`planning.riskHeuristics` phrase matching the plan text, or the
**external-dependency** probe finding an out-of-repo marker — a
scoped package the plan names that no repo manifest declares, a cross-repo
`github.com/<owner>/<repo>` reference, or an endpoint named as a service
prerequisite. That third trigger is what gives the default N=1 plan a cheap
viability check, since the size trigger is unreachable at one ticket and this
repo's resolved `riskHeuristics` is empty. The probe is conservative — explicit
markers only, so a plan naming no such artifact dispatches exactly as before.

```jsonc
{
  "consolidation": { "critic": "consolidation", "dispatch": false, "reasons": ["…"] },
  "premortem": { "critic": "pre-mortem", "dispatch": true, "reasons": ["…"] },
  "textHygiene": { "critic": "text-hygiene", "findings": [] }
}
```

The verdict's third entry, `textHygiene`, is advisory-only: it
carries deterministic body lints (`dangling-citation` / `open-question` /
`slicing-mass`) with no dispatch semantics — it spawns nothing and never
gates the run. Fold `textHygiene.findings[]` into the re-author round the
same way critic findings fold in: fix each named defect in `stories.json`
(anchor or inline the citation, resolve the question into a declarative
assumption, thin the Slicing checkpoint) and re-run the critic step. Empty
`findings` add nothing to the round.

**Dispatch shape.** When `delivery.routing.roleScopedAgents` is enabled (the
**default**), dispatch each firing critic with `subagent_type: plan-critic` —
it boots on the role-scoped [`plan-critic`](../../agents/plan-critic.md)
context (its own system prompt, no `CLAUDE.md` @-closure) that carries the
maker-blind invariant, the `consolidation` and `pre-mortem` charters, and the
output shape standalone. When the kill-switch is off
(`roleScopedAgents: false`) or the host cannot spawn at this depth, fall back
to a generic sub-agent and hand it the same charter (the `consolidation` /
`pre-mortem` definitions in [`plan-critic.md`](../../agents/plan-critic.md)).
**When both critics fire, dispatch them in a single turn.** Consolidation and
pre-mortem read the same immutable draft, share no write path, and neither
consumes the other's verdict — the textbook independent fan-out of
[`parallel-tooling.md`](parallel-tooling.md) Rule 3. Issue both `Agent` calls
together in one assistant turn rather than awaiting the first verdict before
spawning the second; serialized critics double the round's wall clock and buy
nothing, because you fold both verdicts into the same re-author round anyway.

Either way the critic is **maker-blind**: hand it the draft artifacts
(`stories.json`, and `techspec.md` when present) — never the authoring
transcript or the reasons the planner believed its own draft is sound. A
critic that reads the maker's case grades the case, not the draft.

## What `--dry-run` actually gates

`plan-persist.js --dry-run` is the same command with GitHub writes suppressed,
and every gate runs before the first `createIssue` would fire — the validator,
the body parse, the DAG, the capacity and Spec-budget ceilings, the
reachability check, the split and supersede partitions, and the Tech Spec fold.
That is the whole point of running it first: a dry run that comes back clean
has already paid for every deterministic refusal, so the real persist has
nothing left to discover except network failure.

## The container Epic (Gate #3)

Gate #3 has two branches, in this order: **adopt** an Epic that already exists,
else **create** a new one.

### Adopting an open Epic (any N)

`epicCandidates[]` in the plan-context envelope lists **every open `type::epic`
issue**, each `{ id, title, url, score, childIds }`, ranked by token overlap
between the seed and the Epic's title, `## Goal` and its children's titles. The
list is deliberately **complete rather than thresholded**: a low score is
evidence for the operator to weigh, and hiding a candidate is exactly how a
plan opens its second container for one body of work.

This branch fires at **any N, N=1 included** — "add this to the Epic we started
last week" is the single-Story case, and refusing it below three Stories would
leave the common follow-up plan with nowhere to file itself. The three-Story
threshold governs **creation** only, where it still holds: at two Stories a
pair of ids is as easy to carry as one container id.

On a yes, pass `--epic <id>`. Persist then:

1. resolves the id **before the first create** (dry run included) — it must be
   **open** and carry `type::epic`, or the run hard-errors having written
   nothing;
2. after the Stories exist, appends one `- [ ] #N` row per new Story to the
   Epic's checklist via `appendEpicChildIds`, which is idempotent and preserves
   existing rows' **checked state**, their order, and the fingerprint marker;
3. mirrors a native sub-issue edge per child.

The refusal posture is the **opposite** of creation's, deliberately. Creation
degrades (an unensurable label just skips the container) because the operator
never named one. Adoption cannot: the operator named a specific id, so silently
not adopting it would leave them believing their Stories were filed somewhere
they were not. Hence a hard error, raised while nothing has been written and
the fix is free. Once the Stories are live the posture flips back — a failed
checklist write or sub-issue edge only warns.

**Only open Epics are adoptable.** A closed Epic is a finished body of work;
joining one would reopen a container the epilogue deliberately closed and
re-scope a completed plan. Open a new container, or reopen the old one by hand.

`--epic` and `--epic-title`/`--epic-goal` are **mutually exclusive** — a run
either joins a container or opens one — and supplying both is a usage error
raised before any I/O.

### Creating a new container (N>2)

Above two Stories, `/mandrel-plan` offers to group them under one `type::epic`
container. Confirmed, persist opens it **after** the Stories — its body embeds
their issue numbers and its sub-issue edges need their database ids — and
links every created Story both ways it can: a `- [ ] #N` body checklist and a
native GitHub sub-issue edge. Both are written because each survives what the
other does not; the delivery-side reader unions them.

What the Epic must never carry: an `agent::*` label (that absence keeps it out
of the bare `/mandrel-deliver` ready list and outside the `type::story`-scoped
body lint), a `## Spec`, an `acceptance[]` / `verify[]`, or any path, finding
or rationale a child does not already hold. It is a container; unique content
here is content no delivering agent reads.

What the **Stories** never gain is an `Epic: #N` footer. Linkage is
parent→child only, which is exactly why every existing refusal of that footer
still stands and each Story stays independently deliverable (ADR
`20260905-5139`).

Degradation is deliberate: an unensurable `type::epic` label skips the Epic
entirely (an unlabelled container is not a container), while a failed
sub-issue edge only warns — the checklist still lists every child. Either way
the Stories are untouched and deliver by id. A resumed persist adopts an
existing Epic carrying the same fingerprint, which is keyed on the title **and
the exact child set**, so a run grouping different Stories never adopts the
wrong container.

## Cross-plan `depends_on` (`#<id>`)

A `depends_on[]` entry is read **lexically**: `some-slug` is a sibling inside
this plan, `#<id>` an **external** blocker already live on the tracker. The
second form is what lets a plan authored today wait on a Story an earlier plan
opened and never had to name.

`dependencyCandidates[]` in the envelope is the advisory prompt for it: open
`type::story` issues whose declared `changes[]` footprint intersects the seed's
`complexitySignals.predictedPaths`, each carrying the `overlappingPaths[]` that
matched. Overlap is computed on **declared footprints** and not on prose, using
the same `storyFootprint` the wave runner uses to withhold colliding Stories at
dispatch — so the planner sees the collision the runtime would later enforce,
one layer earlier and while it is still cheap to order around. A seed naming no
paths short-circuits to `[]` with no provider call at all.

It stays advisory: two Stories can touch a shared barrel file with no real
ordering between them, and only the operator knows.

External refs are **excluded from sibling ordering and cycle detection** —
a Story already open is not scheduled by this run, so it has no position in the
topological sort and cannot close a cycle back into a Story that does not exist
yet. They are validated **before any create** (dry run included): each must
resolve to an **open `type::story`**, and a closed issue, a container Epic, a
missing id or a non-Story hard-errors with every bad ref named in one pass. The
strictness is the point — a blocker that can never be satisfied reads to the
delivery engine as a permanent wedge rather than as an error worth reporting.

Persist renders the entry unchanged as a `blocked by #<id>` footer line and
mirrors the native `blocked_by` edge, which is the same pair of surfaces a
sibling edge produces. `/mandrel-deliver` therefore gates on it with no engine
change: `resolve-stories.js` has always resolved foreign blockers from live
state.

## Ready means fully persisted

`agent::ready` is the **terminal** step, not part of the creating POST.
The order is: create unlabelled → upsert `story-plan-state` on
every Story → upsert `plan-summary` on the primary → flip every Story to
`agent::ready`.

This is what lets `/mandrel-deliver` trust the label: a Story carrying
`agent::ready` always has its persist receipt on the ticket, so nothing can
pick it up mid-write and read a half-persisted plan.

## Resuming a failed persist

Persist is **idempotent over the same authored artifacts**. Each created body
carries an invisible plan fingerprint (derived from the Story's slug +
title), and persist indexes the open `type::story` backlog by it before
creating anything.

So if a transient GitHub failure strands the run at Story `k` of `N`:

| | Behaviour |
| --- | --- |
| The `1..k-1` Stories | Live, but **not** `agent::ready` — invisible to `/mandrel-deliver`, not half-delivered. |
| Re-running persist | Adopts them by fingerprint, creates only the missing ones, then flips the whole cohort ready. |
| Editing `stories.json` first | Changing a slug or title changes the fingerprint — the old issue is orphaned rather than adopted. Close it by hand. |

Just re-run the same command. Do not hand-delete the stranded issues first.

## Temp hygiene

A terminal-success run deletes its own `--plan-dir`. Every persist also reaps
abandoned `temp/plan-*` directories older than 7 days, so dry-runs, failed
gates, and abandoned authoring sessions do not accumulate under `temp/`.

## How the source ids reach persist

In `--tickets` mode persist needs to know which ids were fetched. It resolves
them **envelope-first**:

| Channel | When it wins |
| --- | --- |
| Envelope `sourceTickets[]` | **The normal path.** Written by step 1's `--out`, then read from `--plan-context <file>` or auto-discovered at `<plan-dir>/plan-context.json`. No ids to re-type. |
| `--source-tickets <ids>` | Explicit **override** for hand-driven runs (no captured envelope, or deliberately narrowing the set). Wins over the envelope; a disagreement is warned about, not silently reconciled. |

The result envelope's `supersede.sourceTicketOrigin` reports which channel was
used (`envelope` \| `flag` \| `none`).

Every path with no envelope is **audible** — persist cannot tell a legitimate
`--seed` run from a `--tickets` run whose envelope was never captured, so it
says so rather than deciding silently:

| Situation | Behaviour |
| --- | --- |
| Neither `--plan-dir` nor `--plan-context` | **Warn** — nothing was read; only `--source-tickets` can supply ids. |
| Auto-discovered `<plan-dir>/plan-context.json` absent | **Warn** — degrade to `--source-tickets`; a `--seed` run legitimately has none. |
| Explicit `--plan-context` missing | **Fatal** — the operator named a file and meant it. |
| Envelope present but unparseable | **Fatal** — a corrupt envelope is not "no source tickets"; treating it as such is how a `--tickets` run used to report success having superseded nothing. |

Whichever channel supplies them, the supersede-map partition above still
fail-closes: a `--tickets` run whose Stories forgot `supersedes[]` is now
**caught** (`source ticket #N is not claimed by any Story`) instead of
partitioning an empty set and passing vacuously.

## Closing superseded source tickets

**Default on.** After the Stories exist, persist comments on each source
issue naming the specific Story that claims it — plus that Story's optional
per-supersede `note` — and closes it with reason **`not_planned`**
(`state_reason`). Nothing has shipped at persist time and the issue will not
be actioned in its own right, so `not_planned` is the honest reason;
`completed` would be a lie. This is what keeps the tracker from asserting
that already-planned work is still unowned, and it writes down the supersede
link that makes the history readable.

| Behaviour | Contract |
| --- | --- |
| Default | Comment + close every source ticket as `not_planned`, **clearing its `agent::*` label** in the same write — a retired ticket has no agent state, and `agent::done` would claim a delivery that never happened. |
| `--no-close-superseded` | Skips all commenting and closing. Story creation is unchanged. Use it for a genuinely partial supersede — when the plan folded in only *part* of an issue and the remainder must stay open. |
| `--dry-run` | Posts no comment and closes nothing; reports what it would have done. |
| Re-run | Idempotent — the comment is keyed off a `superseded-by` structured-comment marker, and an already-closed source is skipped. |
| Already closed / deleted / inaccessible | Skipped and reported. Never throws. |
| Close-phase failure | **Never fails the run.** Stories stay created; the result envelope's `supersede` report names which tickets were and were not closed so the operator can finish by hand. |

`--seed` / `--seed-file` modes have no source tickets, so no close phase
runs at all.
