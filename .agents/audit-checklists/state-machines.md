<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-state-machines.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# State Machine Audit — authoring checklist

> Audit implicit state machines — co-varying flags, status sidecar fields, scattered transitions, state split across systems — and report only the impossible or unhandled combinations the code can reach, each with a traced write path and a sketch of the explicit form.

Self-check your change against this lens's concerns before you ship:

- [ ] Shape: the variables move together.
- [ ] Consequence: a bad combination is reachable.
- [ ] Flags that encode one enum
- [ ] Fields valid only in some statuses
- [ ] Transitions with no single guard
- [ ] Consumers that miss a value
- [ ] One state, two stores
- [ ] Second read of the write order.
- [ ] Severity calibration.
