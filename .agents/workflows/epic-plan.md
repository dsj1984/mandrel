---
description:
  Orchestrates end-to-end Epic planning (PRD, Tech Spec, and Work Breakdown)
  for a GitHub Epic.
---

# /epic-plan [Epic ID]

## Role

Director / Architect

## Context

You are the master orchestrator for the v5 Epic-Centric ticketing pipeline. Your
goal is to transform a high-level Epic into a fully decomposed, ready-to-execute
backlog of Features, Stories, and Tasks.

`/epic-plan` is the unified planning entry point. It delegates to the two
phase helpers — [`helpers/epic-plan-spec.md`](helpers/epic-plan-spec.md) and
[`helpers/epic-plan-decompose.md`](helpers/epic-plan-decompose.md) — and runs
both phases sequentially with a human confirmation gate between them. The Epic
ID is the single positional argument.

As of v5.6, planning artifacts (PRD, Tech Spec, ticket decomposition) are
authored **directly by you, the host LLM** — no external Gemini / Anthropic /
OpenAI API is called. The Node scripts are deterministic GitHub I/O wrappers
that (a) emit the authoring context you need and (b) validate and persist the
artifacts you author.

## Constraint

- Do not modify existing issues without explicit permission.
- Wait for user validation before migrating to Phase 2.
- Delegate Phase 1 and Phase 2 to the
  [`helpers/epic-plan-spec.md`](helpers/epic-plan-spec.md) and
  [`helpers/epic-plan-decompose.md`](helpers/epic-plan-decompose.md)
  procedures respectively — they own the Epic lifecycle label transitions and
  the `epic-plan-state` checkpoint. This wrapper must not apply those labels
  directly.

## Prerequisites

1. **GitHub Epic**: An existing GitHub Issue with the `type/epic` label.
   Skipped when entering via Phase 0a / `--idea` (the Epic does not exist
   yet — Phases 0a–0d will create it).
2. **API Keys**: `GITHUB_TOKEN` must be set in the `.env` file.

## Phase 0a: Idea Refinement (s-plan-ideation entry)

This phase runs **only** when no `<epic#>` argument is supplied, or when
`--idea "<seed>"` is passed. If an Epic ID was provided, skip directly to
Phase 0 (Re-Plan Detection).

1. **Invoke the ideation skill**: Use the `Skill` tool with
   `skill: idea-refinement` and `args` set to the `--idea` value (or a
   user-supplied seed if no argument was given). The skill drives its own
   three-phase divergent → convergent → sharpen loop and returns a
   markdown one-pager with the canonical sections (Problem Statement,
   Recommended Direction, Key Assumptions, MVP Scope, Not Doing).

2. **HITL stop — confirm the sharpened one-pager**: Display the one-pager
   to the operator and **STOP**. Do not proceed to Phase 0b until the
   user explicitly confirms the direction. This is the same gate the
   skill's own Phase 3 enforces; surfacing it here makes the wait
   contract visible to `/epic-plan` callers.

## Phase 0b: Cross-Epic Duplicate Search

Runs immediately after Phase 0a (and only on the s-plan-ideation path).
Its job is to surface open Epics whose scope already overlaps with the
sharpened one-pager so the operator can fold the work in rather than
opening a duplicate.

1. **Invoke the duplicate-search module**: Call
   `findSimilarOpenEpics({ onePager, provider })` exported from
   [`.agents/scripts/lib/duplicate-search.js`](../scripts/lib/duplicate-search.js).
   The `provider` is the resolved ticketing provider
   (`provider-factory.js`), and `onePager` is the markdown returned by
   Phase 0a.

2. **HITL pause on match**: If the module returns a non-empty ranked
   list, render the candidates (id, title, score, URL) and **STOP**. Do
   not proceed to Phase 0c until the user either (a) confirms the new
   Epic is genuinely distinct or (b) chooses to fold the idea into one of
   the existing Epics, in which case `/epic-plan` exits and the operator
   resumes work on the existing Epic ID.

