---
description:
  Unified planning entry point. Routes a seed idea (via scope triage) or an
  existing Epic ID to the right planning path — the 3-step Epic path
  (interrogate → author → persist) or the standalone-Story authoring path —
  and absorbs every planning flag.
---

# /plan [Epic ID] | --idea "<seed>" | --from-notes <path>

## Role

Router. `/plan` owns argument parsing and path selection only — all step
content lives in the two path helpers:

- [`helpers/plan-epic.md`](helpers/plan-epic.md) — the 3-step Epic planning
  path (interrogate → author → persist; Tech Spec + Acceptance Table folded
  into the Epic body, then the Story backlog or a single-delivery marker).
- [`helpers/plan-story.md`](helpers/plan-story.md) — the standalone-Story
  authoring path (context envelope → host-LLM draft → HITL → issue create).

The existing **scope-triage skill**
([`core/scope-triage`](../skills/core/scope-triage/SKILL.md), verdicts
`epic | story | borderline`) is the router's classifier on the `--idea`
path; no new classification machinery exists.

## Inputs

| Invocation | Behavior |
| --- | --- |
| `/plan --idea "<seed>"` | Ideation → **scope triage**. Verdict `epic` → run [`helpers/plan-epic.md`](helpers/plan-epic.md) from its ideation entry. Verdict `story` → run [`helpers/plan-story.md`](helpers/plan-story.md) Phases 1–3. Verdict `borderline` → present both options and let the operator choose. |
| `/plan <epicId>` | Existing-Epic path — run [`helpers/plan-epic.md`](helpers/plan-epic.md) from its existing-Epic entry. When the helper's story-sized advisory fires (the Epic is really one Story), convert **internally** by switching to [`helpers/plan-story.md`](helpers/plan-story.md) — do not re-triage and do not hop commands. |
| `/plan --from-notes <path>` | Internal handoff target (e.g. from `/audit-to-stories`). The notes file already encodes the path decision; do **not** re-run scope triage. Route per the notes' declared shape. |

## Flags

`/plan` absorbs every planning flag and forwards it to the active path
helper:

| Flag | Path | Meaning |
| --- | --- | --- |
| `--idea "<seed>"` | both | Seed text; triggers scope triage. |
| `--from-notes <path>` | both | Pre-triaged handoff notes; skips triage. |
| `--force` | Epic | Re-plan: overwrite managed sections in place and close + recreate the ticket tree. |
| `--amend` | Epic | Change-request delta persist: tickets carry `op: add\|modify\|keep\|close`; close ops require `--explicit-delete` after the dry-run diff. |
| `--force-review` | Epic | Force the gate #2 operator review even when risk routing would skip it. |
| `--allow-over-budget` | Epic | Permit a decomposition that exceeds the framework `maxTickets` reviewability budget. |
| `--yes` | both | **Non-interactive / headless mode.** Deterministically auto-proceeds the two `/plan` HITL STOP gates — gate #1 (exit of interrogate) and gate #2 (risk-routed pre-persist review) — without waiting for operator input. Parallel to [`/deliver --yes`](deliver.md). Composes with `--allow-over-budget` and with the risk-routed gate #2 skip (it forces a proceed where those do not apply). Default (flag absent) behavior is unchanged: both gates still STOP for interactive use. |
| `--steal` | Epic | Forcibly transfer a foreign Epic-lease. |
| `--resume` | Epic | Continue a partial persist (rate-limit / crash recovery). |
| `--dry-run` | Story | Author + validate without GitHub writes (`story-plan.js --dry-run`). |
| `--body <path>` | Story | Pre-authored Story body file; validate (and create, unless `--dry-run`) without re-authoring. |
| `--persona <name>` | Story | Override the persona label on the drafted Story. |
| `--refine` / `--no-refine` | Story | Toggle the draft refinement loop. |

**Cross-path flags are no-ops with a warning.** An Epic-only flag passed on
the story path (or vice versa) is reported once
(`[plan] --force has no effect on the story path`) and ignored — never an
error. The historical bidirectional escalation between the two planning
commands (story-sized Epic ↘ Story; epic-sized Story draft ↗ Epic) is an
**internal branch switch** inside this router: same skills, same helpers, no
command hop and no operator re-entry.

### Headless / non-interactive mode (`--yes`)

`--yes` is the headless escape hatch for an unattended driver (CI, a
benchmark harness, or any `claude -p` run with no human at the keyboard). It
is the `/plan`-side parallel of [`/deliver --yes`](deliver.md). `/plan` has
exactly **two** HITL STOP gates, and `--yes` deterministically auto-proceeds
**both** without waiting for operator input:

