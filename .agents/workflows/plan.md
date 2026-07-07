---
description:
  Unified planning entry point. Routes a seed idea (via scope triage) or an
  existing Epic ID to the right planning path — the full Epic pipeline
  (sectioned Epic body: Tech Spec + Acceptance Table, then decomposition)
  or the standalone-Story authoring path — and absorbs every planning flag.
---

# /plan [Epic ID] | --idea "<seed>" | --from-notes <path>

## Role

Router. `/plan` owns argument parsing and path selection only — all phase
content lives in the two path helpers:

- [`helpers/plan-epic.md`](helpers/plan-epic.md) — the full Epic planning
  pipeline (Tech Spec + Acceptance Table folded into the Epic body, work
  breakdown, healthcheck, handoff).
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
| `--yes` | both | **Non-interactive / headless mode.** Deterministically auto-proceeds the two `/plan` HITL STOP gates — the ideation one-pager / scope-triage confirm (gate #1) and the Phase-7 Epic operator review gate (gate #2) — without waiting for operator input. Parallel to [`/deliver --yes`](deliver.md). Composes with `--allow-over-budget` and with the risk-routed Phase-7 skip (it forces a proceed where those do not apply). Default (flag absent) behavior is unchanged: both gates still STOP for interactive use. |
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

### Headless / non-interactive mode (`--yes`)

`--yes` is the headless escape hatch for an unattended driver (CI, a
benchmark harness, or any `claude -p` run with no human at the keyboard). It
is the `/plan`-side parallel of [`/deliver --yes`](deliver.md), which
suppresses that command's segment-plan confirmation. `/plan` has exactly
**two** HITL STOP gates, and `--yes` deterministically auto-proceeds **both**
without waiting for operator input:

1. **Gate #1 — the ideation one-pager / scope-triage / clarity confirm.**
   This single conceptual gate has three faces depending on the entry form,
   and `--yes` auto-proceeds **all three**:
   - On the `--idea` Epic path,
     [`helpers/plan-epic.md`](helpers/plan-epic.md) Phase 1 (folding in the
     Phase 1.5 scope-triage verdict) STOPs to confirm the sharpened one-pager.
   - On the `--idea` Story path,
     [`helpers/plan-story.md`](helpers/plan-story.md) Phase 2 STOPs to
     confirm the drafted Story body.
   - On the existing-Epic (`/plan <epicId>`) path, the Phase 6 Epic Clarity
     Gate's **needs-refinement** branch STOPs to confirm the refined-body
     diff before persisting it.

   Under `--yes` each auto-proceeds: the one-pager / draft / refined-body
   confirm resolves as **approved**, and a `story` / `borderline` triage
   verdict resolves to its **recommended** branch (the one the gate prose
   marks "Recommended") rather than prompting the three-way choice. The
   verdict / clarity scoring is still recorded in chat (one line); only the
   *wait* is suppressed. The clarity-gate *scoring* itself (deterministic
   section-presence in Phase 6 step 1) still runs — `--yes` suppresses only
   the operator confirm of the proposed refinement.
2. **Gate #2 — the Phase-7 Epic operator review gate.** When risk routing
   forces a review (`planningRisk.requiresReview === true`, or the operator
   also passed `--force-review`),
   [`helpers/plan-epic.md`](helpers/plan-epic.md) Phase 7 STOPs for operator
   approval of the updated Epic body (its Tech Spec sections and
   `## Acceptance Table`) before decomposition.
   Under `--yes` this review auto-proceeds straight to Phase 8 exactly as
   on the low-risk auto-proceed path.

**Composition.** `--yes` is orthogonal to the other planning flags and
composes cleanly:

- With **`--allow-over-budget`**: `--yes` suppresses the gate *waits* while
  `--allow-over-budget` still governs the `maxTickets` over-budget persist —
  passing `--yes` alone does **not** waive the budget gate.
- With the **risk-routed Phase-7 skip**: when risk routing already skips the
  Phase-7 review (low-risk, no `--force-review`), `--yes` is a no-op for that
  gate — it only *forces a proceed where the gate would otherwise STOP*, it
  never *adds* a stop or relaxes any non-HITL validator.

**`--yes` suppresses only the HITL operator *waits* above.** It does **not**
relax any deterministic gate — the Phase 6 Epic Clarity Gate **scoring**
(section-presence), the Phase 7.5 Tech Spec Section Gate, the file-assumption
/ DAG validators, the Phase 10 readiness healthcheck, and the `agent::blocked`
runtime pause all behave exactly as without the flag. A `--yes` run that hits
one of those still fails closed; the flag is an operator-input suppressor, not
a validation override. The other operator-input *waits* in the pipeline also
auto-proceed under `--yes` — the non-blocking Phase 2 duplicate-search pause
(distinct-Epic confirmed), the Phase 6 clarity refinement-diff confirm
(refined body approved), and the advisory Phase 8.3/8.4/8.5
consolidation/critic diffs (consolidated/critic output applied) — since they
are operator-input waits, not validators. The two *named* HITL STOP gates the
Story tracks (gate #1, gate #2) are the load-bearing pair; these additional
waits are auto-proceeded for the same headless reason.

## Boot sweep

Before anything else — ahead of the first-run preflight — run the **protected
boot sweep** so `/plan` opens against a tidy local checkout instead of one
still carrying the merged refs of the last delivered Epic or Story:

```bash
node .agents/scripts/boot-sweep.js \
  --include 'story-*' --include 'epic/*' \
  --include 'feat/*' --include 'fix/*' --include 'chore/*'
```

This is the **safe subset** of the `/git-cleanup` phases: it fast-forwards the
base branch (`main`), prunes stale remote-tracking refs, and reaps every local
branch whose PR is **merged** and whose HEAD matches the merged `headRefOid`.
It **never** touches the stash stack, and its `evaluateProtection` partition
skips (never reaps) any candidate with unpushed work, a dirty worktree, or a
still-open parent Story ticket — so it is safe to run unattended at the top of
a planning session. The sweep is **silent on a no-op**: with nothing to reap
and `main` already current it prints a single summary line
(`[boot-sweep] reaped 0 local + 0 remote; protected 0.`) and moves on. Its exit
code is always `0` — a failed sweep is swallowed and reported in the summary,
never allowed to fail the planning run.

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
2. **Boot sweep.** Run the protected boot sweep above
   (`node .agents/scripts/boot-sweep.js …`) to fast-forward `main`, prune
   stale remotes, and reap merged-PR branches. Silent on a no-op; never fails
   the run.
3. **First-run preflight.** Run the preflight above. Skip when all signals
   are clear (healthy project).
4. **Triage (idea path only).** Run the
   [`core/scope-triage`](../skills/core/scope-triage/SKILL.md) skill on the
   seed. Record the verdict in chat (one line).
5. **Delegate.** Read the selected path helper **in full** and execute it
   from its entry phase, forwarding the absorbed flags (including `--yes`).
   The helper's phase numbering, HITL gates, and scripts are unchanged — this
   router adds no phase content. When `--yes` is present, the two HITL STOP
   gates auto-proceed per [Headless / non-interactive mode](#headless--non-interactive-mode---yes)
   above; every deterministic gate still runs.
6. **Internal returns.** When a path helper would historically have handed
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
