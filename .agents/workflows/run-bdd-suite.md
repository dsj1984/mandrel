---
description: Run a tag-filtered BDD acceptance suite and collect a Cucumber report
---

# /run-bdd-suite

Execute the consuming project's BDD (Gherkin) acceptance suite, filtered by a
tag expression, and produce a Cucumber HTML/JSON report as the evidence
artifact.

> **When to run**: During sprint testing to exercise a targeted slice of the
> acceptance suite (e.g. `@smoke`, `@risk-high`, `@domain-billing`), for
> regression passes before `/epic-close`, or on demand while debugging a
> specific Story.
>
> **Persona**: `qa-engineer` · **Skills**: `stack/qa/gherkin-authoring`,
> `stack/qa/playwright-bdd`

## Slash Command

```text
/run-bdd-suite [tag-expression]
```

### Arguments

| Name             | Required | Shape / Example                                   | Notes                                                                                  |
| ---------------- | -------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `tag-expression` | no       | `@smoke`, `@risk-high and not @wip`, `@domain-*` | Cucumber tag expression. Quoted when it contains spaces. Omit to run the full suite. |

A tag expression follows standard Cucumber semantics: tags may be combined
with `and`, `or`, `not`, and parentheses. Glob-style wildcards (`@domain-*`)
are supported where the consuming project's runner configuration allows.

### Examples

```text
/run-bdd-suite @smoke
/run-bdd-suite "@risk-high and not @wip"
/run-bdd-suite "@domain-billing or @domain-checkout"
/run-bdd-suite
```

The canonical tag taxonomy — `@smoke`, `@risk-high`, `@platform-web`,
`@platform-mobile`, `@domain-*`, and the allowed extension syntax — is defined
in `.agents/rules/gherkin-standards.md`. Do not invent tags inside a feature
file; add new tags to the rule first.

## Step 0 — Resolve Context

1. Resolve `[TAG_EXPRESSION]` from the slash-command argument (may be empty).
2. Confirm the consuming project exposes a tag-filterable `playwright-bdd`
   invocation. The expected shape is a `package.json` script along the lines
   of:

   ```jsonc
   {
     "scripts": {
       "test:bdd": "playwright-bdd test"
     }
   }
   ```

   with tag filtering passed through to the runner (Cucumber-compatible
   `--tags` or the `playwright-bdd`-native equivalent).
3. Confirm the project's reporter configuration emits both Cucumber JSON and
   HTML. If only one is available, still proceed — JSON is the
   machine-readable source of truth; HTML is the human-friendly view.

## Step 1 — Execute the Filtered Suite

Run the project's BDD suite with the tag expression applied. The exact
invocation is project-owned; a representative form is:

```bash
npm run test:bdd -- --tags "[TAG_EXPRESSION]"
```

If `[TAG_EXPRESSION]` is empty, omit `--tags` and run the full suite.

Refer to the `stack/qa/playwright-bdd` skill for fixture composition,
sharding, and trace capture details. The workflow does **not** redefine those
conventions.

## Step 2 — Collect the Evidence Artifact

The evidence artifact for this workflow is the **Cucumber report** produced
by the run:

- **Cucumber JSON** (machine-readable) — the primary artifact. Consumed by
  [`helpers/epic-testing.md`](helpers/epic-testing.md) to attach to the
  sprint-testing ticket and by any downstream aggregation.
- **Cucumber HTML** (human-readable) — attached alongside the JSON for
  reviewer convenience.
- **Playwright traces** for failed scenarios — captured by the
  `playwright-bdd` runner per the `stack/qa/playwright-bdd` skill's trace
  configuration. Link or attach these whenever a scenario fails.

Do not substitute a hand-written markdown checklist; the Cucumber report is
authoritative.

## Step 3 — Report

Summarize the run in chat with:

- Tag expression applied (or "full suite").
- Scenario totals: passed / failed / skipped / undefined.
- Paths (or links) to the Cucumber JSON, Cucumber HTML, and any trace
  artifacts.
- For any failure, the scenario name, file path, and a one-line symptom.

If the run was triggered from a sprint-testing context, follow
[`helpers/epic-testing.md`](helpers/epic-testing.md) for where to attach
the report and how to transition the ticket.

## Relationship to `run-test-plan.md`

`/run-bdd-suite` **supplements** `/run-test-plan`, it does not replace it.

- `/run-test-plan` remains the end-to-end orchestrator for a Story or Epic's
  full test plan. It may invoke `/run-bdd-suite` as the acceptance-layer step
  of a broader plan that also covers unit and contract tiers (per
  `.agents/rules/testing-standards.md`).
- `/run-bdd-suite` is the focused, tag-filtered acceptance run. Use it
  directly when you only need a slice of the suite — a smoke pass, a
  risk-high regression, or a single domain — without reconstructing the full
  test plan.

When in doubt, prefer `/run-test-plan` for sprint closure and
`/run-bdd-suite` for targeted iteration.

## Constraints

- **Never** embed SQL, HTTP status codes, DOM/CSS/XPath selectors, or other
  implementation details inside a `.feature` file to make this workflow pass.
  The `gherkin-standards.md` rule is authoritative; push those assertions
  down to the contract tier instead.
- **Never** hand-author the evidence artifact. The Cucumber report must be
  the output of an actual run.
- **Always** use tags defined in the canonical taxonomy, or extend the
  taxonomy in `gherkin-standards.md` before introducing a new one.
