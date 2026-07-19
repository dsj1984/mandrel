<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-sre.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Production Release Candidate Audit — authoring checklist

> Audit production-readiness for a release candidate: SLOs, observability, runbooks, error budgets, and rollback paths.

Self-check your change against this lens's concerns before you ship:

- [ ] Run the resilience battery.
- [ ] Rollback Path
- [ ] Migration Reversibility
- [ ] Feature-Flag Kill Switch
- [ ] Structured Logging
- [ ] Metrics & Tracing
- [ ] Alerting & SLOs
- [ ] Timeouts & Cancellation
- [ ] Retry & Backoff
- [ ] Graceful Shutdown
- [ ] Error Boundaries
- [ ] Runbook Coverage
- [ ] Health & Readiness
- [ ] On-Call Escalation
