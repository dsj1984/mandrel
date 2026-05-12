---
name: epic-plan-spec-author
description: >-
  Author the PRD and Tech Spec markdown for an Epic from the planner authoring
  context emitted by `epic-plan-spec.js --emit-context`. Use during Phase 1 of
  `/epic-plan` when the host LLM needs to write the two artifacts before
  `epic-plan-spec.js` persists them.
allowed_tools:
  - Read
  - Write
  - Bash
---

# epic-plan-spec-author

## Role

Technical Product Manager + Engineering Architect (two personas, one Skill —
the PRD persona produces the requirements; the Architect persona consumes the
PRD to produce the Tech Spec).

## When to use

`/epic-plan` Phase 1, immediately after `epic-plan-spec.js --emit-context`
writes `temp/epic-<Epic_ID>/planner-context.json`. This Skill replaces the
inline "Author the PRD" / "Author the Tech Spec" steps from the legacy
workflow body — the calling workflow dispatches this Skill via the `Skill`
tool, supplies the Epic ID, and on completion has `temp/epic-<Epic_ID>/prd.md`
and `temp/epic-<Epic_ID>/techspec.md` ready for the persist half of the
script.

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
  - `systemPrompts.prd` and `systemPrompts.techSpec` — left in the envelope
    as a backstop; this Skill's own body below carries the authoritative
    versions and is the source of truth going forward

## Outputs

- `temp/epic-<Epic_ID>/prd.md` — PRD markdown starting with `## Overview`
  (no `<h1>`).
- `temp/epic-<Epic_ID>/techspec.md` — Tech Spec markdown starting with
  `## Technical Overview` (no `<h1>`).

Both files MUST exist on disk before this Skill returns control. The caller
will invoke `epic-plan-spec.js --epic <Epic_ID> --prd ... --techspec ...`
next, and the persist half will fail loudly if either file is missing or
empty.

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

### Step 4 — Hand back to `/epic-plan`

Both files exist; return. The caller will run
`node .agents/scripts/epic-plan-spec.js --epic <Epic_ID> --prd
temp/epic-<Epic_ID>/prd.md --techspec temp/epic-<Epic_ID>/techspec.md`,
which persists the artifacts, appends the `## Planning Artifacts` section to
the Epic body, flips the Epic to `agent::review-spec`, and cleans up the
temp files.

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