3. **No-match fast path**: If the module returns `[]`, proceed
   immediately to Phase 0c — no operator intervention required.

## Phase 0c: Render Epic Body from One-Pager

Runs after Phase 0b clears (no duplicates, or operator confirmed the
new Epic is genuinely distinct).

1. **Render the body**: Call
   `renderEpicBody({ onePager, template })` exported from
   [`.agents/scripts/lib/epic-plan-ideation.js`](../scripts/lib/epic-plan-ideation.js).
   The `template` argument is the contents of
   [`.agents/templates/epic-from-idea.md`](../templates/epic-from-idea.md),
   which carries the five canonical sections (Problem, Direction,
   Assumptions, MVP Scope, Not Doing). Sections missing from the
   one-pager are rendered as `_(not specified)_` rather than left as
   raw `{{token}}` placeholders.

2. **HITL stop — confirm the body**: Display the rendered body to the
   operator and **STOP**. Do not proceed to Phase 0d until the user
   explicitly confirms the body is correct. This is the last chance to
   tweak wording before the GitHub Issue is opened.

## Phase 0d: Open the GitHub Issue (`type::epic` only)

1. **Open the Epic Issue**: Call
   `openEpicFromOnePager({ onePager, template, createIssue })` from the
   same `epic-plan-ideation.js` module. Pass a `createIssue` port that
   delegates to the resolved ticketing provider (`provider-factory.js`)
   so the labels and body land via the canonical I/O surface.

2. **Label discipline**: The Issue is opened with **only** the
   `type::epic` label. **Do not** add any `state::*` label at creation
   time — the Epic carries only `type::epic` until PRD authoring
   advances it to `agent::review-spec` in Phase 1. The
   `openEpicFromOnePager` helper already enforces this; the workflow
   prose codifies the intent so future label-set tweaks don't silently
   widen it.

3. **Continue to Phase 0**: The captured Epic ID becomes the new
   `[Epic_ID]` for the rest of the planning pipeline. Re-Plan Detection
   (the original Phase 0) will short-circuit because no PRD/Tech Spec
   is linked yet, so the run flows naturally into Phase 1.

## Phase 0: Re-Plan Detection

Before generating any artifacts, check whether the Epic has already been
planned.

1. **Fetch Epic**: Read the Epic issue body and check for a
   `## Planning Artifacts` section containing PRD and Tech Spec references.
2. **If already planned**: Inform the user that this Epic already has planning
   artifacts. Ask:

   > "Epic #[ID] already has PRD (#XX) and Tech Spec (#XX) with YY decomposed
   > tickets. Do you want to **re-plan** from scratch? This will close the old
   > PRD, Tech Spec, and all Feature/Story/Task tickets and regenerate them."

3. **If user confirms re-plan**: Pass `--force` to all subsequent script
   invocations.
4. **If user declines**: Abort gracefully.

## Phase 1: Epic Planning (PRD & Tech Spec)

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
> [`lib/plan-phase-cleanup.js`](../scripts/lib/plan-phase-cleanup.js)).
> Nothing else garbage-collects the tree, so cross-Epic artifacts —
> retros, perf reports, signals, manifests — accumulate until an
> operator explicitly removes them.

1. **Gather Authoring Context**: Run the spec-phase CLI in context-emission
   mode to fetch the Epic body, scraped project docs, and the recommended
   system prompts.

   ```bash
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] --emit-context > temp/epic-[Epic_ID]/planner-context.json
   ```

2. **Author the PRD**: Read `temp/epic-[Epic_ID]/planner-context.json`.
   Using the `systemPrompts.prd` guidance combined with the Epic
   title/body, write the PRD markdown to `temp/epic-[Epic_ID]/prd.md`.
   Keep it to the four-section structure (Context & Goals, User
   Stories, Acceptance Criteria, Out of Scope) and start the document
   with `## Overview` (no `<h1>`).

