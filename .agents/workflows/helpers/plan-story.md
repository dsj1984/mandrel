---
description:
  Author a standalone Story (no parent Epic) from a short prompt. Builds a
  context envelope, lets the host LLM draft the body, and creates the
  GitHub Issue with type::story and a persona label — ready to feed into
  /single-story-deliver.
---

# helpers/plan-story — standalone-Story planning path (invoked by /plan)

## Overview

`/plan` is the standalone counterpart to
[`/plan`](plan-epic.md) for Stories that are **not** attached to an
Epic. It closes the gap between "one-line idea" and "well-formed
standalone Story body ready for [`/single-story-deliver`](single-story-deliver.md)"
using the same `host LLM authors + Node wrapper persists` split as
`/plan`.

```text
/plan --idea "<seed>"
  → story-plan.js --emit-context               (envelope: seed, template, dup candidates)
  → host LLM authors a draft Story body         (in chat, using the envelope)
  → operator confirms (HITL)
  → story-plan.js --body <file>                 (validate, gh issue create)
  → "Next: /deliver <id>"
```

**The two paths of `/plan` — when each applies:**

| Trait                | Standalone-Story path (this helper)        | Epic decomposition path (`helpers/plan-epic.md`) |
| -------------------- | ------------------------------------------ | -------------------------------------------- |
| Output               | One standalone Story Issue                 | Epic with child Stories                      |
| Parent Epic          | None (no `Epic: #N` in body)               | Required                                     |
| Downstream workflow  | `/deliver <storyId>`                       | `/deliver <epicId>`                          |
| Replan surface       | Out of scope (recreate manually if needed) | `/plan <epicId> --force` regenerates the backlog |
| Inbound route        | `--idea` with a `story` triage verdict, `--body`, **or** a scope-triage handoff from the Epic path | Direct (`<epicId>`, or `--idea` with an `epic` verdict) |
| Outbound route       | Phase 2 may **escalate** an epic-sized draft to the Epic path (internal branch switch) | The story-sized advisory may **convert** a one-Story Epic to this path |

If a Story-under-Epic needs replanning, use `/plan <epicId> --force`. If you
have a refactor, framework-maintenance idea, or any standalone unit of
work, use this workflow.

**Inbound from `/plan` scope triage.** `/plan` Phase 1.5 runs the
[`core/scope-triage`](../../skills/core/scope-triage/SKILL.md) rubric over the
sharpened one-pager. On a `story` / `borderline` verdict the operator may route
the work here via `/plan --from-notes <path>`. That invocation is a
**scope-triage handoff** — the triage decision is already made, so `/plan`
MUST NOT re-triage it (the no-re-triage rule in the skill); it proceeds straight
to authoring the standalone Story body from the handed-off one-pager.

## Prerequisites

1. `GITHUB_TOKEN` or `gh auth status` clean — `gh issue create` runs at
   persist time.
2. The `type::story` label and the chosen `persona::*` label exist in the
   repo. Run [`agents-bootstrap-github.js`](../../scripts/agents-bootstrap-github.js)
   once to provision them.

## Invocation shapes

```bash
# Seed from an inline string:
/plan --idea "rip out the unused TaskBodyMigrator export"

# Seed from a notes file:
/plan --from-notes temp/single-story-2293-notes.md

# Inspect the draft body without creating an Issue:
/plan --dry-run --body temp/single-story-draft.md
```

## Phase 1 — Emit Context

Run the emit-context phase. The CLI prints a JSON envelope on stdout and
routes all log lines to stderr so the captured file is unconditionally
parseable by `JSON.parse`.

```bash
node .agents/scripts/story-plan.js --emit-context \
  --idea "<seed>" \
  [--persona engineer] \
  [--refine | --no-refine] \
  [--pretty] > temp/single-story-context.json
```

Envelope fields (`kind: "story-plan-context"`, `version: 1`):

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
[`core/idea-refinement`](../../skills/core/idea-refinement/SKILL.md) skill
before drafting the body — same skill `/plan` Phase 1 drives.

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

### Scope-triage escalation gate (symmetric counterpart to `/plan` Phase 1.5)

Once the draft body exists — and **only** then, because the seed alone is not
an honest basis for a sizing judgment — run the
[`core/scope-triage`](../../skills/core/scope-triage/SKILL.md) rubric over the
**drafted Story body** to catch an Epic-sized scope before it is persisted as a
standalone Story. This is the outbound mirror of `/plan` Phase 1.5's
inbound downgrade gate: the two planning entry points route toward each other
instead of each silently accepting wrong-sized work.

