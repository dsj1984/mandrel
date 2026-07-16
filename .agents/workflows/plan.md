---
description:
  Unified planning entry point. Interrogate → author → persist. Emits one
  Story by default (folded Tech Spec in the Story body); splits into N>1
  only under the default-single split policy.
---

# /plan --seed "<text>" | --seed-file <path> | --tickets <ids>

## Role

Single planning path. `/plan` owns the full ceremony — there is no
Epic/Story router, no scope-triage `epic|story` verdict, and no
`deliveryShape`. Two operator modes only:

1. **Text** — seed from chat or a file.
2. **Tickets** — analyze existing issue(s) into proper Stories.

Audit findings become Stories via [`/audit-to-stories`](audit-to-stories.md)
(separate workflow), which hands off with `--emit-plan-seed` →
`/plan --seed-file <path>`.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/plan --seed "<text>"` | Ideation from chat text: interrogate → author **one Story by default** → persist. |
| `/plan --seed-file <path>` | Author from on-disk notes / plan seed (e.g. audit-to-stories handoff). |
| `/plan --tickets 123[,456…]` | Fetch issue(s), analyze into proper Stories (prefer N=1 rewrite). |

`--body` is **not** a `/plan` entry. Persist always goes through
`plan-persist.js --stories …`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--seed "<text>"` | Seed text for ideation. |
| `--seed-file <path>` | Pre-authored notes / plan-seed path. |
| `--tickets <ids>` | Comma-separated issue ids to analyze. Closed as superseded at persist (see below). |
| `--no-close-superseded` | Keep the `--tickets` source issues open — no supersede comment, no close. |
| `--force-review` | STOP at gate #2 for operator review of the assembled plan. The only thing that gates review — there is no risk-derived routing (Story #4542). |
| `--allow-over-budget` | Permit a plan that exceeds `maxTickets` (rare N>1). |
| `--yes` | Non-interactive: auto-proceed gate #1 and gate #2 HITL waits. |
| `--dry-run` | Author + validate without GitHub writes. Run it as a pre-pass before every real persist (see below). |

## Default-single split policy

Author **one Story** unless:

1. the pieces have **near-zero overlap** (genuinely independent capabilities), or
2. there is an **architectural seam** (different deployables, migration vs consumer).

Coupled work stays one Story — decompose it inside `## Slicing` as
intra-session checkpoints, not sibling tickets. When N>1, every acceptance
criterion must belong to exactly one Story; `plan-persist` runs
`assertAcceptancePartition` and refuses coupled splits.

**N=1 is the lean path:** one authoring prompt, folded `## Spec` in the
Story body, light risk/critic profile. Do not run Epic-scale decompose,
clarity, or reconciler ceremony for a single Story.

## Procedure

### 1. Interrogate

```bash
node .agents/scripts/plan-context.js --seed "<seed>" \
  --out temp/plan-<slug>/plan-context.json
# or: --seed-file <path>
# or: --tickets 123,456
```

