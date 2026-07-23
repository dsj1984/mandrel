# /plan — on-demand reference appendix

> **Applies when:** you are executing [`/plan`](../plan.md) and hit one of the
> situations below — shape-derived complexity routing, `--tickets` supersede
> authoring, critic dispatch detail, a failed persist, or source-id
> resolution. The spine stays resident; this file is read on demand.

## Shape-derived complexity routing (`complexitySignals`)

Complexity routes on the **objective shape of the authored work**, never on
seed word count (Story #4722 — a detailed prompt can describe trivial work, a
terse one complex work; `maxSeedWords` is removed). The pipeline stages the
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
  each Story's own shape — `changes[]` count, acceptance-criteria count,
  creates-vs-refactors mix, glob-free footprint, and sensitive-path classes,
  against the framework `STORY_SHAPE_CEILINGS` — and **fails closed to
  `full`** when any Story exceeds them (the refusal is ledgered on the
  checkpoint too). The lite route is **not** licence to drop a
  non-negotiable — every decision's `preserves` field enumerates what still
  holds: the Story ticket, the PR-to-`main` landing, every repo quality gate,
  and the security baseline. Those gates run in `single-story-close.js`
  regardless of route.

**The label is a hint; deliver re-derives (Story #4722).** Persist labels a
lite cohort's Stories with **`route::lite`** as a *human-visible hint only* —
`/deliver` computes the route from each fetched Story body via the same shape
function at dispatch, so neither a lost label nor an unread marker can
misroute delivery: a lite-shaped Story executes **inline** (no story-worker
or acceptance-critic sub-agent boots) even with the label absent, and a
sensitive-footprint Story routes `full` and keeps its fresh critic even with
the label present. The `route::*` axis stays runtime-derived: hand-authored
`route::*` entries in `labels[]` are dropped by persist.

The knobs (`planning.complexityGate.{enabled, maxArtifacts}`) are documented
in [`.agents/docs/configuration.md`](../../docs/configuration.md) under
`### planning`; the defaults live on `DEFAULT_COMPLEXITY_GATE` and the shape
ceilings on `STORY_SHAPE_CEILINGS` in
[`lib/orchestration/complexity-gate.js`](../../scripts/lib/orchestration/complexity-gate.js).

## Correct-by-construction authoring template (Story #4723)

`plan-context.js --out` writes `stories.template.json` as a
**correct-by-construction** skeleton, built from the same repo snapshot the
`complexitySignals` probed:

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
- **Keep `## Spec` near contract-level prose.** Persist emits an
  **advisory** warning past ~250 words (`SPEC_SOFT_WORD_BUDGET`) — it never
  fails the persist, but it is the nudge toward the #4707 contract-level
  Spec (interfaces, invariants, load-bearing constraints; no per-file
  behavior narration). The hard fail-closed ceiling (~1500 tokens,
  `spec-spill.js`) is unchanged.

A faithfully-filled skeleton — placeholders replaced, pre-resolved entries
kept, tags valid — passes the persist ticket validators with no
round-trip.

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
`#4525-#4528 → #4530` while `#4529 → #4531`, which a blanket "superseded by
this plan-run" reference could not.

## Critic dispatch detail

The **pre-mortem** critic fires on any of three deterministic triggers: the
draft ticket count reaching half the reviewability budget, a
`planning.riskHeuristics` phrase matching the plan text, or the
**external-dependency** probe (Story #4700) finding an out-of-repo marker — a
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

The verdict's third entry, `textHygiene`, is advisory-only (Story #4599): it
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
Either way the critic is **maker-blind**: hand it the draft artifacts
(`stories.json`, and `techspec.md` when present) — never the authoring
transcript or the reasons the planner believed its own draft is sound. A
critic that reads the maker's case grades the case, not the draft.

## Ready means fully persisted

`agent::ready` is the **terminal** step, not part of the creating POST
(Story #4541). The order is: create unlabelled → upsert `story-plan-state` on
every Story → upsert `plan-summary` on the primary → flip every Story to
`agent::ready`.

This is what lets `/deliver` trust the label: a Story carrying
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
| The `1..k-1` Stories | Live, but **not** `agent::ready` — invisible to `/deliver`, not half-delivered. |
| Re-running persist | Adopts them by fingerprint, creates only the missing ones, then flips the whole cohort ready. |
| Editing `stories.json` first | Changing a slug or title changes the fingerprint — the old issue is orphaned rather than adopted. Close it by hand. |

Just re-run the same command. Do not hand-delete the stranded issues first.

## Temp hygiene

A terminal-success run deletes its own `--plan-dir`. Every persist also reaps
abandoned `temp/plan-*` directories older than 7 days, so dry-runs, failed
gates, and abandoned authoring sessions do not accumulate under `temp/`.

## How the source ids reach persist

In `--tickets` mode persist needs to know which ids were fetched. It resolves
them **envelope-first** (Story #4554):

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
| Default | Comment + close every source ticket as `not_planned`. |
| `--no-close-superseded` | Skips all commenting and closing. Story creation is unchanged. Use it for a genuinely partial supersede — when the plan folded in only *part* of an issue and the remainder must stay open. |
| `--dry-run` | Posts no comment and closes nothing; reports what it would have done. |
| Re-run | Idempotent — the comment is keyed off a `superseded-by` structured-comment marker, and an already-closed source is skipped. |
| Already closed / deleted / inaccessible | Skipped and reported. Never throws. |
| Close-phase failure | **Never fails the run.** Stories stay created; the result envelope's `supersede` report names which tickets were and were not closed so the operator can finish by hand. |

`--seed` / `--seed-file` modes have no source tickets, so no close phase
runs at all.
