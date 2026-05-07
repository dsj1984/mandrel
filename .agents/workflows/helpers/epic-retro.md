---
description: >-
  Perform Sprint Retrospective, reading data from the Epic ticket graph and
  friction logs, then post the retro as a structured comment on the Epic issue
  (the retro is no longer written to a local file).
---

# Sprint Retro (helper)

> **Helper module.** Not a slash command. Invoked automatically from
> `/epic-close` Phase 6 when the Epic has no retro comment yet. To run a
> retro directly, use `/epic-close [Epic_ID]` — it delegates here (or pass
> `--skip-retro` to bypass).

This helper generates a sprint retrospective by reading execution data
directly from the GitHub ticket graph and **posts the result as a comment on the
Epic issue**. Local `docs/retros/` is no longer used — GitHub is the sole retro
archive.

> **Persona**: `product` · **Skills**:
> `core/documentation-and-adrs`, `core/idea-refinement`

## Step 0 — Resolve Configuration

1. Resolve `[EPIC_ID]` — the GitHub Issue number of the Epic that was just
   completed.
2. Resolve `[SCRIPTS_ROOT]` from `paths.scriptsRoot` in `.agentrc.json`
   (default: `.agents/scripts`).
3. Resolve `[BASE_BRANCH]` from `baseBranch` in `.agentrc.json`.

> **Storage has moved.** The retro is posted as a structured comment on the Epic
> issue — there is no longer a `retroPath` or a local file to produce. The
> comment is greppable via
> `gh api repos/{owner}/{repo}/issues/[EPIC_ID]/comments` and survives branch
> pruning, repo moves, and local cleanups.

## Step 0.5 — Evaluate the Clean-Manifest Heuristic

Before composing six sections of retro boilerplate, check whether the Epic's
frozen dispatch manifest carries any friction signals at all. Clean sprints
(zero friction, zero parked follow-ons, zero recuts, zero hotfixes, zero
agent::blocked events) collapse into a three-section **compact retro** that
preserves the scorecard and the session-observation surface without the
six-section overhead.

Gather the five counts and evaluate the predicate:

```js
import { isCleanManifest } from '[SCRIPTS_ROOT]/lib/orchestration/retro-heuristics.js';

const counts = {
  friction,   // count of `friction` structured comments across descendants
  parked,     // parked follow-ons from the `parked-follow-ons` comment (no manifest lineage)
  recuts,     // Stories carrying a `<!-- recut-of: #N -->` marker
  hotfixes,   // Tasks that flipped to `status::blocked` mid-sprint
  hitl,       // Tickets that raised an `agent::blocked` event mid-sprint (the runtime HITL pause point)
};

