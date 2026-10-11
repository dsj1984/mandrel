<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-security.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# Security & Vulnerability Audit — authoring checklist

> Audit dependency CVEs, input-validation gaps, secrets handling, auth boundaries, and the trust-boundary attack classes the baseline is silent on (business logic, SSRF/traversal, deserialization, crypto misuse, feature abuse, LLM tool-binding); emit a structured High/Medium/Low f…

Self-check your change against this lens's concerns before you ship:

- [ ] Dependency CVEs, per detected ecosystem.
- [ ] Secret scanning (`gitleaks` / `trufflehog`), with a grep fallback.
- [ ] Grep battery (deterministic fallback / augmentation).
- [ ] Manual surface review.
- [ ] Injection
- [ ] Broken Access Control
- [ ] Cryptographic Failures
- [ ] Security Misconfiguration
- [ ] Vulnerable Components
- [ ] Business logic & state machines
- [ ] Access-control depth
- [ ] Resource & file handling
- [ ] Cryptography & secrets misuse
- [ ] Feature abuse & data leakage
- [ ] LLM & tool-binding boundaries
- [ ] An unfillable Boundary is not a finding.
- [ ] Defense-in-depth gaps are hardening notes.
- [ ] Severity never exceeds the demonstrated result.
- [ ] Critical
- [ ] High
- [ ] Medium
- [ ] Low
- [ ] Info
