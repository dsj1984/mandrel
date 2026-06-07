---
name: playwright-bdd
description:
  Wires Gherkin `.feature` files to Playwright via the `playwright-bdd`
  library. Use when running BDD scenarios on a Playwright runtime — pairs
  with the `gherkin-authoring` skill (scenario prose) and the `playwright`
  skill (browser conventions). Drives execution by tag expression with
  trace-first debugging and Playwright-native sharding.
vendor: playwright
---

# Skill: playwright-bdd

## Policy Capsule

- Complete the pre-authoring grep-for-existing-steps checklist before writing any new scenario text; record the matches in your output.
- Keep `.feature` files free of Playwright API calls — scenarios describe intent, step definitions translate to browser actions.
- Generate step bindings into a dedicated directory (e.g. `.features-gen/`) and add it to `.gitignore`; never commit generated specs.
- Drive runs by tag expression (`--grep "@smoke and not @flaky"`), not filename globs; use the canonical `@smoke`/`@risk-high`/`@platform-*`/`@domain-*` taxonomy.
- Inject fixtures via `createBdd` rather than pulling singletons from module scope; reset persistent state through fixture teardown, not stray `After` hooks.
- Reuse `storageState` for authenticated scenarios — create a logged-in user fixture instead of repeating login steps in `Background`.
- Keep `trace: 'on-first-retry'` (or `'retain-on-failure'`) enabled; reproduce failures by `@scenario-id` tag, not by title.
- Shard with Playwright's native `--shard=i/N`; never partition by tag expression across CI jobs.

Guidance for running Gherkin `.feature` files against Playwright via
`playwright-bdd`. Pairs with the `gherkin-authoring` skill (scenario prose) and
the `playwright` skill (browser-level conventions); this skill covers the wiring
between them.

> **Version:** consumers pick their own `playwright-bdd` version. This skill
> documents behavioral constraints, not a pinned release.

## Pre-authoring checklist (mandatory)

