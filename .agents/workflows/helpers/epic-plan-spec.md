---
description: >-
  Phase 7 of sprint planning — generate the PRD and Tech Spec for an Epic,
  persist them as linked GitHub issues, and flip the Epic to
  `agent::review-spec`. Host-LLM authored; no external API calls.
---

# Sprint Plan — Spec Phase (helper)

> **Helper module.** Not a slash command. Invoked by `/plan` (Phase 7).
> To run the spec phase interactively, use `/plan [Epic_ID]` — it
> delegates here.

## Role

Director / Architect

## Context

This helper is the **spec phase** of the split planning pipeline. It produces
**three** planning artifacts for an Epic — a Product Requirements Document, a
Technical Specification, and an Acceptance Spec — persists them as
`context::prd`, `context::tech-spec`, and `context::acceptance-spec` issues
under the Epic, and flips the Epic to `agent::review-spec` (parking) so a human
reviewer can read the artifacts on GitHub before decomposition.

> **Single prose home.** The canonical, full-detail spec-phase contract
> (idempotent context tickets, the three-ticket rationale, the
> `acceptance::n-a` waiver, the Epic-lease preflight) lives in
> [`epic-plan.md` § Phase 7](plan-epic.md). This helper carries only the
> operational step list; when the two disagree, `epic-plan.md` wins.

The PRD and Tech Spec are authored **directly by you, the host LLM**.
`epic-plan-spec.js` is a deterministic wrapper that (a) emits the authoring
context you need and (b) persists the artifacts and transitions the Epic
lifecycle state.

The complementary Phase 8 helper is
[`epic-plan-decompose.md`](epic-plan-decompose.md). The `/plan`
wrapper chains both helpers with a confirmation gate in between.

## Constraint

- **Do not** create or modify tickets outside the `context::prd` /
  `context::tech-spec` / `context::acceptance-spec` contract —
  decomposition belongs to
  [`epic-plan-decompose.md`](epic-plan-decompose.md).
- **Do not** flip the Epic to `agent::ready` from this skill. The terminal
  label for the spec phase is `agent::review-spec`.
- **Every** temp file must include the Epic ID in its name. Multiple Epics may
  be planned concurrently; bare names like `temp/prd.md` will collide.
- **Stop and hand back to the operator** after Step 4 when
  `planningRisk.requiresReview` is true or the operator passed
  `--force-review` — do not chain into decomposition. Low-risk Epics
  auto-proceed to Phase 8 after the persist stdout confirms
  `reviewRouting.decision === 'auto-proceed'`.

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

## Step 3.5 — Author the risk verdict

Judge the change described by the PRD and Tech Spec you just wrote and
write `temp/epic-[Epic_ID]/risk-verdict.json` conforming to
[`risk-verdict.schema.json`](../../schemas/risk-verdict.schema.json):
`{ axes: [{ axis, level, rationale }], summary }`. The authoritative
authoring rules (axis vocabulary, judgment-not-keywords, derivation
preview) live in the
[`epic-plan-spec-author` Skill, Step 4](../../skills/core/epic-plan-spec-author/SKILL.md).

## Step 3.6 — Author the Acceptance Spec

Using `systemPrompts.acceptanceSpec`, the PRD, and the Tech Spec, write the
Acceptance Spec to `temp/epic-[Epic_ID]/acceptance-spec.md`. It captures the
stable-ID acceptance criteria table
(`| AC ID | Outcome | Feature File | Scenario | Disposition |`) that drives
close-time reconciliation in `/deliver` Phase 6.

**Skip this step only** when the Epic carries the `acceptance::n-a` waiver
label (refactor-only or docs-only Epics); in that case omit `--acceptance-spec`
from Step 4.

## Step 4 — Persist and transition

```bash
# Normal flow (three context tickets)
node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
  --prd temp/epic-[Epic_ID]/prd.md \
  --techspec temp/epic-[Epic_ID]/techspec.md \
  --risk-verdict temp/epic-[Epic_ID]/risk-verdict.json \
  --acceptance-spec temp/epic-[Epic_ID]/acceptance-spec.md

# Re-plan (--force overwrites the three context tickets in place)
node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
  --prd temp/epic-[Epic_ID]/prd.md \
  --techspec temp/epic-[Epic_ID]/techspec.md \
  --risk-verdict temp/epic-[Epic_ID]/risk-verdict.json \
  --acceptance-spec temp/epic-[Epic_ID]/acceptance-spec.md --force

# Waived (acceptance::n-a label on Epic — no Acceptance Spec authored)
node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
  --prd temp/epic-[Epic_ID]/prd.md \
  --techspec temp/epic-[Epic_ID]/techspec.md \
  --risk-verdict temp/epic-[Epic_ID]/risk-verdict.json
```

On success the script:

- Validates the risk verdict against `risk-verdict.schema.json` (a
  malformed verdict fails closed before any GitHub mutation) and derives
  the `planningRisk` envelope from it.
- Creates `[PRD]`, `[Tech Spec]`, and `[Acceptance Spec]` child issues
  (`context::prd` / `context::tech-spec` / `context::acceptance-spec`
  labels). The Acceptance Spec is skipped when `--acceptance-spec` is
  omitted under the `acceptance::n-a` waiver.
- Appends a `## Planning Artifacts` section to the Epic body.
- Upserts the `risk-verdict` structured comment recording the verdict and
  the derived envelope.
- Upserts the `epic-plan-state` structured comment with the current phase,
  PRD / Tech Spec / Acceptance Spec IDs, the `riskVerdict` field, and
  timestamps.
- Flips the Epic to `agent::review-spec`.

## Step 5 — Cleanup

The wrapper script deletes the phase-scoped temp files automatically when
Step 4 succeeds — no operator action required. The cleanup contract lives in
[`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js), which
is the single source of truth for which temp paths this phase owns. If you
need to inspect the temp artefacts after the fact, re-run
`epic-plan-spec.js --emit-context` to regenerate the planner context.

## Handoff

Branch on the shared planning risk decision surfaced in the persist stdout
JSON (`planningRisk`, `reviewRouting`):

- **High risk or `--force-review` — STOP.** Surface the PRD and Tech Spec
  URLs to the operator:

  > "Spec phase complete for Epic #[ID]. Review PRD (#XX) and Tech Spec (#YY)
  > on GitHub. When you're ready, re-run `/plan [Epic_ID]` — the wrapper
  > will pick up where it left off and run the decompose phase."

- **Low risk — auto-proceed.** Relay `reviewRouting.operatorMessage` and
  continue directly to Phase 8 decomposition without waiting for verbal
  approval in this session.

## Troubleshooting

- If `--emit-context` fails with "Epic not found", confirm the ID matches the
  GitHub issue number and the token has `issues:read`.
- If the persist call fails after creating the PRD but before the Tech Spec,
  re-run with `--force` (the script reuses the existing PRD when appropriate).
- If the Epic does not flip to `agent::review-spec` after the script claims
  success, the label write likely races with a concurrent mutation — re-run the
  persist step; it's idempotent against the existing PRD/Tech Spec.
