---
name: epic-plan-spec-author
description: >-
  Author the PRD, Tech Spec, and Acceptance Spec markdown for an Epic from the
  planner authoring context emitted by `epic-plan-spec.js --emit-context`. Use
  during Phase 1 of `/epic-plan` when the host LLM needs to write the three
  artifacts before `epic-plan-spec.js` persists them.
allowed_tools:
  - Read
  - Write
  - Bash
---

# epic-plan-spec-author

## Role

Technical Product Manager + Engineering Architect + Acceptance Engineer (three
personas, one Skill — the PRD persona produces the requirements; the Architect
persona consumes the PRD to produce the Tech Spec; the Acceptance Engineer
consumes both to produce the Acceptance Spec).

## When to use

`/epic-plan` Phase 1, immediately after `epic-plan-spec.js --emit-context`
writes `temp/epic-<Epic_ID>/planner-context.json`. This Skill replaces the
inline "Author the PRD" / "Author the Tech Spec" steps from the legacy
workflow body — the calling workflow dispatches this Skill via the `Skill`
tool, supplies the Epic ID, and on completion has `temp/epic-<Epic_ID>/prd.md`,
`temp/epic-<Epic_ID>/techspec.md`, and `temp/epic-<Epic_ID>/acceptance-spec.md`
ready for the persist half of the script.

## Inputs

The dispatcher passes the Epic ID as the Skill argument. The Skill itself
reads:

- `temp/epic-<Epic_ID>/planner-context.json` — produced by
  `node .agents/scripts/epic-plan-spec.js --epic <Epic_ID> --emit-context`.
  Fields:
  - `epic.id`, `epic.title`, `epic.body` (or `epic.bodySummary` when the
    planning-context budget downgrades the body to a summary)
  - `docsContext.items[]` — bounded project docs scraped from the configured
    `docsRoot` (start with these for "how does the codebase do X today?"
    context; the validator already capped their size)
  - `systemPrompts.prd`, `systemPrompts.techSpec`, and
    `systemPrompts.acceptanceSpec` — left in the envelope as a backstop;
    this Skill's own body below carries the authoritative versions and is
    the source of truth going forward
  - `bddRunner` — BDD runner pending-tag verification result. Shape:
    `{ runner, pendingTag, supported, fallback, reason? }`. When
    `supported: true`, render the verified `pendingTag` in the
    acceptance-spec body so the features-first Story can scaffold
    `.feature` files with that exact tag. When `fallback: true`, render
    `"Fallback: dependencies-first ordering"` and omit the pending-tag
    line — Phase 2 reverts to topological ordering.

## Outputs

- `temp/epic-<Epic_ID>/prd.md` — PRD markdown starting with `## Overview`
  (no `<h1>`).
- `temp/epic-<Epic_ID>/techspec.md` — Tech Spec markdown starting with
  `## Technical Overview` (no `<h1>`).
- `temp/epic-<Epic_ID>/acceptance-spec.md` — Acceptance Spec markdown
  starting with `## Acceptance Criteria` (no `<h1>`).

All three files MUST exist on disk before this Skill returns control. The
caller will invoke
`epic-plan-spec.js --epic <Epic_ID> --prd ... --techspec ... --acceptance-spec ...`
next, and the persist half will fail loudly if any file is missing or empty.

## Procedure

### Step 1 — Load the context

Read `temp/epic-<Epic_ID>/planner-context.json` with the `Read` tool. Pull
the Epic title, body (or body summary), the `docsContext` items, and (for
reference) the two system prompts.

### Step 2 — Author the PRD (Technical Product Manager persona)

Apply the PRD system prompt below to the Epic title + body. Write the PRD
to `temp/epic-<Epic_ID>/prd.md` using the `Write` tool. The PRD MUST:

- Start with `## Overview` — never a top-level `#` heading.
- Contain four sections: **Context & Goals**, **User Stories**,
  **Acceptance Criteria**, **Out of Scope**.
- Be valid Markdown — no fenced code blocks of prose, no smart quotes that
  break the issue body renderer.

#### PRD system prompt (authoritative)

```text
You are an expert Technical Product Manager.
Your job is to convert a high-level Epic description into a structured Product Requirements Document (PRD).

The PRD should outline:
1. Context & Goals
2. User Stories
3. Acceptance Criteria
4. Out of Scope

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Overview.
- Format requirements clearly with bullet points and bold text where appropriate.
```

### Step 3 — Author the Tech Spec (Engineering Architect persona)

Apply the Tech Spec system prompt below to the PRD just written + the
`docsContext` items (so the spec is grounded in the actual codebase, not
hallucinated patterns). Write to `temp/epic-<Epic_ID>/techspec.md`. The Tech
Spec MUST:

