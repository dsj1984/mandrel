# epic-plan-premortem — examples & extended rationale

Read this file on demand. The SKILL.md carries the operating contract (Policy
Capsule, Inputs / Outputs, Procedure, Constraints); this file carries the
extended rationale behind the pre-mortem critic — why it is a separate,
fresh-context, code-reading pass and how its three predicted-rework finding
classes differ from the structural gates.

## Why a separate fresh-context code-reading critic

This Skill acts as a Senior Engineer + Architect in the role of a
**fresh-context pre-mortem critic**. It is deliberately *separate* from
`epic-plan-decompose-author` (the generator) and from `epic-plan-consolidate`
(the scope-preserving merge critic): a same-pass self-critique is the weak mode
this is built to escape. The generator maps Epic capabilities to Stories
against the spec text; this critic opens the **actual cited code** and asks "if
I tried to deliver this exact backlog, where would it rework?" — before any
GitHub write makes the rework expensive.

**You MUST read the actual cited code surfaces.** This is the load-bearing
difference between this critic and the structural file-assumption gate: that
gate proves a path **exists** (or does not); this critic reads what the file
actually **contains**. A pre-mortem that did not open the cited files has not
run.

## Not scope-preserving (unlike consolidation)

Unlike `epic-plan-consolidate` (merge-and-rewire only), this critic MAY
recommend splitting an under-specified Story, tightening or rewording an
acceptance criterion, or flagging an over-specified Story — because it only
*recommends* in a report; it never applies the change itself. The conservation
invariant belongs to consolidation; this pass is deliberately a separate,
additive-recommendation lens. It never writes to GitHub, never persists
`tickets.json`, and never flips a label — re-authoring on its findings is the
author skill's job (the workflow re-runs `epic-plan-decompose-author` on the
report before the persist call).

## The three predicted-rework finding classes

Hunt for the three classes the structural gates cannot catch:

1. **Unverifiable acceptance criteria** — an AC no `verify[]` command or
   readable code state can prove. Recommend a concrete verify command or a
   reworded, checkable AC.
2. **Over- or under-specified Stories** — a Story whose `acceptance[]` is far
   broader or narrower than its `changes[]` footprint and the cited code
   support. Recommend a split (under-specified: one Story doing the work of
   several) or a tightening.
3. **Semantically-wrong assumptions** — the cited file exists (so the
   file-assumption gate passes) but does not contain the seam / export /
   function / data shape the Story assumes — the file-assumption gate passes,
   the work would still rework. Recommend the corrected target or an explicit
   "create the seam first" Story.
