---
description: >-
  Phase 1 of sprint planning — generate the PRD and Tech Spec for an Epic,
  persist them as linked GitHub issues, and flip the Epic to
  `agent::review-spec`. Host-LLM authored; no external API calls.
---

# Sprint Plan — Spec Phase (helper)

> **Helper module.** Not a slash command. Invoked by `/epic-plan` (Phase 1).
> To run the spec phase interactively, use `/epic-plan [Epic_ID]` — it
> delegates here.

## Role

Director / Architect

## Context

This helper is the **spec phase** of the split planning pipeline. It produces a
Product Requirements Document and a Technical Specification for an Epic,
persists them as `context::prd` and `context::tech-spec` issues under the
Epic, and flips the Epic to `agent::review-spec` (parking) so a human reviewer
can read the artifacts on GitHub before decomposition.

The PRD and Tech Spec are authored **directly by you, the host LLM**.
`epic-plan-spec.js` is a deterministic wrapper that (a) emits the authoring
context you need and (b) persists the artifacts and transitions the Epic
lifecycle state.

The complementary Phase 2 helper is
[`epic-plan-decompose.md`](epic-plan-decompose.md). The `/epic-plan`
wrapper chains both helpers with a confirmation gate in between.

## Constraint

- **Do not** create or modify tickets outside the `context::prd` /
  `context::tech-spec` contract — decomposition belongs to
  [`epic-plan-decompose.md`](epic-plan-decompose.md).
- **Do not** flip the Epic to `agent::ready` from this skill. The terminal
  label for the spec phase is `agent::review-spec`.
- **Every** temp file must include the Epic ID in its name. Multiple Epics may
  be planned concurrently; bare names like `temp/prd.md` will collide.
- **Stop and hand back to the operator** after Step 4 — do not chain into
  decomposition. The human must confirm the PRD/Tech Spec on GitHub before the
  next phase starts.

## Prerequisites

1. **GitHub Epic** — an open issue with the `type::epic` label. The Epic's
   body should contain enough narrative context to seed the PRD.
2. **API keys** — `GITHUB_TOKEN` set in `.env`.

## Step 1 — Gather authoring context

Run the spec-phase CLI in context-emission mode to collect the Epic body, the
scraped project docs, and the recommended system prompts.

```bash
node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] --emit-context \
  > temp/epic-[Epic_ID]/planner-context.json
```

## Step 2 — Author the PRD

Read `temp/epic-[Epic_ID]/planner-context.json`. Using `systemPrompts.prd`
combined with the Epic title/body, write the PRD markdown to
`temp/epic-[Epic_ID]/prd.md`. Use the four-section structure (Context & Goals,
User Stories, Acceptance Criteria, Out of Scope) and start the document with
`## Overview` (no `<h1>`).

## Step 3 — Author the Tech Spec

Using `systemPrompts.techSpec`, the PRD you just wrote, and `docsContext`,
write the Tech Spec to `temp/epic-[Epic_ID]/techspec.md`. Start with
`## Technical Overview` (no `<h1>`).

## Step 4 — Persist and transition

```bash
# Normal flow
node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
  --prd temp/epic-[Epic_ID]/prd.md \
  --techspec temp/epic-[Epic_ID]/techspec.md

# Re-plan (regenerates an existing PRD / Tech Spec)
node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
  --prd temp/epic-[Epic_ID]/prd.md \
  --techspec temp/epic-[Epic_ID]/techspec.md --force
```

On success the script:

- Creates `[PRD]` and `[Tech Spec]` child issues (`context::prd` /
  `context::tech-spec` labels).
- Appends a `## Planning Artifacts` section to the Epic body.
- Upserts the `epic-plan-state` structured comment with the current phase,
  PRD / Tech Spec IDs, and timestamps.
- Flips the Epic to `agent::review-spec`.

## Step 5 — Cleanup

The wrapper script deletes the phase-scoped temp files automatically when
Step 4 succeeds — no operator action required. The cleanup contract lives in
[`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js), which
is the single source of truth for which temp paths this phase owns. If you
need to inspect the temp artefacts after the fact, re-run
`epic-plan-spec.js --emit-context` to regenerate the planner context.

## Handoff

- **STOP** — do not proceed to decomposition. Surface the PRD and Tech Spec
  URLs to the operator:

  > "Spec phase complete for Epic #[ID]. Review PRD (#XX) and Tech Spec (#YY)
  > on GitHub. When you're ready, re-run `/epic-plan [Epic_ID]` — the wrapper
  > will pick up where it left off and run the decompose phase."

## Troubleshooting

- If `--emit-context` fails with "Epic not found", confirm the ID matches the
  GitHub issue number and the token has `issues:read`.
- If the persist call fails after creating the PRD but before the Tech Spec,
  re-run with `--force` (the script reuses the existing PRD when appropriate).
- If the Epic does not flip to `agent::review-spec` after the script claims
  success, the label write likely races with a concurrent mutation — re-run the
  persist step; it's idempotent against the existing PRD/Tech Spec.
