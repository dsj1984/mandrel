---
description:
  Orchestrates end-to-end Epic planning (PRD, Tech Spec, Acceptance Spec, and
  Work Breakdown) for a GitHub Epic.
---

# helpers/plan-epic — Epic planning path (invoked by /plan)

## Role

Director / Architect

## Context

You are the master orchestrator for the v5 Epic-Centric ticketing pipeline. Your
goal is to transform a high-level Epic into a fully decomposed, ready-to-execute
backlog of Stories.

`/plan` is the unified planning entry point. It delegates to the two
phase helpers — [`helpers/epic-plan-spec.md`](epic-plan-spec.md) and
[`helpers/epic-plan-decompose.md`](epic-plan-decompose.md) — and runs
both phases sequentially with a human confirmation gate between them. The Epic
ID is the single positional argument.

As of v5.6, planning artifacts (PRD, Tech Spec, ticket decomposition) are
authored **directly by you, the host LLM** — no external Gemini / Anthropic /
OpenAI API is called. The Node scripts are deterministic GitHub I/O wrappers
that (a) emit the authoring context you need and (b) validate and persist the
artifacts you author.

## Constraint

- Do not modify existing issues without explicit permission.
- Wait for user validation before migrating to Phase 8 when
  `planningRisk.requiresReview` is true (or the operator passes
  `--force-review`). Low-risk Epics auto-proceed after spec validation.
  See [SDLC § Adaptive planning risk routing](../../docs/SDLC.md#adaptive-planning-risk-routing)
  for the full envelope shape and the planner-selected
  `acceptance::n-a` route.
- Delegate Phase 7 and Phase 8 to the
  [`helpers/epic-plan-spec.md`](epic-plan-spec.md) and
  [`helpers/epic-plan-decompose.md`](epic-plan-decompose.md)
  procedures respectively — they own the Epic lifecycle label transitions and
  the `epic-plan-state` checkpoint. This wrapper must not apply those labels
  directly.

## Prerequisites

1. **GitHub Epic**: An existing GitHub Issue with the `type::epic` label.
   Skipped when entering via Phase 1 / `--idea` (the Epic does not exist
   yet — Phases 1–4 will create it).
2. **API Keys**: `GITHUB_TOKEN` must be set in the `.env` file.

## Phase 1: Idea Refinement (s-plan-ideation entry)

This phase runs **only** when no `<epic#>` argument is supplied, or when
`--idea "<seed>"` is passed. If an Epic ID was provided, skip directly to
Phase 5 (Re-Plan Detection).

1. **Activate the ideation skill**: Read
   `<agentRoot>/skills/core/idea-refinement/SKILL.md` via the `Read`
   tool (resolve `<agentRoot>` from `project.paths.agentRoot` —
   default `.agents`) and execute its procedure with the `--idea` value
   (or a user-supplied seed if no argument was given) as the seed. The
   skill drives its own three-phase divergent → convergent → sharpen
   loop and returns a markdown one-pager with the canonical sections
   (Problem Statement, Recommended Direction, Key Assumptions, MVP
   Scope, Not Doing). This is the canonical pattern for framework
   skills — they are library-style content read on-demand per
   `<agentRoot>/instructions.md` section 1.B, not entries in the
   host's harness-level skill registry.

2. **Run Phase 1.5 (Scope Triage) before the HITL stop**: The sharpened
   one-pager feeds the scope-triage gate below, whose verdict folds into
   the **same** Phase 1 HITL confirmation. Do not stop twice.

3. **HITL stop — confirm the sharpened one-pager** (**gate #1**): Display
   the one-pager to the operator and **STOP**. Do not proceed to Phase 2
   until the user explicitly confirms the direction. This is the same gate
   the skill's own Phase 3 enforces; surfacing it here makes the wait
   contract visible to `/plan` callers. When the Phase 1.5 verdict is
   `story` or `borderline`, this stop carries the three-way choice the
   triage gate defines (below) instead of a plain confirm.

   > **`--yes` (headless) auto-proceed.** When `/plan` was invoked with
   > `--yes`, this gate does **not** STOP: the one-pager confirm resolves as
   > **approved** and the run continues to Phase 2. A `story` / `borderline`
   > triage verdict resolves to its **Recommended** branch (below) rather
   > than prompting the three-way choice. Display the one-pager and the
   > verdict line for the record, then proceed without waiting. See
   > [`plan.md` § Headless / non-interactive mode](../plan.md#headless--non-interactive-mode---yes).

## Phase 1.5: Scope Triage (ideation path only)

This phase runs **only** on the ideation path, immediately after Phase 1
produces the sharpened one-pager. It is **skipped entirely** when an Epic ID
argument was supplied (the existing-Epic path jumps straight to Phase 5), and
it is **skipped** when `/plan` was entered via a scope-triage handoff from
[`/plan`](plan-story.md) — a handoff is a triage decision already made,
and re-triaging it would re-litigate a settled call (the no-re-triage rule the
skill states once).

1. **Activate the scope-triage skill**: Read
   [`<agentRoot>/skills/core/scope-triage/SKILL.md`](../../skills/core/scope-triage/SKILL.md)
   via the `Read` tool (resolve `<agentRoot>` from `project.paths.agentRoot` —
   default `.agents`) and apply its rubric to the Phase 1 one-pager. The skill
   anchors its sizing judgment **by reference** to
   `DELIVERABLE_GRANULARITY_GUIDANCE` / `DEFAULT_TASK_SIZING` in
   [`ticket-validator-sizing.js`](../../scripts/lib/orchestration/ticket-validator-sizing.js)
   and emits one verdict: `epic` | `story` | `borderline`. The verdict is
   host-LLM judgment — there is **no `--flag`**, no scorer, no schema, and no
   label transition.

2. **Fold the verdict into the existing Phase 1 HITL stop** — do **not** add a
   second stop:
   - **`epic` verdict** → no extra prompt. The Phase 1 confirmation proceeds
     as a plain one-pager confirm and the run continues to Phase 2.
   - **`story` or `borderline` verdict** → the Phase 1 confirmation prompt
     presents a **three-way operator choice**:
     - **Recommended: single Story** (with the triage rationale) — persist the
       one-pager to a notes file and hand off to
       `/plan --from-notes <path>`, identifying the invocation as a
       scope-triage handoff so `/plan` skips its own gate. Then **exit
       `/plan`**.
     - **Plan as Epic anyway** — ignore the recommendation and continue to
       Phase 2 with the one-pager.
     - **Abort** — stop planning entirely.

   **Never auto-route.** The verdict is advisory; the operator always decides.
   Being wrong in the `epic` direction is cheap (Phase 8.3 consolidation and
   the sizing validator catch an over-planned Story later); the gate exists to
   avoid the ceremony tax of pushing a story-sized scope through the full Epic
   pipeline.

   > **`--yes` (headless) exception.** "Never auto-route" is the interactive
   > contract. Under `--yes` the operator has *pre-authorized* the
   > recommendation: the three-way choice resolves to its **Recommended**
   > branch deterministically — `single Story` hands off to
   > `/plan --from-notes <path>` (carrying `--yes` so the receiving story
   > path also auto-proceeds), and an `epic` verdict simply continues to
   > Phase 2. No operator wait. This is the only sanctioned auto-route, and it
   > exists solely to make `/plan` driveable headlessly.

## Phase 2: Cross-Epic Duplicate Search

Runs immediately after Phase 1 (and only on the s-plan-ideation path).
Its job is to surface open Epics whose scope already overlaps with the
sharpened one-pager so the operator can fold the work in rather than
opening a duplicate.

1. **Invoke the duplicate-search module**: Call
   `findSimilarOpenEpics({ onePager, provider })` exported from
   [`.agents/scripts/lib/duplicate-search.js`](../../scripts/lib/duplicate-search.js).
   The `provider` is the resolved ticketing provider
   (`provider-factory.js`), and `onePager` is the markdown returned by
   Phase 1.

2. **HITL pause on match**: If the module returns a non-empty ranked
   list, render the candidates (id, title, score, URL) and **STOP**. Do
   not proceed to Phase 3 until the user either (a) confirms the new
   Epic is genuinely distinct or (b) chooses to fold the idea into one of
   the existing Epics, in which case `/plan` exits and the operator
   resumes work on the existing Epic ID.

3. **No-match fast path**: If the module returns `[]`, proceed
   immediately to Phase 3 — no operator intervention required.

## Phase 3: Render Epic Body from One-Pager

Runs after Phase 2 clears (no duplicates, or operator confirmed the
new Epic is genuinely distinct).

1. **Render the body**: Call
   `renderEpicBody({ onePager, template })` exported from
   [`.agents/scripts/lib/epic-plan-ideation.js`](../../scripts/lib/epic-plan-ideation.js).
   The `template` argument is the contents of
   [`.agents/templates/epic-from-idea.md`](../../templates/epic-from-idea.md),
   which carries the five canonical sections (Context, Goal, Non-Goals,
   Scope, Acceptance Criteria). Sections missing from the one-pager are
   rendered as `_(not specified)_` rather than left as raw `{{token}}`
   placeholders.

2. **HITL stop — confirm the body**: Display the rendered body to the
   operator and **STOP**. Do not proceed to Phase 4 until the user
   explicitly confirms the body is correct. This is the last chance to
   tweak wording before the GitHub Issue is opened.

## Phase 4: Open the GitHub Issue (`type::epic` only)

1. **Open the Epic Issue**: Call
   `openEpicFromOnePager({ onePager, template, createIssue })` from the
   same `epic-plan-ideation.js` module. Pass a `createIssue` port that
   delegates to the resolved ticketing provider's `createIssue` method
   (`provider-factory.js`; GitHub: `TicketGateway.createIssue`) so the
   labels and body land via the canonical I/O surface.

   **Board membership (Story #3822)**: the provider's `createIssue`
   adds the new Epic to the configured Projects V2 board via the
   shared `addIssueToBoard` helper
   ([`providers/github/board-add.js`](../../scripts/providers/github/board-add.js))
   — idempotent, non-fatal (warn-on-error), and a no-op when no
   project number is configured — so the Epic lands on the board
   without relying on GitHub's "Auto-add to project" built-in
   workflow (off by default on fresh boards and not enableable via
   API). The created issue's GraphQL `node_id` is surfaced as
   `nodeId` on the returned envelope for follow-up board operations.

2. **Label discipline**: The Issue is opened with **only** the
   `type::epic` label. **Do not** add any `state::*` label at creation
   time — the Epic carries only `type::epic` until PRD authoring
   advances it to `agent::review-spec` in Phase 7. The
   `openEpicFromOnePager` helper already enforces this; the workflow
   prose codifies the intent so future label-set tweaks don't silently
   widen it.

3. **Continue to Phase 5**: The captured Epic ID becomes the new
   `[Epic_ID]` for the rest of the planning pipeline. Re-Plan Detection
   (Phase 5) will short-circuit because no PRD/Tech Spec is linked yet,
   so the run flows naturally into Phase 6 (Epic Clarity Gate) and then
   Phase 7.

## Phase 5: Re-Plan Detection

Before generating any artifacts, check whether the Epic has already been
planned.

1. **Fetch Epic**: Read the Epic issue body and check for a
   `## Planning Artifacts` section containing PRD and Tech Spec references.
2. **If already planned**: Inform the user that this Epic already has planning
   artifacts. Ask:

   > "Epic #[ID] already has PRD (#XX) and Tech Spec (#XX) with YY decomposed
   > tickets. Do you want to **re-plan**? This will **overwrite the PRD,
   > Tech Spec, and Acceptance Spec in place** (same issue numbers, refreshed
   > bodies, comment history preserved) and **close-and-recreate** all
   > child Story tickets."

3. **If user confirms re-plan**: Pass `--force` to all subsequent script
   invocations. Under `--force`, the three context tickets (PRD, Tech Spec,
   Acceptance Spec) are overwritten in place — their issue numbers, Epic
   sub-issue links, and prior discussion are preserved, and each receives a
   one-line regeneration audit comment. Child Story tickets are still
   closed and recreated, because a re-decomposition can legitimately produce a
   different ticket set.
4. **If user declines**: Abort gracefully.

## Phase 5.5: Story-Sized Advisory (existing-Epic path)

An **advisory** scope-triage check that catches a story-sized scope which was
hand-opened directly as a `type::epic` issue before any ceremony is paid for.
Phase 6's Epic Clarity Gate scores section *presence*, not scope *size* — a
perfectly clear but story-sized Epic (typically a thin, freshly opened issue)
sails straight through to full planning. This advisory is the size check the
clarity gate does not make.

### Firing condition (load-bearing)

The advisory runs **only** when **both** hold:

1. **Phase 5 found no planning artifacts** — the Epic body has no
   `## Planning Artifacts` section linking a PRD / Tech Spec (i.e. Phase 5
   did **not** enter its re-plan branch).
2. **The Epic has no open Story children** — no open `type::story`
   sub-issues are linked to this Epic.

If **either** condition fails, **skip this phase silently** and continue to
Phase 6. It must **never** fire on the re-plan path: recommending a "downgrade
to a Story" on an Epic that already carries a PRD and a ticket tree is
nonsense and would collide with the `--force` re-plan flow. The advisory also
does not fire on the ideation path — that path already ran the Phase 1.5 scope
triage on the one-pager before the Epic existed.

### Triage

1. **Activate the scope-triage skill**: Read
   [`<agentRoot>/skills/core/scope-triage/SKILL.md`](../../skills/core/scope-triage/SKILL.md)
   via the `Read` tool (resolve `<agentRoot>` from `project.paths.agentRoot` —
   default `.agents`) and apply its rubric to the **Epic body**. The skill is
   artifact-agnostic — it reads the same against an Epic body as against a
   one-pager or a Story draft — and anchors its sizing judgment **by
   reference** to `DELIVERABLE_GRANULARITY_GUIDANCE` / `DEFAULT_TASK_SIZING`
   in
   [`ticket-validator-sizing.js`](../../scripts/lib/orchestration/ticket-validator-sizing.js).
   It emits one verdict: `epic` | `story` | `borderline`. The verdict is
   host-LLM judgment — there is **no `--flag`**, no scorer, no schema, and no
   label transition behind this gate. Do **not** restate the skill's rubric or
   its sizing thresholds here.

2. **`epic` verdict** → proceed silently. No extra prompt, no HITL stop. The
   run continues straight to Phase 6. Being wrong in the `epic` direction is
   cheap (Phase 8.3 consolidation and the sizing validator catch an
   over-planned Story later), so an `epic` verdict never costs the operator a
   stop.

3. **`story` or `borderline` verdict** → **STOP** and present a **three-way
   operator choice**. Never auto-route; the verdict is advisory and the
   operator always decides.

   - **Recommended: convert to a standalone Story** (with the triage
     rationale) — run the conversion path below.
   - **Proceed as Epic anyway** — ignore the recommendation and continue to
     Phase 6 with the Epic unchanged.
   - **Abort** — stop planning entirely. The Epic is left exactly as it was;
     no labels move and nothing is closed.

### Conversion path (close-and-recreate)

Conversion is **close-and-recreate**, not in-place relabeling. A `type::epic`
body does not satisfy `validateStoryBody` (it lacks the required Story
sections and would have to drop the Epic shape), and editing or relabeling the
existing issue violates the workflow's "Do not modify existing issues without
explicit permission" Constraint. So the conversion seeds a fresh Story and
closes the Epic in its favor, and **every** issue mutation below happens
**only after the operator explicitly confirms the conversion in-session**:

1. **Seed a notes file from the Epic body.** Write the Epic's Context / Goal /
   Scope / Acceptance Criteria into a seed file under
   `temp/epic-[Epic_ID]/scope-triage-seed.md` (the `temp/` tree is gitignored).
   This is the same notes-file shape `/plan --from-notes` consumes.

2. **Hand off to `/plan --from-notes`.** Invoke
   [`/plan --from-notes temp/epic-[Epic_ID]/scope-triage-seed.md`](plan-story.md),
   **identifying the invocation as a scope-triage handoff** so `/plan`
   skips its own escalation gate (the skill's no-re-triage rule — a handoff is
   a settled triage decision, and re-running the gate on the receiving side
   would re-litigate it and risk a ping-pong between the two workflows). The
   replacement Story's `## Notes` section links back to the closed Epic
   (`Converted from Epic #[Epic_ID] — scope triaged as a standalone Story`) so
   the audit trail is bidirectional.

3. **Close the Epic in favor of the replacement.** Once `/plan` has
   created the replacement Story (capture its number as `#N`), close the Epic
   with a cross-linking comment:

   ```bash
   gh issue close [Epic_ID] --repo <owner>/<repo> \
     --comment "Closed in favor of #N — scope triaged as a standalone Story."
   ```

   This is the only `gh issue close` in the path, and it runs **after** the
   replacement Story exists, so the conversion never strands a closed Epic
   with no successor. The replacement-Story back-link plus this close comment
   give a reviewer the full bidirectional trail.

The conversion mutates two issues (creates the Story, closes the Epic) — both
behind the single operator confirmation above. After conversion `/plan`
exits: the work now lives on the standalone Story, which the operator delivers
via [`/single-story-deliver`](single-story-deliver.md) or
[`/deliver`](deliver-stories.md).

## Phase 6: Epic Clarity Gate

Runs on every existing-Epic invocation, after Phase 5 (Re-Plan
Detection) and the Phase 5.5 story-sized advisory, and before Phase 7
(PRD, Tech Spec & Acceptance Spec). The gate scores the Epic body
against the five canonical
sections from
[`.agents/templates/epic-from-idea.md`](../../templates/epic-from-idea.md)
(Context, Goal, Non-Goals, Scope, Acceptance Criteria) and either
skips fast (when the Epic body is already clear) or drops into a
refinement loop seeded from the current Epic body. The scorer also
accepts common heading variants for back-compat (e.g. `## Problem`,
`## Direction`, `## MVP Scope`, `## Not Doing`, `## Out of Scope`) so
hand-authored Epics that predate the canonical headings continue to
pass without rewording.

The rubric is deterministic: section-presence against the five
canonical headings. A `clear` verdict requires **both** ≥ 4 of 5
sections present **and** the **Acceptance Criteria** section present —
AC is a required section, not one of the four optional passers, so an
Epic with no Acceptance Criteria is always `needs-refinement` (it would
otherwise hard-fail the `/deliver` start gate downstream). See
[`lib/epic-plan-clarity.js`](../../scripts/lib/epic-plan-clarity.js)
for the scoring logic.

1. **Score the body**: Run the clarity-check CLI in context-emission
   mode.

   ```bash
   node .agents/scripts/epic-plan-clarity.js --epic [Epic_ID] --emit-context \
     > temp/epic-[Epic_ID]/clarity-context.json
   ```

   The envelope carries
   `{ epicId, epicBody, verdict, sections, missingOrPlaceholder }`.

2. **Clear fast path**: When `verdict === 'clear'`, print
   `Epic clarity: clear — proceeding to Phase 7.` and continue. No
   HITL, no prompt.

3. **Needs-refinement path**: When `verdict === 'needs-refinement'`,
   activate the
   [`core/idea-refinement`](../../skills/core/idea-refinement/SKILL.md)
   skill **seeded from the current Epic body** (not a blank seed),
   with `missingOrPlaceholder` as the convergence target. The skill
   runs its three-phase divergent → convergent → sharpen loop and
   returns a sharpened one-pager.

4. **Re-render the body**: Call
   `renderEpicBody({ onePager, template })` from
   [`lib/epic-plan-ideation.js`](../../scripts/lib/epic-plan-ideation.js)
   (the same helper Phase 3 uses), passing the contents of
   [`.agents/templates/epic-from-idea.md`](../../templates/epic-from-idea.md).
   Write the result to `temp/epic-[Epic_ID]/clarity-update.md`.

5. **HITL stop — confirm the diff**: Display the diff between the
   current Epic body and the sharpened body and **STOP**. Operator
   approves, edits, or aborts. Flag the blast radius in the
   confirmation prompt: an approved body change feeds **three**
   downstream artifacts (PRD, Tech Spec, Acceptance Spec) — treat
   this gate as a one-shot rewrite, not an iterative draft. The
   Constraint ("Do not modify existing issues without explicit
   permission") is honored — no `gh issue edit` call until the
   operator confirms.

   > **`--yes` (headless) auto-proceed.** This refinement-diff confirm is the
   > clarity-gate face of `/plan`'s **gate #1** on the existing-Epic
   > (`/plan <epicId>`) path — it is an operator *wait*, not a deterministic
   > validator (the deterministic half is the section-presence *scoring* in
   > step 1, which always runs). When `/plan` was invoked with `--yes`, this
   > confirm does **not** STOP: the sharpened body is auto-**approved** and the
   > run proceeds to step 6 (persist). The blast-radius note is still displayed
   > for the record; only the operator wait is suppressed. This keeps
   > `/plan <epicId> --yes` driveable headlessly even when the Epic body needs
   > refinement (`gh issue edit` still runs only via the step 6 persist call,
   > which the auto-approval authorizes). See
   > [`plan.md` § Headless / non-interactive mode](../plan.md#headless--non-interactive-mode---yes).

6. **Persist**: On approval, run the persist mode:

   ```bash
   node .agents/scripts/epic-plan-clarity.js --epic [Epic_ID] \
     --updated-body temp/epic-[Epic_ID]/clarity-update.md
   ```

   The CLI persists the new body via `provider.updateTicket` and
   posts a `clarity-gate-update` audit comment recording the change.
   Idempotent: no-op when the file content matches the current body.

7. **Re-verify**: Re-run the `--emit-context` step once to confirm
   the verdict flipped to `clear`. If it still reads
   `needs-refinement`, abort with a non-zero exit and surface a
   remediation hint to the operator. Do not loop — one refinement
   pass per invocation, matching the `--force` re-plan pattern.

## Phase 7: Epic Planning (PRD, Tech Spec & Acceptance Spec)

> **Epic-lease preflight (workflow guard).** Before any Phase 7 mutation,
> `epic-plan-spec.js` acquires the Epic-lease via the assignee-as-lease
> primitive (`lib/orchestration/ticket-lease.js`, wired through
> `lib/orchestration/epic-plan-lease-guard.js`). The lease rides the Epic's
> single assignee: the operator (`github.operatorHandle` in `.agentrc.json`)
> claims the Epic for the duration of the plan. The guard **fails closed**:
> `/plan` emits no `story.heartbeat` during its run (heartbeats are a
> delivery-time signal), so there is no live-heartbeat source to judge a
> concurrent plan's liveness from. Any **foreign assignee** is therefore
> treated as a live claim — the persist half **exits non-zero and names the
> current owner**, so two `/plan` runs cannot drive the same Epic
> concurrently. Pass **`--steal`** to forcibly transfer a foreign claim once
> you have confirmed the other run is dead. An **unassigned** Epic, or one
> **already held by this operator**, is taken (or re-affirmed) silently. The
> lease is **released after Phase 8** (decompose) completes; see the Phase 8
> note.

<!-- separator: adjacent blockquotes -->

> **Idempotent context tickets.** The persist half is find-or-create keyed on
> the Epic's `linkedIssues`: a re-run **reuses the already-linked PRD and Tech
> Spec issues** (and Acceptance Spec, when present) instead of creating
> duplicates. Pass `--force` to overwrite the canonical context tickets in
> place (same issue numbers, refreshed bodies).

<!-- separator: adjacent blockquotes -->

> **Three context tickets, not two.** Every Epic carries three planning
> artifacts as linked GitHub sub-issues: PRD (`context::prd`), Tech Spec
> (`context::tech-spec`), and Acceptance Spec
> (`context::acceptance-spec`). The Acceptance Spec captures the
> stable-ID acceptance criteria table (`| AC ID | Outcome | Feature
> File | Scenario | Disposition |`) that drives close-time
> reconciliation during `/deliver` Phase 6. Operators may opt out
> for refactor-only or docs-only Epics by applying the
> `acceptance::n-a` label to the Epic ticket — when present, the
> `epic-plan-spec-author` skill skips the Acceptance Spec output and
> the runtime gates (start gate, finalize reconciler) honour the
> waiver — the spec ticket itself need not be authored or approved when
> the waiver is set. See [SDLC § Acceptance Spec — the third planning
> context ticket](../../docs/SDLC.md#acceptance-spec--the-third-planning-context-ticket)
> for the full lifecycle.

<!-- separator: adjacent blockquotes -->

> **Parallel-safe file naming (per-Epic tree).** Multiple Epics may be
> planned or decomposed concurrently. Every temp file written in this
> workflow lives under the per-Epic tree
> (`temp/epic-[Epic_ID]/<artifact>`) — e.g.
> `temp/epic-[Epic_ID]/planner-context.json`,
> `temp/epic-[Epic_ID]/prd.md`, `temp/epic-[Epic_ID]/techspec.md`,
> `temp/epic-[Epic_ID]/decomposer-context.json`,
> `temp/epic-[Epic_ID]/tickets.json`. The directory namespace is the
> isolation boundary; basenames inside it are stable. Do **not** reuse
> bare flat names like `temp/prd.md` or the legacy
> `temp/<artifact>-epic-<id>.<ext>` shape — both have been retired.
>
> **Durability.** The per-Epic tree is durable across runs: only the
> wrapper scripts perform intra-phase cleanup of files they wrote in
> the same invocation (see
> [`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js)).
> Nothing else garbage-collects the tree, so cross-Epic artifacts —
> retros, perf reports, signals, manifests — accumulate until an
> operator explicitly removes them.

1. **Gather Authoring Context**: Run the spec-phase CLI in context-emission
   mode to fetch the Epic body, scraped project docs, and the recommended
   system prompts.

   ```bash
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] --emit-context > temp/epic-[Epic_ID]/planner-context.json
   ```

2. **Activate the `epic-plan-spec-author` skill**: Read
   [`<agentRoot>/skills/core/epic-plan-spec-author/SKILL.md`](../../skills/core/epic-plan-spec-author/SKILL.md)
   via the `Read` tool (resolve `<agentRoot>` from
   `project.paths.agentRoot` — default `.agents`) and execute its
   procedure with `[Epic_ID]` as input. The skill reads
   `temp/epic-[Epic_ID]/planner-context.json`, authors the PRD, Tech
   Spec, **risk verdict**, and **Acceptance Spec** against the embedded
   system prompts, and writes them to `temp/epic-[Epic_ID]/prd.md`,
   `temp/epic-[Epic_ID]/techspec.md`,
   `temp/epic-[Epic_ID]/risk-verdict.json`, and
   `temp/epic-[Epic_ID]/acceptance-spec.md`. The skill is the
   authoritative authoring step — do **not** inline the PRD / Tech
   Spec / risk-verdict / Acceptance Spec drafting in the workflow
   body. The skill front-matter declares
   `allowed_tools: [Read, Write, Bash]`; it never calls GitHub.

   The skill body carries the authoritative PRD, Tech Spec, and
   Acceptance Spec system prompts. The `systemPrompts` field on the
   `--emit-context` envelope is a backstop for legacy callers; the
   skill body wins when the two surfaces diverge.

3. **Persist to GitHub**: Run the spec-phase CLI's persist half. It
   schema-validates the planner-authored risk verdict (`--risk-verdict`,
   required — a missing or malformed verdict fails closed before any
   GitHub mutation), derives the `planningRisk` envelope from it
   (`deriveRiskEnvelope`), records a `risk-verdict` structured comment
   on the Epic, flips the Epic to `agent::review-spec`, and writes the
   `epic-plan-state` checkpoint (including the `riskVerdict` field).
   The `--acceptance-spec` flag persists the third planning ticket
   (`context::acceptance-spec`) alongside the PRD and Tech Spec; the
   persist half fails loudly if any file is missing or empty. Omit
   `--acceptance-spec` only when the Epic carries the `acceptance::n-a`
   waiver label.

   ```bash
   # Normal planning (three context tickets)
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
     --prd temp/epic-[Epic_ID]/prd.md \
     --techspec temp/epic-[Epic_ID]/techspec.md \
     --risk-verdict temp/epic-[Epic_ID]/risk-verdict.json \
     --acceptance-spec temp/epic-[Epic_ID]/acceptance-spec.md

   # Re-planning (--force overwrites the three context tickets IN PLACE —
   # same PRD / Tech Spec / Acceptance Spec issue numbers, refreshed bodies,
   # tickets kept open, one regeneration audit comment each. Child Story
   # tickets are still close-and-recreate at decomposition time.)
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
     --prd temp/epic-[Epic_ID]/prd.md \
     --techspec temp/epic-[Epic_ID]/techspec.md \
     --risk-verdict temp/epic-[Epic_ID]/risk-verdict.json \
     --acceptance-spec temp/epic-[Epic_ID]/acceptance-spec.md --force

   # Waived (acceptance::n-a label on Epic — no spec authored)
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
     --prd temp/epic-[Epic_ID]/prd.md \
     --techspec temp/epic-[Epic_ID]/techspec.md \
     --risk-verdict temp/epic-[Epic_ID]/risk-verdict.json
   ```

4. **Verification and review routing**:
   - Verify that the PRD, Technical Specification, and (when not waived)
     Acceptance Specification have been posted as linked issues under
     the Epic.
   - Read `planningRisk` from the persist stdout JSON (or the
     `epic-plan-state` checkpoint). Branch on
     `planningRisk.requiresReview` unless the operator passed
     `--force-review`:
     - **High risk** (`requiresReview === true`) or **operator override**
       (`--force-review`) — **gate #2**: **STOP**. Ask the USER to review the
       generated PRD, Tech Spec, and Acceptance Spec on GitHub. Approval is
       the user's verbal OK in this session — the three context tickets stay
       **open** through delivery and are closed automatically by
       `/deliver` when the Epic PR opens. Do NOT proceed
       to decomposition until the user confirms the plan is accurate.

       > **`--yes` (headless) auto-proceed.** When `/plan` was invoked with
       > `--yes`, this review gate does **not** STOP, even when
       > `requiresReview === true` or `--force-review` was also passed: the
       > review resolves as **approved** and the run **continues directly to
       > Phase 8**, exactly as the low-risk auto-proceed branch below. The
       > three context tickets stay **open** through delivery as usual; only
       > the operator *wait* is suppressed. This is `/plan`'s **gate #2** —
       > the second and last HITL STOP `--yes` suppresses. `--yes` does
       > **not** alter risk routing or the review criteria themselves; it
       > only forces a proceed where this gate would otherwise STOP. See
       > [`plan.md` § Headless / non-interactive mode](../plan.md#headless--non-interactive-mode---yes).
     - **Low risk** (`requiresReview === false` and no `--force-review`):
       Emit the auto-proceed message from the persist stdout
       (`reviewRouting.operatorMessage`) and **continue directly to Phase 8**
       without an extra review stop. The Epic still carries
       `agent::review-spec` until decomposition completes; the routing
       decision is recorded in the `epic-plan-state` checkpoint. (`--yes` is
       a no-op on this branch — there is no STOP to suppress.)

5. **Tech Spec freshness check (advisory)**: After the Tech Spec issue
   is created, `epic-plan-spec.js` runs
   [`validateSpecFreshness`](../../scripts/lib/orchestration/spec-freshness.js)
   against the authored Tech Spec body, probing every cited path-shape
   reference (backticked paths, `// header` lines in code blocks, and
   inline mentions of paths under `.agents/`, `src/`, `lib/`, `app/`,
   `tests/`, `packages/`, `scripts/`, `docs/`) against the configured
   `baseBranch`. Results land in three buckets:
   - **fresh** — path exists at the base ref (no action).
   - **ambiguous** — path is absent but surrounding prose carries a
     net-new cue (`introduce`, `add`, `create`, `new file`, `to be
     created`, etc.); surfaced for review without alarm.
   - **stale** — path is absent and no net-new cue is nearby; likely a
     reference the Architect inherited from drift-stale docs.

   When ≥1 stale reference is detected, a `spec-freshness` structured
   comment is upserted on the Tech Spec issue listing each citation
   with its line number. The full report is also written to
   `<tempRoot>/epic-<id>-spec-freshness.json` for downstream tooling.
   The check is **advisory and non-blocking** — Phase 7 completes even
   when stale references are present, so the operator retains final
   judgment on edge cases. If the run summary shows
   `⚠️ Spec freshness: N stale / M ambiguous`, review the Tech Spec
   issue's `spec-freshness` comment and correct the cited spec body
   before approving the plan for Phase 8.

6. **BDD scenario cross-reference (advisory)**: When the project has
   adopted BDD, `epic-plan-spec.js` populates the planner-context
   envelope with `bddScenarios` — the output of
   [`scanBddScenarios`](../../scripts/lib/bdd-scenario-scanner.js) over
   the canonical feature roots resolved by
   [`resolveFeatureRoots`](../../scripts/lib/bdd-runner-detect.js)
   (`tests/features`, `features`, `test/features`). The Acceptance
   Engineer step in the [`epic-plan-spec-author`](../../skills/core/epic-plan-spec-author/SKILL.md)
   skill scores each planned AC against the scenario index via
   `findBestScenarioMatch`; when an existing scenario covers an AC's
   outcome, the AC's `Scenario` column is annotated with `<file>:L<line>`
   and the `Disposition` becomes `unchanged` / `refined` instead of
   `new`. When `bddScenarios` is empty (no `.feature` files), the skill
   degrades silently and the spec is authored exactly as before. The
   matcher is keyword-based and deterministic so re-runs produce stable
   dispositions.

7. **Cleanup**: The wrapper script (`epic-plan-spec.js`) deletes the Phase 7
   temp files automatically on success — no operator action required. The
   cleanup contract lives in
   [`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js).
   **Run the Phase 7.5 spec-validate gate (below) on
   `temp/epic-[Epic_ID]/techspec.md` *before* this cleanup deletes the file** —
   the gate reads the authored spec from temp.

## Phase 7.5: Tech Spec Section Gate (`epic-plan-spec-validate.js`)

> **Hard gate (blocks Phase 8).** This step runs **after** the Tech Spec is
> authored (Phase 7) and **before** decomposition (Phase 8). Unlike the
> advisory spec-freshness and BDD cross-reference checks in Phase 7, this gate
> is **blocking**: a missing required section exits non-zero and Phase 8 MUST
> NOT proceed until it is resolved. It is the Phase 8-side counterpart to the
> Phase 6 Epic Clarity Gate — same detect-then-prompt pattern, one phase later.

**Why this gate exists.** Phase 8.3 (Holistic Consolidation) reconciles the
draft ticket array against the Tech Spec's `## Delivery Slicing` section, which
the [`epic-plan-decompose-author`](../../skills/core/epic-plan-decompose-author/SKILL.md)
skill uses as the capability-boundary anchor (see Phase 8 step 2 below). When
the authored Tech Spec omits that section, the consolidation pass runs against a
void and produces groupings that reflect **technical shape** (e.g. cron jobs
together) rather than **capability boundaries** — reproduced on Epic #18 in
`dsj1984/athportal` (planned with v1.54.0), whose spec carried a detailed
`## Core Components` table but no `## Delivery Slicing` section.

**Run the gate** against the authored Tech Spec before the Phase 7 cleanup
deletes `temp/epic-[Epic_ID]/techspec.md`:

```bash
node .agents/scripts/epic-plan-spec-validate.js \
  --techspec temp/epic-[Epic_ID]/techspec.md
```

- **Exit 0** — the spec contains a `## Delivery Slicing` heading (case-
  insensitive; the gate also accepts the variant `## Delivery slicing` and the
  shorthand `## Slicing`). Continue to Phase 8.
- **Exit non-zero** — the required section is missing. The gate is implemented
  by [`lib/orchestration/spec-section-validator.js`](../../scripts/lib/orchestration/spec-section-validator.js)
  and prints an operator-visible message naming the missing section and the two
  recovery paths:

  ```text
  [epic-plan-spec-validate] Tech Spec is missing required section(s): ## Delivery Slicing
    Spec file: temp/epic-18/techspec.md

    Phase 8 (decomposition) reconciles the draft ticket array against the
    Tech Spec's "## Delivery Slicing" section — without it, the Phase 8.3
    consolidation pass has no capability-boundary anchor and groups by
    technical shape instead.

    To continue, do ONE of the following before re-running Phase 8:
      1. Re-author the Tech Spec (re-run the Phase 7 spec-author step) so it
         emits a "## Delivery Slicing" section, OR
      2. Add a "## Delivery Slicing" section to the Tech Spec by hand,
         describing the capability boundaries the work should be sliced along.
  ```

  **STOP** on a non-zero exit: do not advance to Phase 8. Re-author the Tech
  Spec (re-run the Phase 7 spec-author step) or add a `## Delivery Slicing`
  section to the Tech Spec issue body by hand, then re-run the gate until it
  exits 0.

## Phase 8: Work Breakdown Decomposition

> **Open-children guard (workflow guard).** Before persisting the breakdown,
> `epic-plan-decompose.js` refuses to run when the Epic **already has open
> Story children**, unless `--force` (close + recreate the tree) or
> `--resume` (continue a partial persist) is set. This stops a re-run from
> stacking a duplicate Story set on top of an existing one — the
> phase exits non-zero and lists the open children. Once persist completes,
> the Epic-lease acquired in Phase 7 is **released** (best-effort; a release
> failure never fails decompose).

<!-- separator: adjacent blockquotes -->

> **Hierarchy.** The decomposer emits a flat Story backlog under the Epic.
> Acceptance criteria and verification steps are inlined on each Story
> body (`acceptance[]` / `verify[]` fields) and resolved against the
> Acceptance Spec context ticket at close time. See
> [`.agents/instructions.md` § 5.D](../../instructions.md) for the full
> contract.

1. **Gather Decomposition Context**:

   ```bash
   node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] --emit-context > temp/epic-[Epic_ID]/decomposer-context.json
   ```

2. **Activate the `epic-plan-decompose-author` skill**: Read
   [`<agentRoot>/skills/core/epic-plan-decompose-author/SKILL.md`](../../skills/core/epic-plan-decompose-author/SKILL.md)
   via the `Read` tool (resolve `<agentRoot>` from
   `project.paths.agentRoot` — default `.agents`) and execute its
   procedure with `[Epic_ID]` as input. The skill reads
   `temp/epic-[Epic_ID]/decomposer-context.json` (PRD body, Tech Spec
   body, risk heuristics, `maxTickets` cap, `contextMode`), applies its
   embedded decomposer system prompt + ticket schema, and writes the
   ticket array to `temp/epic-[Epic_ID]/tickets.json`. Do **not** inline
   the JSON authoring in the workflow body.

   The `maxTickets` cap is a **framework constant**
   (`LIMITS_DEFAULTS.maxTickets` in
   `.agents/scripts/lib/config/limits.js`; not operator-configurable) and
   a **reviewability budget**, not a hard authoring ceiling: a draft over
   budget warns at authoring time and is rejected at persist unless rerun
   with `--allow-over-budget` (after confirming the over-budget rationale
   on the Epic). The `epic-plan-decompose.js` script also logs the
   resolved budget to stderr. The decomposer system prompt is
   single-sourced in
   `.agents/scripts/lib/templates/decomposer-prompts.js`
   (`renderDecomposerSystemPrompt`); the `epic-plan-decompose-author`
   skill references that rendered `systemPrompt` rather than carrying
   its own copy of the prompt body.

   When the Tech Spec carries a `## Delivery Slicing` section (authored by
   `epic-plan-spec-author` in Phase 7), the decompose-author skill authors
   toward the Architect's proposed shippable-Story clusters; it degrades
   gracefully when the section is absent.

3. **Phase 8.3 — Holistic Consolidation (HITL diff gate)**: After the
   draft `temp/epic-[Epic_ID]/tickets.json` exists and **before** the persist
   call below, activate the
   [`epic-plan-consolidate`](../../skills/core/epic-plan-consolidate/SKILL.md)
   skill with `[Epic_ID]` as input. This is a **separate critic pass with
   fresh context** (not a self-review appended to the author skill): it reads
   the draft array plus the PRD / Tech Spec, reconciles the draft against the
   Tech Spec `## Delivery Slicing` target, and emits a **consolidated**
   `tickets.json` plus a human-readable
   `temp/epic-[Epic_ID]/consolidation-report.md`. Its operations are
   scope-preserving only — **merge sibling Stories and rewire
   `depends_on`** — and it MUST NOT add scope or invent tickets; it
   consolidates fragmented slices by merging them into a cohesive Story,
   never by splitting one. It runs **before** the deterministic
   validator (step 7), so the validator re-checks its output and the critic
   cannot emit an invalid plan.

   **Show the operator the consolidation report (the before/after diff +
   rationale) before persisting.** Consolidation is never auto-applied without
   review: on operator approval, persist the consolidated `tickets.json`; on
   rejection, persist the draft instead. This is a sub-step of Phase 8 — it
   does **not** renumber the top-level lifecycle phases (9–12).

4. **Phase 8.4 — Reachability Completeness Critic (HITL diff gate, F6)**:
   After consolidation (8.3) and **before** the persist call below, run the
   completeness critic. This is a **distinct pass** from
   [`epic-plan-consolidate`](../../skills/core/epic-plan-consolidate/SKILL.md)
   and **must NOT relax** that skill's scope-preserving conservation invariant:
   the consolidate critic is merge-and-rewire-only (it MUST NOT add scope or
   invent tickets), whereas this critic is permitted exactly one **additive**
   operation — appending a **single reachability Story** when, and only when, an
   Epic introduces a user-facing surface (a new route/page) that **no Story
   gives a navigation owner** (no nav-registry entry, no menu/link door from an
   authenticated home). The two passes are deliberately separate so the
   conservation invariant stays intact: consolidation never adds, and this
   critic's only addition is the reachability Story.

   - **Detection.** Scan the consolidated `tickets.json` for Stories that add a
     route-shaped surface (paths under the consumer-configured
     `planning.navigation.routeGlobs`, mirroring the
     `epic-plan-healthcheck.js --paranoid` reachability check, F7). For each
     such surface, confirm some Story's `acceptance[]` / `changes[]` references
     the consumer's nav-registry SSOT (`planning.navigation.navRegistry`). A
     surface with **no** nav owner is an orphan.
   - **Action.** When at least one orphan surface exists, append **one**
     reachability Story whose `acceptance[]` requires the orphaned surface to be
     reachable by navigation from the relevant persona's authenticated home
     (never by deep-link), and wire its `depends_on` to the surface-adding
     Story. Append **at most one** reachability Story per decompose run — batch
     every orphan under it — so the critic never fans out a parallel backlog.
   - **No-op when unconfigured.** With no `planning.navigation` config present,
     the critic degrades to a silent no-op (it cannot identify route-shaped
     surfaces or a nav registry), exactly like the F7 healthcheck flag.
   - **HITL.** The added Story is surfaced in the **same Phase 8 HITL diff** as
     consolidation, **before** any GitHub write — never auto-persisted. On
     operator rejection, drop the added Story and persist without it. The
     deterministic validator (step 7) re-checks the critic's output, so an
     invalid addition cannot reach GitHub.

5. **Phase 8.5 — Planning Pre-Mortem Critic (code-reading, F9)**: After the
   reachability critic (8.4) and **before** the persist call below, activate the
   [`epic-plan-premortem`](../../skills/core/epic-plan-premortem/SKILL.md)
   skill with `[Epic_ID]` as input. This is a **fresh-context critic** sibling
   to `epic-plan-consolidate`: it reads the drafted `tickets.json`, the PRD /
   Tech Spec, **and the actual cited code surfaces** (the files each Story's
   `changes[]` / `references[]` name), then emits predicted-rework findings —
   unverifiable acceptance criteria, over- or under-specified Stories, and
   semantically-wrong assumptions the structural file-assumption gate (step 7)
   cannot catch — to `temp/epic-[Epic_ID]/premortem-report.md`.

   Unlike the consolidate critic it is **not** scope-preserving-only: it may
   recommend splitting an under-specified Story or tightening an AC. But it
   **never writes to GitHub** and never persists `tickets.json` — it only emits
   the report. Its findings are shown in the **same Phase 8 HITL diff**, and on
   operator approval the author re-runs (Step 2) on the findings **before** the
   persist call. The critic runs **before** the deterministic validator (step
   7), so the persist below is the single GitHub write for the whole phase.

6. **Persist to GitHub**: Run the decompose CLI's persist half. It
   validates the ticket array (`validateAndNormalizeTickets`), creates
   the Story issues, flips the Epic to `agent::ready`, and
   writes the `epic-plan-state` checkpoint.

   ```bash
   # Normal decomposition
   node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
     --tickets temp/epic-[Epic_ID]/tickets.json

   # Re-planning (close old tickets first)
   node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
     --tickets temp/epic-[Epic_ID]/tickets.json --force
   ```

7. **Cross-Validation**:
   - Hierarchy completeness, dependency-DAG acyclicity, and `risk::high`
     labelling are deterministic invariants enforced by
     `validateAndNormalizeTickets` in
     [`lib/orchestration/ticket-validator.js`](../../scripts/lib/orchestration/ticket-validator.js);
     its output during decomposition is the canonical proof — no manual
     re-check needed.
   - **File-assumption gate (Story #2636)**: Each Story's `body.changes`
     and `body.references` entries declare an explicit `assumption` ∈
     `creates | refactors-existing | exists | deletes`. The validator
     probes the base branch for every declared path and rejects the
     decompose when the declaration contradicts reality:
     - `creates` + path **exists** at base → error.
     - `refactors-existing` / `exists` / `deletes` + path **absent** at
       base → error.
     Errors are batched per-Story into the validator's `errors` envelope
     so the decompose loop surfaces every mismatch in a single re-prompt
     rather than one at a time.
   - **Scope-overlap check (docs/runbook downstream of config work)**:
     Scan for Stories whose scope is "docs update", "runbook", or
     "README" that land downstream of an earlier "config + runbook"
     Story in the same Epic. If the earlier Story's AC already covers
     the same document, the downstream Story's deliverable is likely
     absorbed. Append a "Scope verification note" to the downstream
     Story body pointing the executor to `git diff main -- <path>`
     against the upstream Story branch so they can confirm whether a
     substantive edit is still required (or only a cross-reference
     remains). The decomposer system prompt emits this flag
     automatically where it can detect the pattern — this checklist
     item is the human/host-LLM backstop.
   - **Action**: Fix any scope-overlap exceptions or validator failures by
     re-running the scripted force path so the change is recorded in tooling
     rather than hand-applied:

     ```bash
     node .agents/scripts/epic-plan-decompose.js \
       --epic [Epic_ID] \
       --tickets temp/epic-[Epic_ID]/tickets.json \
       --force
     ```

8. **Audit**:
   - Check the Epic's comment thread to ensure the backlog summary was posted.
   - Verify that at least one `type::story` issue was created.

9. **Cleanup**: The wrapper script (`epic-plan-decompose.js`) deletes the
   Phase 8 temp files automatically on success — no operator action required.
   The cleanup contract lives in
   [`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js).

## Phase 9: Execution Roadmap (Story Dispatch)

1. **Generate Roadmap**: Automatically invoke the dispatcher in dry-run mode to
   calculate execution waves and model recommendations:

   ```bash
   node .agents/scripts/dispatcher.js [Epic_ID] --dry-run
   ```

2. **Verify Output**:
   - Confirm the **Story Dispatch Table** is printed.
   - Check for any stories in **Wave 0** — these are ready for immediate
     execution.

   > **Manifest persistence (v5.9.0):** the dispatcher also posts the manifest
   > as a `dispatch-manifest` structured comment on the Epic (idempotent —
   > re-runs replace the prior comment). That comment is the source of truth for
   > the Wave Completeness Gate in `/deliver` Step 0.5 and for any external
   > wave-tracking tooling.

3. **Handoff**: Provide the user with the recommended next step:

   > "Planning is complete. Run `/deliver #[Epic ID]` to start the wave
   > loop, or pick a single Story from Wave 0 and run `/deliver #[Story
   > ID]` to drive it directly."

## Phase 10: Readiness Health Check

Run the post-plan health check to validate the backlog before handing off to
`/deliver`. The default mode runs only the cheap checks
(config + git remote) and targets sub-2-second turnaround. The script itself
always exits 0; the structured JSON on stdout reports findings.

```bash
node .agents/scripts/epic-plan-healthcheck.js --epic [Epic_ID]
```

**The healthcheck is a blocking exit condition for `agent::ready`.**
Story #2921 (Epic #2880 F7) wired the persist half of
`epic-plan-decompose.js` to re-run the same default check before
flipping the Epic to `agent::ready`.
When the inline run reports `ok: false`, the persist phase **refuses the
flip** and throws with the failing check's `reason`. The Epic stays on its
prior label (`agent::review-spec` in the normal flow) until either the
underlying check passes on a rerun, or the operator applies the
`planning::healthcheck-waived` label to the Epic and reruns the persist
phase. See `.agents/docs/SDLC.md` § "`agent::ready` exit conditions" for the
full handoff contract and the waiver scope.

The script emits a single line of JSON to stdout:

```json
{
  "ok": true,
  "degraded": false,
  "reason": null,
  "checks": [
    { "name": "config",     "ok": true, "durationMs": 12,  "detail": "..." },
    { "name": "git-remote", "ok": true, "durationMs": 234, "detail": "..." }
  ]
}
```

Modes (additive — the fast checks always run):

- **(default)** — config validation + git remote check only.
- **`--paranoid`** — adds ticket-hierarchy revalidation. Requires `--epic`.
  Use this when you want the full backlog audit before execution.
- **`--prime-install`** — adds the pnpm content-addressable-store prime
  (`pnpm install --frozen-lockfile`, up to 300s). Run only when
  `nodeModulesStrategy: 'pnpm-store'` is configured and you want subsequent
  worktree installs to be near-instant instead of fetching from scratch.

If `ok` is `false`, review the entries in `checks[]`, resolve the failing
check(s), and rerun the persist phase. Apply `planning::healthcheck-waived`
to the Epic only when the failure is environmental and the operator has
triaged it (e.g. a known `origin` outage during a maintenance window).

## Phase 11: Plan Comprehension Gate

An **opt-in, advisory** gate that offers the operator a guided walkthrough of
the freshly planned backlog before they hand off to `/deliver`. The plan
is the moment the operator authorizes an autonomous fan-out of subagents — this
phase exists so they can *understand and endorse* the approach while it is
still free to change, not after the code lands.

> **Non-blocking by construction.** This phase runs **after** Phase 10 has
> already flipped the Epic to `agent::ready`. It never gates that flip, never
> blocks the handoff, and the operator can decline or stop it at any point.
> `risk::high` remains planning metadata and `agent::blocked` remains the only
> mandatory runtime pause — this gate adds neither.

### 1. Decide whether to offer the walkthrough (LM judgment)

There is **no `--flag`**. Evaluate the plan with judgment and **default to
skipping silently**. Offer the walkthrough only when the plan is genuinely
worth one. Signals that warrant offering:

- The roadmap spans **multiple waves** or a **large Story count**.
- Any Story or the Epic carries **`risk::high`**, or the plan matches the
  `planning.riskHeuristics` in `.agentrc.json` (destructive/irreversible
  changes, shared auth/security, CI/CD gate changes, monorepo-wide rewrites,
  destructive migrations).
- The Tech Spec introduces a **novel architectural decision** or a wide
  **blast radius** across subsystems.

A small, single-wave, low-risk plan proceeds straight to Phase 12 with no
prompt. When in doubt on a borderline plan, make a one-line offer rather than
forcing the walkthrough.

### 2. Run the walkthrough (when offered and accepted)

Activate the
[`core/knowledge-transfer`](../../skills/core/knowledge-transfer/SKILL.md) skill
with the **plan** as the subject — the Epic body, the linked PRD / Tech Spec
context tickets, the decomposition (Stories with inline
`acceptance[]` / `verify[]`), and the Phase 9 wave roadmap. The skill owns the
method (restate-first, the why-ladder, mastery gates, depth levels, optional
quizzing, the persistent `temp/comprehension-*.md` checklist).

**Interruptible at every checkpoint.** Each step MUST offer an explicit
"I'm good — proceed to `/deliver`" exit. The instant the operator takes
it, stop the walkthrough and advance to Phase 12. Never trap the operator in
the loop.

### 3. Advance

Whether the walkthrough was skipped, declined, completed, or stopped early,
proceed to Phase 12. This gate produces no label transition and no blocking
condition.

## Phase 12: Notification & Handoff

1. **Notify Operator (INFO)**:
   - Post a summary comment on the Epic issue with work breakdown stats.
   - @mention the operator (informational — no webhook for planning) by running
     the notification script:

   ```bash
   node .agents/scripts/notify.js [Epic_ID] "Planning complete, review tickets. Backlog decomposition complete. Epic is ready for /deliver." --action
   ```

## Troubleshooting

- If `epic-plan-spec.js --emit-context` fails, confirm the Epic exists and
  has a body with enough initial context.
- If `epic-plan-decompose.js` rejects the tickets file, re-read the
  validator's error message — the most common causes are a ticket whose
  `type` is not `story`, a Story missing its inline `acceptance[]` /
  `verify[]` contract, or a dependency cycle in the Story `depends_on`
  graph.
- If decomposition persisted the tickets but the Epic is not on `agent::ready`,
  you likely called `runDecomposePhase` from `epic-plan-decompose.js`
  directly without completing the persist flow — only the CLI surface
  (`node epic-plan-decompose.js --tickets ...`) drives the full
  reconciler pipeline and flips the lifecycle label. Apply `agent::ready`
  by hand and re-run via the CLI next time.
- **Secondary rate limit on large Epics**: For backlogs over ~60 tickets,
  GitHub's secondary rate limit (HTTP 403, body contains "secondary rate
  limit") can trip mid-decomposition after ~80 issue creations. The
  http-client retries automatically with a 30–120s backoff and the
  decomposer drops `concurrencyCap` to 1 for the rest of the run on the
  first observation. If the run still aborts (network drop, exhausted
  retries, etc.), resume from the partial backlog with:

  ```bash
  node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
    --tickets temp/epic-[Epic_ID]/tickets.json --resume
  ```

  `--resume` is idempotent: the reconciler recovers the slug→issue map
  from `temp/epic-[Epic_ID]/[Epic_ID].state.json`, and when that file is
  missing or incomplete it **reseeds the map from live GitHub state** by
  matching each spec slug against the open children of the Epic by title.
  Slugs that resolve to an existing open child diff as Updates/no-ops;
  only the genuinely-missing children are created — the existing tree is
  never duplicated. To force-throttle from the first call on a known-large
  Epic, set `(framework constant: decomposer concurrency): 1` in
  `.agentrc.json`.
