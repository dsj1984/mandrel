# /plan — on-demand reference appendix

> **Applies when:** you are executing [`/plan`](../plan.md) and hit one of the
> situations below — the ceremony-lite route, `--tickets` supersede authoring,
> critic dispatch detail, a failed persist, or source-id resolution. The spine
> stays resident; this file is read on demand.

## Ceremony-lite complexity gate (`complexityRoute`)

The envelope's `complexityRoute` field is a **deterministic, conservative**
plan-time gate (Story #4683) that routes a genuinely trivial single-artifact
seed onto a collapsed path so it stops paying the full two-session
plan/deliver ceremony that measurably buys no quality at that size:

- **`route: "lite"`** — a trivial scope (seed ≤ `maxSeedWords` words **and** ≤
  `maxArtifacts` enumerated items). Collapse the ceremony: author **one minimal
  Story** and skip the fresh-critic / Tech-Spec ceremony a one-artifact scope
  does not earn. The lite route is **not** licence to drop a non-negotiable —
  its `preserves` field enumerates exactly what still holds: the Story ticket,
  the PR-to-`main` landing, every repo quality gate, and the security baseline.
  Those gates still run in `single-story-close.js` regardless of route.
- **`route: "full"`** — everything else. The gate fails toward `full` on any
  doubt (empty seed, over the word ceiling, a multi-capability enumeration, or
  the gate disabled via `planning.complexityGate.enabled=false`), so a real
  capability slice never loses ceremony. Author normally under the split policy.

**Planner downgrade (audited, Story #4707).** Seed word count is a poor
complexity proxy, so a `full` verdict you judge genuinely trivial (one
artifact, one obvious change) may be downgraded to `lite` — but **only** by
passing `--route-downgrade-reason "<why>"` to persist. The reason is recorded
on every created Story's `story-plan-state` checkpoint, making the judgment
auditable; without a recorded reason the deterministic verdict stands, and the
gate itself is unchanged (it still fails toward `full`).

**The route persists with the Story (Story #4707).** Persist labels every
Story of a lite-routed plan with the **`route::lite`** marker and ledgers the
route (including any downgrade reason) on its `story-plan-state` checkpoint;
a full-routed Story carries no marker. `/deliver` reads the marker to execute
a lite Story **inline** — no story-worker or acceptance-critic sub-agent
boots — while every `single-story-close.js` gate runs unchanged. The
`route::*` axis is runtime-derived: hand-authored `route::*` entries in
`labels[]` are dropped by persist.

The threshold and its override knob (`planning.complexityGate.{enabled,
maxSeedWords, maxArtifacts}`) are documented in
[`.agents/docs/configuration.md`](../../docs/configuration.md) under
`### planning`; the defaults live on `DEFAULT_COMPLEXITY_GATE` in
[`lib/orchestration/complexity-gate.js`](../../scripts/lib/orchestration/complexity-gate.js).

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
