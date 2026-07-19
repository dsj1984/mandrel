<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-performance.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Performance & Bottleneck Audit — authoring checklist

> Audit performance by measuring first — profile hot paths, I/O, memory, and payload against the repo's own numbers — and audit interleaving/partial-failure correctness (TOCTOU, unawaited promises, non-atomic writes) as a first-class dimension.

Self-check your change against this lens's concerns before you ship:

- [ ] Diff against the previous baseline
- [ ] Suppress unchanged known findings.
- [ ] CPU & algorithmic hot paths
- [ ] I/O & syscall efficiency
- [ ] Memory & leaks
- [ ] Payload & bundle (web only)
- [ ] Interleaving & partial-failure correctness
