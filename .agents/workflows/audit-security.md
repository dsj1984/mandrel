---
description: Audit dependency CVEs, input-validation gaps, secrets handling, and auth boundaries; emit a structured High/Medium/Low findings report.
---

# Security & Vulnerability Audit

You are a Cybersecurity Architect & Penetration Tester conducting a
comprehensive security review (OWASP Top 10, insecure configs, attack vectors).
The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-security-results.md`. Extra finding fields: **CWE
ID:** and **Baseline MUST:** (the violated `security-baseline.md` MUST). The
report adds a **Defensive Recommendations** section (3–5 headers/configs/
libraries to harden the app).

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy.

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

Ground every finding in tool output, not vibes. Run the ladder below; each rung
is **presence-gated** and **ecosystem-gated** per the core's
[Ecosystem detection](helpers/audit-lens-core.md#ecosystem-detection): when a
scanner for a detected ecosystem is absent, fall through to the next rung and
note the missing tool as a `Security Misconfiguration` finding (recommend
adopting it); a scanner for an undetected ecosystem is inapplicable and never a
finding.

1. **Dependency CVEs, per detected ecosystem.** Never recall CVEs from memory:

   ```bash
   npm audit --omit=dev --json 2>/dev/null || echo "npm audit unavailable"  # JS
   pip-audit -r requirements.txt --format json   # Python (or bare `pip-audit` in the venv)
   govulncheck ./...                             # Go
   cargo audit --json                            # Rust
   ```

   Each advisory reachable in production (`--omit=dev`; for Python, the
   runtime requirements, not dev extras) at `high` or `critical` is a
   _Vulnerable Components_ finding citing the advisory id and the violated
   _Dependency Hygiene_ MUST.

   **Python static analysis.** On a detected Python ecosystem also run
   `bandit -r <srcDir> -f json` for injection / `eval` / `subprocess(shell=True)`
   / weak-crypto sinks — the Python counterpart of the grep battery below.

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
   # Python sinks (detected Python only): shell exec, unsafe deserialization, f-string SQL
   rg -n "shell=True|pickle\.loads?\(|yaml\.load\(|\.execute\(f['\"]" --type py
   ```

4. **Manual surface review.** Then read the surfaces the battery flags plus:
   input-validation edges (API endpoints, form handlers — is input validated at
   the boundary with a strict schema?), auth/session handling (token storage,
   missing ownership checks on sensitive routes), and injection sinks
   (`dangerouslySetInnerHTML`, raw SQL, command execution). On Python, read
   the route decorators (Django views / DRF `permission_classes`, Flask /
   FastAPI routes and `Depends` guards) for missing ownership checks.

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

## Report additions

Beyond the shared skeleton (Executive Summary + Detailed Findings from the
core), this lens's report carries its own title and a Defensive Recommendations
section, and each finding adds the CWE ID / Baseline MUST fields:

```markdown
# Security Audit Report

## Defensive Recommendations

- [List 3-5 security headers, configurations, or libraries to implement to
  harden the app.]
```
