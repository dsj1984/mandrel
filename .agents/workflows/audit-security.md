---
description: Audit dependency CVEs, input-validation gaps, secrets handling, and auth boundaries; emit a structured High/Medium/Low findings report.
---

# Security & Vulnerability Audit

## Role

Cybersecurity Architect & Penetration Tester

## Context & Objective

Conduct a comprehensive security review of the codebase. Your goal is to
identify common vulnerabilities (OWASP Top 10), insecure configurations, and
potential attack vectors.

## Scope (Epic mode)

When this lens is invoked from `/epic-deliver` Phase 4 (epic-audit), the
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
