---
description: >-
  Phase 8 of sprint planning — decompose an Epic's PRD and Tech Spec into a
  Feature/Story/Task hierarchy, persist the backlog, and flip the Epic to
  `agent::ready`. Host-LLM authored; no external API calls.
---

# Sprint Plan — Decompose Phase (helper)

> **Helper module.** Not a slash command. Invoked by `/epic-plan` (Phase 8).
> To run the decompose phase interactively, use `/epic-plan [Epic_ID]` — it
> delegates here after the spec phase.

## Role

Director / Architect

## Context

This helper is the **decompose phase** of the split planning pipeline. It
reads the PRD and Tech Spec previously produced by the spec phase helper
([`epic-plan-spec.md`](epic-plan-spec.md)), generates the Feature / Story
/ Task ticket hierarchy, persists it to GitHub, and flips the Epic to
`agent::ready` (parking) so a human can run `/epic-deliver` when execution
should begin.

The ticket array is authored **directly by you, the host LLM**.
`epic-plan-decompose.js` is a deterministic wrapper that (a) emits the
authoring context you need and (b) validates, persists, and transitions the
Epic lifecycle state.

> **3-tier hierarchy (target shape — opt-in via `planning.hierarchy: '3-tier'`).**
> The decompose phase honours the `planning.hierarchy` flag resolved
> from `.agentrc.json` (default `'4-tier'`).
>
> - Under `'4-tier'` (default), the ticket array contains
>   `type::feature`, `type::story`, and `type::task` tickets; Stories
>   require ≥1 child Task and acceptance criteria live on Task bodies.
> - Under `'3-tier'`, the ticket array contains only `type::feature`
>   and `type::story` tickets — no `type::task` children are emitted.
>   Acceptance criteria and verification steps are inlined on the
>   Story body via the `acceptance[]` and `verify[]` fields. Story
>   dependencies that would have been expressed as cross-Task edges
>   are lifted to Story-level `depends_on`.
>
> Both shapes flow through `validateAndNormalizeTickets`; the
> validator branches on the flag and applies the appropriate
> cardinality rules. The decomposer system prompt (carried by the
> [`epic-plan-decompose-author`](../../skills/core/epic-plan-decompose-author/SKILL.md)
> skill) selects the matching authoring template. While Epic #3078
> is in flight both shapes are supported in parallel; after the
> destructive Feature 8 lands, the flag is removed and 3-tier
> becomes the only shape. See
> [`.agents/instructions.md` § 5.D](../../instructions.md) for the
> full contract.

## Constraint

- **Do not** run this skill until the spec phase is complete. The Epic must
  have linked `context::prd` and `context::tech-spec` issues; the script will
  refuse to proceed otherwise.
- **Do not** reassign Story / Task parents across Features after the
  decomposition writes — the `epic-plan-state` checkpoint records the
  structure as committed. Use `--force` to rebuild from scratch.
- **Every** temp file must include the Epic ID in its name. Multiple Epics
  may be decomposed concurrently; bare names will collide.
- **Do not** flip the Epic past `agent::ready` from this helper. Execution
  begins when an operator runs `/epic-deliver [Epic_ID]`.

## Prerequisites

1. **Epic is on `agent::review-spec`** — i.e. the spec phase has already run
   and the PRD / Tech Spec exist.
2. **API keys** — `GITHUB_TOKEN` set in `.env`.

## Step 1 — Gather decomposition context

```bash
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] --emit-context \
  > temp/epic-[Epic_ID]/decomposer-context.json
```

The emitted JSON contains the PRD body, Tech Spec body, risk heuristics, the
decomposer system prompt, and the `maxTickets` **reviewability budget**
(Story #2798 — not a hard cap; over-budget plans require an explicit
`--allow-over-budget` override at persist time).

## Step 2 — Author the ticket array

Read `temp/epic-[Epic_ID]/decomposer-context.json`. Produce a JSON array of
Feature / Story / Task objects that conforms to the schema in the system
prompt and write it to `temp/epic-[Epic_ID]/tickets.json`.

## Step 3 — Persist and transition

```bash
# Normal decomposition
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json

# Re-decompose (closes existing child Features/Stories/Tasks first)
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json --force

# Persist an over-budget plan (Story #2798 — only after the operator
# has confirmed the over_budget_rationale on the Epic)
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json --allow-over-budget
```

On success the script:

- Creates the Feature / Story / Task hierarchy under the Epic.
- Updates the `epic-plan-state` structured comment with the ticket count and
  decompose timestamp.
- Flips the Epic to `agent::ready`.

## Step 4 — Cross-validation

Delegate the structural invariants (hierarchy completeness, dependency DAG
acyclicity, missing complexity labels) to `epic-plan-healthcheck.js`. It is
the single source of truth for post-decompose validation — the Phase 10 run
inside `/epic-plan` calls the same script, so local and remote flows agree.

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

- Missing `type::feature` / `type::story` / `type::task` tickets.
- Stories without `complexity::` labels.
- Dependency cycles across Tasks.

For the semantic checks the healthcheck cannot automate, do these by eye:

- **Scope-overlap check**: Stories whose scope is "docs / runbook / README"
  downstream of a "config + runbook" Story in the same Epic should carry a
  scope-verification note pointing at
  `git diff main -- <path>` against the upstream Story branch.
- **Risk flagging**: Confirm `risk::high` Tasks match the heuristics in the
  decomposer context.

Fix any gaps by creating additional issues or updating existing ones.

## Step 5 — Cleanup

The wrapper script deletes the phase-scoped temp files automatically when
Step 3 succeeds — no operator action required. The cleanup contract lives in
[`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js), which
is the single source of truth for which temp paths this phase owns.

## Handoff

- Surface the backlog summary and the Wave 0 candidates to the operator:

  > "Decomposition complete. Epic #[ID] is on `agent::ready` with NN ticket(s)
  > across MM Stories. Run `/epic-deliver [Epic_ID]` to begin execution."

## Troubleshooting

- "Epic #N is missing a linked PRD or Tech Spec" — run `/epic-plan [Epic_ID]`
  first (it will run the spec phase if the PRD / Tech Spec are missing).
- Validator rejects the tickets file — the most common causes are a Story
  with no child Tasks, a Task whose `parent_slug` does not point at a Story,
  or cross-Story Task dependencies (which must be lifted to Story-level
  dependencies).
- If `--force` is required but the script refuses, confirm the Epic has the
  linked artifacts first — `--force` only re-decomposes; it does not bypass
  the spec-phase prerequisite.
