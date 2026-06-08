---
name: epic-plan-consolidate
description: >-
  Run a holistic, pre-persist consolidation pass over the draft Feature/Story
  ticket array an Epic's decompose phase produced. Use during Phase 8 of
  `/epic-plan`, after `epic-plan-decompose-author` writes
  `temp/epic-<Epic_ID>/tickets.json` and before `epic-plan-decompose.js`
  validates and persists it. Reconciles the draft against the Tech Spec
  "Delivery Slicing" target via scope-preserving operations only.
allowed_tools:
  - Read
  - Write
  - Bash
---

# epic-plan-consolidate

## Policy Capsule

- Run only after `epic-plan-decompose-author` has written `temp/epic-<Epic_ID>/tickets.json`; fail loudly if the draft array is missing. Read the PRD / Tech Spec from `temp/epic-<Epic_ID>/decomposer-context.json` (the same envelope the author skill consumed) — never re-fetch from GitHub, and never call the GitHub API from this Skill.
- Emit exactly two artifacts inside `temp/epic-<Epic_ID>/`: the **consolidated** `tickets.json` (overwriting the draft array in place) and a human-readable `consolidation-report.md` (the rationale + before/after diff the operator reviews at the HITL gate). Both MUST exist before returning.
- **Scope conservation is the load-bearing invariant.** You are a *critic*, not a second author: you MUST NOT add scope, invent tickets, or drop acceptance criteria. Every acceptance item and every `verify` entry present in the draft MUST survive into the consolidated array (possibly re-homed onto a merged Story). The downstream validator re-checks your output, so an invalid plan is rejected — but conserving scope is *your* contract, asserted by a test that feeds an over-fragmented draft and checks the union of acceptance/verify is unchanged.
- Your operations are constrained to exactly four shapes: **(1) merge two or more Stories** into one (union their `changes`/`acceptance`/`verify`/`references`, keep one coherent `goal`); **(2) collapse a single-Story Feature** into a sibling Feature (re-parent its lone Story, drop the empty Feature) — **never** by manufacturing a second Story; **(3) re-parent** a Story to a different sibling Feature; **(4) rewire `depends_on`** so the edges still reference surviving sibling-Story slugs. No other mutation is permitted.
- Consume the Tech Spec **"Delivery Slicing"** section as the authoritative target grouping when one is present: cluster the draft's Stories toward the N shippable Stories the Architect proposed. When the section is **absent**, degrade gracefully — apply only the cohesion + single-Story-Feature rules below and leave the rest of the draft shape intact.
- Implement rec #2: resolve every single-Story Feature by **collapsing** it into a sibling (operation 2), not by splitting its lone Story into two. The `assertNoSingleStoryFeature` validator from Story #3777 stays as the post-consolidation backstop — your output must already satisfy it.
- Apply the same cohesion heuristic the author skill leads with: **one Story = one coherent change with one reason to exist**, and the **single-consumer merge rule** (a Story whose only consumer is one sibling Story is merged into that sibling). Lead every merge decision with the change's reason, not its file count.
- After every merge / collapse / re-parent, **rewire `depends_on`**: drop self-edges, collapse edges that now point at the absorbing Story onto itself, and re-point any edge that named a now-deleted slug at its surviving successor. Never leave a `depends_on` referencing a slug absent from the consolidated array — the validator HARD-rejects unknown deps.
- The consolidation report MUST name each operation applied (merged slugs → surviving slug, collapsed Feature → sibling, re-parented Story, rewired edges) with a one-line reason, plus a before/after Story-count line, so the operator can approve or reject at the HITL diff gate before the persist call.

## Role

Senior Project Manager + Orchestrator, acting as a **holistic critic** with
fresh context. This Skill is deliberately *separate* from
`epic-plan-decompose-author` (the generator): a same-pass self-critique is the
weak mode this is built to escape. The generator maps PRD capabilities to
Stories ~1:1; this critic steps back and looks at the *whole* decomposition
against the Tech Spec's intentional grouping before any GitHub write.

## When to use

`/epic-plan` Phase 8, as the **8.3 — Holistic Consolidation** sub-step:
immediately after `epic-plan-decompose-author` writes
`temp/epic-<Epic_ID>/tickets.json` and **before**
`epic-plan-decompose.js --tickets …` validates and persists. The pass operates
on the temp artifact so the holistic adjustment happens before the GitHub
write; the deterministic validator runs *after* it, so the critic can never
emit a plan the validator would reject.

## Inputs

The dispatcher passes the Epic ID as the Skill argument. The Skill itself
reads:

