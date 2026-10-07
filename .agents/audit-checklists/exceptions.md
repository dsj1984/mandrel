<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-exceptions.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Exception & Override Audit — authoring checklist

> Audit every exception and escape valve — inline suppressions, tool-config exemptions, dependency overrides, patches and allowlists, CI gate exemptions, test skips and code allowlists — and flag the ones that are dead, expired, orphaned, unjustified, or papering over a real fix.

Self-check your change against this lens's concerns before you ship:

- [ ] `degradations`.
- [ ] `skipped[]`.
- [ ] `delegated[]`.
- [ ] `truncated`.
- [ ] Dead.
- [ ] Expired.
- [ ] Orphaned.
- [ ] Unjustified.
- [ ] Fix Properly.
- [ ] Dead bundle template
- [ ] Unjustified template
- [ ] Fix Properly template
