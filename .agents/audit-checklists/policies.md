<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-policies.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Policy Consistency Audit — authoring checklist

> Audit a project's published customer-facing policies (Terms, Privacy, Cookie, refund and cancellation, consent and waiver text) against what the code actually does, in both directions — promises the system does not keep and practices no policy discloses. Never edits policy text…

Self-check your change against this lens's concerns before you ship:

- [ ] Unresolved cross-references
- [ ] Absent referenced documents
- [ ] Contact drift
- [ ] Money literals
- [ ] Contradiction
- [ ] Unbacked Promise
- [ ] Undisclosed Practice
- [ ] Stale Reference
- [ ] Internal Inconsistency
- [ ] Unverifiable
- [ ] Scheduled invocation
