---
description: Audit dependency CVEs, input-validation gaps, secrets handling, and auth boundaries; emit a structured High/Medium/Low findings report.
command: false
---

# Security & Vulnerability Audit

## Role

Cybersecurity Architect & Penetration Tester

## Context & Objective

Conduct a comprehensive security review of the codebase. Your goal is to
identify common vulnerabilities (OWASP Top 10), insecure configurations, and
potential attack vectors.

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
  `.claude/workflows/audit-security.workflow.js` fans the dimensions below
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

## Step 1: Vulnerability Surface Analysis

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Scan the codebase for:

- **Input Validation:** Check where user input enters the system (API endpoints,
  forms). Is it sanitized/validated?
- **Injection Risks:** Search for raw SQL queries, `dangerouslySetInnerHTML`,
  `eval()`, or command execution logic.
- **Authentication/Authorization:** Review how sessions/tokens are handled. Are
  there missing checks on sensitive routes?
- **Dependency Security:** Check `package.json` for known-vulnerable versions of
  libraries.
- **Secret Management:** Scan for `.env` files in git, hardcoded keys, or
  exposed credentials.

## Step 2: Evaluation Dimensions

1. **Injection:** SQL, NoSQL, OS Command, and Cross-Site Scripting (XSS).
2. **Broken Access Control:** Can a user access data they don't own?
3. **Cryptographic Failures:** Is sensitive data (passwords, PII) hashed or
   encrypted using modern standards?
4. **Security Misconfiguration:** Are there default passwords, verbose error
   messages in production, or insecure headers?
5. **Vulnerable Components:** Are outdated libraries introducing risks?

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-security-results.md`, using the exact template below.

```markdown
# Security Audit Report

## Executive Summary

[Overview of the risk profile (Critical/High/Medium/Low) and overarching
security posture.]

## Detailed Findings

[For every vulnerability identified, use the following strict structure:]

### [Short Title of the Vulnerability]

- **Dimension:** [e.g., Injection | Broken Access Control]
- **Severity:** [Critical | High | Medium | Low]
- **CWE ID:** [e.g., CWE-89 for SQL Injection]
- **Current State:** [Technical explanation of the flaw and its location]
- **Recommendation & Rationale:** [Step-by-step fix and defensive hardening
  strategy]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this remediation independently]`

## Defensive Recommendations

- [List 3-5 security headers, configurations, or libraries to implement to
  harden the app.]
```

## Constraint

This is a **read-only** audit. Your priority is accuracy and clear impact
assessment. Do not attempt to exploit the system or modify code.
