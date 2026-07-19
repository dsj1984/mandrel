---
description: Audit test coverage gaps, flaky tests, missing assertions, and test-pyramid balance; recommend a remediation batch.
---

# Testing & Quality Assurance Audit

## Role

Principal SDET (Software Development Engineer in Test) & Quality Architect

## Context & Objective

You are performing a comprehensive, read-only audit of this repository's testing
infrastructure, test coverage, and overall quality assurance practices. Your
goal is to identify testing gaps, flaky tests, inefficient mocking strategies,
and opportunities to improve test execution speed and reliability without making
any immediate changes. Additionally, you must evaluate the implemented tests
against the Story under audit and the current codebase to ensure all quality
requirements are met and correctly documented.

**Note on Testing Responsibilities**: When evaluating test maturity, note the
established standard: Software Engineers (SWEs) must provide comprehensive unit
and integration test coverage alongside their feature implementations. The QA
Engineering function focuses on End-to-End (E2E) testing, complex system
integrations, and test environment stability.

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Execution strategy (dual-path)

This lens runs along one of two execution paths (orchestrated dynamic-workflow
or sequential single-pass). Both emit the **identical** Step 3 report contract;
downstream consumers (`audit-to-stories`) are agnostic to which path produced
it. See [`helpers/audit-dual-path.md`](helpers/audit-dual-path.md) for strategy
selection, the forcing flags, and the read-only guarantee — read `audit-<lens>`
there as this lens's name.

## Step 0 - Mode split + tool-first artifact read (mandatory)

**Resolve the mode first**, then read the numbers before judging. The two modes
do not share a Step 0 — a codebase-wide run must not try to read a Story it was
never given.

- **Story-scoped mode** (the `## Scope` block above is populated with a change
  set): read the Story under audit — its `## Goal`, inline `acceptance[]` /
  `verify[]`, and folded `## Spec` — to identify the target features, and scope
  the audit to the change set and its direct dependencies.
- **Codebase-wide mode** (the `## Scope` block renders the literal
  `{{changedFiles}}` token): there is **no Story** — do not look for one. Audit
  the whole test surface, ranked (below).

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

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

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

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-quality-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# Testing & Quality Assurance Audit

## Executive Summary

[Provide a brief overview of the current test suite health, highlighting the
primary vulnerabilities, coverage gaps, and areas causing developer friction.]

## Test Strategy Assessment

| Layer               | Status                           | Notes          |
| ------------------- | -------------------------------- | -------------- |
| Unit Testing        | [Healthy / Needs Work / Missing] | [Brief reason] |
| Integration Testing | [Healthy / Needs Work / Missing] | [Brief reason] |
| E2E Testing         | [Healthy / Needs Work / Missing] | [Brief reason] |
| Test Plans          | [Healthy / Needs Work / Missing] | [Brief reason] |

## Detailed Findings

[For every gap identified, use the following strict structure. Lead each title
with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Category:** [Flakiness | Coverage | Performance | Mocking | Test Plans]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [How the tests are currently written and why it's
  problematic]
- **Recommendation & Rationale:** [The specific testing pattern or refactor
  strategy to fix the issue]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. the new test failing before / passing after the fix, a coverage re-check, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`
```

---

## Constraint

Do NOT execute any code modifications, edit files, create branches, or **run**
the test suite (do not invoke `npm test`, a coverage run, or a mutation run —
those mutate state and cost minutes). Reading the **committed** coverage / CRAP
/ mutation artifacts under `baselines/` is explicitly permitted and required
(Step 0): citing an already-computed metric is read-only analysis, not a suite
run. Output the report and stop.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
