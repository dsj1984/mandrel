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

## Step 0: Tool-first detection (mandatory — measure before you judge)

Ground the maintainability, duplication, and dead-code findings in the exact
instruments this repo ships, then let the LLM triage in Steps 1–2 interpret and
rank the numbers. Do **not** eyeball complexity or "spot" dead code from prose —
run the tools first.

1. **Complexity / maintainability (scoped mode).** When a change-set is in
   scope, run the quality preview against the base:

   ```bash
   node .agents/scripts/quality-preview.js --changed-since <base>
   ```

   It reports the per-file maintainability-index and complexity deltas the
   `check-baselines.js` gate enforces. Treat any per-file MI drop beyond
   `delivery.quality.gates.maintainability.tolerance` (default 0.5pt) as a
   grounded must-fix finding, and any cyclomatic reading over the
   `codingGuardrails` ceilings (flag > 8, must-fix > 12) as measured, not
   guessed.

2. **Committed baselines (codebase-wide mode).** Read the committed metric
   baselines under `baselines/` — `baselines/maintainability.json`,
   `baselines/duplication.json`, `baselines/crap.json`,
   `baselines/dead-exports.json` — and cite the outlier rows as evidence
   rather than re-deriving them. These are the same artifacts the delivery
   gates read, so a finding that quotes a baseline row is reproducible.

3. **Duplication.** Run the shipped duplication checker
   (`node .agents/scripts/check-baselines.js --gate duplication`, backed by
   jscpd) and lift its clone clusters into the DRY dimension.

4. **Dead code.** Run the shipped dead-export checker
   (`node .agents/scripts/check-dead-exports.js`); it is backed by `knip`.
   **`knip --production` is a silent no-op unless entry points are declared
   with `!`-suffixed patterns** — a run that reports `{"issues":[]}` without
   `!`-suffixed entries has measured nothing, so verify the entry config before
   trusting a clean result. Apply the **dead-code exclusion taxonomy** below so
   the report does not drown real dead code in false positives:

   - **Entry points** — CLI mains, `bin/` scripts, and files named in
     `package.json` `main` / `exports` / `bin`: reachable by definition, never
     dead.
   - **Public API surface** — exports that are the package's declared
     `exports` / barrel contract: consumed out-of-tree, so a zero in-repo
     importer count is not death.
   - **Dynamic imports** — symbols reached via `import()`,
     `require(variable)`, or string-keyed dispatch tables: invisible to static
     export-graph analysis, so exclude unless you confirm no dynamic reference.
   - **Test-only seams** — exports consumed only by tests (the sanctioned
     `test-seams` pattern): flag as test-only, not dead, and never as a
     production-dead finding.
   - **Framework/registration hooks** — decorators, lifecycle listeners, and
     files auto-loaded by convention (globbed listener/plugin dirs): reachable
     via the framework, not the import graph.

5. **Churn-by-complexity hotspot cap.** Rank candidate hotspots by
   **churn × complexity** (frequently-changed files that also score poorly on
   MI/CRAP) and **cap the Detailed Findings at the top ~15 hotspots** so the
   report stays a ranked, actionable batch rather than an exhaustive dump. Note
   the cap in the Executive Summary when it bites.

## Step 1: Quality Scan

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Analyze the repository with a focus on:

- **Logic Complexity:** Apply the cyclomatic / Maintainability-Index ceilings
  from
  [`helpers/code-quality-guardrails.md`](helpers/code-quality-guardrails.md):
  cyclomatic complexity > 8 (`delivery.quality.codingGuardrails.cyclomaticFlag`)
  is **flag in review** (annotate or split); > 12
  (`codingGuardrails.cyclomaticMustFix`) is **must-fix** before the work merges.
  A per-file MI drop beyond the configured
  `delivery.quality.gates.maintainability.tolerance` (default 0.5pt) requires
  a refactor in the same Story rather than a baseline bump.
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

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# Clean Code Audit Report

## Executive Summary

[Brief overview of the codebase's maintainability index (High/Medium/Low) and
primary themes.]

## Detailed Findings

[For every gap identified, use the following strict structure. Lead each title
with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [e.g., SOLID Principles | DRY | KISS | Dead Code]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [Problematic code snippet, file, or pattern description]
- **Recommendation & Rationale:** [The specific refactor strategy and how it
  improves long-term velocity]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. a duplication re-check, `npm test`, or a re-run of this lens]
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

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