The agent MUST complete every item below AND MUST include the results in its
output report BEFORE any scenario text is written. See
[§ Step Reuse — Grep Before You Write](../../../../rules/gherkin-standards.md#step-reuse--grep-before-you-write)
for rationale.

1. Run `rg` against the project's steps directory and list every step signature
   you will reuse. Format: one `Given/When/Then "…"` per line.
2. For each scenario line you plan to author, identify the matching existing
   step. For any line with no match, either rephrase to reuse an existing step
   or record it as a gap. Do NOT author new step definitions during scenario
   authoring.
3. State the canonical domain tag and platform tag you will apply (or note
   "Cross-Platform → no platform tag" per `gherkin-standards.md`).
4. Confirm the AC's `data-testid`, URL, and payload hints will be stripped from
   scenario prose.

If you cannot complete every item, stop and report — do not proceed to scenario
authoring.

## 1. Core Principles

- **One source of truth per scenario:** `.feature` files describe intent; step
  definitions translate intent into Playwright calls. Never author browser
  actions in `.feature` prose.
- **Deterministic tag filtering:** every scenario carries enough tags that any
  CI shard can be selected by a tag expression without inspecting file paths.
- **Fixture-per-scenario isolation:** scenarios must not share mutable state.
  Treat each scenario as a fresh browser context.
- **Trace-first debugging:** keep the Playwright Trace Viewer workflow intact —
  `playwright-bdd` wraps Playwright, it does not replace its diagnostics.

## 2. Config Patterns

- Generate step-definition bindings into a dedicated output directory (commonly
  `.features-gen/`) and add it to `.gitignore`. Do not commit generated specs.
- Point `playwright.config.ts` at the generated directory via `testDir`; keep a
  single `defineBddConfig` block that lists `features` and `steps` paths.
- Register the Cucumber HTML/JSON reporter alongside the Playwright HTML
  reporter so a headless CI invocation emits machine-readable evidence
  alongside the agent-driven `/qa-run-harness` sweep.
- Use Playwright projects (not Cucumber profiles) for browser matrix fan-out —
  keeps sharding, retries, and trace config in one place.

## 3. Fixture Composition

- Extend Playwright's `test` via `playwright-bdd`'s `createBdd` so fixtures
  (auth state, API clients, seeded data) are injected into `Given`/`When`/
  `Then` callbacks by name, not pulled from module-level singletons.
- Layer fixtures: base Playwright fixtures → domain fixtures (authenticated
  user, seeded tenant) → scenario-scoped helpers. Each layer depends only on the
  layer below.
- Reset persistent state with fixture teardown, not with `After` hooks buried in
  step files — teardown order is then deterministic and visible in the fixture
  graph.
- Reuse `storageState` for authenticated scenarios; create a "logged-in user"
  fixture rather than repeating login steps in `Background`.

## 4. Tag-Filtered Execution

- Drive runs via tag expressions, not filename globs:
  `npx bddgen && npx playwright test --grep "@smoke and not @flaky"`.
- Use the canonical tag taxonomy defined in
  [`.agents/rules/gherkin-standards.md`](../../../../rules/gherkin-standards.md#tag-taxonomy)
  (`@smoke`, `@risk-high`, `@platform-*`, `@domain-*`). Do not invent parallel
  tag vocabularies in the runner config; extend via `@domain-*` only.
- Wire tag-filtered headless runs to a single npm script so operators never
  reconstruct the generate-then-run sequence by hand; the agent-driven
  `/qa-run-harness` selector mirrors the same tag expressions for browser sweeps.
- Fail the run if generation produces zero matching scenarios — a silent empty
  suite is worse than a red build.

## 5. Debug & Trace Workflow

- Keep `trace: 'on-first-retry'` (or `'retain-on-failure'`) in the Playwright
  config. `playwright-bdd` preserves the trace attachment because each scenario
  maps to a Playwright test.
- Reproduce a single failing scenario with `--grep "@scenario-id"` rather than
  the scenario title — titles change, tags are stable.
- Open traces with `npx playwright show-trace` against the artifact produced
  under `test-results/`; the trace timeline annotates each `Given`/`When`/
  `Then` step, which is the primary debug affordance.
- For step-definition bugs, run with `PWDEBUG=1` to drop into the inspector at
  the failing step — do not add `page.pause()` calls inside step files.

## 6. Sharding & CI Notes

- Shard with Playwright's native `--shard=i/N`; do not partition by tag
  expression across jobs — tag-sharding makes flake triage non-deterministic.
- Run `bddgen` once per job before `playwright test`; cache the generated
  directory only if the cache key includes every `.feature` and step file.
- Publish the Cucumber HTML/JSON report as the evidence artifact consumed by the
  `epic-testing` helper, alongside the Playwright HTML report and any trace
  zips.
- Quarantine `@flaky` scenarios with a dedicated job that does not gate the
  merge queue; do not silently retry flakes in the main suite.

## Recommended invocation template

Use this template when invoking a subagent to author a `.feature` file from an
Acceptance Criterion.

```text
You are an AI coding agent. Your sole task is to invoke the
**stack/qa/playwright-bdd** skill (defined in this repo) to author one new
acceptance scenario from a single Acceptance Criterion. You receive nothing
about this codebase except the AC text and the skill itself — you must
discover everything else (existing step library, naming conventions, etc.)
through the skill's prescribed workflow.

Follow the skill's guidance precisely. Your output will be evaluated
against `.agents/rules/gherkin-standards.md`.

**Skill to invoke.** Read `.agents/skills/stack/qa/playwright-bdd/SKILL.md`
and follow it. Also read `.agents/rules/gherkin-standards.md` (which the
skill references).

**The Acceptance Criterion (your sole input).** {{AC_TEXT}}

**Your task.**
1. Read the skill and the gherkin rule.
2. Per the skill's "Step Reuse — Grep Before You Write" section, grep
   {{STEPS_DIR}} to discover the existing step vocabulary BEFORE
   authoring. List the matches you found.
3. Author a NEW `.feature` file at {{OUTPUT_PATH}} that covers this AC.
4. You are FORBIDDEN from editing any file under {{STEPS_DIR}}. This
   task tests scenario authorship and step REUSE. If a step you need does
   not exist, you must either rephrase the scenario to reuse what exists,
   or report that as a gap (do not silently invent).
5. Tag the feature/scenario per the canonical taxonomy in
   `gherkin-standards.md`.
6. Honor every "Forbidden Patterns" rule. `data-testid` hints in the AC
   parentheses are for the step-definition layer; they MUST NOT appear in
   your scenario text.

**Report back.** Sections A–E: discovered steps, exact `.feature` content,
step-coverage analysis, forbidden-patterns self-audit, uncertainty/gaps.
```

This template encodes the invocation prompt used in the Epic C pilot of
dsj1984/athlete-portal, where a general-purpose subagent — given only an AC and
a pointer to this skill — produced a publishable scenario on the first attempt
with **zero Forbidden-Patterns violations**, reused **4 of 5** needed steps from
the existing library, and surfaced the single remaining step as a clean, named
gap rather than inventing one. Future maintainers: resist the urge to "simplify"
this template. Its explicit grep-before-author step, the hard prohibition on
editing the steps directory, and the mandated gap-report section are what forced
those outcomes.

## 7. Cross-References

- Scenario authoring rules: `.agents/rules/gherkin-standards.md`.
- Browser-level conventions: `.agents/skills/stack/qa/playwright/SKILL.md`.
- Operator entry point: `.agents/workflows/qa-run-harness.md`.
- Evidence handoff: `.agents/workflows/helpers/epic-testing.md`.
