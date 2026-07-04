---
description: >-
  Shared scope-triage gate fragment — the single home for the verdict
  meanings, the three-way operator choice, the --yes headless resolution,
  and the no-re-triage rule that both /plan paths reference instead of
  restating.
caller: plan-epic.md, plan-story.md
---

# helpers/scope-triage-gate — shared scope-triage gate semantics

> **Not a slash command.** This file lives in `helpers/` and is a
> path-included fragment (not projected into the plugin command tree). It is
> referenced by [`plan-epic.md`](plan-epic.md) (Phases 1.5 and 5.5) and
> [`plan-story.md`](plan-story.md) (Phase 2), which supply only their
> path-specific firing conditions and defer the gate mechanics here.

## What the gate is

Both `/plan` paths run the
[`core/scope-triage`](../../skills/core/scope-triage/SKILL.md) rubric over the
path-appropriate artifact (an ideation one-pager, an existing Epic body, or a
drafted Story body) to catch a wrong-sized scope **before** it is committed to
the wrong pipeline. The rubric is host-LLM judgment anchored **by reference**
to `DELIVERABLE_GRANULARITY_GUIDANCE` / `DEFAULT_TASK_SIZING` in
[`ticket-validator-sizing.js`](../../scripts/lib/orchestration/ticket-validator-sizing.js).
There is **no `--flag`**, no scorer, no schema, and no label transition behind
the gate. Each referencing path activates the skill by reading its `SKILL.md`
via the `Read` tool and applying its rubric — do **not** restate the skill's
sizing thresholds or copy its verdict prose.

## Verdict meanings

The rubric emits exactly one verdict:

- **`epic`** — the scope is genuinely Epic-sized (multiple independent
  capabilities, a plausible sizing-ceiling breach, or a real dependency
  structure). Proceed on the Epic path; no downgrade offered.
- **`story`** — the scope is really a single capability-sized Story. The Epic
  ceremony is not worth paying for; the gate offers a downgrade/handoff to the
  standalone-Story path.
- **`borderline`** — the rubric cannot confidently place the scope on either
  side. Treated the same as `story` at the gate: the three-way choice is
  presented so the operator makes the call.

The verdict is **advisory**. Being wrong in the `epic` direction is cheap
(Phase 8.3 consolidation and the sizing validator catch an over-planned Story
later), so the gate never costs the operator a stop on an `epic` verdict; the
gate exists to avoid the ceremony tax of pushing a story-sized scope through
the full Epic pipeline.

## The three-way operator choice

The referencing path folds the verdict into its **existing** HITL confirmation
stop — it never adds a second stop. On a `story` / `borderline` verdict, that
confirmation presents a **three-way operator choice**:

- **Recommended (the path-specific downgrade/handoff)** — with the triage
  rationale. The referencing path defines the concrete action (persist a
  notes/seed file and hand off to the sibling `/plan` path, identifying the
  invocation as a **scope-triage handoff**), then **exits** the current path.
- **Proceed on the current path anyway** — ignore the recommendation and
  continue with the artifact unchanged.
- **Abort** — stop planning entirely. Nothing is mutated.

**Never auto-route.** The verdict is advisory and the operator always decides;
no `agent::*` / label transition happens on either side of the choice. (The
one sanctioned exception is `--yes`, below.)

## `--yes` (headless) resolution

`"Never auto-route"` is the **interactive** contract. When `/plan` was invoked
with `--yes`, the operator has *pre-authorized* the recommendation and the gate
does **not** STOP:

- The three-way choice resolves to its **Recommended** branch
  deterministically — the handoff carries `--yes` so the receiving `/plan`
  path also auto-proceeds; an `epic` verdict simply continues on the current
  path with no wait.
- Display the artifact and the verdict line for the record, then proceed
  without waiting.

This is the **only** sanctioned auto-route, and it exists solely to make
`/plan` driveable headlessly. `--yes` does not alter the rubric or the verdict
meanings; it only forces the Recommended resolution where the gate would
otherwise STOP. See
[`plan.md` § Headless / non-interactive mode](../plan.md#headless--non-interactive-mode---yes).

## No-re-triage rule

A **scope-triage handoff** is a triage decision *already made*. When `/plan` is
entered via a handoff (from the ideation-path Phase 1.5, the existing-Epic
Phase 5.5 conversion, or the standalone-Story Phase 2 escalation), the
receiving path **MUST NOT** re-run this gate. Re-triaging a settled call would
re-litigate it and risk a ping-pong between the two `/plan` paths. Each
referencing path states its own skip-on-handoff condition and defers the
rationale here.
