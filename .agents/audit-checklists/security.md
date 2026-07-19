<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-security.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Security & Vulnerability Audit — authoring checklist

> Audit dependency CVEs, input-validation gaps, secrets handling, and auth boundaries; emit a structured High/Medium/Low findings report.

Self-check your change against this lens's concerns before you ship:

- [ ] Dependency CVEs (`npm audit`).
- [ ] Secret scanning (`gitleaks` / `trufflehog`), with a grep fallback.
- [ ] Grep battery (deterministic fallback / augmentation).
- [ ] Manual surface review.
- [ ] Injection
- [ ] Broken Access Control
- [ ] Cryptographic Failures
- [ ] Security Misconfiguration
- [ ] Vulnerable Components
