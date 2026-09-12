---
description:
  Unified planning entry point. Interrogate → author → persist. Emits one
  Story by default; splits into N>1 only under the default-single split policy.
---

# /mandrel-plan

> **Lean spine.** Happy path + gate list; edge-case detail is on demand in
> [`helpers/plan-reference.md`](helpers/plan-reference.md).

## Inputs

Single planning path — there is no Epic/Story router, no scope-triage
`epic|story` verdict (Gate #3's container groups, never routes). **Derive the
mode from what the operator typed, announce it, act**:

| Invocation | Mode | Behavior |
| --- | --- | --- |
| `/mandrel-plan` | ask | Ask what to plan; nothing runs first. |
| `/mandrel-plan add a --json flag to doctor` | seed | Ideation from prose → **one Story by default** → persist. |
| `/mandrel-plan temp/notes/idea.md` | seed-file | Same, from notes. An existing file is a path, not prose. |
| `/mandrel-plan 4712[,4713…]` | tickets | Fetch issue(s), analyze into proper Stories (prefer N=1 rewrite). |
| `/mandrel-plan 4712`, already delivered | amends | Amend a shipped Story from a **delta envelope**. |

**Resolving a bare id.** Read live state rather than asking: `agent::done` can
only be amended, an open unplanned issue only planned. **Announce the
derivation**. Ask **only** for an open Story already at `agent::ready`.

## Saying what you want

No flags to remember — state intent; the workflow fills in the CLI
([ref](helpers/plan-reference.md)). Run scripts with `--help`.

`--yes` is **runner-set, never operator-typed** — cron, `/loop`, and headless
dispatch set it to mean *nobody is at the keyboard*, which auto-proceeds the
gates below (#1 and #2) and skips #3. Never offer it to an operator.

## Default-single split policy

Author **one Story** unless the pieces have **near-zero overlap** or sit across
an **architectural seam**. Coupled work stays one Story — `## Slicing`
checkpoints, not sibling tickets ([ref](helpers/plan-reference.md)).

## Procedure

### 1. Interrogate

```bash
node .agents/scripts/plan-context.js --seed "<seed>" \
  --out temp/plan-<slug>/plan-context.json
# or: --seed-file <path> | --tickets 123,456 | --amends #<id>
```

**Always pass `--out`.** Persist auto-discovers the envelope from `--plan-dir`
and derives source ids from its `sourceTickets[]`; it also writes
**`stories.template.json`**, step 2's skeleton.

The envelope carries docs context, the story-author prompt (`systemPrompts.story`,
plus `systemPrompts.storySplitRules` for an N>1 draft), `sourceTickets[]`,
`duplicates[]` (open **Stories**, never Epics), `epicCandidates[]` +
`dependencyCandidates[]` (Gate #3; path collisions), `priorFeedback` and
advisory `complexitySignals` (**no routing authority**). An envelope over the
planner-context ceiling is written truncated with a `truncated` note, never
refused.

**Triage each unknown by resolver** ([ref](helpers/plan-reference.md)): an
**AFK** unknown (research settles it) is resolved before authoring, never
assumed; a **HITL** unknown goes to Gate #1. Under `--yes` do not ask free-form
operator questions — AFK unknowns are still researched; only HITL unknowns land
in Key Assumptions, each a decision-made-by-default.

**Gate #1** — STOP for exactly two things: confirm the sharpened plan intent,
and settle any HITL unknown the operator owns. Everything else the envelope
surfaced — `duplicates[]`, open `intake` rows, a truthy
`memoryPoolAdvisory.recommend`, a truthy `complexitySignals.uiSurface` naming
[`/prototype`](prototype.md) (never invoke it here) — collapses to
**one advisory line** under the gate; none of it stops the run or reroutes
it ([ref](helpers/plan-reference.md)). Under `--yes`, auto-proceed.

### 2. Author

**One-shot authoring.** From `stories.template.json`, author `stories.json`
in one pass. `body` is markdown **or** a structured object;
persist parses either, serializes canonical markdown and syncs top-level
`acceptance[]` / `verify[]` in — never dual-author them.

**Grounding = your reads + Phase 8.** Nothing inventories the repo: read each
file you cite; persist hard-errors on any `{path, assumption}` absent from the
tree — a `refactors-existing` on a path the base branch **deleted or renamed**
included. One rescue: a **never-tracked** one normalises to `creates`. Fields:
[ref](helpers/plan-reference.md).

Artifacts under `temp/plan-<slug>/`: `stories.json` (**length 1 by default**;
a Spec is as long as the work needs, inline, never under `docs/`); optional
`techspec.md` (**N===1 only**, folded into `## Spec`) and
`acceptance-manifest.json` (N>1 — `--plan-acceptance`). Use the envelope
`systemPrompts.story`; split only under the policy above, and when you do,
read `systemPrompts.storySplitRules` too — it carries the schedule and
partition rules the core omits.

**Tickets mode:** every Story authors a top-level `supersedes[]`; persist
refuses a partial map ([shape](helpers/plan-reference.md)).

The maker-blind **pre-mortem** critic is not a step of this spine: run
`plan-critics.js` only when the operator asks for it
([how](helpers/plan-reference.md)).

### 3. Persist

**Gate #2** — STOP for approval before persist **only** when the operator asked
to review (`--force-review`). Under `--yes`, auto-proceed.

**Gate #3 — adopt, else create.** Offer the top `epicCandidates[]` Epic at
**any N** (`--epic <id>`); else, at **N>2**, a new container (`--epic-title` /
`--epic-goal`). Never unasked ([ref](helpers/plan-reference.md)).

Run persist `--dry-run` **first** — same command, writes suppressed; every gate
runs before the first `createIssue`, and the run **lists its warnings**
(a `creates` / `refactors-existing` the base branch disagrees with, a goal or
acceptance path absent at base, an open question in a body) and the
`changes[]` repairs it applied ([list](helpers/plan-reference.md)). Read
them; they never stop the persist:

```bash
node .agents/scripts/plan-persist.js \
  --stories temp/plan-<slug>/stories.json \
  --plan-dir temp/plan-<slug> \
  [--plan-acceptance temp/plan-<slug>/acceptance-manifest.json] \
  [--tech-spec temp/plan-<slug>/techspec.md] \
  [--source-tickets 123,456] \
  [--epic <id> | --epic-title "<name>" --epic-goal "<one paragraph>"]
```

`--chain-on-clean` folds a clean dry-run into the persist for **any** plan —
the dry-run's warning list is the review.

Persist creates `type::story` issue(s), a **metadata-only** `plan-run::<id>`
label, `blocked by #<id>` footers for every `depends_on` edge, and on a Gate #3
yes links them under a `type::epic` container (adopted or new). `agent::ready`
is the **terminal** flip after receipts land; stdout is pure JSON. Tickets mode
also comments on and closes each source id ([ref](helpers/plan-reference.md)).

## Constraints

- `/mandrel-plan` never starts delivery — its Stories land via
  [`/mandrel-deliver`](mandrel-deliver.md).
- Duplicate search targets open Stories (`type::story`), not Epics; and
  deterministic gates still fail closed under `--yes`.
- A container Epic is never a work item and only an **open** one is adoptable;
  no Story body gains an `Epic: #N` footer (linkage is parent→child only).
- `depends_on` takes a sibling slug or `#<id>` (open Story).

## See also

[`/mandrel-deliver`](mandrel-deliver.md), [`/audit-to-stories`](audit-to-stories.md),
[`helpers/plan-reference.md`](helpers/plan-reference.md) (on-demand detail),
[`core/scope-triage`](../skills/core/scope-triage/SKILL.md) — optional
split-advisory notes only (no routing verdict).