1. **Gate #1 — the exit of the interrogate step.** One conceptual gate with
   a face per entry form, and `--yes` auto-proceeds all of them:
   - On the `--idea` Epic path, the interrogate step of
     [`helpers/plan-epic.md`](helpers/plan-epic.md) STOPs to confirm the
     sharpened one-pager, folding in the scope-triage verdict and the
     duplicate-candidate review.
   - On the `--idea` Story path,
     [`helpers/plan-story.md`](helpers/plan-story.md) Phase 2 STOPs to
     confirm the drafted Story body.
   - On the existing-Epic (`/plan <epicId>`) path, the interrogate step
     STOPs to confirm the folded re-plan / clarity-refinement / advisory
     outcomes (the Clarity Gate's refined-body diff among them).

   Under `--yes` each resolves as **approved**, and a `story` /
   `borderline` triage verdict resolves to its **Recommended** branch rather
   than prompting the three-way choice. **The interrogation itself runs
   exactly one bounded pass**: no operator questions are asked — facts come
   from the codebase, and every unresolved unknown lands in the one-pager's
   **Key Assumptions** section instead of a question, so a headless driver
   can never hang inside a free-form interrogation. The verdict / clarity
   scoring is still recorded in chat (one line); only the *wait* is
   suppressed — the deterministic clarity *scoring* inside the
   `plan-context.js` envelope always runs.
2. **Gate #2 — the risk-routed pre-persist review.** When the authored risk
   verdict routes to review (high risk, or the operator also passed
   `--force-review`), [`helpers/plan-epic.md`](helpers/plan-epic.md) step 3
   STOPs for operator approval of the assembled plan (spec, tickets, risk,
   and `deliveryShape` in one view) before the persist CLI runs. Under
   `--yes` this review auto-proceeds straight to the persist call, exactly
   as on the low-risk auto-proceed branch.

**Composition.** `--yes` is orthogonal to the other planning flags and
composes cleanly:

- With **`--allow-over-budget`**: `--yes` suppresses the gate *waits* while
  `--allow-over-budget` still governs the `maxTickets` over-budget persist —
  passing `--yes` alone does **not** waive the budget gate.
- With the **risk-routed gate #2 skip**: when risk routing already
  auto-proceeds the review (low-risk, no `--force-review`), `--yes` is a
  no-op for that gate — it only *forces a proceed where the gate would
  otherwise STOP*, it never *adds* a stop or relaxes any non-HITL validator.

**`--yes` suppresses only the HITL operator *waits* above.** It does **not**
relax any deterministic gate — the clarity scoring, the Tech Spec section
gate, the ticket validator / file-assumption / DAG / budget gates, the
inline readiness healthcheck, and the `agent::blocked` runtime pause all
behave exactly as without the flag; it is an operator-input suppressor, not
a validation override. A `--yes` run that hits one of those still fails
closed. The smaller operator-input waits folded into the two gates — the
duplicate-candidate review, the clarity refinement-diff confirm, and the
advisory critic diffs — auto-proceed for the same headless reason.

## Procedure

1. **Parse args.** Exactly one of `<epicId>`, `--idea`, `--from-notes`, or
   `--body` must be present; anything else is a usage error naming the four
   forms. A `--body` invocation routes to the story path (no triage).
2. **Triage (idea path only).** Run the
   [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) skill on the
   seed. Record the verdict in chat (one line).
3. **Delegate.** Read the selected path helper **in full** and execute it
   from its entry, forwarding the absorbed flags (including `--yes`). The
   helper's steps, HITL gates, and scripts are the procedure — this router
   adds no step content. When `--yes` is present, the two HITL STOP gates
   auto-proceed per [Headless / non-interactive mode](#headless--non-interactive-mode---yes)
   above; every deterministic gate still runs.
4. **Internal returns.** When a path helper would historically have handed
   off to the other planning command, switch helpers in-place and continue;
   surface the switch to the operator as a one-line note.

## Constraints

- The plan→deliver boundary stays a hard stop: `/plan` never starts
  delivery. It ends by naming the follow-up — `/deliver <epicId>` for a
  planned Epic, `/deliver <storyId>` for a standalone Story.
- The router never calls planning scripts directly; the path helpers own
  every script invocation.
- Checkout hygiene (branch sweep) and day-0 doc readiness are owned by
  [`/git-cleanup`](git-cleanup.md) and `mandrel doctor` respectively —
  `/plan` runs no boot sweep and no first-run preflight.

## See also

- [`/deliver`](deliver.md) — the unified delivery entry point. Accepts a
  single Epic, one or more standalone Stories, or any mix of ≥1 Epics and
  standalone Stories — mixed sets compose a sequential segment plan.
- [`helpers/plan-epic.md`](helpers/plan-epic.md) /
  [`helpers/plan-story.md`](helpers/plan-story.md) — the path helpers.
