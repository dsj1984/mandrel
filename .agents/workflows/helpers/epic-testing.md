---
description: QA Epic-testing workflow — ingest the agent-driven QA harness sweep as Epic evidence
---

# Epic Testing (helper)

> **Helper module.** Not a slash command. Invoked from the QA gate during
> `/deliver` or directly by an operator when the Epic-testing ticket
> needs refreshed evidence. For ad-hoc acceptance runs use `/qa-run-harness` —
> this helper owns the Epic-evidence ticket lifecycle on top of it.

Gather and attach the acceptance-suite evidence that gates Epic closure. The
evidence artifact is the **agent-driven QA harness sweep report** produced by
`/qa-run-harness` (scenario pass/fail/blocked totals plus structured
findings), **not** a hand-ticked markdown checklist.

> **When to run**: During the QA phase of an Epic, after all Story merges
> have landed on the Epic branch and before `/deliver`. Also run ad-hoc
> when a regression is suspected mid-Epic.
>
> **Persona**: `qa-engineer` · **Skills**:
> `stack/qa/gherkin-authoring`, `stack/qa/playwright-bdd`

## Step 0 — Resolve Context

1. Identify the Epic-testing ticket for the current Epic (the QA evidence
   ticket produced by Epic planning).
2. Confirm the Epic branch is green: all child Story branches merged, CI
   passing.
3. Decide the tag slice to run:
   - Epic-wide regression gate → `@smoke and @risk-high` (or the project's
     equivalent release gate expression).
   - Targeted domain pass → `@domain-<area>`.
   - Full acceptance sweep → omit the tag expression.

   The canonical taxonomy lives in `.agents/rules/gherkin-standards.md`. Do
   not invent new tags here.

## Step 1 — Execute the QA Harness Sweep

Invoke `/qa-run-harness` with the chosen selector:

```text
/qa-run-harness "tag:@smoke and @risk-high"
```

The `/qa-run-harness` workflow (`.agents/workflows/qa-run-harness.md`) owns the
execution mechanics — `qa` contract resolution, scenario selection, browser
navigation, and finding capture. This workflow consumes its output.

If the consuming project runs the suite through its own CI invocation rather
than the slash command, treat the CI run as equivalent provided it produces
the same scenario totals and structured findings.

## Step 2 — Collect the Evidence Artifact

The evidence package for the Epic-testing ticket is:

- **Sweep summary** — selector applied, scenario totals (passed / failed /
  blocked), and the commit SHA the sweep ran against. Required.
- **Structured findings** — the `F#` findings bundle the harness emits
  (console / network / visual problems by surface). Required.
- **Accessibility snapshots / traces** — for every failed or blocked scenario.
  Required on failure.
- **Drafted follow-up bundle** — the proposed follow-up tickets awaiting
  operator sign-off, when the sweep surfaced findings.

Store the artifacts where your project's evidence convention dictates (CI
artifact store, object storage, or attached to the ticket directly). Link —
do not paste — large artifacts.

## Step 3 — Attach and Transition

1. Comment on the Epic-testing ticket with:
   - The sweep summary from Step 2.
   - Links (or attachments) to the structured findings, accessibility
     snapshots, and any traces.
   - The commit SHA the sweep executed against.
2. If every scenario passed (no `failed`, no `blocked`), transition the
   Epic-testing ticket to `agent::done`.
3. If any scenario failed or is blocked, leave the ticket in its current
   state and open a follow-up ticket per failure with:
   - Scenario name and `.feature` file path.
   - One-line symptom.
   - Link to the failing scenario's snapshot or trace.

Do not close the Epic-testing ticket on a failed run. `/deliver`
depends on green evidence.

## Deprecated — Markdown Checklist Flow

Earlier revisions of this workflow asked the QA reviewer to tick items in a
hand-maintained markdown checklist (`epic-<id>/test-plan.md`) and attach
that file as evidence. **That flow is deprecated.** Reasons:

- Hand-ticked checklists drift from the code and cannot be re-executed.
- They do not capture scenario-level pass/fail state, traces, or the SHA the
  run targeted.
- They are not machine-readable, so downstream aggregation and trend
  reporting are impossible.

The QA harness sweep replaces the checklist as the single evidence artifact.
Projects still maintaining a checklist should migrate by authoring the
equivalent scenarios in Gherkin (see the `stack/qa/gherkin-authoring` skill)
and deleting the checklist in the same change.

## Constraints

- **Never** substitute a hand-authored checklist or prose summary for the
  harness sweep. The evidence must be the output of an actual run.
- **Never** close the Epic-testing ticket while any scenario is `failed` or
  `blocked`.
- **Always** record the commit SHA the sweep ran against, so the evidence is
  pinned to a verifiable tree state.
- **Always** link a snapshot or trace for failed scenarios; a failure without
  evidence is not actionable.

## Cross-References

- Execution mechanics: `.agents/workflows/qa-run-harness.md`.
- Scenario authoring rules: `.agents/rules/gherkin-standards.md`.
- Runner / fixture / trace conventions:
  `.agents/skills/stack/qa/playwright-bdd/SKILL.md`.
- Tier responsibilities (unit / contract / acceptance):
  `.agents/rules/testing-standards.md`.