**Always pass `--out temp/plan-<slug>/plan-context.json`.** The CLI writes the
envelope there (creating parent dirs); persist auto-discovers that file from
`--plan-dir` and derives the `--tickets` source ids from its `sourceTickets[]`.
That is what makes superseding work without anyone re-typing ids
(Story #4554). The envelope still goes to stdout too, so piping is unaffected.

The envelope carries docs context, codebase snapshot, BDD probe, risk
heuristics, the story-author system prompt, `sourceTickets[]` (`--tickets`
mode), and `duplicates[]` (open **Stories** whose title/body overlap the
seed — never Epics).
Under `--yes`, do not ask free-form operator questions — unresolved
unknowns land in Key Assumptions.

**Gate #1** — STOP to confirm the sharpened plan intent and any
duplicate-candidate review. Under `--yes`, auto-proceed.

### 2. Author

Write artifacts under `temp/plan-<slug>/`:

- `stories.json` — array of Story tickets (**length 1 by default**). Each
  body uses the canonical `story-body` shape (`## Goal`, optional
  `## Slicing`, optional `## Spec`, `## Changes`, `## Acceptance`,
  `## Verify`, …). The Story is the single executable document: put lean
  approach prose in `## Spec`, binding criteria in top-level
  `acceptance[]` / `verify[]` (persist syncs them into the body). Do not
  restate Goal/Acceptance inside Spec. Over-budget Specs fail closed —
  split the Story or tighten Spec; never write Specs under `docs/`.
- optional `techspec.md` — **N===1 only** convenience when Spec was authored
  outside the Story JSON; persist folds it into that Story's `## Spec`.
  Forbidden for N>1 (each Story must carry its own Spec).
- optional `acceptance-manifest.json` — plan-level AC list (a JSON
  `string[]`) for partition coverage when N>1. Pass it to persist as
  `--plan-acceptance` or it is not read.

For N=1, use the envelope `systemPrompts.story` and emit one cohesive
Story. Split only under the policy above.

**Tickets mode — author `supersedes[]` on every Story.** In `--tickets`
mode each Story carries a top-level `supersedes` array claiming the source
issues it replaces. It is bookkeeping, not part of the Story body, so it is
never serialized into the markdown:

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

### 3. Persist

**Gate #2** — when the operator passed `--force-review`, STOP for approval of
the assembled plan before persist. Under `--yes`, auto-proceed.

`--force-review` is the **only** thing that raises this gate. Story #4542
retired the risk-derived alternative: the planner authored its own risk verdict,
persist computed a `requiresStop` from it *after* `createStoryIssues` had already
run, and nothing read the result — the STOP was prose executed by the same
session that wrote the verdict. A gate a plan can lower for itself is not a gate.

#### Dry-run pre-pass (always)

Run persist with `--dry-run` **before** the real one. It is the same command
with the same flags — only the GitHub writes are suppressed:

```bash
node .agents/scripts/plan-persist.js \
  --stories temp/plan-<slug>/stories.json \
  [--plan-acceptance temp/plan-<slug>/acceptance-manifest.json] \
  [--tech-spec temp/plan-<slug>/techspec.md] \
  --plan-dir temp/plan-<slug> \
  --dry-run
```

Every gate — ticket validator, body parse, subject-prefix, DAG, capacity,
budget, reachability, split-policy and supersede partitions, Spec fold —
runs **before** the first `createIssue`, so a dry-run exercises all of them
write-free. An authoring mistake surfaces here, where the fix costs one
re-author, instead of after `k` of `N` Stories are already live.

#### The real persist

```bash
node .agents/scripts/plan-persist.js \
  --stories temp/plan-<slug>/stories.json \
  [--plan-acceptance temp/plan-<slug>/acceptance-manifest.json] \
  [--tech-spec temp/plan-<slug>/techspec.md] \
  [--plan-dir temp/plan-<slug>] \
  [--plan-context temp/plan-<slug>/plan-context.json] \
  [--source-tickets 123,456] \
  [--no-close-superseded] \
  [--force-review] \
  [--allow-over-budget]
```

Pass `--plan-acceptance` whenever step 2 wrote an `acceptance-manifest.json`
— it is what `assertAcceptancePartition` checks the N>1 split against.

Persist creates Story issue(s) with `type::story` (plus any sanitized
authored `labels[]`) and, when N>1, writes each authored `depends_on` edge
into the sibling's body as a `blocked by #<id>` footer — the ordering
`/deliver` resolves from. No batch label is applied (Story #4540 retired
`plan-run::<id>`). Ends by naming the exact command:
`/deliver <storyId> [<storyId> ...]`.

stdout is a pure JSON result; all log lines go to stderr, so a headless
driver can `JSON.parse` the stdout stream directly.

#### Ready means fully persisted

`agent::ready` is the **terminal** step, not part of the creating POST
(Story #4541). The order is: create unlabelled → upsert `story-plan-state` on
every Story → upsert `plan-summary` on the primary → flip every Story to
`agent::ready`.

This is what lets `/deliver` trust the label: a Story carrying
`agent::ready` always has its persist receipt on the ticket, so nothing can
pick it up mid-write and read a half-persisted plan.

#### Resuming a failed persist

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

#### Temp hygiene

A terminal-success run deletes its own `--plan-dir`. Every persist also reaps
abandoned `temp/plan-*` directories older than 7 days, so dry-runs, failed
gates, and abandoned authoring sessions do not accumulate under `temp/`.

### How the source ids reach persist

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

### Closing superseded source tickets

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

## Constraints

- `/plan` never starts delivery.
- No Epic ticket is opened. No reconciler. No `delivery::single` marker.
- Duplicate search targets open Stories (`type::story`), not Epics.
- Deterministic gates (ticket validator, split policy, reachability, budget)
  still fail closed under `--yes`.

## See also

- [`/deliver`](deliver.md) — delivery entry point (`/deliver <storyId>`).
- [`/audit-to-stories`](audit-to-stories.md) — audit findings → plan seed →
  `/plan --seed-file`.
- [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) — optional
  split-advisory notes only (no routing verdict).
