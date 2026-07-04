---
description: >-
  Phase 8 of sprint planning — decompose an Epic's sectioned body (which
  carries the folded Tech Spec) into a
  backlog of child Stories, persist the backlog, and flip the Epic to
  `agent::ready`. Host-LLM authored; no external API calls.
---

# Sprint Plan — Decompose Phase (helper)

> **Helper module.** Not a slash command. Invoked by `/plan` (Phase 8).
> To run the decompose phase interactively, use `/plan [Epic_ID]` — it
> delegates here after the spec phase.

## Role

Director / Architect

## Context

This helper is the **decompose phase** of the split planning pipeline. It
reads the Epic body — whose managed sections carry the Tech Spec previously
produced by the spec phase
helper ([`epic-plan-spec.md`](epic-plan-spec.md)) — generates the Epic's child
Story tickets, persists them to GitHub, and flips the Epic to
`agent::ready` (parking) so a human can run `/deliver` when
execution should begin.

The ticket array is authored **directly by you, the host LLM**.
`epic-plan-decompose.js` is a deterministic wrapper that (a) emits the
authoring context you need and (b) validates, persists, and transitions the
Epic lifecycle state.

The ticket array contains `type::story` tickets only — no Feature
containers and no `type::task` children. Acceptance criteria and verification
steps are inlined on each Story body via the `acceptance[]` and
`verify[]` fields. The decomposer system prompt lives in the
[`epic-plan-decompose-author`](../../skills/core/epic-plan-decompose-author/SKILL.md)
skill.

## Constraint

- **Do not** run this skill until the spec phase is complete. The Epic body
  must carry Tech Spec content (the managed section or a `## Delivery
  Slicing` heading); the script will refuse to proceed otherwise.
- **Do not** restructure the Story set after the decomposition
  writes — the `epic-plan-state` checkpoint records the structure as
  committed. Use `--force` to rebuild from scratch.
- **Every** temp file must include the Epic ID in its name. Multiple Epics
  may be decomposed concurrently; bare names will collide.
- **Do not** flip the Epic past `agent::ready` from this helper. Execution
  begins when an operator runs `/deliver [Epic_ID]`.

## Prerequisites

1. **Epic is on `agent::review-spec`** — i.e. the spec phase has already run
   and the Epic body carries the Tech Spec sections.
2. **API keys** — `GITHUB_TOKEN` set in `.env`.

## Step 1 — Gather decomposition context

```bash
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] --emit-context \
  > temp/epic-[Epic_ID]/decomposer-context.json
```

The emitted JSON contains the Epic body (`epicBody` — the spec sections and
acceptance table travel inside it), risk heuristics, the
decomposer system prompt, and the `maxTickets` **reviewability budget**
(Story #2798 — not a hard cap; over-budget plans require an explicit
`--allow-over-budget` override at persist time).

## Step 2 — Author the ticket array

Read `temp/epic-[Epic_ID]/decomposer-context.json`. Produce a JSON array of
Story objects that conforms to the schema in the system prompt
and write it to `temp/epic-[Epic_ID]/tickets.json`.

When the Tech Spec carries a `## Delivery Slicing` section, author toward the
Architect's proposed shippable-Story clusters rather than mapping Epic
capabilities 1:1; degrade gracefully (current behaviour) when it is absent.

## Step 2.5 — Phase 8.3: Holistic Consolidation (HITL diff gate)

The decompose phase runs in the sequence **emit-context → author →
consolidate → validate+persist**. Step 2 is the *author* half; this step is
the *consolidate* half, a separate critic pass run **before** the
deterministic validator and **before** the GitHub write.

Activate the
[`epic-plan-consolidate`](../../skills/core/epic-plan-consolidate/SKILL.md)
skill with `[Epic_ID]` as input. It reads the draft
`temp/epic-[Epic_ID]/tickets.json` plus the Epic body (with its folded
Tech Spec sections) from
`decomposer-context.json`, reconciles the draft against the Tech Spec
`## Delivery Slicing` target (degrading gracefully when absent), and emits:

