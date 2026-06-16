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
| `--allow-over-budget` | Epic | Permit a decomposition that exceeds the framework `maxTickets` reviewability budget. |
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

## First-run preflight

Before routing to a path helper, run a **first-run preflight** to catch
common day-0 issues that would silently degrade every downstream task.

### When the preflight fires

The preflight runs when **any** of these is true:

1. One or more `project.docsContextFiles` entries are absent under the
   configured `docsRoot`.
2. One or more present `docsContextFiles` still carry the
   `<!-- MANDREL:STUB -->` marker (i.e. they are un-edited scaffolded stubs).
3. The last `mandrel doctor` verdict cached in `temp/doctor-result.json`
   records `"verdict": "unready"`. An **absent** cache file is no signal —
   doctor may simply never have run; only an explicit recorded unready
   verdict fires this signal.

### Preflight procedure

1. **Detect the condition.** Check the three signals above. When none is
   true, skip the preflight entirely — no operator interaction, no delay.
2. **Offer to flesh out docs.** Summarize the found condition to the
   operator (e.g. "3 docsContextFiles are missing" or "architecture.md
   still carries the stub marker") and ask:
   > *Do you want to flesh out these docs from the codebase before planning?
   > [y/N]*
3. **On acceptance.** Walk through each affected file, read relevant
   codebase artifacts (source files, README, existing docs), and write real
   content to replace the stub. Then re-run `mandrel doctor` to confirm
   readiness. If doctor passes, proceed to routing.
4. **On decline.** Log one line:
   > *[plan] Proceeding with degraded doc context — planning quality may be
   > reduced.*
   Then continue to the normal routing procedure below.

The preflight is **never a hard stop** — declining continues planning with a
noted degradation. It only fires when there is a genuine signal (missing or
stubbed docs, or an unready doctor verdict).

## Procedure

1. **Parse args.** Exactly one of `<epicId>`, `--idea`, `--from-notes`, or
   `--body` must be present; anything else is a usage error naming the four
   forms. A `--body` invocation routes to the story path (no triage).
2. **First-run preflight.** Run the preflight above. Skip when all signals
   are clear (healthy project).
3. **Triage (idea path only).** Run the
   [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) skill on the
   seed. Record the verdict in chat (one line).
4. **Delegate.** Read the selected path helper **in full** and execute it
   from its entry phase, forwarding the absorbed flags. The helper's phase
   numbering, HITL gates, and scripts are unchanged — this router adds no
   phase content.
5. **Internal returns.** When a path helper would historically have handed
   off to the other planning command, switch helpers in-place and continue;
   surface the switch to the operator as a one-line note.

## Constraints

- The plan→deliver boundary stays a hard stop: `/plan` never starts
  delivery. It ends by naming the follow-up — `/deliver <epicId>` for a
  planned Epic, `/deliver <storyId>` for a standalone Story.
- The router never calls planning scripts directly; the path helpers own
  every script invocation.

## See also

- [`/deliver`](deliver.md) — the unified delivery entry point. Accepts a
  single Epic, one or more standalone Stories, or any mix of ≥1 Epics and
  standalone Stories — mixed sets compose a sequential segment plan.
- [`helpers/plan-epic.md`](helpers/plan-epic.md) /
  [`helpers/plan-story.md`](helpers/plan-story.md) — the path helpers.
