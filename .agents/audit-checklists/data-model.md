<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-data-model.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Data Model & Persistence Audit — authoring checklist

> Audit the persistence layer as a first-class artifact — model↔migration↔seed drift, constraint completeness, migration hygiene, type fidelity, and access-pattern fit; gated by a persistence-layer applicability probe so DB-less repos skip cleanly.

Self-check your change against this lens's concerns before you ship:

- [ ] ORM drift tooling (preferred)
- [ ] Read-only file fallback
- [ ] Model & schema inventory
- [ ] Migration history
- [ ] Seed & fixture data
- [ ] Model↔migration↔seed drift
- [ ] Constraint completeness
- [ ] Migration hygiene
- [ ] Type fidelity
- [ ] Access-pattern fit
