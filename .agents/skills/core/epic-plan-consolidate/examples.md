# epic-plan-consolidate — examples & extended rationale

Read this file on demand. The SKILL.md carries the operating contract (Policy
Capsule, Inputs / Outputs, Procedure, Constraints); this file carries the
extended rationale behind the consolidation pass — why it is a separate,
fresh-context critic and how the scope-conservation invariant is enforced by
you rather than by the runtime.

## Why a separate fresh-context critic

This Skill acts as a **holistic critic** with fresh context (a Senior Project
Manager + Orchestrator lens). It is deliberately *separate* from
`epic-plan-decompose-author` (the generator): a same-pass self-critique is the
weak mode this is built to escape. The generator maps Epic capabilities to
Stories ~1:1; this critic steps back and looks at the *whole* decomposition
against the Tech Spec's intentional grouping before any GitHub write.

## Scope conservation is your contract, not a machine guarantee

Scope conservation is the load-bearing invariant: you MUST NOT add scope,
invent tickets, or drop acceptance criteria. Every acceptance item and every
`verify` entry present in the draft MUST survive into the consolidated array
(possibly re-homed onto a merged Story).

**This is your contract, not a machine guarantee.** There is **no runtime
acceptance-union diff** on your output. The only deterministic runtime backstop
the validator applies after you run is the standard ticket-structure
validation — it does not re-derive the pre-consolidation acceptance/verify
union, so a critic that silently dropped an acceptance item would **not** be
caught downstream. (The repo's unit test exercises a *pure model* of the merge
over an over-fragmented fixture to document the intended invariant; it does not
inspect this Skill's actual output.) Conserve scope yourself, deliberately, on
every merge — and if you cannot preserve an item, you have over-reached, so back
the operation out.

## Ceiling, not target — the below-ceiling coarsening case

Consume the Tech Spec **"Delivery Slicing"** section as a **ceiling, not a
target** when present: the Architect's proposed N shippable Stories is an
*upper bound*, not a floor. Cluster the draft's Stories toward that grouping,
and go **below** N when slices form dependent single-consumer chains — a slice
whose "Independent? No" row carries no justification (parallelism, risk
isolation, or delivery-envelope pressure) folds into its consumer. You **never**
split above N.

When the consolidated count drops **below** the Delivery-Slicing count, the
consolidation report MUST surface that fact explicitly — e.g.
`Below ceiling: N (Delivery Slicing) → M (consolidated)` — and attach a one-line
rationale to each below-ceiling merge (which dependent single-consumer slice
folded into which consumer, and why it was unjustified), so the operator sees
the coarsening at the Phase 8.3 advisory diff.