const compact = isCleanManifest(counts);
```

- `compact === true` → follow the **compact path** in Step 2 (three sections).
- `compact === false` → follow the **full path** in Step 2 (six sections — the
  default composition that has always applied).

> **Operator override.** If the caller passed `--full-retro` (via
> `/epic-close --full-retro` or a direct helper invocation), treat
> `compact` as `false` regardless of the heuristic and compose the full
> six-section retro. The `--full-retro` flag is the documented escape
> hatch for cases where the operator wants the full narrative treatment on
> a scorecard-clean sprint (e.g. the Epic introduced subtle architectural
> drift that the numeric signals missed).

## Step 1 — Gather Retrospective Data from the Ticket Graph

Read execution telemetry directly from GitHub — **not** from local files:

1. **Fetch the Epic and all child tickets** (Features, Stories, Tasks) using
   `provider.getTickets(epicId)`.
2. **Fetch the per-Story `story-perf-summary` and Epic `epic-perf-report`
   summary comments** (Epic #1030 Story #1046). The retro now reads the
   unified summary comments instead of fanning out across per-Task `friction`
   structured comments — `analyze-execution.js` is the single writer of both
   markers (Story close posts `story-perf-summary`; Epic close Phase 6 posts
   `epic-perf-report`).
   - For each closed Story under the Epic, fetch the
     `<!-- structured:story-perf-summary -->` comment via
     `provider.getTicketComments(storyId)`. Each payload carries
     `frictionByCategory`, `phaseTimingsMs`, `topSlowPhasesVsBaseline`,
     `reworkScore`, and `retryDensity`. Aggregate `frictionByCategory` counts
     across descendants — that aggregate is the friction count the scorecard
     and `isCleanManifest` heuristic consume.
   - Fetch the single `<!-- structured:epic-perf-report -->` comment on the
     Epic itself via `provider.getTicketComments(epicId)`. This payload
     carries the cross-Story rollups (median/p95 per phase, top hotspots,
     baseline drift). It is consumed in Step 2 to populate the
     **What Could Be Improved → Top hotspots** subsection.
   - If a Story has no `story-perf-summary` comment (e.g. Story was closed
     before Story #1046 wired the analyzer), treat its contribution as
     `frictionByCategory = {}` and continue. The retro still composes; the
     missing payload is observably degraded but non-fatal. Same fallback
     applies if the `epic-perf-report` comment is absent — the Top hotspots
     subsection collapses to `_No epic-perf-report available._`.
3. **Collect aggregate friction signals** (sourced from the
   `story-perf-summary` payloads aggregated above, plus per-ticket label
   reads):
   - Count of Tasks that required a hotfix (`status::blocked` was applied).
   - Count of tickets that raised an `agent::blocked` event mid-sprint (the
     runtime HITL pause point — count distinct tickets that received the
     `agent::blocked` label at any point during execution, including ones
     that were later flipped back to `agent::executing`).
   - Count of Tasks that required more than one integration attempt.
4. **Fetch the code-review structured comment** (if present) from the Epic —
   `provider.getTicketComments(epicId)` filtered by the
   `ap:structured-comment type="code-review"` HTML marker (posted by
   `epic-code-review.js`). Summarise any Critical Blocker / High Risk findings
   in the **Architectural Debt** section of the retro body below. If no comment
   is present, note "no automated code-review findings".
5. **Fetch the parked-follow-ons structured comment** (if present) from the Epic
   — filter by `ap:structured-comment type="parked-follow-ons"` (posted by the
   dispatcher). The JSON block lists **recuts** (Stories created mid-sprint
   carrying a `<!-- recut-of: #N -->` marker attributable to a manifest Story)
   and **parked** follow-ons (Stories without manifest lineage). Attribute
   recuts back to their parent Story in the scorecard so the sprint count lines
   up with the frozen manifest, and call out any parked follow-ons in **Action
   Items for Next Epic**. Each Story also declares its recut lineage directly in
   its body via the `<!-- recut-of: #N -->` marker — read that as a fallback
   when the structured comment is absent.

## Step 2 — Compose the Retrospective Markdown

Produce the retro body (in memory — do **not** write to disk) with one of two
structures, selected by the Step 0.5 heuristic:

