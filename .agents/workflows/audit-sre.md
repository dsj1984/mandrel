---
description: "Audit production-readiness for a release candidate: SLOs, observability, runbooks, error budgets, and rollback paths."
---

# Production Release Candidate Audit

## Role

Senior Site Reliability Engineer (SRE) & Lead Developer

## Context & Objective

You are conducting a rigorous, read-only operational-readiness audit for a
production release candidate. Your goal is to surface critical risks across
rollback & recovery paths, observability & instrumentation, resilience &
failure handling, and runbooks & operational docs — providing a prioritized,
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

## Step 1: Resilience Detection Battery (Read-Only, Tool-First)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

This lens audits **operational readiness** — can this release be observed,
survive failure, and be rolled back? It deliberately does **not** re-audit
secrets, injection, dead code, or complexity; those are owned by
[`audit-security`](audit-security.md) and [`audit-clean-code`](audit-clean-code.md).
Ground findings in the greps below, then read the operational surfaces they
flag.

1. **Run the resilience battery.** Each grep maps to a Step 2 dimension:

   ```bash
   # Network calls without a timeout (a hung upstream stalls the whole request)
   rg -n "\b(fetch|axios(\.\w+)?|http\.request|got|ky)\s*\(" --glob '!**/*.test.*' | \
     rg -v -i "timeout|signal|AbortController"
   # Graceful-shutdown handlers (their ABSENCE is the finding for long-lived processes)
   rg -n "process\.on\(\s*['\"]SIG(TERM|INT)['\"]" || echo "no SIGTERM/SIGINT handler found"
   # Error-swallowing empty catch blocks (silent failure — no signal to observe)
   rg -n "catch\s*(\([^)]*\))?\s*\{\s*\}"
   # Retry / backoff on network-dependent work (resilience to transient failure)
   rg -n -i "retr(y|ies)|backoff|circuit.?breaker|p-retry"
   # Health / readiness endpoints (needed for orchestrated rollout & rollback)
   rg -n -i "/(health|healthz|readyz|livez|ping)\b|healthCheck"
   ```

## Step 2: Analysis Dimensions

Evaluate the release candidate against these **production-readiness** criteria.

### 1. Rollback & Recovery Paths

- **Rollback Path:** Is there a defined, tested way to revert this release —
  a versioned deploy, blue-green/canary, or a documented `git revert` + redeploy
  path? A release with no rollback path is a Critical finding.
- **Migration Reversibility:** Any schema migration in scope must ship a
  down-migration (or a documented forward-fix); an irreversible destructive
  migration blocks the release.
- **Feature-Flag Kill Switch:** Risky new behaviour should sit behind a flag
  that can be disabled without a redeploy.

### 2. Observability & Instrumentation

- **Structured Logging:** Are operational events emitted through a structured
  logger (levels, correlation ids) rather than bare `console.*`, so they are
  queryable in production?
- **Metrics & Tracing:** Are latency/error/throughput metrics and trace spans
  emitted for the new code path? Missing instrumentation on a critical path is
  a High finding.
- **Alerting & SLOs:** Is there an SLO (or error budget) and an alert wired to
  the signals above, so a regression pages someone?

### 3. Resilience & Failure Handling

- **Timeouts & Cancellation:** Every outbound call needs a timeout /
  `AbortSignal` (grep 1 in Step 1). A call without one is a Reliability finding.
- **Retry & Backoff:** Transient-failure-prone calls should retry with backoff;
  flag network work that fails hard on the first error.
- **Graceful Shutdown:** Long-lived processes must handle `SIGTERM`/`SIGINT`
  and drain in-flight work (grep 2). Its absence risks dropped requests on
  every deploy.
- **Error Boundaries:** Empty `catch` blocks (grep 3) swallow failures with no
  signal — flag each as an Observability + Resilience finding.

### 4. Runbooks & Operational Docs

- **Runbook Coverage:** Does an operational runbook exist for this
  service/feature (how to deploy, roll back, and respond to the top failure
  modes)? A new production surface with no runbook is a finding.
- **Health & Readiness:** Are health/readiness endpoints (grep 5) present and
  wired into the orchestrator so a bad rollout is caught before it takes
  traffic?
- **On-Call Escalation:** Is ownership / escalation for this surface documented?

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

- **Category:** [Rollback & Recovery | Observability | Resilience | Runbooks]
- **Severity:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [What exists and why it's a risk]
- **Recommendation:** [The specific fix and rationale]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. `npm test`, a grep that now returns empty, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`

## Release Readiness Checklist

| Category             | Status                     |
| -------------------- | -------------------------- |
| Rollback & Recovery  | ✅ Clear / ⚠️ Issues Found |
| Observability        | ✅ Clear / ⚠️ Issues Found |
| Resilience           | ✅ Clear / ⚠️ Issues Found |
| Runbooks             | ✅ Clear / ⚠️ Issues Found |
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
