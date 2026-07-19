---
description: Audit logs, telemetry, and persistence paths for PII leakage and retention violations; surface secrets exposure and consent gaps.
---

# Privacy and PII Data Audit

## Role

Data Privacy Officer & Security Engineer

## Context & Objective

You are conducting a privacy audit to identify potential mishandling of
Personally Identifiable Information (PII) and ensure compliance with data
protection standards (GDPR, CCPA). Your goal is to find accidental logging,
insecure storage, or unnecessary collection of sensitive data.

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

## Step 1: Sink-First Detection

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

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

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-privacy-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# Privacy & PII Audit Report

## Executive Summary

[Overview of the privacy posture and critical risks identified.]

## Privacy Scorecard

- **Data Encryption:** [Pass/Fail/Partial]
- **Logging Safety:** [Pass/Fail/Partial]
- **Minimization:** [Pass/Fail/Partial]

## Detailed Findings

[For every gap identified, use the following strict structure. Lead each title
with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [Leaky Log | Insecure Storage | Data Over-collection]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [The specific file/line/module and why it is problematic]
- **Recommendation & Rationale:** [How to remediate and why it's necessary for
  compliance]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. a grep for the leaky log that now returns empty, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this remediation independently]`
```

## Constraint

This is a **read-only** audit. Do not modify any code. Focus on identifying
risks and providing clear remediation steps.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