- a **consolidated** `temp/epic-[Epic_ID]/tickets.json` (overwriting the draft),
- a human-readable `temp/epic-[Epic_ID]/consolidation-report.md` (rationale +
  before/after diff).

The pass is constrained to scope-preserving operations only — **merge sibling
Stories and rewire `depends_on`**. It MUST NOT add scope or invent tickets.
It consolidates fragmented slices by merging them into a cohesive Story,
never by splitting one into two; the `assertAllTicketsAreStories` validator
(in `lib/orchestration/ticket-validator.js`) stays as the post-consolidation
backstop that rejects any non-Story ticket the pass might emit.

> **HITL diff gate.** Show the operator
> `temp/epic-[Epic_ID]/consolidation-report.md` (the before/after diff +
> rationale) **before** running the persist call in Step 3. Consolidation is
> never auto-applied without operator review — the operator approves the
> consolidated plan (or rejects it and the draft is persisted instead). Only
> after approval proceed to Step 3.

This sub-step does **not** renumber the top-level lifecycle phases (9–12); it
is a sub-step of Phase 8.

## Step 3 — Persist and transition

```bash
# Normal decomposition
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json

# Re-decompose (closes existing child Features/Stories first)
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json --force

# Persist an over-budget plan (Story #2798 — only after the operator
# has confirmed the over_budget_rationale on the Epic)
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json --allow-over-budget
```

On success the script:

- Creates the Feature / Story hierarchy under the Epic.
- Updates the `epic-plan-state` structured comment with the ticket count
  and decompose timestamp.
- Flips the Epic to `agent::ready`.

## Step 4 — Cross-validation

Delegate the structural invariants (hierarchy completeness, dependency DAG
acyclicity, missing complexity labels) to `epic-plan-healthcheck.js`. It is
the single source of truth for post-decompose validation — the Phase 10 run
inside `/plan` calls the same script, so local and remote flows agree.

```bash
node .agents/scripts/epic-plan-healthcheck.js --epic [Epic_ID] --paranoid
```

`--paranoid` is the flag that runs the richer hierarchy and dependency
checks; pair it with `--epic [Epic_ID]` so the script can fetch the
ticket tree. `--dry-run` exists as well but only emits the planned
checks without performing any I/O — it is not a substitute for
`--paranoid` when you need the hierarchy invariants validated.

The script exits 0 regardless of findings (non-blocking), but lists any
`ERR`-level findings that must be addressed before execution:

- Missing `type::story` tickets.
- Stories without `complexity::` labels.
- Dependency cycles across Stories.

For the semantic checks the healthcheck cannot automate, do these by eye:

- **Scope-overlap check**: Stories whose scope is "docs / runbook / README"
  downstream of a "config + runbook" Story in the same Epic should carry a
  scope-verification note pointing at
  `git diff main -- <path>` against the upstream Story branch.
- **Risk flagging**: Confirm `risk::high` Stories match the heuristics in
  the decomposer context.

Fix any gaps by creating additional issues or updating existing ones.

## Step 5 — Cleanup

The wrapper script deletes the phase-scoped temp files automatically when
Step 3 succeeds — no operator action required. The cleanup contract lives in
[`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js), which
is the single source of truth for which temp paths this phase owns.

## Handoff

- Surface the backlog summary and the Wave 0 candidates to the operator:

  > "Decomposition complete. Epic #[ID] is on `agent::ready` with NN ticket(s)
  > across MM Stories. Run `/deliver [Epic_ID]` to begin execution."

## Troubleshooting

- "Epic #N body carries no Tech Spec sections (no ## Delivery Slicing)" —
  run `/plan [Epic_ID]`
  first (it will run the spec phase if the Tech Spec sections are missing).
- Validator rejects the tickets file — the most common causes are a
  Story whose `parent_slug` does not point at a Feature, a missing
  `acceptance[]` / `verify[]` array on a Story body, or a Story
  `depends_on` slug that does not resolve to another Story in the same
  Epic.
- If `--force` is required but the script refuses, confirm the Epic has the
  linked artifacts first — `--force` only re-decomposes; it does not bypass
  the spec-phase prerequisite.
