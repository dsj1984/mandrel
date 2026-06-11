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
against the active Epic and the current codebase to ensure all quality
requirements are met and correctly documented.

**Note on Testing Responsibilities**: When evaluating test maturity, note the
established standard: Software Engineers (SWEs) must provide comprehensive unit
and integration test coverage alongside their feature implementations. The QA
Engineering function focuses on End-to-End (E2E) testing, complex system
integrations, and test environment stability.

## Scope (Epic mode)

When this lens is invoked from `/deliver` Phase 4 (epic-audit), the
following block is populated with the Epic's change-set file list.
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

This lens runs along one of two execution paths. Both emit the **identical**
report contract (Step 3); downstream consumers (`/deliver` Phase 4
epic-audit, `audit-to-stories`) are agnostic to which path produced it.

- **Orchestrated (dynamic-workflow) path.** When Claude Code's
  [dynamic workflows](https://code.claude.com/docs/en/workflows) are
  available, the saved project workflow
  `.claude/workflows/audit-quality.workflow.js` fans the dimensions below
  out as parallel read-only subagents, runs an **adversarial cross-check**
  stage (an independent agent reviews each dimension's findings and drops
  false positives before they enter the report), then synthesises the Step 3
  report. The orchestrator derives its per-dimension prompts from *this*
  markdown at run time — the lens stays the single source of truth; the
  script does not fork a second copy of the spec.
- **Sequential (single-pass) path.** When dynamic workflows are unavailable,
  follow Steps 1–3 below turn-by-turn exactly as before. This is the default
  fallback and changes nothing about the existing behaviour.

**Strategy selection** is computed by
[`lib/dynamic-workflow/capability.js`](../scripts/lib/dynamic-workflow/capability.js)
(`selectAuditStrategy`). The orchestrated path is chosen only when the runtime
is Claude Code, `disableWorkflows` is not set (settings.json **or**
`CLAUDE_CODE_DISABLE_WORKFLOWS`), and the Claude Code version meets the
research-preview floor (`>= 2.1.154`). Any other runtime, a disabled setting,
or an older version degrades gracefully to the sequential path.

> **Capability degradation, not a contract shim.** This dual path is **not**
> covered by the No-Shim / hard-cutover rule in
> [`git-conventions.md`](../rules/git-conventions.md). That rule forbids
> running two shapes of the *same contract* side by side. Here there is **one**
> report contract; only the *execution strategy* is selected from a runtime
> capability — the same pattern the protocol already endorses for live-docs
> fallback in [`instructions.md` §1.C/§1.D](../instructions.md). The full
> capability-degradation rationale lives in the
> [`capability.js`](../scripts/lib/dynamic-workflow/capability.js) module
> docstring; the orchestrated-run evidence and per-lens cost/precision gate
> verdicts live in [`docs/roadmap.md`](../../docs/roadmap.md) (Part 3 —
> Dynamic-Workflow Orchestration).

**Forcing a path (for testing).** Set `MANDREL_AUDIT_STRATEGY=sequential` to
verify the fallback path with the feature notionally disabled, or
`MANDREL_AUDIT_STRATEGY=orchestrated` to pin the dynamic path. To exercise the
real disable signals instead, set `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (env) or
`disableWorkflows: true` in `.claude/settings.json` and re-run the lens — both
degrade to the sequential path.

> **Read-only on both paths.** The lens is read-only (see Constraint). The
> orchestrated subagents run in `acceptEdits` and inherit the session tool
> allowlist, but the workflow script grants the analysis agents only
> read/search tools (`Read`, `Grep`, `Glob`) — no write/edit/shell-mutation
> tools. The single write in an orchestrated run is the final report artifact.

## Step 0 - Project Context

1.  Read the active Epic and its child tickets to identify the current milestone
    and target features.
2.  Identify the target codebase paths for the audit.

## Step 1: Context Gathering (Read-Only Scan)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Before generating the report, silently scan the workspace for testing-related
files. Pay special attention to:

- Test configuration files (e.g., `jest.config.js`, `vitest.config.ts`,
  `playwright.config.ts`, `cypress.json`).
- Test directories and files (e.g., `__tests__/`, `spec/`, `e2e/`, `*.test.ts`,
  `*.spec.js`).
- The active Epic and its child tickets to map out expected features versus
  implemented tests.
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
6. **Requirement Alignment:** Cross-reference the features outlined in the
   active Epic to ensure they have corresponding and complete test coverage.
   Verify that the implementation found in the codebase correctly matches the
   architectural requirements and highlight any inconsistencies or gaps.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-quality-results.md`, using the exact template below.

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

[For every gap identified, use the following strict structure:]

### [Short Title of the Issue]

- **Category:** [Flakiness | Coverage | Performance | Mocking | Test Plans]
- **Impact:** [High | Medium | Low]
- **Current State:** [How the tests are currently written and why it's
  problematic]
- **Recommendation & Rationale:** [The specific testing pattern or refactor
  strategy to fix the issue]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`
```

---

## Constraint

Do NOT execute any code modifications, edit files, create branches, or run the
test suite. This is strictly a read-only analysis. Output the report and stop.
