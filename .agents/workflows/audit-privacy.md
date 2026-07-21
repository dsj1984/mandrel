---
description: Audit logs, telemetry, and persistence paths for PII leakage and retention violations; surface secrets exposure and consent gaps.
---

# Privacy and PII Data Audit

You are a Data Privacy Officer & Security Engineer finding accidental logging,
insecure storage, or unnecessary collection of PII, and checking GDPR/CCPA
compliance. The shared lens machinery — read-only constraint, scope
interpretation, report envelope + finding-block skeleton, severity scale,
self-cross-check, and execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-privacy-results.md`. This lens labels the severity
axis **Impact** and uses dimension values `Leaky Log | Insecure Storage | Data
Over-collection`; its report adds a **Privacy Scorecard** section (Data
Encryption / Logging Safety / Minimization: Pass/Fail/Partial).

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Step 1: Sink-First Detection

A PII leak is a **source → sink** flow: sensitive data reaching an egress point.
Enumerate the **sinks** first, then trace which ones receive PII. Report only
**proven flows** — a sink that never touches a PII source is not a finding.

1. **Enumerate the sinks.** Run these verbatim `rg` commands (they anchor every
   finding to a real line):

   ```bash
   # Logging sinks
   rg -n "\b(console\.(log|info|warn|error|debug)|logger\.(info|warn|error|debug|log))\s*\(" --glob '!**/*.test.*'
   # Telemetry / analytics sinks
   rg -n "\b(track|capture|analytics|telemetry|reportEvent|Sentry\.(captureException|captureMessage))\s*\(" --glob '!**/*.test.*'
   # Persistence sinks
   rg -n "\b(localStorage|sessionStorage|\.set\(|db\.(insert|update|save)|prisma\.\w+\.(create|update|upsert))\b" --glob '!**/*.test.*'
   # Outbound-HTTP sinks (PII in URLs / bodies / headers)
   rg -n "\b(fetch|axios|http\.request|got|ky)\s*\(" --glob '!**/*.test.*'
   ```

2. **Secret scan.** Prefer `gitleaks`; fall back to `rg`:

   ```bash
   command -v gitleaks >/dev/null 2>&1 && gitleaks detect --no-banner --redact -v || \
     rg -n -i "(api[_-]?key|secret|password|token|salt)\s*[:=]\s*['\"][^'\"]{8,}" --glob '!**/*.test.*'
   ```

3. **Trace PII sources to the enumerated sinks.** PII source tokens to follow:
   `email`, `password`, `token`, `phone`, `address`, `ssn`, `dob`, `ip`,
   `fullName`, `firstName`/`lastName`, `creditCard`, `user` object spreads. For
   each sink from step 1, decide whether a PII source reaches it (directly, or
   via a variable/object logged whole). Only a **proven** source→sink flow
   becomes a finding; cite both the source line and the sink line.

## Step 2: Analysis Dimensions

Evaluate the codebase against these privacy pillars:

1. **Data Minimization:** Is the application collecting more PII than strictly
   necessary for its functions?
2. **Leaky Logging:** Are sensitive objects being logged to stdout/stderr or
   external logging services?
3. **Insecure Transmission:** Is PII sent over non-TLS connections or via GET
   parameters?
4. **Hardcoded Secrets:** Are there any API keys, salts, or credentials stored
   in plain text?
5. **Consent & Retention:** Check for logic related to data deletion (Right to
   be Forgotten) and consent management.
