---
description: Audit test coverage gaps, flaky tests, missing assertions, and test-pyramid balance; recommend a remediation batch.
---

# Testing & Quality Assurance Audit

You are a Principal SDET & Quality Architect auditing the repository's testing
infrastructure, coverage, flaky tests, mocking strategy, and test-pyramid
balance — and, in Story-scoped mode, evaluating the implemented tests against
the Story under audit. The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-quality-results.md`. Each finding carries a
**Category:** (`Flakiness | Coverage | Performance | Mocking | Test Plans`); the
report adds a **Test Strategy Assessment** table (Unit / Integration / E2E /
Test Plans / Property-Based Testing: Healthy / Needs Work / Missing, or `N/A`
for Property-Based Testing when no module is a candidate).

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy.

## Step 0 - Mode split + tool-first artifact read (mandatory)

**Resolve the mode first**, then read the numbers before judging. The two modes
do not share a Step 0 — a codebase-wide run must not try to read a Story it was
never given.

- **Story-scoped mode** (the change-set fence is populated with a change set):
  read the Story under audit — its `## Goal`, inline `acceptance[]` /
  `verify[]`, and folded `## Spec` — to identify the target features, and scope
  the audit to the change set and its direct dependencies.
- **Codebase-wide mode** (the fence renders the literal `{{changedFiles}}`
  token): there is **no Story** — do not look for one. Audit the whole test
  surface, ranked (below).

**Read the committed test-quality artifacts as evidence** (both modes). This
lens grounds every coverage/quality claim in the metrics the delivery gates
already compute and commit, rather than prose-scanning the tests:

- `baselines/coverage.json` — per-file line/branch coverage. Cite the covered
  ratio for any file you flag as under-tested.
- `baselines/crap.json` — the CRAP score (complexity × uncoveredness). A high
  CRAP row is a measured "complex **and** under-tested" hotspot — the single
  strongest coverage-gap signal.
- `baselines/mutation.json` — mutation-testing survivors where present: tests
  that execute code without asserting on it (coverage without confidence).

**Rank churn-by-coverage.** Order candidate findings by **churn × coverage
gap** — frequently-changed files (`git log --format= --name-only -n 200 | sort
| uniq -c | sort -rn`) that also score low coverage / high CRAP are the
highest-value gaps. Lead the report with them; cap the Detailed Findings at the
top hotspots so the output is an actionable batch, not an exhaustive dump.

**Anchor the rubric** to [`rules/testing-standards.md`](../rules/testing-standards.md):
the three-tier pyramid, assertion-placement, and mocking/isolation MUSTs are the
standard a finding is measured against — cite the rule the test violates rather
than asserting a bare opinion.

Reading these committed artifacts is **read-only** and explicitly permitted (see
the Constraint) — it is not "running the suite".

## Step 1: Context Gathering (Read-Only Scan)

Before generating the report, silently scan the workspace for testing-related
files. Pay special attention to:

- Test configuration files (e.g., `jest.config.js`, `vitest.config.ts`,
  `playwright.config.ts`, `cypress.json`).
- Test directories and files (e.g., `__tests__/`, `spec/`, `e2e/`, `*.test.ts`,
  `*.spec.js`).
- The Story's `acceptance[]` / `verify[]` arrays, to map expected behaviour
  versus implemented tests.
- Mocking and stubbing setups (e.g., `__mocks__/`, `setupTests.js`, MSW
  handlers).
- CI/CD workflow files to understand how and when tests are executed.

## Step 2: Analysis Dimensions

Evaluate the gathered context against the following test quality dimensions:

1. **Coverage vs. Confidence:** Identify areas with missing tests (unit,
   integration, or E2E) or tests that assert trivial things while missing core
   business logic.
2. **Test Fragility & Flakiness:** Spot patterns that lead to flaky tests, such
   as reliance on hardcoded timeouts (`sleep`), improper handling of
   asynchronous code, or shared mutable state between tests.
3. **Mocking & Stubbing Strategy:** Identify over-mocked tests that test
   implementation details rather than behavior, or missing mocks that cause
   tests to inadvertently hit external networks/APIs.
4. **Test Data Management:** Look for hardcoded test data, lack of proper
   setup/teardown (`beforeEach`/`afterEach`), or test pollution.
5. **Performance & Execution:** Find bottlenecks in the test suite, such as
   unnecessary serial execution, heavy setup running too frequently, or
   opportunities for parallelization.
6. **Requirement Alignment:** Cross-reference the Story's `acceptance[]`
   criteria to ensure they have corresponding and complete test coverage.
   Verify that the implementation found in the codebase correctly matches the
   architectural requirements and highlight any inconsistencies or gaps.
