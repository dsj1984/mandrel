---
name: scope-triage
description:
  Optional split-advisory for `/plan`. Under v2 there is no epic|story routing
  verdict — `/plan` always authors Stories. Use this skill only when judging
  whether a draft should stay one Story or legitimately split (near-zero
  overlap or an architectural seam).
---

# scope-triage (split advisory)

## Policy Capsule

- There is **no** `epic | story | borderline` routing verdict in v2. `/plan`
  is a single path that emits **one Story by default**.
- This skill is an optional **split advisory**: should the author keep one
  Story, or does the seed clear the default-single split policy?
- Anchor sizing judgment to `DEFAULT_MODEL_CAPACITY` and
  `DELIVERABLE_GRANULARITY_GUIDANCE` in
  [`ticket-validator-sizing.js`](../../../scripts/lib/orchestration/ticket-validator-sizing.js).
  Do not restate numeric thresholds.
- Lead with **cohesion**: one Story is one coherent change with one reason
  to exist. Coupled work stays one Story and uses `## Slicing` for
  intra-session checkpoints.
- Emit an **advisory only** — `keep-single` (the default) or `split` with its
  seam/overlap rationale. **Never auto-route**: the operator decides, and
  `--yes` defaults to `keep-single`.

## Split policy (when N>1 is allowed)

Split into sibling Stories **only** when:

1. **Near-zero overlap** — genuinely independent capabilities that happen to
   share a seed idea, or
2. **Architectural seam** — different deployables, or a migration vs the
   feature that consumes it.

Otherwise keep one Story. Persist refuses coupled splits via
`assertAcceptancePartition` (identical AC text across Stories).

## Advisory output

Emit one of:

- `keep-single` — default; fold complexity into `## Spec` / `## Slicing`
- `split` — list the proposed Stories and the seam/overlap rationale

Never auto-route. The operator (or `--yes` default = `keep-single`) decides.
