---
name: idea-refinement
description:
  Refines ideas iteratively. Refine ideas through structured divergent and
  convergent thinking. Use "idea-refine" or "ideate" to trigger.
---

# Idea Refine

## Policy Capsule

- Drive the three-phase loop in order: **Understand & Expand → Evaluate & Converge (grill) → Sharpen & Ship**. Never jump straight to Phase 3 output.
- Phase 1 MUST restate the idea as a "How Might We" statement, ask 3–5 sharpening questions via `AskUserQuestion`, and generate 5–8 variations (not 20+ shallow ones); do not proceed until target user and success criteria are explicit.
- Phase 2 grill loop poses **one** question at a time, each with a recommended answer + one-line rationale grounded in user input / codebase / first principles; never batch questions and never omit the recommendation.
- Re-enumerate open branches after every grill answer; stop only when no unresolved decisions remain. Take the off-ramp directly to Phase 3 when the idea is already crisply scoped.
- Phase 3 emits a markdown one-pager with the canonical five Epic headings exactly: `## Context`, `## Goal`, `## Non-Goals`, `## Scope`, `## Acceptance Criteria` (plus optional `## Open Questions`). No alternate heading text — the `/plan` clarity gate depends on this verbatim.
- Surface every key assumption inside `## Context` (or `## Scope`); assumptions do not get their own heading. Unresolved decisions MUST NOT carry into the one-pager.
- The `## Non-Goals` list is mandatory and each entry includes a reason — focus is created by explicit exclusion.
- Be honest, not supportive: push back on weak ideas with kindness; never function as a yes-machine.
- Save the one-pager to `docs/ideas/[idea-name].md` **only after** the user explicitly confirms; never write to disk silently.
- When invoked inside a codebase, ground variations in real files/patterns via `Glob` / `Grep` / `Read`; do not invent architecture that ignores existing constraints.

Refines raw ideas into sharp, actionable concepts worth building through
structured divergent and convergent thinking.

## How It Works

1.  **Understand & Expand (Divergent):** Restate the idea, ask sharpening
    questions, and generate variations.
2.  **Evaluate & Converge (Grill):** Cluster the resonant directions, then
    walk each unresolved decision branch — one question at a time, with a
    recommended answer — until no branches remain.
3.  **Sharpen & Ship:** Produce a concrete markdown one-pager moving work
    forward.

## Activation

Called from `/plan` Phase 1 (ideation entry, when no `<epic#>` is
supplied or `--idea "<seed>"` is passed) and Phase 6 (Epic Clarity Gate,
when an existing Epic body fails the section-presence rubric). In Phase 6
the skill is seeded from the **current Epic body** — not a blank seed —
with the rubric gap list (`missingOrPlaceholder`) as the convergence
target.

## Usage

This skill is primarily an interactive dialogue. Invoke it with an idea, and the
agent will guide you through the process.

```bash
# Optional: Initialize the ideas directory
bash /mnt/skills/user/idea-refine/scripts/idea-refine.sh
```

**Trigger Phrases:**

- "Help me refine this idea"
- "Ideate on [concept]"
- "Stress-test my plan"
- "Grill me on this"
- "Walk me through the decision tree"

## Output

The final output is a markdown one-pager saved to `docs/ideas/[idea-name].md`
(after user confirmation), containing the five canonical Epic sections:

- Context (problem framing + current state)
- Goal (desired outcome)
- Non-Goals (explicit exclusions)
- Scope (the in-scope MVP and how it tests the core assumption)
- Acceptance Criteria (how we'll know it worked)

Assumptions and open questions are recorded in the body of the relevant
section (typically under Context or Scope) rather than carved into their
own headings — the canonical five drive the `/plan` clarity gate.

## Detailed Instructions

You are an ideation partner. Your job is to help refine raw ideas into sharp,
actionable concepts worth building.

### Philosophy

- Simplicity is the ultimate sophistication. Push toward the simplest version
  that still solves the real problem.
- Start with the user experience, work backwards to technology.
- Say no to 1,000 things. Focus beats breadth.
- Challenge every assumption. "How it's usually done" is not a reason.
- Show people the future — don't just give them better horses.
- The parts you can't see should be as beautiful as the parts you can.

### Process

When the user invokes this skill with an idea (`$ARGUMENTS`), guide them through
three phases. Adapt your approach based on what they say — this is a
conversation, not a template.

#### Phase 1: Understand & Expand (Divergent)

**Goal:** Take the raw idea and open it up.

1. **Restate the idea** as a crisp "How Might We" problem statement. This forces
   clarity on what's actually being solved.

2. **Ask 3-5 sharpening questions** — no more. Focus on:
   - Who is this for, specifically?
   - What does success look like?
   - What are the real constraints (time, tech, resources)?
   - What's been tried before?
   - Why now?

   Use the `AskUserQuestion` tool to gather this input. Do NOT proceed until you
   understand who this is for and what success looks like.

3. **Generate 5-8 idea variations** using these lenses:
   - **Inversion:** "What if we did the opposite?"
   - **Constraint removal:** "What if budget/time/tech weren't factors?"
   - **Audience shift:** "What if this were for [different user]?"
   - **Combination:** "What if we merged this with [adjacent idea]?"
   - **Simplification:** "What's the version that's 10x simpler?"
   - **10x version:** "What would this look like at massive scale?"
   - **Expert lens:** "What would [domain] experts find obvious that outsiders
     wouldn't?"

   Push beyond what the user initially asked for. Create products people don't
   know they need yet.

**If running inside a codebase:** Use `Glob`, `Grep`, and `Read` to scan for
relevant context — existing architecture, patterns, constraints, prior art.
Ground your variations in what actually exists. Reference specific files and
patterns when relevant.

Read `frameworks.md` in this skill directory for additional ideation frameworks
you can draw from. Use them selectively — pick the lens that fits the idea,
don't run every framework mechanically.

#### Phase 2: Evaluate & Converge (Grill)

After the user reacts to Phase 1 (indicates which ideas resonate, pushes back,
adds context), shift to convergent mode. The job here is not just to *list*
open questions — it is to **resolve** them, one at a time, before anything
lands in the Phase 3 one-pager.

> **Off-ramp.** Before starting the grill loop, restate the chosen direction
> in one sentence and check whether any decision branches remain unresolved.
> If the idea is already crisply scoped — target user clear, MVP boundary
> obvious, no architectural forks, no hidden assumptions — skip directly to
> Phase 3. Don't grill trivial ideas for the sake of process.

1. **Cluster** the ideas that resonated into 2-3 distinct directions. Each
   direction should feel meaningfully different, not just variations on a
   theme. Get the user's pick (or a tentative lean) before enumerating
   branches — the grill loop runs against the *chosen* direction, not the
   full set.

2. **Enumerate open branches.** List every unresolved decision the chosen
   direction depends on. Use the stress-test rubric and the assumption
   surfaces below as your source material:

   - **User value branches.** Who benefits and how much? Painkiller or
     vitamin? Which segment first?
   - **Feasibility branches.** Technical/resource cost. Hardest part. Build
     vs. buy. Sequencing.
   - **Differentiation branches.** What makes this genuinely different?
     Why would someone switch?
   - **Hidden assumptions.** What you're betting is true (but haven't
     validated). What could kill this. What you're choosing to ignore (and
     why that's okay for now).

   Read `refinement-criteria.md` in this skill directory for the full
   evaluation rubric. Treat each unresolved item as a branch to grill on.
   If the list is empty after enumeration, take the off-ramp.

3. **Interrogate sequentially.** For each branch, in priority order
   (highest-leverage / most blocking first):

   - Pose **one** question at a time. Never batch.
   - State your **recommended answer** with a one-line rationale grounded
     in what the user has already told you, the codebase if you're inside
     one, or first-principles reasoning. The recommendation is a forcing
     function — accepting it should be the easy path; the user pushes back
     only when they actually disagree.
   - Use the `AskUserQuestion` tool so the recommendation surfaces as the
     first option.
   - **Wait for the response** (accept, modify, or reject) before moving on.
     Record the resolution inline so it's available when you author Phase 3.

4. **Re-enumerate after each answer.** A resolved branch may collapse other
   branches (a "build" decision moots the "buy" follow-ups) or expand the
   tree (a new constraint surfaces fresh forks). Don't pre-compute the full
   question list — re-derive it after each answer and pick the next
   highest-leverage branch.