3. **Author the Tech Spec**: Using `systemPrompts.techSpec`, the PRD you just
   wrote, and `docsContext`, write the Tech Spec to
   `temp/epic-[Epic_ID]/techspec.md`. Start with `## Technical Overview`
   (no `<h1>`).

4. **Persist to GitHub**: Use `epic-plan-spec.js` (not the low-level
   `epic-planner.js` — only the wrapper flips the Epic to `agent::review-spec`
   and writes the `epic-plan-state` checkpoint).

   ```bash
   # Normal planning
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
     --prd temp/epic-[Epic_ID]/prd.md \
     --techspec temp/epic-[Epic_ID]/techspec.md

   # Re-planning (force regeneration)
   node .agents/scripts/epic-plan-spec.js --epic [Epic_ID] \
     --prd temp/epic-[Epic_ID]/prd.md \
     --techspec temp/epic-[Epic_ID]/techspec.md --force
   ```

5. **Verification**:
   - Verify that the PRD and Technical Specification have been posted as linked
     issues under the Epic.
   - **STOP**: Ask the USER to review the generated PRD and Tech Spec on GitHub.
     Do NOT proceed to decomposition until the user confirms the plan is
     accurate.

6. **Cleanup**: The wrapper script (`epic-plan-spec.js`) deletes the Phase 1
   temp files automatically on success — no operator action required. The
   cleanup contract lives in
   [`lib/plan-phase-cleanup.js`](../scripts/lib/plan-phase-cleanup.js).

## Phase 2: Work Breakdown Decomposition

1. **Gather Decomposition Context**:

   ```bash
   node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] --emit-context > temp/epic-[Epic_ID]/decomposer-context.json
   ```

2. **Author the Ticket Array**: Read
   `temp/epic-[Epic_ID]/decomposer-context.json` — it contains the PRD
   body, Tech Spec body, risk heuristics, the decomposer system
   prompt, and a `maxTickets` cap (configurable via
   `agentSettings.limits.maxTickets` in `.agentrc.json`; the framework
   default lives in `.agents/scripts/lib/config/limits.js`). The
   decompose script also logs the resolved cap to stderr so a
   misconfigured key doesn't silently fall through. Produce a JSON
   array of Feature/Story/Task objects conforming to the schema in the
   system prompt and write it to
   `temp/epic-[Epic_ID]/tickets.json`.

3. **Persist to GitHub**: Use `epic-plan-decompose.js` (not the low-level
   `ticket-decomposer.js` — only the wrapper flips the Epic to `agent::ready`
   and writes the `epic-plan-state` checkpoint).

   ```bash
   # Normal decomposition
   node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
     --tickets temp/epic-[Epic_ID]/tickets.json

   # Re-planning (close old tickets first)
   node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
     --tickets temp/epic-[Epic_ID]/tickets.json --force
   ```

4. **Cross-Validation**:
   - Hierarchy completeness, dependency-DAG acyclicity, and `risk::high`
     labelling are deterministic invariants enforced by
     `validateAndNormalizeTickets` in
     [`lib/orchestration/ticket-validator.js`](../scripts/lib/orchestration/ticket-validator.js);
     its output during decomposition is the canonical proof — no manual
     re-check needed.
   - **Scope-overlap check (docs/runbook downstream of config work)**: Scan for
     Stories whose scope is "docs update", "runbook", or "README" Tasks that
     land downstream of an earlier "config + runbook" Story in the same Epic. If
     the earlier Story's AC already covers the same document, the downstream
     Task's deliverable is likely absorbed. Append a "Scope verification note"
     to the downstream Task body pointing the executor to
     `git diff main -- <path>` against the upstream Story branch so they can
     confirm whether a substantive edit is still required (or only a
     cross-reference remains). The decomposer system prompt emits this flag
     automatically where it can detect the pattern — this checklist item is the
     human/host-LLM backstop.
   - **Action**: Fix any scope-overlap exceptions or validator failures by
     re-running the scripted force path so the change is recorded in tooling
     rather than hand-applied:

     ```bash
     node .agents/scripts/epic-plan-decompose.js \
       --epic [Epic_ID] \
       --tickets temp/epic-[Epic_ID]/tickets.json \
       --force
     ```

