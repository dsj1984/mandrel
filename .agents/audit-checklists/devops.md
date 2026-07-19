<!-- GENERATED FILE — do not edit by hand.
     Source of truth: .agents/workflows/audit-devops.md
     Regenerate: node .agents/scripts/generate-lens-checklists.js
     Drift is gated by: npm run docs:check
-->

# DevOps Infrastructure Audit — authoring checklist

> Audit CI/CD workflows, container images, infrastructure-as-code, and deployment pipelines; surface failure modes and hardening gaps.

Self-check your change against this lens's concerns before you ship:

- [ ] Workflow static analysis (`actionlint`).
- [ ] Workflow security posture (`zizmor`).
- [ ] Container linting (`hadolint`), presence-gated on Dockerfiles.
- [ ] Pipeline reliability history (`gh run list`).
- [ ] Redundancy & Duplication
- [ ] Performance Gaps
- [ ] Security & Compliance
- [ ] Standardization & Modernization
- [ ] Reliability & Resilience
