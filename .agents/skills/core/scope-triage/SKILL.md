---
name: scope-triage
description:
  Judge whether a piece of planned work is epic-sized or story-sized before the
  planning ceremony is paid for. Emits one of three verdicts —
  `epic` | `story` | `borderline` — over any planning artifact (a one-pager, an
  Epic body, or a Story draft). Use from `/plan` Phase 1.5 and any other
  planning gate that needs the canonical story-vs-epic rubric.
---

# scope-triage

## Policy Capsule

- Produce exactly one verdict — `epic` | `story` | `borderline` — for the
  artifact under judgment. Never auto-route on the verdict; the verdict is
  **advisory**, and the operator always decides what to do with it.
- Anchor every sizing judgment to the existing sizing SSOT **by reference**:
  `DELIVERABLE_GRANULARITY_GUIDANCE` and `DEFAULT_TASK_SIZING` in
  [`ticket-validator-sizing.js`](../../../scripts/lib/orchestration/ticket-validator-sizing.js).
  **Do not restate the numeric thresholds** — read them from that module so the
  rubric cannot drift from the validator that enforces them.
- The verdict is **host-LLM judgment**, not a deterministic score. There is no
  `--flag`, no scorer, no schema, and no label transition behind this skill —
  it is read-on-demand library content, evaluated with judgment per
  [`.agents/instructions.md` § 1.B](../../../instructions.md).
- Lead with **cohesion**, the same primary heuristic the sizing SSOT leads
  with: one Story is *one coherent change with one reason to exist*. The file /
  acceptance ceilings are the backstop, not the first cut.
- Bias toward `epic` only when the work genuinely spans multiple independent
  capabilities, crosses subsystems, or carries a real dependency graph. Being
  wrong in the `epic` direction is cheap — the Phase 8.3 consolidation pass and
  the sizing validator catch an over-planned Story later. Being wrong in the
  `story` direction is expensive — a story-sized scope pushed through the full
  Epic ceremony pays a sectioned-Epic-body (Tech Spec + Acceptance Table) +
  Story backlog +
  `epic/<id>` integration-branch tax for a degenerate one-Story output.
- Keep the rubric prose **artifact-agnostic**. The thing under judgment may be a
  sharpened one-pager, an existing Epic body, or a draft Story — the rubric
  reads the same against all three so every consumer reuses it verbatim.

## Verdicts

The skill emits exactly one of three verdicts.

### `story`

The work is a single shippable capability. Signals:

- **One capability, one reason to exist.** The artifact describes one coherent
  change a reviewer would accept as a single PR — the
  `DELIVERABLE_GRANULARITY_GUIDANCE.definition` notion of a Story.
- **Acceptance fits one Story.** The acceptance-criteria list reads as the
  binding contract of one coherent capability rather than spanning many
  independent outcomes. Acceptance mass is advisory-only (the
  `softAcceptanceCount` nudge in `DEFAULT_TASK_SIZING` — there is no hard
  ceiling), so the question is cohesion, not count.
- **Footprint fits Story sizing.** The plausible file footprint fits the Story
  width described by `DEFAULT_TASK_SIZING` (the `softFiles` / `hardFiles`
  knobs); a legitimately broad-but-cohesive change would declare `wide` rather
  than being two Stories.
- **No novel architecture, no high-risk trigger.** The work introduces no novel
  architectural decision and matches none of the `planning.riskHeuristics` in
  `.agentrc.json` (destructive/irreversible changes, shared auth/security,
  CI/CD gate changes, monorepo-wide rewrites, destructive migrations).
- **Decomposition would degenerate.** Running it through `/plan` would
  plausibly yield exactly **one Feature with one Story** — the shape the Phase
  8.3 consolidation skill flags only after all the spec authoring is already
  sunk cost.

### `epic`

The work is genuinely Epic-sized. Signals (any one is sufficient):

- **Multiple independent capabilities.** The artifact bundles two or more
  capabilities that each stand alone as a unit of work.
- **Cross-subsystem blast radius.** The change reaches across subsystems that
  do not share one cohesive reason to exist.
- **A real dependency graph.** The work has internal ordering — slices that
  must land before others — rather than one atomic change.

### `borderline`

The work is genuinely on the line — it could reasonably be one ambitious Story
or a small Epic, and neither call is clearly right. **Present the choice rather
than deciding for the operator.** Do not force a verdict to avoid the third
option; a borderline scope surfaced as borderline is the correct output.

## Change-Request Triage Rubric

