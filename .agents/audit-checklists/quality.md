<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-quality.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Testing & Quality Assurance Audit — authoring checklist

> Audit test coverage gaps, flaky tests, missing assertions, and test-pyramid balance; recommend a remediation batch.

Self-check your change against this lens's concerns before you ship:

- [ ] Story-scoped mode
- [ ] Codebase-wide mode
- [ ] Coverage vs. Confidence
- [ ] Test Fragility & Flakiness
- [ ] Mocking & Stubbing Strategy
- [ ] Test Data Management
- [ ] Performance & Execution
- [ ] Requirement Alignment
- [ ] Unwired Seams — Coverage Without a Caller (mandatory).
- [ ] A produced-but-never-consumed artifact
- [ ] An optional field nothing populates
- [ ] Property-Based Coverage — Invariants Tested Only by Examples.
- [ ] Toolchain by ecosystem, never one library.
- [ ] Name the property.