7. **Unwired Seams — Coverage Without a Caller (mandatory).** Report code the
   suite **covers** but no live production path **calls**. This is the blind spot
   this dimension exists for, and it is a property of the suite, not of the code:
   a seam with its own passing unit test reports as covered, contributes to the
   coverage number, and is never exercised in assembly — so the suite reads green
   over wiring that has never run once. High coverage is therefore not evidence
   of a live path; it is what conceals a dead one. Cover at least:

   - **A produced-but-never-consumed artifact** — a field, file, or marker the
     code writes that no test and no consumer ever reads back. A writer test that
     asserts on the writer's own output is not a reader.
     `assert(written === expected)` proves the write, never the round-trip.
   - **An optional field nothing populates** — a parameter or config key a
     consumer branches on that only *tests* ever set. The suite covers both
     branches; production has only ever taken the default.

   For each, name the missing test rather than the missing caller: the gap is
   that **no test would fail if the wiring were deleted**. That is the assertion
   to recommend — an integration-tier test that drives the real production entry
   point and fails when the seam is unwired. Grade a dead guard/gate **High** or
   **Critical** (the enforcement has never been in force and the bar reads green
   because it never runs), other dead wiring **Medium**. The core's exclusion
   list still applies: a sanctioned test seam or a declared entry point is not a
   finding here. Route the *architectural* framing of the same defect to
   [`audit-architecture`](audit-architecture.md)'s Shipped-But-Never-Wired
   dimension; this lens owns the **missing-test** framing.
8. **Property-Based Coverage — Invariants Tested Only by Examples.** Flag a
   module whose correctness rests on an invariant but whose tests are all
   hand-picked examples, which structurally cannot reach the inputs nobody
   thought to pick. A module is a candidate **only** on code evidence: a
   documented invariant or "never"/"always" claim in a header comment; an
   explicit state machine or status/label transition table; an
   encode/decode, parse/serialize or normalise pair (round-trip); a
   merge/dedup/sort/scheduler function; bounded-concurrency or retry
   coordination over async I/O; or an idempotency claim. A module with no
   stated or implied invariant is **never** a finding. Rank candidates by
   Step 0's churn × coverage gap and cite their `baselines/` coverage/CRAP row
   where one exists.

   - **Toolchain by ecosystem, never one library.** Detect an existing
     property-testing library from the consumer's manifests (e.g.
     `fast-check` for JS/TS, `hypothesis` for Python, `proptest`/`quickcheck`
     for Rust, `jqwik` for the JVM, `rapid`/`gopter` for Go); recommend the
     ecosystem-idiomatic one only when none is present.
   - Severity: an async/concurrency coordinator, or a guard whose
     invariant protects an irreversible write, tested only by examples →
     **High**; any other invariant-bearing module with example-only tests →
     **Medium**; toolchain absent with no High/Medium candidate → **one Low**
     roll-up finding, not one per module.
   - Category: file under `Coverage`. A property test whose seed is
     neither pinned nor printed on failure goes under `Flakiness`: a red that
     cannot be reproduced breaks the reproducibility the rubric demands.
   - **Name the property.** Each finding states the invariant as a testable
     property (e.g. `decode(encode(x)) === x`; "no transition leaves a
     terminal state") plus its generator shape (the input domain to draw
     from) — never a bare "add property tests".

## Constraint (lens-specific carve-out)

Do NOT **run** the test suite (do not invoke `npm test`, a coverage run, or a
mutation run — those mutate state and cost minutes). Reading the **committed**
coverage / CRAP / mutation artifacts under `baselines/` is explicitly permitted
and required (Step 0): citing an already-computed metric is read-only analysis,
not a suite run.

## Report additions

Beyond the shared skeleton (Executive Summary + Detailed Findings from the
core), this lens's report carries its own title and a Test Strategy Assessment
table:

```markdown
# Testing & Quality Assurance Audit

## Test Strategy Assessment

| Layer                  | Status                                 | Notes          |
| ---------------------- | -------------------------------------- | -------------- |
| Unit Testing           | [Healthy / Needs Work / Missing]       | [Brief reason] |
| Integration Testing    | [Healthy / Needs Work / Missing]       | [Brief reason] |
| E2E Testing            | [Healthy / Needs Work / Missing]       | [Brief reason] |
| Test Plans             | [Healthy / Needs Work / Missing]       | [Brief reason] |
| Property-Based Testing | [Healthy / Needs Work / Missing / N/A] | [Brief reason] |
```

`Property-Based Testing` reads `N/A` when the repo has no candidate module
(dimension 8), so a repo with no invariant-bearing code is not nagged.
