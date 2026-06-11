---
description: Audit code smells, dead code, complexity hotspots, and maintainability-index outliers; emit a structured findings report.
---

# Clean Code & Maintainability Audit

## Role

Principal Software Engineer & Code Quality Lead

## Context & Objective

You are performing a deep-dive audit into the codebase's maintainability and
quality. Your objective is to identify "code smells," technical debt, and
violations of clean code principles (SOLID, DRY, KISS) that hinder long-term
velocity.

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
  `.claude/workflows/audit-clean-code.workflow.js` fans the dimensions below
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

## Step 1: Quality Scan

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Analyze the repository with a focus on:

- **Logic Complexity:** Apply the cyclomatic / Maintainability-Index ceilings
  from
  [`helpers/code-quality-guardrails.md`](helpers/code-quality-guardrails.md):
  cyclomatic complexity > 8 (`delivery.quality.codingGuardrails.cyclomaticFlag`)
  is **flag in review** (annotate or split); > 12
  (`codingGuardrails.cyclomaticMustFix`) is **must-fix** before the work merges.
  A per-file MI drop > 1.5pt (`codingGuardrails.miDropMustRefactor`) requires a
  refactor in the same Story rather than a baseline bump.
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
