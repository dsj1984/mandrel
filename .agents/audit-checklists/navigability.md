<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-navigability.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Navigability Audit — authoring checklist

> Audit the whole route tree against the consumer's nav-registry SSOT — every route has a persona nav door and no nav href is dead. A deliberately-global lens (Epic #4131, F2/F3) exempt from the cross-epic-leak guard and routed onto route-adding change sets.

Self-check your change against this lens's concerns before you ship:

- [ ] Every route has a persona nav door.
- [ ] No nav href is dead.
- [ ] Dynamic-segment children of a surfaced parent
- [ ] System routes
- [ ] Inbound in-app references
