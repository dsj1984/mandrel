---
description: Run a clean code and maintainability audit
---

# Clean Code & Maintainability Audit

## Role

Principal Software Engineer & Code Quality Lead

## Context & Objective

You are performing a deep-dive audit into the codebase's maintainability and
quality. Your objective is to identify "code smells," technical debt, and
violations of clean code principles (SOLID, DRY, KISS) that hinder long-term
velocity.

## Step 1: Quality Scan

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Analyze the repository with a focus on:

- **Logic Complexity:** Identify functions with high cyclomatic complexity or
  deep nesting.
- **Duplication:** Find "copy-paste" logic that should be abstracted into
  reusable utilities or hooks.
- **Component Health:** In UI code, look for "component bloat" (files > 300
  lines) or missing prop validation.
- **Naming Clarity:** Flag variables like `data`, `info`, `obj`, or
  single-letter variables that obscure intent.
- **Error Handling:** Check for "silent failures" (empty catch blocks) or
  inconsistent error reporting.
- **Dead Code:** Locate unused functions, unreferenced exports, orphaned files,
  stale feature flags, commented-out code blocks, and variables that are
  assigned but never read. Cross-reference `export` statements against `import`
  usage across the project to surface modules with zero consumers.

## Step 2: Evaluation Dimensions

1. **SOLID Principles:** Are classes and functions focused? Are dependencies
   injected or hardcoded?
2. **DRY (Don't Repeat Yourself):** Is there logic repeated across multiple
   domains?
3. **KISS (Keep It Simple, Stupid):** Are there over-engineered solutions where
   a simple one would suffice?
4. **Testability:** How easy is it to unit test the current implementation? Are
   side effects isolated?
5. **Dead Code & Orphaned Modules:** Are there exported symbols with no
   importers, files unreachable from any entry point, or commented-out blocks
   that have survived multiple commits? Quantify the LOC impact.
6. **Documentation:** Does the code explain "why" through its structure, or does
   it require extensive comments?

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-clean-code-results.md`, using the exact template
below.

```markdown
# Clean Code Audit Report

## Executive Summary

[Brief overview of the codebase's maintainability index (High/Medium/Low) and
primary themes.]

## Detailed Findings

[For every gap identified, use the following strict structure:]

### [Short Title of the Issue]

- **Dimension:** [e.g., SOLID Principles | DRY | KISS | Dead Code]
- **Impact:** [High | Medium | Low]
- **Current State:** [Problematic code snippet, file, or pattern description]
- **Recommendation & Rationale:** [The specific refactor strategy and how it
  improves long-term velocity]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this refactor independently]`

## Dead Code Inventory

| File   | Symbol / Block        | Type                                                               | Estimated LOC |
| ------ | --------------------- | ------------------------------------------------------------------ | ------------- |
| [path] | [name or description] | [Unused export · Orphaned file · Commented-out block · Stale flag] | [LOC]         |

## Technical Debt Backlog

[List specific files or modules that require significant rework to meet quality
standards.]
```

## Constraint

This workflow is **read-only**. Provide the analysis and the roadmap, but do not
apply changes.
