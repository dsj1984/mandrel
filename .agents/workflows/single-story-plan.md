---
description:
  Author a standalone Story (no parent Epic) from a short prompt. Builds a
  context envelope, lets the host LLM draft the body, and creates the
  GitHub Issue with type::story and a persona label — ready to feed into
  /single-story-deliver.
---

# /single-story-plan

## Overview

`/single-story-plan` is the standalone counterpart to
[`/epic-plan`](epic-plan.md) for Stories that are **not** attached to an
Epic. It closes the gap between "one-line idea" and "well-formed
standalone Story body ready for [`/single-story-deliver`](helpers/single-story-deliver.md)"
using the same `host LLM authors + Node wrapper persists` split as
`/epic-plan`.

```text
/single-story-plan --idea "<seed>"
  → single-story-plan.js --emit-context        (envelope: seed, template, dup candidates)
  → host LLM authors a draft Story body         (in chat, using the envelope)
  → operator confirms (HITL)
  → single-story-plan.js --body <file>          (validate, gh issue create)
  → "Next: /single-story-deliver <id>"
```

**When to use `/single-story-plan` vs. `/epic-plan` Phase 8:**

| Trait                | `/single-story-plan`                       | `/epic-plan` Phase 8                         |
| -------------------- | ------------------------------------------ | -------------------------------------------- |
| Output               | One standalone Story Issue                 | Decomposed Feature/Story/Task hierarchy      |
| Parent Epic          | None (no `Epic: #N` in body)               | Required                                     |
| Downstream workflow  | `/single-story-deliver`                    | `/story-deliver` (per Story)                 |
| Replan surface       | Out of scope (recreate manually if needed) | `/epic-plan --replan` regenerates everything |

If a Story-under-Epic needs replanning, use `/epic-plan --replan`. If you
have a refactor, framework-maintenance idea, or any standalone unit of
work, use this workflow.

## Prerequisites

1. `GITHUB_TOKEN` or `gh auth status` clean — `gh issue create` runs at
   persist time.
2. The `type::story` label and the chosen `persona::*` label exist in the
   repo. Run [`agents-bootstrap-github.js`](../scripts/agents-bootstrap-github.js)
   once to provision them.

## Invocation shapes

```bash
# Seed from an inline string:
/single-story-plan --idea "rip out the unused TaskBodyMigrator export"

# Seed from a notes file:
/single-story-plan --from-notes temp/single-story-2293-notes.md

# Inspect the draft body without creating an Issue:
/single-story-plan --dry-run --body temp/single-story-draft.md
```

## Phase 1 — Emit Context

Run the emit-context phase. The CLI prints a JSON envelope on stdout and
routes all log lines to stderr so the captured file is unconditionally
parseable by `JSON.parse`.

```bash
node .agents/scripts/single-story-plan.js --emit-context \
  --idea "<seed>" \
  [--persona engineer] \
  [--refine | --no-refine] \
  [--pretty] > temp/single-story-context.json
```

Envelope fields (`kind: "single-story-plan-context"`, `version: 1`):

| Field                  | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `seed`                 | The raw seed (verbatim from `--idea` / `--from-notes`).   |
| `refine`               | `{ refine, reason }` heuristic verdict.                   |
| `persona`              | Persona label to apply (default `engineer`).              |
| `bodyTemplate`         | Contents of `.agents/templates/single-story-body.md`.     |
| `requiredSections`     | `["Context", "Acceptance Criteria", "Out of Scope", "Notes"]`. |
| `duplicateCandidates`  | Ranked open Stories whose titles fuzzy-match the seed.    |
| `techStack`            | The `## Tech Stack` section of `docs/architecture.md`.    |
| `deliverContract`      | Workflow path + required/forbidden labels and references. |

### Refine heuristic

`refine.refine` is `true` when the seed is shorter than 200 characters
(or empty). Pass `--refine` / `--no-refine` to override. When the
envelope advises refinement, activate the
[`core/idea-refinement`](../skills/core/idea-refinement/SKILL.md) skill
before drafting the body — same skill `/epic-plan` Phase 1 drives.

## Phase 2 — Host LLM Authors a Draft Body

Using the envelope above, draft a Story body that:

- Starts with `# <title>` (the H1 becomes the GitHub Issue title at
  persist time).
- Includes every section in `requiredSections` (`## Context`,
  `## Acceptance Criteria`, `## Out of Scope`, `## Notes`).
- Has at least one unchecked checklist item under `## Acceptance Criteria`
  (`- [ ] …`).
- Does **NOT** contain any `Epic: #N` reference — that breaks the
  standalone contract enforced by `single-story-init.js`.

Write the draft to `temp/single-story-draft.md`.

### HITL — operator confirms the draft

Display the draft to the operator and **STOP**. Do not call the persist
phase until the operator explicitly confirms the draft. This mirrors the
HITL gate `/epic-plan` Phase 3 enforces before opening the Epic Issue.

## Phase 3 — Persist (`gh issue create`)

```bash
node .agents/scripts/single-story-plan.js \
  --body temp/single-story-draft.md \
  [--persona engineer]
```

The script:

1. Reads the body file.
2. Runs `validateStoryBody` — required sections present, no `Epic:`
   reference, AC checklist non-empty. Fails fast on any error.
3. Extracts the H1 title.
4. Calls `gh issue create` with `--title`, `--body-file`, and the
   `type::story` + `persona::<name>` labels.
5. Prints a JSON line with `{ issueNumber, title, labels }` and a
   trailing `Next: /single-story-deliver <id>` hint on stderr.

### `--dry-run`

```bash
node .agents/scripts/single-story-plan.js \
  --body temp/single-story-draft.md --dry-run
```

Prints the resolved title, labels, and `gh` argv plus the full body, then
exits 0. No GitHub mutations. Use this to spot-check the draft and the
exact `gh issue create` shape that would run.

## Constraints

- **No `Epic: #N` references.** This is the standalone contract; persist
  fails fast if one is present. To attach a Story to an Epic, use
  `/epic-plan` Phase 8 instead.
- **No external LLM APIs.** Mirrors the v5.6 contract: the host LLM does
  the authoring; the Node wrapper does the I/O.
- **Idempotent.** Re-running `--emit-context` is safe. Re-running
  `--body` opens a new Issue (it is not aware of prior runs); use
  `--dry-run` first when iterating on the draft.
- **No child Task creation.** Standalone Stories are atomic by contract
  ([`single-story-deliver.md`](helpers/single-story-deliver.md)).

## See also

- [`/single-story-deliver`](helpers/single-story-deliver.md) — the consumer
  workflow that picks the Story up after this one creates it.
- [`/epic-plan`](epic-plan.md) — the Epic-tier equivalent. Phases 1–4
  inspired the seed-capture + envelope-emit pattern used here.
- [`core/idea-refinement`](../skills/core/idea-refinement/SKILL.md) —
  optional pre-authoring skill activated when the seed is short.
