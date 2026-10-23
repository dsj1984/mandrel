<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-resilience.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Resilience Audit — authoring checklist

> Audit every external dependency, platform binding and cross-service seam: whether failure is bounded, whether the system degrades on purpose, what the user sees, and whether a human is told and how fast. A deliberately-global lens that builds a dependency inventory and follows…

Self-check your change against this lens's concerns before you ship:

- [ ] Timeout scope
- [ ] Retry safety
- [ ] Outage as empty
- [ ] Fail-open vs fail-closed
- [ ] Missing secret or binding
- [ ] Bypassed primitive
- [ ] Idempotency keys
- [ ] Claim before transmit
- [ ] Webhook receivers
- [ ] Reconciliation coverage
- [ ] Compensation
- [ ] Fan-out settlement
- [ ] Sink classification
- [ ] Capture census
- [ ] Storms and collapse
- [ ] Silent producers
- [ ] Sink posture
- [ ] Watch the watcher
- [ ] Error page
- [ ] Outage shape
- [ ] Retry affordance
- [ ] Error boundaries
- [ ] Report path
- [ ] Per-job isolation
- [ ] Per-job deadline
- [ ] Overlap safety
- [ ] Heartbeats
- [ ] …see the full lens for the remaining concerns
