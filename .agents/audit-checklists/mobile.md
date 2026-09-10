<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-mobile.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Mobile & Tablet UX Audit — authoring checklist

> Audit mobile and tablet UX — layout and viewport correctness, touch ergonomics, responsive assets, and whether anything actually verifies them at a small viewport (static-first, with an optional runtime viewport pass)

Self-check your change against this lens's concerns before you ship:

- [ ] Breakpoint scale
- [ ] Viewport contract
- [ ] Declared device matrix
- [ ] Runtime target (optional)
- [ ] Viewport meta
- [ ] Fixed dimensions
- [ ] Viewport-height units
- [ ] Horizontal overflow
- [ ] Safe-area insets
- [ ] Hover-only interaction
- [ ] Control size and spacing
- [ ] Input ergonomics
- [ ] Gesture conflicts
- [ ] Images
- [ ] Media and embeds
- [ ] Typography and spacing
- [ ] Coverage — is anything exercised at a non-desktop viewport?
- [ ] Effectiveness — does that exercise assert anything mobile-specific?
- [ ] Drive two form factors per route.
