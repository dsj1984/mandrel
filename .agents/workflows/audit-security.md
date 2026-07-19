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

## Rubric — `rules/security-baseline.md` is the contract

This lens does **not** grade against recalled OWASP lore. The authoritative
rubric is [`../rules/security-baseline.md`](../rules/security-baseline.md) — the
project's inviolable security MUSTs (Input Validation, Authentication,
Authorization, Output & Rendering, Data Leakage & Logging, Transport & Headers,
Secrets Management, Dependency Hygiene). Read it first. **Every finding MUST
name the specific `security-baseline.md` MUST it violates** (e.g. "violates
_Secrets Management_: 'Fallback or placeholder secrets MUST NOT be committed'").
A finding that cannot be tied to a baseline MUST — or to a CWE where the
baseline is silent — is out of scope for this lens.

## Step 1: Detection Battery (Tool-First, Read-Only)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Ground every finding in tool output, not vibes. Run the ladder below; each rung
is **presence-gated** — when a scanner is absent, fall through to the next rung
and note the missing tool as a `Security Misconfiguration` finding (recommend
adopting it).

1. **Dependency CVEs (`npm audit`).** Never recall CVEs from memory:

   ```bash
   npm audit --omit=dev --json 2>/dev/null || echo "npm audit unavailable"
   ```

   Each advisory reachable in production (`--omit=dev`) at `high` or `critical`
   is a _Vulnerable Components_ finding citing the advisory id and the violated
   _Dependency Hygiene_ MUST.

2. **Secret scanning (`gitleaks` / `trufflehog`), with a grep fallback.** When
   `gitleaks` is installed, prefer it:

   ```bash
   command -v gitleaks >/dev/null 2>&1 && gitleaks detect --no-banner --redact -v || \
     command -v trufflehog >/dev/null 2>&1 && trufflehog filesystem . --no-update || \
     echo "no secret scanner installed — running the grep battery below"
   ```

3. **Grep battery (deterministic fallback / augmentation).** Run these
   regardless — they are cheap and catch what a scanner's ruleset may miss:

   ```bash
   # Hardcoded key material (violates Secrets Management)
   rg -n -i "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}" --glob '!**/*.test.*'
   # eval / exec sinks (violates Output & Rendering)
   rg -n "\b(eval|new Function|child_process\.exec|execSync)\s*\(" --glob '!**/*.test.*'
   # Template-literal SQL (violates Output & Rendering — parameterize)
   rg -n "(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\$\{" -i
   # Committed .env with real values (violates Secrets Management)
   git ls-files | rg "(^|/)\.env($|\.)" | rg -v "\.env\.example$"
   ```

4. **Manual surface review.** Then read the surfaces the battery flags plus:
   input-validation edges (API endpoints, form handlers — is input validated at
   the boundary with a strict schema?), auth/session handling (token storage,
   missing ownership checks on sensitive routes), and injection sinks
   (`dangerouslySetInnerHTML`, raw SQL, command execution).

## Step 2: Evaluation Dimensions

Grade each finding against the `security-baseline.md` MUST it breaks (and the
CWE where one applies):

1. **Injection:** SQL, NoSQL, OS Command, and Cross-Site Scripting (XSS) —
   _Output & Rendering_.
2. **Broken Access Control:** Can a user access data they don't own? —
   _Authorization_.
3. **Cryptographic Failures:** Is sensitive data (passwords, PII) hashed or
   encrypted using modern standards? — _Authentication_ / _Data Leakage &
   Logging_.
4. **Security Misconfiguration:** Are there default passwords, verbose error
   messages in production, or insecure headers? — _Transport & Headers_.
5. **Vulnerable Components:** Are outdated libraries introducing risks? —
   _Dependency Hygiene_.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-security-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# Security Audit Report

## Executive Summary

[Overview of the risk profile (Critical/High/Medium/Low) and overarching
security posture.]

## Detailed Findings

[For every vulnerability identified, use the following strict structure. Lead
each title with the primary file the vulnerability lives in:]

### `path/to/primary-file.ext` — [Short title of the vulnerability]

- **Dimension:** [e.g., Injection | Broken Access Control]
- **Severity:** [Critical | High | Medium | Low]
- **CWE ID:** [e.g., CWE-89 for SQL Injection]
- **Baseline MUST:** [the violated `security-baseline.md` MUST — e.g. "Secrets Management: fallback secrets MUST NOT be committed"]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [Technical explanation of the flaw and its location]
- **Recommendation & Rationale:** [Step-by-step fix and defensive hardening
  strategy]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. the exploit no longer reproducing, an added regression test, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this remediation independently]`

## Defensive Recommendations

- [List 3-5 security headers, configurations, or libraries to implement to
  harden the app.]
```

## Constraint

This is a **read-only** audit. Your priority is accuracy and clear impact
assessment. Do not attempt to exploit the system or modify code.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