- **Compact path** (three sections) — fires when `isCleanManifest` returned
  `true` and `--full-retro` was not set. Jump to
  [Step 2 — Compact path](#step-2--compact-path-clean-manifest-only).
- **Full path** (six sections) — fires otherwise. Continue with the full
  template below.

Either path ends with the same `<!-- retro-complete: <ISO_TIMESTAMP> -->`
HTML marker — that marker is the detection signal used by `/epic-close`'s
Retrospective Gate (Step 1.5) when a structured-comment lookup is unavailable.
The final post in Step 3 is `type: 'retro'` regardless of which path composed
the body, so downstream tooling sees the same comment shape.

### Checkpoint after each composed section (`retro-partial`)

Long retros can run for many minutes and occasionally crash mid-compose. To
avoid re-composing from scratch, **upsert** a `retro-partial` structured
comment on the Epic **after composing each major section**. The retro body
assembled so far is the comment body; each checkpoint replaces the prior
`retro-partial` (one comment per Epic, never N).

Call order (one upsert per checkpoint):

```text
compose Sprint Scorecard                    → upsertStructuredComment(epicId, { type: 'retro-partial', body })
compose What Went Well                      → upsertStructuredComment(epicId, { type: 'retro-partial', body })
compose What Could Be Improved              → upsertStructuredComment(epicId, { type: 'retro-partial', body })
compose Architectural Debt                  → upsertStructuredComment(epicId, { type: 'retro-partial', body })
compose Protocol Optimization Recommendations → upsertStructuredComment(epicId, { type: 'retro-partial', body })
compose Action Items for Next Epic          → upsertStructuredComment(epicId, { type: 'retro-partial', body })
```

`upsertStructuredComment` lives in
`.agents/scripts/lib/orchestration/ticketing.js` and replaces the prior
comment of the same type on each call, so no comment sprawl occurs. The
partial body does **not** carry the `retro-complete:` marker — it is
informational only. Step 3 then posts the final body as `type: 'retro'`
with the `retro-complete:` marker, which `/epic-close` Phase 6 uses as
its sole completion gate (the regex matches `retro-complete:` exclusively,
so `retro-partial:` checkpoints never trip the gate).

If this helper is re-invoked after a mid-run crash, the prior
`retro-partial` comment is visible on the Epic; resume composition from the
next unwritten section rather than starting over.

```markdown
## 🪞 Sprint Retrospective — Epic #[EPIC_ID]: [Epic Title]

_Generated [ISO date] · Protocol Version [from .agents/VERSION]_

### Sprint Scorecard

| Metric                    | Value |
| ------------------------- | ----- |
| Total Tasks                  |       |
| Tasks Completed First Try    |       |
| Tasks Requiring Hotfix       |       |
| agent::blocked Events Raised |       |
| Friction Events              |       |

### What Went Well

> (Analyse Task ticket labels and comments for smooth execution patterns)

### What Could Be Improved

> (Identify systemic friction; extract root causes from the
> `story-perf-summary` aggregate `frictionByCategory` rollup.)

#### Top hotspots

> Sourced from the Epic's `<!-- structured:epic-perf-report -->` comment
> (Step 1.2). Render the top callouts the analyzer produced — typically a
> short bullet list of the slowest phases vs. baseline, the highest-rework
> file paths, and any retry-density outliers. If no `epic-perf-report`
> comment is present, render `_No epic-perf-report available._` instead.

### Architectural Debt

> (List any patterns introduced that deviate from established ADRs)

### Protocol Optimization Recommendations (Self-Healing)

> MUST: Identify systemic friction points and propose agent-ready markdown
> snippets or skill updates for the agent-protocols library.

### Action Items for Next Epic

> Clear, actionable items derived from the retro analysis.

<!-- retro-complete: 2026-04-15T00:00:00Z -->
```

Replace the placeholder ISO timestamp with the actual time the retro was
composed. The marker MUST be present as the final line so downstream gates can
detect completion even when the structured-comment type metadata is not
available to the caller.

The `## 🪞 Sprint Retrospective — Epic #[EPIC_ID]` heading should appear at the
top for human readability, but `/epic-close`'s Retrospective Gate no longer
depends on a heading grep — it prefers `provider.getComments(epicId)` filtered
by `type === "retro"` and falls back to grepping for the `retro-complete:` HTML
marker added at the end of the body.

## Step 2 — Compact path (clean-manifest only)

When `isCleanManifest` returned `true` and `--full-retro` was not set, compose
the three-section retro body below. The `retro-partial` checkpoint cadence
collapses to three upserts instead of six (one after each composed section).
The final post in Step 3 is still `type: 'retro'` with the
`retro-complete:` marker; only the body shape changes.

```markdown
## 🪞 Sprint Retrospective — Epic #[EPIC_ID]: [Epic Title]

_Generated [ISO date] · Protocol Version [from .agents/VERSION]_

🟢 Clean sprint — zero friction, zero parked follow-ons, zero recuts, zero hotfixes, zero agent::blocked events.

### Sprint Scorecard

| Metric                       | Value |
| ---------------------------- | ----- |
| Total Tasks                  |       |
| Tasks Completed First Try    |       |
| Tasks Requiring Hotfix       | 0     |
| agent::blocked Events Raised | 0     |
| Friction Events              | 0     |

### Session Observations

> Merges **What Went Well**, **What Could Be Improved**, and **Architectural
> Debt** into a single narrative section. The operator still contributes here
> — numeric cleanliness is not the same as "nothing worth noting". If the run
> truly was unremarkable beyond the scorecard, `_Nothing notable beyond the
> scorecard._` is an acceptable body.

### Action Items for Next Epic

> Clear, actionable items surfaced during this sprint. An empty list is valid
> signal (the sprint was genuinely self-contained), **not** a failure mode —
> do not fabricate action items to fill the section.

<!-- retro-complete: 2026-04-15T00:00:00Z -->
```

Replace the placeholder ISO timestamp with the actual time the retro was
composed. The **Protocol Optimization Recommendations** section is deliberately
omitted from the compact path — a clean-manifest sprint did not produce
systemic friction worth codifying. Restore the full six-section structure by
re-running the helper with `--full-retro` if you need that section.

## Step 3 — Post the Retrospective as an Epic Comment

### Step 3.0 — Mirror the composed body to `temp/epic-<id>/retro.md`

Before posting the retro to GitHub, mirror the final composed markdown to a
local file at `temp/epic-[EPIC_ID]/retro.md` (Epic #1030 Story #1046). The
mirror is informational — GitHub remains the sole authoritative archive (see
the "Storage has moved" callout in Step 0) — but the local copy lets
operators inspect the rendered body without round-tripping through the
GitHub API and survives mid-post network failures so the body can be
re-posted from disk after retry.

```bash
mkdir -p temp/epic-[EPIC_ID]
# Write the composed markdown to disk (the operator's tooling supplies the
# body; the path is fixed by convention).
echo "<final retro markdown>" > temp/epic-[EPIC_ID]/retro.md
```

The mirror is overwritten on each retro run — one file per Epic, never N.
Do **not** commit `temp/epic-<id>/retro.md` to git; it is a transient
operator-facing artefact, like the per-Story manifest pair next to it.

### Step 3.1 — Post via the structured comment API

Post the composed markdown as a structured comment on the Epic issue, tagged
with the `retro` type. **Never** route the retro body through `notify.js` —
that path fires the notification webhook, leaking the long-form retro body to
downstream consumers (Make.com / Slack / Discord). GitHub is the sole
destination.

```bash
# Preferred — CLI structured comment (does NOT fire the webhook).
# Write the retro markdown to a file first; --body-file is required.
node .agents/scripts/post-structured-comment.js \
  --ticket [EPIC_ID] --marker retro --body-file <path-to-retro.md>

# Direct SDK fallback (also does NOT fire the webhook):
node -e "
  import('./.agents/scripts/lib/provider-factory.js').then(async ({ loadProvider }) => {
    const provider = loadProvider();
    await provider.postComment([EPIC_ID], { body: '<retro markdown>', type: 'retro' });
  });
"
```

The retro body **must** still end with the `<!-- retro-complete: <ISO_TIMESTAMP> -->`
HTML marker — `/epic-close`'s Retrospective Gate (Phase 6) falls back to
grepping that marker when the structured-comment type lookup is unavailable.
This final `retro` comment replaces any prior `retro-partial` checkpoint
posted during Step 2.

Record the returned comment URL — the caller (typically `/epic-close`) may
echo it in its summary.

### Manual verification

After a full retro run, inspect the Make.com (or equivalent)
notification webhook log for the window of the run and confirm **no entry
contains the retro body**. The webhook should only ever see short
notification payloads fired elsewhere in the protocol — the retro post must
not appear there. If it does, Step 3 has regressed to a `notify.js` path;
stop and fix before continuing.

### Fallback on network failure

If the comment post fails (network / 4xx / 5xx), **do not** write the retro to
disk. Surface the error to the operator and abort. The retro body lives only in
the agent's working memory for the current session — the operator re-runs
`/epic-close [EPIC_ID]` after resolving connectivity (which will re-invoke
this helper) so the content is regenerated from the ticket graph (the
authoritative source) and posted fresh.
The `retro-partial` checkpoint from Step 2 remains on the Epic so prior
section composition is preserved across the re-run. GitHub is the sole retro
archive.

## Step 4 — Update Architecture & Patterns Documentation (Optional)

If the Epic introduced cross-cutting architectural decisions, update the
supporting docs in the same session:

- Update `docs/architecture.md` if any core schemas or dependencies were
  introduced during this Epic.
- Update `docs/decisions.md` to capture key architectural decisions made during
  implementation.

Commit these with a conventional `docs(...)` message on the Epic branch. Do
**not** stage or commit the retro itself — it lives only on GitHub.

## Constraint

- **Never** write the retro to `docs/retros/` or any other local path as the
  permanent artifact. GitHub Epic comments are the source of truth.
- **Never** omit the closing `<!-- retro-complete: <ISO_TIMESTAMP> -->` marker —
  `/epic-close`'s Retrospective Gate falls back to grepping for it when the
  structured-comment lookup is unavailable.
- **Never** post the retro body through `notify.js`. That path fires the
  notification webhook and leaks the long-form retro to Make.com / Slack /
  Discord. Use `node .agents/scripts/post-structured-comment.js --marker retro`
  or `provider.postComment(..., { type: 'retro' })` exclusively — both post
  only to GitHub and never touch the webhook.
- **Always** post the retro as `type: retro` via the structured comment API so
  downstream tooling (and the `/epic-close` gate) can filter it.
- **Always** re-run the workflow end-to-end if the final comment post fails.
  The `retro-partial` checkpoint written in Step 2 preserves section-level
  progress across the re-run — resume composition from the next unwritten
  section rather than starting over.
- GitHub is the Single Source of Truth in v5 — all execution data must be
  sourced from the ticket graph.
- **`--full-retro` override.** `/epic-close --full-retro` (or an explicit
  caller-side flag) forces the full six-section path regardless of the Step
  0.5 heuristic. The override is opt-in — the compact path stays the default
  for clean manifests. Use it when numeric signals miss an observation the
  operator wants captured in the richer template (e.g. architectural debt
  that would otherwise slip past a scorecard-clean sprint).
