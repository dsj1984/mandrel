---
description: Audit CI/CD workflows, container images, infrastructure-as-code, and deployment pipelines; surface failure modes and hardening gaps.
---

# DevOps Infrastructure Audit

## Role

Principal DevOps Engineer & Infrastructure Architect

## Context & Objective

You are performing a comprehensive, read-only audit of this repository's DevOps
infrastructure, developer experience (DX) tooling, and CI/CD pipelines. Your
goal is to identify inefficiencies, security risks, and areas for modernization
without making any immediate changes.

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Step 1: Context Gathering (Read-Only Scan)

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Before generating the report, silently scan the workspace for relevant
configuration files. Pay special attention to:

- CI/CD pipelines (e.g., `.github/workflows/`, `.gitlab-ci.yml`,
  `azure-pipelines.yml`).
- Dependency manifests and script definitions (e.g., `package.json`,
  `pnpm-workspace.yaml`).
- Linting, formatting, and static analysis configs (e.g., `.eslintrc*`,
  `.prettierrc*`, `biome.json`, `tsconfig.json`).
- Git hooks and commit standards (e.g., `.husky/`, `commitlint.config.js`).

## Step 2: Analysis Dimensions

Evaluate the gathered context against the following dimensions:

1. **Redundancy & Duplication:** Overlapping tools or conflicting rules (e.g.,
   Prettier vs. ESLint formatting, duplicated scripts in `package.json` and CI).
2. **Performance Gaps:** Bottlenecks in CI/CD, slow caching strategies, or
   unoptimized hooks (e.g., missing `lint-staged`).
3. **Security & Compliance:** Missing secret scanning, loose permissions (e.g.,
   `GITHUB_TOKEN` scopes), outdated or vulnerable dependency resolution
   strategies.
4. **Standardization & Modernization:** Opportunities to consolidate tooling
   (e.g., migrating to unified tools like Biome) or extract inline
   configurations into dedicated dotfiles.
5. **Reliability & Resilience:** Fragile pipeline steps, missing error handling,
   silent failures, or lack of retries for network-dependent tasks.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-devops-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# DevOps Infrastructure Audit Report

## Executive Summary

[Provide a brief 2–3 sentence overview of the current infrastructure state and
highlight the most critical overarching themes from the findings.]

## Detailed Findings

[For every gap identified, use the following strict structure. Lead each title
with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [e.g., Security & Compliance]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [What is currently configured in the codebase]
- **Recommendation & Rationale:** [The specific fix and why it improves the
  system]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. a green CI run, a hardened config lint, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this fix independently]`

## Proposed Implementation Roadmap

[Organize the recommended changes into a logical, phased approach — e.g., Phase
1: Critical Security & Fixing Broken Builds, Phase 2: Performance Optimizations,
Phase 3: Modernization / Tech Debt.]
```

---

## Constraint

Do NOT execute any code modifications, edit files, create branches, or install
packages. This is strictly a read-only analysis. Output the report and stop.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