**Skip the gate entirely when `/plan` was entered via a scope-triage
handoff** — i.e. from `/plan` Phase 1.5 (the inbound route above) or the
`/plan` Phase 5.5 existing-Epic conversion path. A handoff is a triage
decision already made; re-running the rubric here would re-litigate a settled
call and risk a ping-pong between the two workflows (the skill's no-re-triage
rule).

Otherwise, activate the skill **by reference** — read its `SKILL.md` via the
`Read` tool and apply its rubric; do **not** restate its sizing thresholds or
copy its verdict prose here. The skill anchors its sizing judgment to
`DELIVERABLE_GRANULARITY_GUIDANCE` / `DEFAULT_TASK_SIZING` in
[`ticket-validator-sizing.js`](../../scripts/lib/orchestration/ticket-validator-sizing.js)
and emits one verdict — `epic` | `story` | `borderline`. The verdict is
host-LLM judgment: there is **no `--flag`**, no scorer, no schema, and no label
transition behind it. (The `refine` heuristic in `story-plan.js` is unchanged —
it is a deterministic seed-length proxy, not a scope-size judgment.) The verdict
folds into the **existing** draft-confirmation HITL stop below — it does **not**
add a second stop.

### HITL — operator confirms the draft (verdict folded in)

Display the draft to the operator and **STOP**. Do not call the persist phase
until the operator explicitly confirms the draft. This mirrors the HITL gate
`/plan` Phase 3 enforces before opening the Epic Issue. The scope-triage
verdict folds into this same stop:

- **`story` verdict (or gate skipped via handoff)** → no extra prompt. The
  operator confirms the draft as usual and the run proceeds to Phase 3
  (persist).
- **`epic` verdict** (multiple independent capabilities, a plausible
  sizing-ceiling breach, or a real dependency structure) → the confirmation
  prompt presents a **three-way operator choice**:
  - **Recommended: escalate to `/plan --idea`** (with the triage
    rationale) — persist the notes/draft to a notes file and hand off to
    `/plan --idea` (or `--from-notes <path>`), identifying the invocation
    as a **scope-triage handoff** so `/plan` skips its own Phase 1.5 gate
    (the skill's no-re-triage rule). Then **abandon the draft and exit
    `/plan`** — no standalone Story is created.
  - **Persist as a standalone Story anyway** — ignore the recommendation and
    proceed to Phase 3 with the draft unchanged. Being wrong in the `epic`
    direction is cheap to tolerate: if the operator persists an oversized Story,
    the sizing validator and delivery reality push back later. The gate's value
    is surfacing the recommendation while the scope is still free to change.
  - **Abort** — stop planning entirely. No Issue is created.

  **Never auto-route.** The verdict is advisory; the operator always decides,
  and no `agent::*` / label transition happens on either side of the choice.

## Phase 3 — Persist (`gh issue create`)

```bash
node .agents/scripts/story-plan.js \
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
node .agents/scripts/story-plan.js \
  --body temp/single-story-draft.md --dry-run
```

Prints the resolved title, labels, and `gh` argv plus the full body, then
exits 0. No GitHub mutations. Use this to spot-check the draft and the
exact `gh issue create` shape that would run.

## Constraints

- **No `Epic: #N` references.** This is the standalone contract; persist
  fails fast if one is present. To attach a Story to an Epic, use
  `/plan` Phase 8 instead.
- **No external LLM APIs.** Mirrors the v5.6 contract: the host LLM does
  the authoring; the Node wrapper does the I/O.
- **Idempotent.** Re-running `--emit-context` is safe. Re-running
  `--body` opens a new Issue (it is not aware of prior runs); use
  `--dry-run` first when iterating on the draft.
- **Atomic by contract.** A Story is the leaf of the 2-tier hierarchy — it
  has no child tickets. Its acceptance criteria and verification steps live
  inline on the Story body
  ([`single-story-deliver.md`](single-story-deliver.md)).

## See also

- [`/single-story-deliver`](single-story-deliver.md) — the consumer
  workflow that picks the Story up after this one creates it.
- [`/plan`](plan-epic.md) — the Epic-tier equivalent. Phases 1–4
  inspired the seed-capture + envelope-emit pattern used here.
- [`core/idea-refinement`](../../skills/core/idea-refinement/SKILL.md) —
  optional pre-authoring skill activated when the seed is short.
