---
description:
  Unified planning entry point. Routes a seed idea (via scope triage) or an
  existing Epic ID to the right planning path — the full Epic pipeline
  (PRD, Tech Spec, Acceptance Spec, decomposition) or the standalone-Story
  authoring path — and absorbs every planning flag.
---

# /plan [Epic ID] | --idea "<seed>" | --from-notes <path>

## Role

Router. `/plan` owns argument parsing and path selection only — all phase
content lives in the two path helpers:

- [`helpers/plan-epic.md`](helpers/plan-epic.md) — the full Epic planning
  pipeline (PRD, Tech Spec, Acceptance Spec, work breakdown, healthcheck,
  handoff).
- [`helpers/plan-story.md`](helpers/plan-story.md) — the standalone-Story
  authoring path (context envelope → host-LLM draft → HITL → issue create).

The existing **scope-triage skill**
([`core/scope-triage`](../skills/core/scope-triage/SKILL.md), verdicts
`epic | story | borderline`) is the router's classifier on the `--idea`
path; no new classification machinery exists.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/plan --idea "<seed>"` | Ideation → **scope triage**. Verdict `epic` → run [`helpers/plan-epic.md`](helpers/plan-epic.md) from Phase 1 (Idea Refinement). Verdict `story` → run [`helpers/plan-story.md`](helpers/plan-story.md) Phases 1–3. Verdict `borderline` → present both options and let the operator choose. |
| `/plan <epicId>` | Existing-Epic path — run [`helpers/plan-epic.md`](helpers/plan-epic.md) from Phase 5. When the helper's story-sized advisory fires (the Epic is really one Story), convert **internally** by switching to [`helpers/plan-story.md`](helpers/plan-story.md) — do not re-triage and do not hop commands. |
| `/plan --from-notes <path>` | Internal handoff target (e.g. from `/audit-to-stories`). The notes file already encodes the path decision; do **not** re-run scope triage. Route per the notes' declared shape. |

## Flags

`/plan` absorbs every flag the two retired planning commands accepted and
forwards them to the active path helper:

| Flag | Path | Meaning |
| --- | --- | --- |
| `--idea "<seed>"` | both | Seed text; triggers scope triage. |
| `--from-notes <path>` | both | Pre-triaged handoff notes; skips triage. |
| `--force` | Epic | Close + recreate an existing ticket tree on re-plan. |
| `--force-review` | Epic | Force the operator review gate even when risk routing would skip it. |
| `--allow-over-budget` | Epic | Permit a decomposition that exceeds `planning.maxTickets`. |
| `--steal` | Epic | Forcibly transfer a foreign Epic-lease. |
| `--dry-run` | both | Author + validate without GitHub writes. |
| `--body <path>` | Story | Pre-authored Story body file; validate (and create, unless `--dry-run`) without re-authoring. |
| `--persona <name>` | Story | Override the persona label on the drafted Story. |
| `--refine` / `--no-refine` | Story | Toggle the draft refinement loop. |

**Cross-path flags are no-ops with a warning.** An Epic-only flag passed on
the story path (or vice versa) is reported once
(`[plan] --force has no effect on the story path`) and ignored — never an
error. The historical bidirectional escalation between the two planning
commands (story-sized Epic ↘ Story; epic-sized Story draft ↗ Epic) is now
an **internal branch switch** inside this router: same skills, same
helpers, no command hop and no operator re-entry.

## Procedure

1. **Parse args.** Exactly one of `<epicId>`, `--idea`, `--from-notes`, or
   `--body` must be present; anything else is a usage error naming the four
   forms. A `--body` invocation routes to the story path (no triage).
2. **Triage (idea path only).** Run the
   [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) skill on the
   seed. Record the verdict in chat (one line).
3. **Delegate.** Read the selected path helper **in full** and execute it
   from its entry phase, forwarding the absorbed flags. The helper's phase
   numbering, HITL gates, and scripts are unchanged — this router adds no
   phase content.
4. **Internal returns.** When a path helper would historically have handed
   off to the other planning command, switch helpers in-place and continue;
   surface the switch to the operator as a one-line note.

## Constraints

- The plan→deliver boundary stays a hard stop: `/plan` never starts
  delivery. It ends by naming the follow-up — `/deliver <epicId>` for a
  planned Epic, `/deliver <storyId>` for a standalone Story.
- The router never calls planning scripts directly; the path helpers own
  every script invocation.

## See also

- [`/deliver`](deliver.md) — the unified delivery entry point.
- [`helpers/plan-epic.md`](helpers/plan-epic.md) /
  [`helpers/plan-story.md`](helpers/plan-story.md) — the path helpers.