A **change request** — "fix this", "tweak that", "extend the existing X" —
is the common case this rubric routes cheaply: a delta against a surface the
project already shipped, not a from-scratch capability. Route it to `story`
by default when all three delta signals hold; treat any one signal's absence
as a prompt to re-check, not an automatic `epic` bump.

### Delta signals

- **Delta to an already-delivered surface.** The request references a
  concrete existing capability (a module, workflow, script, or shipped
  feature) rather than proposing a new one. "Fix the flaky retry in
  `evidence-gate.js`" is a delta; "add a retry framework" is not.
- **Existing corpus covers the touched area.** The project's docs digest
  and/or an already-closed or in-flight Epic's Tech Spec section already
  describe the surface being changed — the standalone-Story path can draft
  against that inherited context (`corpusContext` in the `/plan --idea`
  envelope) instead of re-deriving architecture from a blank slate. When no
  corpus hit exists for the touched area, that is a signal the request may
  be reaching into genuinely new territory — re-check the `epic` signals
  below before defaulting to `story`.
- **Footprint fits Story sizing.** The plausible file footprint and
  acceptance-criteria count still fit the Story width in
  `DEFAULT_TASK_SIZING` (per the `story` verdict signals above) — a change
  request that fans out across independent subsystems is sized like an Epic
  regardless of how small the originating request sounded.

### Story-verdict rationale template

Use this template to record the verdict — it names which delta signal
carried the call, so a reviewer can sanity-check the routing decision without
re-deriving it:

```text
Verdict: story
Delta: <the existing surface this change targets>
Corpus hit: <docs digest section / Epic # and Tech Spec excerpt that covers
  this area, or "none — re-checked epic signals, still story-sized">
Footprint: <rough file/AC count vs DEFAULT_TASK_SIZING>
```

### Worked example

> Request: "The `/plan` standalone-Story path always drafts from a blank
> slate even when a change request is a small delta against something we
> already shipped — thread the existing docs digest and matching Epic
> Tech Spec sections into the draft context."
>
> ```text
> Verdict: story
> Delta: story-plan.js's --emit-context envelope and the plan-story.md
>   Phase 2 drafting instructions — both already exist and ship today.
> Corpus hit: Epic #4429's own Tech Spec section (this rubric's parent
>   Epic) already describes the docs-digest reuse pattern from
>   orchestration/docs-digest.js.
> Footprint: one new lib module (planning-corpus.js), one envelope field,
>   one helper-doc instruction — comfortably inside DEFAULT_TASK_SIZING's
>   softFiles/softAcceptanceCount band.
> ```

## Handoff & no-re-triage rule

A workflow entered via a scope-triage **handoff** MUST NOT re-triage. A handoff
*is* a triage decision already made — re-running this gate on the receiving side
would re-litigate a settled call and risk a ping-pong between two planning
workflows. Handoff invocations identify themselves as such (e.g. `/plan`
entered via a `/plan` scope-triage escalation, or `/plan` entered
via an `/plan` Phase 1.5 handoff), and the receiving workflow skips its own
scope-triage gate when it detects the handoff marker.

## When to use

- **`/plan` Phase 1.5** (ideation path only) — judge the sharpened
  one-pager Phase 1 produced before the Epic ceremony is paid for. The verdict
  folds into the existing Phase 1 HITL stop; on a `story` / `borderline`
  verdict the operator may hand off to
  [`/plan --from-notes`](../../../workflows/helpers/plan-story.md).
- Any other planning gate that needs the canonical story-vs-epic rubric. Keep
  the rubric here as the SSOT; consumers reference this file rather than
  forking the prose.

## Output

A single verdict (`epic` | `story` | `borderline`) plus a one-paragraph
rationale grounded in the signals above. The rationale names the deciding
signal (cohesion, capability count, blast radius, dependency graph, or sizing
fit) so the operator can sanity-check the call before acting on it.

## Anti-patterns to avoid

- **Restating the sizing numbers.** Reference `DEFAULT_TASK_SIZING` /
  `DELIVERABLE_GRANULARITY_GUIDANCE`; never copy the thresholds into this file
  (they would drift from the validator).
- **Auto-routing on the verdict.** The verdict is advisory; the operator
  decides. Never silently fork a workflow on a `story` verdict.
- **Forcing a binary call.** When the work is genuinely on the line, emit
  `borderline` and present the choice. Do not collapse it to `epic` or `story`
  to look decisive.
- **Re-triaging after a handoff.** A handoff is a settled decision. Skip the
  gate when the invocation identifies itself as a scope-triage handoff.