5. **Audit**:
   - Check the Epic's comment thread to ensure the backlog summary was posted.
   - Verify that at least one `type/feature`, `type/story`, and `type/task`
     issue was created.

6. **Cleanup**: The wrapper script (`epic-plan-decompose.js`) deletes the
   Phase 2 temp files automatically on success — no operator action required.
   The cleanup contract lives in
   [`lib/plan-phase-cleanup.js`](../scripts/lib/plan-phase-cleanup.js).

## Phase 3: Execution Roadmap (Story Dispatch)

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
   > the Wave Completeness Gate in `/epic-deliver` Step 0.5 and for any external
   > wave-tracking tooling.

3. **Handoff**: Provide the user with the recommended next step:

   > "Planning is complete. Run `/epic-deliver #[Epic ID]` to start the wave
   > loop, or pick a single Story from Wave 0 and run `/story-execute #[Story
   > ID]` to drive it directly."

## Phase 4: Readiness Health Check

Run the post-plan health check to validate the backlog before handing off to
`/epic-deliver`. The default `--fast` mode runs only the cheap checks
(config + git remote) and targets sub-2-second turnaround. It is non-blocking
— the script always exits 0; the structured JSON on stdout reports findings.

```bash
node .agents/scripts/epic-plan-healthcheck.js --epic [Epic_ID] --fast
```

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

Modes (additive — fast checks always run):

- **`--fast` (default)** — config validation + git remote check only.
- **`--paranoid`** — adds ticket-hierarchy + dependency-cycle revalidation.
  Requires `--epic`. Use this when you want the full backlog audit before
  execution.
- **`--prime-install`** — adds the pnpm content-addressable-store prime
  (`pnpm install --frozen-lockfile`, up to 300s). Run only when
  `nodeModulesStrategy: 'pnpm-store'` is configured and you want subsequent
  worktree installs to be near-instant instead of fetching from scratch.

If `ok` is `false`, review the entries in `checks[]` before starting
execution. Individual non-`ok` entries are advisory unless the operator
chooses to gate on them.

## Phase 5: Notification & Handoff

1. **Notify Operator (INFO)**:
   - Post a summary comment on the Epic issue with work breakdown stats.
   - @mention the operator (informational — no webhook for planning) by running
     the notification script:

   ```bash
   node .agents/scripts/notify.js [Epic_ID] "Planning complete, review tickets. Backlog decomposition complete. Epic is ready for /epic-deliver." --action
   ```

## Troubleshooting

- If `epic-plan-spec.js --emit-context` fails, confirm the Epic exists and
  has a body with enough initial context.
- If `epic-plan-decompose.js` rejects the tickets file, re-read the
  validator's error message — the most common causes are a Story with no child
  Tasks, a Task whose `parent_slug` does not point at a Story, or cross-Story
  Task dependencies (which must be lifted to Story-level dependencies).
- If decomposition persisted the tickets but the Epic is not on `agent::ready`,
  you invoked the low-level `ticket-decomposer.js` directly — only
  `epic-plan-decompose.js` flips the lifecycle label. Apply `agent::ready`
  by hand and re-run via the wrapper next time.
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

  `--resume` is idempotent: planned tickets whose title matches an existing
  open child of the Epic are skipped (their issue IDs flow through the
  parent/dep wiring), and only the missing ones are created. To force-throttle
  from the first call on a known-large Epic, set
  `orchestration.concurrency.decomposer: 1` in `.agentrc.json`.
