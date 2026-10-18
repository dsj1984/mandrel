<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-lean.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Lean Code Audit — authoring checklist

> Audit whether code should exist at all — reinvented helpers, stdlib and platform re-implementations, single-implementation abstractions, dependencies carried for a few lines, and semantic near-copies — every finding grounded in a grep before it is judged.

Self-check your change against this lens's concerns before you ship:

- [ ] Reuse
- [ ] Stdlib & Platform
- [ ] YAGNI
- [ ] Dependency Weight
- [ ] Near-Copy
- [ ] Reinvented helpers
- [ ] Parallel registries
- [ ] Hand-rolled built-ins
- [ ] Polyfills past their target
- [ ] Single-implementation abstractions
- [ ] Pass-through wrappers
- [ ] Dead options
- [ ] Packages carried for a few lines
- [ ] Semantic duplicates
