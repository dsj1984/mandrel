---
name: knowledge-transfer
description:
  Verifies that a human operator actually understands a plan or a code change
  through restate-first probing, a why-ladder, incremental mastery gates, and a
  persistent comprehension checklist. Use "explain", "walk me through", "help
  me understand", "teach me this change/plan", or "do I understand this?" to
  trigger. Operator-facing and interactive only.
---

# Knowledge Transfer

## Policy Capsule

- **Restate-first, always.** Open every layer by asking the operator to
  state their current understanding **before** you explain anything. You
  are filling gaps in their model, not lecturing from a blank slate. Never
  lead with the answer.
- **Confirm mastery before advancing.** Walk the why-ladder one layer at a
  time and verify comprehension of the current layer (high-level *and*
  low-level) before moving to the next. Do not dump the whole picture at the
  end.
- **The operator can stop at any point.** Every checkpoint MUST offer an
  explicit exit ("I'm good — proceed"). When the operator takes it, stop
  immediately and hand back. This is a comprehension *aid*, never a gate
  that traps the operator. This deliberately overrides any "do not end
  until verified" framing — operator control wins.
- **Drive the why-ladder in order:** problem → why the problem existed →
  branches considered → chosen solution → design decisions → edge cases →
  broader impact / blast radius. Drill into *why* repeatedly; cover *what*
  and *how* alongside it.
- **Keep a persistent checklist artifact.** Write a running markdown
  checklist to `temp/comprehension-<subject>.md` and update it incrementally
  as each item is mastered — so even a skipped or interrupted session leaves
  a readable summary. Artifacts over chat.
- **Adapt depth on request.** Support ELI5 (explain like I'm five), intern
  (explain like I'm a new engineer), and peer (explain like I'm a colleague)
  levels; switch when the operator asks.
- **Quiz with the host's structured-question mechanism when it sharpens
  understanding.** Randomize the position of the correct answer, ask one
  focused question at a time, and do not reveal the answer until the
  operator has submitted. Quizzing is optional — gate it behind the
  operator's appetite, never force it.
- **Interactive only.** This skill MUST NOT run inside a non-interactive
  delivery sub-agent (`helpers/single-story-deliver`,
  `helpers/epic-deliver-story`, or any headless parent). There is no
  operator to teach; skip it entirely.
- **Be honest, not flattering.** If the operator's restatement is wrong,
  say so plainly and correct it. A false "you've got it" defeats the
  purpose.

## What this skill is for

Mandrel drives autonomous delivery: agents plan an Epic and then write and
merge code the operator merges through the GitHub UI. That leaves two moments
where the operator may not actually understand what they are authorizing or
what they now own:

1. **Before delivery** — does the operator understand the **plan** (the Tech
   Spec, the decomposition, the wave roadmap, the risk) before authorizing a
   fan-out of subagents?
2. **After delivery** — does the operator understand the **realized change**
   (the diff, the design decisions, the edge cases) they just merged?

This skill is the reusable comprehension engine for both. The *subject*
differs (a plan vs. a diff); the *method* is identical.

## The subject

Before starting, identify the comprehension subject and gather it:

- **A plan** — the Epic body (whose managed sections carry the folded Tech
  Spec and Acceptance Table), the
  decomposition (Stories with inline `acceptance[]` / `verify[]`),
  and the dispatch/wave roadmap.
- **A change** — a PR, a branch, or a working-tree diff. Read the diff, the
  PR/issue description, and the surrounding code the change touches.

Ground every explanation in the actual artifact. Do not generalize from the
title — read the real content first (`Glob` / `Grep` / `Read`, `gh pr view`,
`git diff`).

## The loop

1. **Frame & gather.** State the subject in one sentence and load it. Write
   the initial checklist to `temp/comprehension-<subject>.md` with one
   unchecked item per why-ladder layer.
2. **Restate-first.** Ask the operator to explain, in their own words, what
   they currently understand about the subject. Listen for the gaps — this
   sets where you start.
3. **Fill gaps, one layer at a time.** For each why-ladder layer the operator
   has not mastered:
   - Explain at the requested depth, grounded in the artifact (show the code,
     the spec section, or the diff hunk).
   - Probe understanding: a short open question, or a quiz item via the host's
     structured-question mechanism.
   - Mark the checklist item only when the operator demonstrates
     understanding — not when you have merely explained it.
   - Offer the stop exit before moving on.
4. **Cover both altitudes.** High-level (motivation, why it matters, what it
   impacts) and low-level (business logic, specific edge cases). A confident
   high-level summary with no grasp of the edge cases is not mastery.
5. **Close.** When every checklist item is mastered — or the operator stops —
   summarize what was covered, note any unchecked items, and leave the
   checklist artifact in place.

## The why-ladder (comprehension checklist)

The default checklist. Adapt the wording to the subject; keep the
progression.

- [ ] **The problem** — what is being solved, in one sentence.
- [ ] **Why the problem existed** — the root cause or the gap, not just the
      symptom.
- [ ] **The branches** — what alternatives were considered and set aside.
- [ ] **The solution** — what was chosen (the plan, or the realized change).
- [ ] **Why this solution** — the reasoning that selected it over the
      branches.
- [ ] **Design decisions** — the specific choices inside the solution and
      their trade-offs.
- [ ] **Edge cases** — the boundaries, failure modes, and what is explicitly
      *not* handled.
- [ ] **Broader impact** — the blast radius: what this affects downstream,
      who is impacted, what to watch.

## Depth levels

- **ELI5** — plain-language analogy, no jargon. For orienting before detail.
- **Intern** — assumes general engineering literacy, explains the
  project-specific context and conventions.
- **Peer** — assumes domain fluency; focuses on the non-obvious decisions and
  trade-offs.

Default to *intern* and adjust when the operator's restatement or an explicit
request tells you to go shallower or deeper.

## Quizzing

When a quick check would sharpen understanding, pose a question through the
host's structured-question mechanism. In Claude Code the reference
implementation is the `AskUserQuestion` tool; on another host, use that
host's equivalent structured-choice surface.

- Ask **one** question at a time.
- For multiple-choice, **randomize** which option is correct across questions.
- Do **not** reveal or hint at the answer until the operator submits.
- Follow a wrong answer with a targeted re-explanation of just that gap, then
  re-probe — do not move on.

## Activation

This skill is the engine behind two operator-facing entry points:

- [`/explain`](../../../workflows/explain.md) — runs the loop over a realized
  change (a PR, branch, or diff).
- [`/plan`](../../../workflows/helpers/plan-epic.md) **Phase 11 — Plan
  Comprehension Gate** — runs the loop over a freshly planned backlog before
  the operator hands off to `/deliver`. That phase decides *whether* to
  run via an LM-judgment predicate; this skill owns *how* it runs once
  invoked.

It is discovered through the standard skill-activation contract in
[`.agents/instructions.md` § 1.B](../../../instructions.md) — no separate
always-on directive is required.

## Constraints

- **Never** run in a non-interactive / headless delivery sub-agent.
- **Never** advance past a checklist item the operator has not demonstrated
  understanding of (unless they explicitly stop).
- **Never** reveal a quiz answer before submission, and never keep the
  correct choice in a fixed position across questions.
- **Always** offer an explicit "proceed / stop" exit at every checkpoint.
- **Always** ground explanations in the real artifact, not the title.
- **Always** leave the `temp/comprehension-<subject>.md` checklist in place
  on exit.