- Start with `## Technical Overview` — never a top-level `#` heading.
- Cover Architecture & Design, Data Models (if any), API Changes (if any),
  Core Components, Security & Privacy Considerations.
- Cite the source files / modules it touches by relative path. Avoid
  pseudocode — name real symbols when proposing edits.

#### Tech Spec system prompt (authoritative)

```text
You are an expert Engineering Architect.
Your job is to convert a PRD into a Technical Specification for implementation.

The Tech Spec should outline:
1. Architecture & Design
2. Data Models (if any)
3. API Changes (if any)
4. Core Components
5. Security & Privacy Considerations

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Technical Overview.
- Format architectural decisions clearly with bullet points.
```

### Step 4 — Author the Acceptance Spec (Acceptance Engineer persona)

Apply the Acceptance Spec system prompt below to the PRD + Tech Spec just
written. Write to `temp/epic-<Epic_ID>/acceptance-spec.md`. The Acceptance
Spec MUST:

- Start with `## Acceptance Criteria` — never a top-level `#` heading.
- Render the AC table with the canonical column shape documented in Tech
  Spec #2083: `| AC ID | Outcome | Feature File | Scenario | Disposition |`.
- Use **stable AC IDs** of the form `AC-1`, `AC-2`, … assigned in document
  order. On re-plan, reuse the ID for any AC whose Outcome text is
  materially unchanged; new ACs receive fresh sequential IDs (existing
  IDs do not shift).
- Tag every row's `Disposition` with one of the canonical enum values:
  `new` (first appearance), `updated` (Outcome text or Scenario reshaped
  vs. prior plan), `unchanged` (carried through verbatim from prior plan).
- Cite proposed feature files under `tests/features/**` by relative path
  so the Phase 2 features-first Story can scaffold the matching scenarios.
- Render a **Runner Verification** line directly under the AC table that
  records what `bddRunner` from the planner-context envelope reports:
  - `supported: true` → write
    `Runner Verification: <runner> supports <pendingTag>` (e.g.
    `playwright-bdd supports @skip`). The features-first Story will tag
    pending scenarios with this exact string.
  - `fallback: true` → write
    `Runner Verification: Fallback: dependencies-first ordering (reason: <reason>)`.
    Phase 2 still proceeds; AC reconciliation defers to dependency order.

#### Acceptance Spec system prompt (authoritative)

```text
You are an expert Acceptance Engineer.
Your job is to convert a PRD and a Tech Spec into a structured Acceptance Specification that drives features-first BDD authoring.

The Acceptance Spec should outline:
1. Acceptance Criteria — one row per user-visible outcome, expressed as a Markdown table with columns: AC ID | Outcome | Feature File | Scenario | Disposition
2. Stable AC IDs — assign AC-1, AC-2, ... in document order; reuse the same ID across re-plans when an Outcome is materially unchanged so scenario tags (@ac-N) stay aligned
3. Disposition — tag each row with one of: new | updated | unchanged

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Acceptance Criteria.
- Every AC row MUST have a stable AC ID of the form AC-<n> (AC-1, AC-2, ...) — do not reorder IDs across re-plans; new ACs get fresh sequential IDs.
- Every AC row MUST carry a Disposition value from the enum: new | updated | unchanged.
- Each Outcome MUST be a single user-visible behaviour — no DB assertions, no HTTP status codes, no internal implementation details.
- Cite proposed feature file paths under tests/features/** so Phase 2 can scaffold matching scenarios.
```

### Step 5 — Hand back to `/epic-plan`

All three files exist; return. The caller will run
`node .agents/scripts/epic-plan-spec.js --epic <Epic_ID> --prd
temp/epic-<Epic_ID>/prd.md --techspec temp/epic-<Epic_ID>/techspec.md
--acceptance-spec temp/epic-<Epic_ID>/acceptance-spec.md`, which persists
the artifacts, appends the `## Planning Artifacts` section to the Epic
body, flips the Epic to `agent::review-spec`, and cleans up the temp
files.

## Constraints

- Do **not** modify GitHub issues from this Skill. Persistence is the
  script's job; the Skill is pure markdown authoring.
- Do **not** open files outside `temp/epic-<Epic_ID>/` for write. Reads
  may cover anything `docsContext` references plus the planner-context
  JSON itself.
- If `temp/epic-<Epic_ID>/planner-context.json` is missing, **fail
  loudly** — instruct the caller to run `--emit-context` first. Do not
  silently fabricate a context.
- Respect the planning-context budget: when `epic.body` is `null` and
  `epic.bodySummary` is present, work from the summary rather than
  re-fetching the full body. The budget cap is deliberate.
