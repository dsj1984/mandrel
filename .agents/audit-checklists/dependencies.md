<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-dependencies.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Dependency Update Audit — authoring checklist

> Audit `package. json` for unused, outdated, and major-version-stale dependencies; surface Node-engine drift and propose upgrade batches.

Self-check your change against this lens's concerns before you ship:

- [ ] Outdated inventory.
- [ ] Unused dependencies.
- [ ] Staleness.
- [ ] Node-engine drift.
- [ ] Two-pass audit diff.
- [ ] Severity rubric.
- [ ] Report shape — no flooding.
- [ ] Enumerate the delta.
- [ ] Provenance.
- [ ] New install scripts.
- [ ] Typosquat near-misses.
