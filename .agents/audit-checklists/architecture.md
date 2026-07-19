<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-architecture.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Architecture & Clean Code Audit — authoring checklist

> Audit architectural boundaries, module coupling, and layering violations; emit a structured findings report keyed to High/Medium/Low severity.

Self-check your change against this lens's concerns before you ship:

- [ ] Cycle detection.
- [ ] Dead-export detection.
- [ ] Hotspot ranking.
- [ ] LLM triage on top.
- [ ] Documented architecture boundaries
- [ ] Automated boundary checks
- [ ] Testable Surface (Humble-Object Boundary)
- [ ] High
- [ ] Medium
- [ ] Low
- [ ] Automated Architecture Guardrails