- `temp/epic-<Epic_ID>/tickets.json` — the **draft** Feature/Story array the
  `epic-plan-decompose-author` Skill wrote. This is the consolidation input.
- `temp/epic-<Epic_ID>/decomposer-context.json` — the authoring envelope
  emitted by `epic-plan-decompose.js --emit-context`. Read `prd.body` /
  `prd` and `techSpec.body` / `techSpec` from it. The **"Delivery Slicing"**
  section (authored by `epic-plan-spec-author` in the Tech Spec) is the
  target grouping when present; degrade gracefully when it is absent.

## Outputs

- `temp/epic-<Epic_ID>/tickets.json` — the **consolidated** array, overwriting
  the draft. Same schema as the author skill emits (Feature → Story; Stories
  carry top-level `acceptance[]` / `verify[]`; `body` is a serialized string).
  The downstream `epic-plan-decompose.js --tickets …` validator is the final
  gate — author for its rules, not for "looks right."
- `temp/epic-<Epic_ID>/consolidation-report.md` — a human-readable
  rationale + before/after diff. This is the artifact the workflow shows the
  operator at the HITL diff gate before the persist call.

Both files MUST exist before the Skill returns.

## Procedure

### Step 1 — Load the draft and the target

Read `temp/epic-<Epic_ID>/tickets.json` (the draft array) and
`temp/epic-<Epic_ID>/decomposer-context.json` (for the PRD / Tech Spec). Locate
the Tech Spec **"Delivery Slicing"** section. Pin two facts before mutating
anything:

1. The **target grouping** — the N shippable Stories the Architect proposed in
   Delivery Slicing, or `null` when the section is absent (graceful-degrade
   mode: cohesion + single-Story-Feature rules only).
2. The **draft Story count per Feature** — so you can spot single-Story
   Features and over-fragmented capability clusters.

### Step 2 — Plan the consolidation

For each Feature, decide which Stories merge, which collapse, which re-parent:

- **Single-Story Feature** → collapse its lone Story into a sibling Feature
  whose capability is closest (Delivery-Slicing target, else thematic
  proximity). Drop the now-empty Feature. Never split the lone Story.
- **Over-fragmented capability** → when several draft Stories map to one
  Delivery-Slicing target (or one coherent reason to exist), merge them into a
  single Story: union their `changes` / `acceptance` / `verify` / `references`,
  write one `goal` naming the parent Feature, and keep the union of labels.
- **Single-consumer Story** → merge into the one sibling that consumes it.

Record each decision with its one-line reason for the report.

### Step 3 — Rewire dependencies and conserve scope

After applying the operations:

- **Rewire `depends_on`**: drop self-edges, re-point any edge that named a
  deleted slug at its surviving successor, and dedupe. No `depends_on` may
  reference a slug absent from the consolidated array.
- **Conserve scope**: assert the union of all `acceptance` items and all
  `verify` entries across the consolidated array equals the union across the
  draft. Nothing is dropped; nothing new is invented. If you cannot preserve an
  item, you have over-reached — back the operation out.

### Step 4 — Write both artifacts

Write the consolidated array to `temp/epic-<Epic_ID>/tickets.json` (2-space
indent, machine-consumed) and the rationale + before/after diff to
`temp/epic-<Epic_ID>/consolidation-report.md`.

### Step 5 — Hand back to `/epic-plan`

Return control. The workflow shows the operator the consolidation report at the
HITL diff gate; on approval it runs
`node .agents/scripts/epic-plan-decompose.js --epic <Epic_ID> --tickets
temp/epic-<Epic_ID>/tickets.json`, which validates the consolidated array,
persists the hierarchy, and flips the Epic to `agent::ready`.

## Constraints

- Do **not** call the GitHub API from this Skill. It reads two temp artifacts
  and writes two temp artifacts; persistence belongs to the script.
- Do **not** write outside `temp/epic-<Epic_ID>/`.
- Do **not** add scope or invent tickets. The four permitted operations (merge
  Stories, collapse single-Story Features, re-parent, rewire `depends_on`) are
  exhaustive — anything else is out of contract.
- If `temp/epic-<Epic_ID>/tickets.json` is missing, fail loudly and instruct
  the caller to run the `epic-plan-decompose-author` Skill first.
- The validator
  ([`lib/orchestration/ticket-validator.js`](../../../scripts/lib/orchestration/ticket-validator.js))
  is the authoritative post-consolidation gate — including
  `assertNoSingleStoryFeature`. Re-consolidate when it rejects rather than
  patching tickets by hand.
