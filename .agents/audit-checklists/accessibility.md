<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-accessibility.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Accessibility (WCAG) Audit — authoring checklist

> Audit WCAG accessibility conformance (static-first) with an optional runtime verification pass, and produce a structured findings report

Self-check your change against this lens's concerns before you ship:

- [ ] `audit-accessibility` (this lens)
- [ ] `audit-ux-ui`
- [ ] Renderable surface
- [ ] Static a11y tooling already in the repo
- [ ] Design tokens
- [ ] Runtime target (optional)
- [ ] Semantic structure
- [ ] ARIA correctness
- [ ] Keyboard operability & focus management
- [ ] Forms & labels
- [ ] Media alternatives
- [ ] Contrast where statically derivable
- [ ] Raw-element census
- [ ] Resolve the target from config — never a hardcoded URL.
- [ ] Sample routes from the navigability SSOT.
- [ ] Run an accessibility engine per sampled route.
- [ ] Median-of-3 or provisional.
