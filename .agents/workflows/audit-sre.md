---
description: "Audit production-readiness for a release candidate: SLOs, observability, runbooks, error budgets, and rollback paths."
---

# Production Release Candidate Audit

You are a Senior SRE & Lead Developer running an operational-readiness audit for
a production release candidate — rollback & recovery paths, observability &
instrumentation, resilience & failure handling, and runbooks & operational
docs. The shared lens machinery — read-only constraint, scope interpretation,
report envelope + finding-block skeleton, severity scale, self-cross-check, and
execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-sre-results.md`. Each finding carries a **Category:**
(`Rollback & Recovery | Observability | Resilience | Runbooks`); the report adds
a **Release Readiness Checklist** table (per-category ✅ Clear / ⚠️ Issues
Found).

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Step 1: Resilience Detection Battery (Read-Only, Tool-First)

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