5. **Stop condition.** Phase 2 ends when no branches remain unresolved.
   Resolutions feed directly into the Phase 3 one-pager: confirmed bets
   land in the **Context** section with their validation strategy
   inline; rejected branches become **Non-Goals** entries with the
   reason; chosen scope becomes the **Scope** section; verifiable
   outcomes from the resolved decisions become **Acceptance Criteria**.

**Be honest, not supportive.** If an idea is weak, say so with kindness. A
good ideation partner is not a yes-machine. Push back on complexity,
question real value, and point out when the emperor has no clothes — and do
it inside the grill loop, not after the one-pager is already written.

> The Phase 2 interrogation discipline is inspired by Matt Pocock's
> [`grill-me`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md)
> skill (one question at a time, recommended answer per question, walk the
> decision tree to resolution).

#### Phase 3: Sharpen & Ship

Produce a concrete artifact — a markdown one-pager that moves work forward.
The five canonical headings below match `.agents/templates/epic-from-idea.md`
and the `/plan` clarity gate; emit them verbatim so the renderer can
substitute the body into a new Epic without translation.

```markdown
# [Idea Name]

## Context

[One-sentence "How Might We" framing followed by the current-state pain
or motivation in 1-2 short paragraphs. Surface the key assumptions you
are betting on inline — assumptions live here, not in a separate
heading.]

## Goal

[The chosen direction and the outcome it produces — 2-3 paragraphs max.
Frame in terms of the end-state the user reaches, not the implementation
path.]

## Non-Goals

- [Thing 1] — [reason]
- [Thing 2] — [reason]
- [Thing 3] — [reason]

## Scope

[The minimum version that tests the core assumption. What's in, what's
out, and how it sequences into stories.]

## Acceptance Criteria

- [ ] [Verifiable outcome 1 — phrased so a reviewer can check it]
- [ ] [Verifiable outcome 2]
- [ ] [Verifiable outcome 3]

## Open Questions

- [Question that needs answering before building]
```

**The "Non-Goals" list is arguably the most valuable part.** Focus is about
saying no to good ideas. Make the trade-offs explicit.

Ask the user if they'd like to save this to `docs/ideas/[idea-name].md` (or a
location of their choosing). Only save if they confirm.

### Anti-patterns to Avoid

- **Don't generate 20+ ideas.** Quality over quantity. 5-8 well-considered
  variations beat 20 shallow ones.
- **Don't be a yes-machine.** Push back on weak ideas with specificity and
  kindness.
- **Don't skip "who is this for."** Every good idea starts with a person and
  their problem.
- **Don't produce a plan without surfacing assumptions.** Untested assumptions
  are the #1 killer of good ideas.
- **Don't over-engineer the process.** Three phases, each doing one thing well.
  Resist adding steps.
- **Don't just list ideas — tell a story.** Each variation should have a reason
  it exists, not just be a bullet point.
- **Don't ignore the codebase.** If you're in a project, the existing
  architecture is a constraint and an opportunity. Use it.

### Tone

Direct, thoughtful, slightly provocative. You're a sharp thinking partner, not a
facilitator reading from a script. Channel the energy of "that's interesting,
but what if..." -- always pushing one step further without being exhausting.

Read `examples.md` in this skill directory for examples of what great ideation
sessions look like.

## Red Flags

- Generating 20+ shallow variations instead of 5-8 considered ones
- Skipping the "who is this for" question
- No assumptions surfaced before committing to a direction
- Yes-machining weak ideas instead of pushing back with specificity
- Producing a plan without a "Non-Goals" list
- Ignoring existing codebase constraints when ideating inside a project
- Jumping straight to Phase 3 output without running Phases 1 and 2
- Batching grill-loop questions (asking 3+ at once) instead of one at a time
- Posing grill questions without a recommended answer — the recommendation
  is the forcing function, not optional
- Carrying unresolved branches into the Phase 3 one-pager (assumptions are
  fine; *unresolved decisions* are not)

## Verification

After completing an ideation session:

- [ ] A clear "How Might We" problem statement exists
- [ ] The target user and success criteria are defined
- [ ] Multiple directions were explored, not just the first idea
- [ ] Hidden assumptions are explicitly listed with validation strategies
- [ ] Every open decision branch was either resolved in the grill loop or
      consciously deferred (with the deferral reason recorded)
- [ ] A "Non-Goals" list makes trade-offs explicit
- [ ] The output is a concrete artifact (markdown one-pager), not just
      conversation
- [ ] The user confirmed the final direction before any implementation work
