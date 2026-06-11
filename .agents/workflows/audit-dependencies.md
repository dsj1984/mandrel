---
description: Audit `package.json` for unused, outdated, and major-version-stale dependencies; surface Node-engine drift and propose upgrade batches.
---

# Dependency Update Audit

## Role

DevOps Engineer & Security Researcher

## Context & Objective

Manage the lifecycle of project dependencies. Your goal is to identify outdated,
vulnerable, or bloated packages and suggest a safe upgrade path that maintains
system stability.

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

## Step 1: Inventory & Stale Check

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

1. Run `npm outdated` (or equivalent for the package manager) to see which
   packages are behind.
2. Identify "stale" dependencies (packages with no updates for >1 year).
3. Check for "bloat" — large dependencies that could be replaced by smaller
   alternatives or native code.

## Step 2: Vulnerability Scan

1. Run `npm audit` to find security vulnerabilities.
2. Cross-reference critical dependencies with known CVE databases if necessary.
3. Highlight any peer dependency conflicts that might arise from upgrades.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-dependencies-results.md`, using the exact template
below.

```markdown
# Dependency Audit Report

## Health Summary

- **Outdated Packages:** [Count]
- **Vulnerabilities:** [Critical: #, High: #, Mod: #]

## Detailed Findings

[For every security fix or major update identified, use the following strict
structure:]

### [Package Name Update]

- **Dimension:** [Security Fix | Major Upgrade | Removal]
- **Impact:** [High | Medium | Low]
- **Current State:** [Current vs Target version and reason for update]
- **Recommendation & Rationale:** [How to perform the update and potential
  breaking changes to watch for]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this update independently (e.g., npm install package@version)]`

## Recommended Removals/Replacements

- Replace `[heavy-library]` with `[light-library]` or native `[browser-api]`.
```

## Constraint

This is a **read-only** evaluation. Do not run `npm install` or `npm update`
unless explicitly requested by the user after reviewing this report.
