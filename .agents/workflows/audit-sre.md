---
description: "Audit production-readiness for a release candidate: SLOs, observability, runbooks, error budgets, and rollback paths."
---

# Production Release Candidate Audit

## Role

Senior Site Reliability Engineer (SRE) & Lead Developer

## Context & Objective

You are conducting a rigorous, read-only final code audit for a production
release candidate. Your goal is to surface critical risks across configuration
integrity, security, observability, and code quality — providing a prioritized,
actionable report that can be handed off for remediation before deployment.

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

## Step 1: Context Gathering (Read-Only Scan)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Before generating the report, silently scan the workspace. Pay special attention
to:

- Application configuration files (e.g., `site.config.ts`, `.env.example`,
  `wrangler.toml`, `app.config.ts`).
- Source files for hardcoded values (strings resembling secrets, IDs, or
  environment-specific data).
- Error handling patterns across services, API routes, and background jobs.
- `package.json` for unused, deprecated, or overly heavy dependencies.
- Any debugging artifacts likely introduced during development.

## Step 2: Analysis Dimensions

Evaluate the gathered context against the following production-readiness
criteria:

### 1. Configuration Architecture

- **Config Integrity:** Audit the application config to ensure it defines a
  clear schema for all variable/environment-specific data.
- **Hardcoding Scan:** Scan components, utils, and services for any hardcoded
  values that should come from config or environment variables (e.g., API URLs,
  feature flags, region/locale data, identifiers).
- **Fallback Logic:** Verify how the app behaves if a required config value is
  missing — does it fail gracefully or crash silently?

### 2. Security & Secrets Management

- **Secret Leaks:** Check for hardcoded API keys, tokens, or credentials
  committed to source. Ensure all secrets use environment variables.
- **Input Sanitization:** Identify potential XSS or injection vectors,
  particularly where user input or URL parameters are reflected in the DOM or
  database.
- **Dependency Risks:** Flag obviously deprecated, unmaintained, or unused heavy
  dependencies in `package.json`.

### 3. Error Handling & Observability

- **Console Hygiene:** Identify debugging artifacts (`console.log`, `debugger`,
  commented-out test code) that must be removed before release.
- **Error Swallowing:** Flag empty `catch` blocks or places where errors are
  silently ignored rather than logged or re-thrown.
- **Boundary Handling:** Ensure the app handles unexpected or invalid inputs
  (e.g., bad URL params, missing DB records) with appropriate error responses.

### 4. Code Quality & Performance

- **Dead Code:** Identify unused variables, imports, functions, or unreachable
  code blocks.
- **Complexity:** Highlight logic with high cyclomatic complexity (deeply nested
  `if/else`, massive switch statements) that violates DRY principles.
- **Asset Loading:** Flag synchronous heavy operations or unoptimized asset
  loading patterns that could hurt Core Web Vitals or API response times.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-sre-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# Production Release Candidate Audit

## Executive Summary

[A brief overview of the release candidate's health. Highlight the most critical
risks that must be resolved before deployment.]

## Detailed Findings

[Group findings by the categories below. Use this structure for each item.
Lead each title with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Category:** [Configuration | Security | Observability | Code Quality]
- **Severity:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [What exists and why it's a risk]
- **Recommendation:** [The specific fix and rationale]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. `npm test`, a grep that now returns empty, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`

## Release Readiness Checklist

| Category                | Status                     |
| ----------------------- | -------------------------- |
| Configuration Integrity | ✅ Clear / ⚠️ Issues Found |
| Security & Secrets      | ✅ Clear / ⚠️ Issues Found |
| Error Handling          | ✅ Clear / ⚠️ Issues Found |
| Code Quality            | ✅ Clear / ⚠️ Issues Found |
```

---

## Constraint

Do NOT generate code fixes, edit files, or create branches. This is strictly a
read-only analysis. Output the report and stop.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
