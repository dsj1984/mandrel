---
description: Audit architectural boundaries, module coupling, and layering violations; emit a structured findings report keyed to High/Medium/Low severity.
---

# Architecture & Clean Code Audit

## Role

Staff Software Engineer & Architecture Reviewer

## Context & Objective

You are performing a comprehensive, read-only architectural and clean-code
review of this codebase. Your goal is to identify areas of unnecessary
abstraction, premature optimization, high cognitive load, and over-engineering.
You must prioritize maintainability and readability without altering any
existing external APIs or business logic.

## Step 1: Context Gathering (Read-Only Scan)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Before generating the report, silently scan the core application logic. Pay
special attention to:

- Domain/Business logic layers (e.g., services, use cases, managers).
- Utility and shared folders (e.g., `utils/`, `helpers/`, `shared/`).
- Data access patterns and component hierarchies.
- Complex or heavily modified files (look for large file sizes or deeply nested
  directory structures).

## Step 2: Analysis Dimensions

Evaluate the gathered context against the following clean code dimensions:

1. **Over-Engineering & Abstractions:** Identify "dry-run" complexity, premature
   optimizations, or interfaces/classes that add boilerplate without clear value
   (e.g., interfaces with only one implementation).
2. **Cognitive Load & Nesting:** Pinpoint deeply nested logic (arrow code),
   massive functions violating the Single Responsibility Principle (SRP), or
   excessive cyclomatic complexity.
3. **Dead Code & Redundancy:** Locate unused exports, redundant utility
   functions that duplicate standard library features, or obsolete commented-out
   code blocks.
4. **Naming & Self-Documentation:** Find poorly named variables/functions,
   inconsistent naming conventions, or areas that rely heavily on comments to
   explain _what_ the code does rather than _why_.
5. **Coupling & Cohesion:** Spot tight coupling between modules that should be
   independent or god-objects handling too many concerns.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-architecture-results.md`, using the exact template
below.

```markdown
# Architecture & Clean Code Review

## Executive Summary

[Provide a brief overview of the codebase's health, highlighting the primary
architectural pain points and areas for simplification.]

## Triage Summary

### Quick Wins (Low Effort, High Impact)

- [List 2–3 immediate, safe refactors — e.g., deleting dead code, renaming
  variables, extracting simple utilities.]

### Structural Changes (Medium/High Effort, Architectural Impact)

- [List 2–3 larger refactors — e.g., decoupling services, flattening complex
  module hierarchies, removing unnecessary design patterns.]

## Detailed Findings

[For every gap identified, use the following strict structure:]

### [Short Title of the Issue]

- **Category:** [Quick Win | Structural Change]
- **Dimension:** [e.g., Cognitive Load & Nesting]
- **Current State:** [The specific file/function and why it is problematic]
- **Recommendation & Rationale:** [The specific refactor strategy and how it
  improves readability or maintainability]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this refactor independently. Must explicitly state NOT to change external APIs.]`
```

---

## Constraint

Do NOT execute any code modifications, edit files, create branches, or implement
changes. This is strictly a read-only analysis. Ensure all recommendations
preserve existing functionality and external APIs. Output the report and stop.
