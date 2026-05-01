---
description: QA sprint-testing workflow — ingest the Cucumber report from the BDD acceptance suite as sprint evidence
---

# Sprint Testing (helper)

> **Helper module.** Not a slash command. Invoked from the QA gate during
> `/sprint-close` or directly by an operator when the sprint-testing ticket
> needs refreshed evidence. For ad-hoc BDD runs use `/run-bdd-suite` — this
> helper owns the sprint-evidence ticket lifecycle on top of it.

Gather and attach the acceptance-suite evidence that gates sprint closure. The
evidence artifact is the **Cucumber HTML/JSON report** produced by the
consuming project's BDD suite (typically via `/run-bdd-suite`), **not** a
hand-ticked markdown checklist.

> **When to run**: During the QA phase of a sprint, after all Story merges
> have landed on the Epic branch and before `/sprint-close`. Also run ad-hoc
> when a regression is suspected mid-sprint.
>
> **Persona**: `qa-engineer` · **Skills**:
> `stack/qa/gherkin-authoring`, `stack/qa/playwright-bdd`

## Step 0 — Resolve Context

1. Identify the sprint-testing ticket for the current Epic (the QA evidence
   ticket produced by sprint planning).
2. Confirm the Epic branch is green: all child Story branches merged, CI
   passing.
3. Decide the tag slice to run:
   - Epic-wide regression gate → `@smoke and @risk-high` (or the project's
     equivalent release gate expression).
   - Targeted domain pass → `@domain-<area>`.
   - Full acceptance sweep → omit the tag expression.

   The canonical taxonomy lives in `.agents/rules/gherkin-standards.md`. Do
   not invent new tags here.

## Step 1 — Execute the BDD Suite

Invoke `/run-bdd-suite` with the chosen tag expression:

```text
/run-bdd-suite "@smoke and @risk-high"
```

The `/run-bdd-suite` workflow (`.agents/workflows/run-bdd-suite.md`) owns the
execution mechanics — reporter configuration, shard layout, trace capture.
This workflow consumes its output.

If the consuming project runs the suite through its own CI invocation rather
than the slash command, treat the CI run as equivalent provided it produces
the same Cucumber JSON + HTML artifacts.

## Step 2 — Collect the Evidence Artifact

The evidence package for the sprint-testing ticket is:

- **Cucumber JSON** — primary, machine-readable record of the run. Required.
- **Cucumber HTML** — human-readable companion. Required when available.
- **Playwright trace zips** — for every failed scenario. Required on failure.
- **Suite summary** — tag expression applied, totals (passed / failed /
  skipped / undefined), and the commit SHA the suite ran against.

Store the artifacts where your project's evidence convention dictates (CI
artifact store, object storage, or attached to the ticket directly). Link —
do not paste — large artifacts.

## Step 3 — Attach and Transition

1. Comment on the sprint-testing ticket with:
   - The suite summary from Step 2.
   - Links (or attachments) to the Cucumber JSON, Cucumber HTML, and any
     trace zips.
   - The commit SHA the run executed against.
2. If every scenario passed (no `failed`, no `undefined`), transition the
   sprint-testing ticket to `agent::done`.
3. If any scenario failed or is undefined, leave the ticket in its current
   state and open a follow-up ticket per failure with:
   - Scenario name and `.feature` file path.
   - One-line symptom.
   - Link to the failing scenario's trace zip.

Do not close the sprint-testing ticket on a failed run. `/sprint-close`
depends on green evidence.

## Deprecated — Markdown Checklist Flow

Earlier revisions of this workflow asked the QA reviewer to tick items in a
hand-maintained markdown checklist (`sprint-<N>/test-plan.md`) and attach
that file as evidence. **That flow is deprecated.** Reasons:

- Hand-ticked checklists drift from the code and cannot be re-executed.
- They do not capture scenario-level pass/fail state, traces, or the SHA the
  run targeted.
- They are not machine-readable, so downstream aggregation and trend
  reporting are impossible.

The Cucumber report replaces the checklist as the single evidence artifact.
Projects still maintaining a checklist should migrate by authoring the
equivalent scenarios in Gherkin (see the `stack/qa/gherkin-authoring` skill)
and deleting the checklist in the same change.

## Constraints

- **Never** substitute a hand-authored checklist or prose summary for the
  Cucumber report. The report must be the output of an actual run.
- **Never** close the sprint-testing ticket while any scenario is `failed` or
  `undefined`.
- **Always** record the commit SHA the suite ran against, so the evidence is
  pinned to a verifiable tree state.
- **Always** link trace zips for failed scenarios; a failure without a trace
  is not actionable.

## Cross-References

- Execution mechanics: `.agents/workflows/run-bdd-suite.md`.
- Scenario authoring rules: `.agents/rules/gherkin-standards.md`.
- Runner / fixture / trace conventions:
  `.agents/skills/stack/qa/playwright-bdd/SKILL.md`.
- Tier responsibilities (unit / contract / acceptance):
  `.agents/rules/testing-standards.md`.
